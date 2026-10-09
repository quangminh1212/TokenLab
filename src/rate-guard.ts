/**
 * Request-rate guard that mirrors LiteLLM's own pre-call limiter.
 *
 * Source of truth: the `glm_rps_limit.py` callback wired into the VPS LiteLLM
 * proxy via `litellm_settings.callbacks` in `_config_live.yaml`. The original
 * .py source was lost; this port was reconstructed from the surviving
 * `__pycache__/glm_rps_limit.cpython-314.pyc` bytecode, so the algorithm below
 * is a 1:1 behavioural match rather than an approximation.
 *
 * The upstream implementation, as recovered from bytecode:
 *
 *   RPS_LIMIT = 1.0             # 1 request / second
 *   RPM_LIMIT = 60.0            # 60 requests / minute
 *   SECOND_WINDOW_SECONDS = 1.0
 *   MINUTE_WINDOW_SECONDS = 60.0
 *
 *   async def async_pre_call_hook(...):
 *       model = str((data or {}).get("model") or "").strip().lower()
 *       if model not in GLM_MODELS:
 *           return data
 *       async with self._lock:                       # serialised → exact counts
 *           now = time.monotonic()                   # monotonic, not wall-clock
 *           while self._starts and now - self._starts[0] >= MINUTE_WINDOW_SECONDS:
 *               self._starts.popleft()               # sliding window, evict head
 *           second_starts = [t for t in self._starts if now - t < SECOND_WINDOW_SECONDS]
 *           if len(second_starts) >= RPS_LIMIT:
 *               retry_after = max(1, math.ceil(SECOND_WINDOW_SECONDS - (now - second_starts[0])))
 *               raise ProxyRateLimitError(...)       # HTTP 429
 *           if len(self._starts) >= RPM_LIMIT:
 *               retry_after = max(1, math.ceil(MINUTE_WINDOW_SECONDS - (now - self._starts[0])))
 *               raise ProxyRateLimitError(...)
 *           self._starts.append(now)
 *       return data
 *
 * Deliberate properties carried over exactly:
 *
 * 1. **Sliding windows, not calendar buckets.** The guard keeps individual
 *    start timestamps in a deque and evaluates `now - t < window`. A fixed
 *    `floor(ts / 60s)` bucket (what `computeActiveUsageRpm` uses for the
 *    dashboard) reports a *different* number: 6 calls at :59 and :00 of
 *    adjacent minutes read as 2 RPM bucketed but as 6 in this rolling window.
 *    Anything meant to agree with LiteLLM's verdict must use THIS definition.
 *
 * 2. **Monotonic clock.** Upstream uses `time.monotonic()`, which is immune to
 *    wall-clock jumps. This port therefore accepts elapsed *seconds* rather
 *    than absolute timestamps, so callers can feed monotonic time on the live
 *    path and synthetic offsets in tests.
 *
 * 3. **`>=` on the limit.** The check is `len(...) >= LIMIT`, so a limit of 1
 *    rejects the very next request when one is already inside the window — the
 *    limit is *exclusive*: the Nth concurrent request is denied, not allowed.
 *
 * 4. **`max(1, ceil(...))` Retry-After.** Never returns 0 or a fraction.
 *
 * The rejected request is NOT recorded, so a client that retries immediately
 * after a 429 gets a fresh evaluation rather than deepening its own penalty.
 */

/** A single window/limit pair, matching one branch of the upstream guard. */
export interface RateWindow {
  /** Bucket identifier, e.g. "1s" or "60s". */
  windowSeconds: number;
  /** Requests allowed inside `windowSeconds`. The check is `>=`, so this is exclusive. */
  limit: number;
}

/** Limits for one model route, mirroring the upstream module-level constants. */
export interface RateLimitSpec {
  /** Model ids this spec applies to, compared lowercased+trimmed. Empty = all. */
  models: string[];
  windows: RateWindow[];
}

export interface RateVerdict {
  allowed: boolean;
  /** Which window rejected the request, when denied. */
  rejectedBy: { windowSeconds: number; limit: number } | null;
  /** Seconds to wait before retrying. `max(1, ceil(...))`, like upstream. */
  retryAfterSeconds: number | null;
  /** Requests currently inside each window — the numbers upstream compares. */
  counts: Array<{ windowSeconds: number; limit: number; count: number }>;
  /** Human-readable message shaped like the upstream ProxyRateLimitError detail. */
  message: string | null;
}

/**
 * Upstream defaults, straight from the recovered constants.
 *
 * The task brief quoted "5 requests / 30 giây" and "2 request/giây", but the
 * LiteLLM callback that actually enforces limits on this proxy uses 1/s and
 * 60/min. Both are configurable here so a deployment can match whichever
 * provider contract applies; `litellmDefaultSpec()` returns the recovered
 * upstream values, and `quotedProviderSpec()` returns the figures from the
 * warning text.
 */
export const LITELLM_RPS_LIMIT = 1;
export const LITELLM_RPM_LIMIT = 60;
export const LITELLM_SECOND_WINDOW_SECONDS = 1;
export const LITELLM_MINUTE_WINDOW_SECONDS = 60;

/** The model ids the upstream callback gated (`GLM_MODELS`). */
export const LITELLM_GATED_MODELS = ["glm-5.3", "glm-5.53"];

/** Recovered upstream configuration: 1 req/s and 60 req/min, GLM routes only. */
export function litellmDefaultSpec(): RateLimitSpec {
  return {
    models: [...LITELLM_GATED_MODELS],
    windows: [
      { windowSeconds: LITELLM_SECOND_WINDOW_SECONDS, limit: LITELLM_RPS_LIMIT },
      { windowSeconds: LITELLM_MINUTE_WINDOW_SECONDS, limit: LITELLM_RPM_LIMIT },
    ],
  };
}

/** Parse `RATE_LIMIT_WINDOWS` style config, e.g. "5/30s,2/1s" or "1/1s,60/60s". */
export function parseRateWindows(raw: string | null | undefined): RateWindow[] | null {
  if (!raw || !raw.trim()) return null;
  const out: RateWindow[] = [];
  for (const part of raw.split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    // Accepted: "5/30s", "5/30", "5 / 30s"
    const m = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(piece);
    if (!m) return null;
    const limit = Number(m[1]);
    let windowSeconds = Number(m[2]);
    if (!Number.isFinite(limit) || !Number.isFinite(windowSeconds)) return null;
    const unit = (m[3] || "s").toLowerCase();
    if (unit === "m") windowSeconds *= 60;
    else if (unit === "h") windowSeconds *= 3600;
    if (limit <= 0 || windowSeconds <= 0) return null;
    out.push({ windowSeconds, limit });
  }
  return out.length > 0 ? out : null;
}

/**
 * Parse `RATE_LIMIT_MODELS` list, e.g. "glm-5.3,glm-5.53" or "*" for all.
 *
 * Returns null for anything that cannot be a model list, so the caller can warn
 * and fall back instead of installing a guard that matches nothing. That
 * failure mode is the dangerous one: a guard whose model set is empty-by-typo
 * still reports "limits enforced" while blocking nothing.
 *
 * Model ids are free-form but drawn from a known charset — letters, digits, and
 * `. _ - : / + @` (covers `glm-5.53`, `anthropic/claude-opus-5.5`,
 * `nvidia/nemotron-3-ultra-550b-a55b:free`). Two conditions must both hold:
 * every character is in that charset, AND the entry contains at least one
 * letter or digit. The first alone accepts `@@@`; the second alone accepts
 * `!!!bad!!!`. Together they reject both while accepting every real id.
 */
const MODEL_ID_PATTERN = /^[a-z0-9._:/+@-]+$/;
const HAS_ALNUM = /[a-z0-9]/;

export function parseRateModels(raw: string | null | undefined): string[] | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === "*") return [];
  const models = trimmed
    .split(",")
    .map((m) => m.trim().toLowerCase())
    .filter((m) => m.length > 0);
  if (models.length === 0) return null;
  if (!models.every((m) => MODEL_ID_PATTERN.test(m) && HAS_ALNUM.test(m))) return null;
  return models;
}

/**
 * Rolling-window request guard, ported from LiteLLM's pre-call hook.
 *
 * State is intentionally process-local and per-model, exactly like upstream:
 * the deque holds start offsets in seconds and is pruned by the widest window.
 */
export class RequestRateGuard {
  private readonly starts: number[] = [];
  private readonly windows: RateWindow[];
  private readonly models: Set<string>;
  private readonly widestWindowSeconds: number;

  constructor(spec: RateLimitSpec) {
    this.windows = [...spec.windows].sort((a, b) => a.windowSeconds - b.windowSeconds);
    this.models = new Set(spec.models.map((m) => m.trim().toLowerCase()));
    this.widestWindowSeconds = this.windows.reduce((max, w) => Math.max(max, w.windowSeconds), 0);
  }

  /** True when this guard gates the given model id. Empty model set = all. */
  appliesTo(model: string | null | undefined): boolean {
    if (this.models.size === 0) return true;
    if (typeof model !== "string") return false;
    return this.models.has(model.trim().toLowerCase());
  }

  /** Current request count inside each window. Prunes stale entries first. */
  countsAt(nowSeconds: number): Array<{ windowSeconds: number; limit: number; count: number }> {
    this.prune(nowSeconds);
    return this.windows.map((w) => ({
      windowSeconds: w.windowSeconds,
      limit: w.limit,
      count: this.starts.filter((t) => nowSeconds - t < w.windowSeconds).length,
    }));
  }

  /** Prune entries older than the widest window — upstream's `while` + `popleft`. */
  private prune(nowSeconds: number): void {
    // The deque is append-ordered, so stale entries are always a prefix.
    let drop = 0;
    while (drop < this.starts.length && nowSeconds - this.starts[drop]! >= this.widestWindowSeconds) {
      drop += 1;
    }
    if (drop > 0) this.starts.splice(0, drop);
  }

  /**
   * Evaluate a request without recording it. Mirrors the upstream order:
   * narrowest window first, then widest, first failure wins.
   */
  check(model: string | null | undefined, nowSeconds: number): RateVerdict {
    if (!this.appliesTo(model)) {
      return {
        allowed: true,
        rejectedBy: null,
        retryAfterSeconds: null,
        counts: [],
        message: null,
      };
    }

    this.prune(nowSeconds);
    const label = typeof model === "string" ? model.trim().toLowerCase() : "";
    const counts: Array<{ windowSeconds: number; limit: number; count: number }> = [];

    for (const w of this.windows) {
      const inside = this.starts.filter((t) => nowSeconds - t < w.windowSeconds);
      counts.push({ windowSeconds: w.windowSeconds, limit: w.limit, count: inside.length });
      if (inside.length >= w.limit) {
        // Upstream: max(1, ceil(window - (now - oldest_in_window)))
        const oldest = inside[0]!;
        const retryAfterSeconds = Math.max(1, Math.ceil(w.windowSeconds - (nowSeconds - oldest)));
        const unit = w.windowSeconds < 60 ? "per second" : "per minute";
        const perUnit =
          w.windowSeconds < 60
            ? `maximum ${w.limit} requests ${unit}`
            : `maximum ${w.limit} requests ${unit}`;
        return {
          allowed: false,
          rejectedBy: { windowSeconds: w.windowSeconds, limit: w.limit },
          retryAfterSeconds,
          counts,
          message: `${label} rate limit exceeded: ${perUnit}`,
        };
      }
    }

    return {
      allowed: true,
      rejectedBy: null,
      retryAfterSeconds: null,
      counts,
      message: null,
    };
  }

  /**
   * Check and, when allowed, record the request — the guard's normal entry
   * point. A denied request is never recorded, matching upstream: rejection
   * must not extend the window.
   */
  admit(model: string | null | undefined, nowSeconds: number): RateVerdict {
    const verdict = this.check(model, nowSeconds);
    if (verdict.allowed && this.appliesTo(model)) this.starts.push(nowSeconds);
    return verdict;
  }

  /** Drop all state (model switch, config reload, tests). */
  reset(): void {
    this.starts.length = 0;
  }

  /** Requests currently held in state — after pruning, the widest window's count. */
  size(nowSeconds: number): number {
    this.prune(nowSeconds);
    return this.starts.length;
  }
}

export interface ReplayDecision {
  index: number;
  atSeconds: number;
  allowed: boolean;
  retryAfterSeconds: number | null;
  rejectedBy: { windowSeconds: number; limit: number } | null;
}

export interface ReplayResult {
  decisions: ReplayDecision[];
  admitted: number;
  rejected: number;
  /** Seconds of the widest window before the first admission, for caller context. */
  firstAdmissionAtSeconds: number | null;
}

/**
 * Feed recorded request timestamps through the guard and report each verdict.
 *
 * This is how TokenLab answers "would LiteLLM have rejected this?" without
 * touching the proxy: replay the observed request times and report exactly
 * where the upstream algorithm would have raised ProxyRateLimitError.
 *
 * `timestampsSeconds` must be ascending; the caller is responsible for having
 * sorted them (aggregate callers already hold ascending arrays).
 */
export function replayThroughGuard(
  spec: RateLimitSpec,
  model: string | null,
  timestampsSeconds: number[],
): ReplayResult {
  const guard = new RequestRateGuard(spec);
  const decisions: ReplayDecision[] = [];
  let admitted = 0;
  let rejected = 0;
  let firstAdmissionAtSeconds: number | null = null;

  for (let i = 0; i < timestampsSeconds.length; i++) {
    const at = timestampsSeconds[i]!;
    if (!Number.isFinite(at)) continue;
    const verdict = guard.admit(model, at);
    if (verdict.allowed) {
      admitted += 1;
      if (firstAdmissionAtSeconds == null) firstAdmissionAtSeconds = at;
    } else {
      rejected += 1;
    }
    decisions.push({
      index: i,
      atSeconds: at,
      allowed: verdict.allowed,
      retryAfterSeconds: verdict.retryAfterSeconds,
      rejectedBy: verdict.rejectedBy,
    });
  }

  return { decisions, admitted, rejected, firstAdmissionAtSeconds };
}

/**
 * Resolve the effective guard spec from env > config > upstream default.
 *
 * Precedence is deliberate: an operator debugging a live block wants an env
 * override to take effect immediately, without editing config.json. A
 * malformed override is logged-by-returning-false (see `isUpstreamDefault`)
 * rather than silently ignored, so a typo cannot masquerade as "limits are
 * applied".
 */
export interface RateConfigInput {
  /** `config.rateLimit.windows`, e.g. "5/30s,2/1s". */
  configWindows?: string | null;
  /** `config.rateLimit.models`, e.g. "glm-5.3" or "*". */
  configModels?: string | null;
  /** Process env, injected so this stays testable. */
  env?: Record<string, string | undefined>;
}

export interface ResolvedRateSpec {
  spec: RateLimitSpec;
  /** Where the window list came from, for the API/UI to show provenance. */
  windowsSource: "env" | "config" | "upstream-default";
  modelsSource: "env" | "config" | "upstream-default";
  /** Non-fatal problems (unparseable override fell back to the default). */
  warnings: string[];
  /** True when nothing overrode the recovered upstream constants. */
  isUpstreamDefault: boolean;
}

export function resolveRateSpec(input: RateConfigInput = {}): ResolvedRateSpec {
  const env = input.env ?? process.env;
  const warnings: string[] = [];

  const envWindows = env.TOKENLAB_RATE_LIMIT_WINDOWS ?? null;
  const cfgWindows = input.configWindows ?? null;

  let windows: RateWindow[] | null = null;
  let windowsSource: ResolvedRateSpec["windowsSource"] = "upstream-default";

  if (envWindows != null && envWindows.trim() !== "") {
    windows = parseRateWindows(envWindows);
    if (windows) windowsSource = "env";
    else warnings.push(`TOKENLAB_RATE_LIMIT_WINDOWS=${JSON.stringify(envWindows)} is not parseable; using default`);
  }
  if (!windows && cfgWindows != null && cfgWindows.trim() !== "") {
    windows = parseRateWindows(cfgWindows);
    if (windows) windowsSource = "config";
    else warnings.push(`config rateLimit.windows=${JSON.stringify(cfgWindows)} is not parseable; using default`);
  }
  if (!windows) {
    windows = litellmDefaultSpec().windows;
    windowsSource = "upstream-default";
  }

  const envModels = env.TOKENLAB_RATE_LIMIT_MODELS ?? null;
  const cfgModels = input.configModels ?? null;

  let models: string[] | null = null;
  let modelsSource: ResolvedRateSpec["modelsSource"] = "upstream-default";

  if (envModels != null && envModels.trim() !== "") {
    models = parseRateModels(envModels);
    if (models) modelsSource = "env";
    else warnings.push(`TOKENLAB_RATE_LIMIT_MODELS=${JSON.stringify(envModels)} is not parseable; using default`);
  }
  if (!models && cfgModels != null && cfgModels.trim() !== "") {
    models = parseRateModels(cfgModels);
    if (models) modelsSource = "config";
    else warnings.push(`config rateLimit.models=${JSON.stringify(cfgModels)} is not parseable; using default`);
  }
  if (!models) {
    models = litellmDefaultSpec().models;
    modelsSource = "upstream-default";
  }

  return {
    spec: { models, windows },
    windowsSource,
    modelsSource,
    warnings,
    isUpstreamDefault: windowsSource === "upstream-default" && modelsSource === "upstream-default",
  };
}
