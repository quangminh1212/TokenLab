import { normalizeModelName, num } from "../../util.js";

export interface TokenBuckets {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Some providers report prompt/input as a full value that already includes cache reads. */
  inputIncludesCache?: boolean;
  /**
   * True when the source usage object actually carried a cache field (read or
   * write), even when its value is 0. Distinct from `cacheReadTokens > 0`: a row
   * that reports cache and a row that says nothing about caching both land at 0
   * tokens, and the dashboard's CACHE $ column needs to tell them apart.
   */
  cacheReported?: boolean;
}

/**
 * True when `obj` carries any cache-related key (read or write), regardless of
 * value. Used to distinguish "the provider told us cache was 0" from "the
 * provider said nothing about caching" — both yield 0 tokens but only the first
 * is a measurement the CACHE $ column may render as $0.00 instead of "—".
 */
function hasCacheField(obj: Record<string, unknown> | null): boolean {
  if (!obj) return false;
  for (const key of Object.keys(obj)) {
    if (/cach/i.test(key)) return true;
  }
  return false;
}

/** Extract token buckets from heterogeneous vendor usage objects. */
export function extractTokenBuckets(usage: unknown): TokenBuckets | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;

  // Nested shapes: usage / token_usage / metrics (Devin) / metadata.metrics
  const meta =
    u.metadata && typeof u.metadata === "object" ? (u.metadata as Record<string, unknown>) : null;
  const nested =
    (u.usage && typeof u.usage === "object" ? (u.usage as Record<string, unknown>) : null) ||
    (u.token_usage && typeof u.token_usage === "object" ? (u.token_usage as Record<string, unknown>) : null) ||
    (u.tokenUsage && typeof u.tokenUsage === "object" ? (u.tokenUsage as Record<string, unknown>) : null) ||
    (u.tokens && typeof u.tokens === "object" ? (u.tokens as Record<string, unknown>) : null) ||
    (u.token_count && typeof u.token_count === "object" ? (u.token_count as Record<string, unknown>) : null) ||
    (u.metrics && typeof u.metrics === "object" ? (u.metrics as Record<string, unknown>) : null) ||
    (meta?.metrics && typeof meta.metrics === "object" ? (meta.metrics as Record<string, unknown>) : null) ||
    u;

  const inputTokens = num(
    nested.input_tokens ??
      nested.inputTokens ??
      nested.prompt_tokens ??
      nested.promptTokens ??
      nested.prompt_token_count ??
      nested.input ??
      nested.total_input_tokens ??
      nested.input_other,
  );
  const explicitOutputTokens = num(
    nested.output_tokens ??
      nested.outputTokens ??
      nested.completion_tokens ??
      nested.completionTokens ??
      nested.candidatesTokenCount ??
      nested.output ??
      nested.total_output_tokens ??
      nested.completion,
  );
  // Codex/Orca can emit reasoning_output_tokens alongside (or instead of)
  // output_tokens. In the normal shape reasoning is already included in
  // output_tokens, so only use it as a fallback when output is absent/zero.
  const reasoningOutputTokens = num(
    nested.reasoning_output_tokens ??
      nested.reasoningOutputTokens ??
      nested.reasoning_tokens ??
      nested.reasoningTokens,
  );
  const outputTokens = explicitOutputTokens > 0 ? explicitOutputTokens : reasoningOutputTokens;
  // Nested OpenAI / LiteLLM shapes: prompt_tokens_details.cached_tokens
  const promptDetails =
    (nested.prompt_tokens_details && typeof nested.prompt_tokens_details === "object"
      ? (nested.prompt_tokens_details as Record<string, unknown>)
      : null) ||
    (nested.promptTokensDetails && typeof nested.promptTokensDetails === "object"
      ? (nested.promptTokensDetails as Record<string, unknown>)
      : null) ||
    (nested.input_tokens_details && typeof nested.input_tokens_details === "object"
      ? (nested.input_tokens_details as Record<string, unknown>)
      : null);

  // Anthropic/Claude Code 2.x can expose cache creation as a nested
  // breakdown while retaining the flat cache_creation_input_tokens field.
  // The flat total wins when it is positive; otherwise sum the mutually
  // exclusive ephemeral windows so cache-write usage is not lost.
  const cacheCreationDetails =
    nested.cache_creation && typeof nested.cache_creation === "object"
      ? (nested.cache_creation as Record<string, unknown>)
      : null;
  const ephemeralCacheCreationTokens =
    num(cacheCreationDetails?.ephemeral_5m_input_tokens) +
    num(cacheCreationDetails?.ephemeral_1h_input_tokens);
  const cacheCreationDetailTokens =
    ephemeralCacheCreationTokens > 0
      ? ephemeralCacheCreationTokens
      : num(cacheCreationDetails?.input_tokens ?? cacheCreationDetails?.tokens);

  const cacheReadDetails =
    nested.cache_read && typeof nested.cache_read === "object"
      ? (nested.cache_read as Record<string, unknown>)
      : null;

  const cacheReadTokens = num(
    nested.cached_input_tokens ??
      nested.cachedInputTokens ??
      nested.cache_read_input_tokens ??
      nested.cache_read_tokens ??
      nested.cacheReadTokens ??
      nested.cached_input_tokens ??
      nested.cachedInputTokens ??
      nested.cachedReadTokens ??
      nested.cacheReadInputTokens ??
      nested.cache_read ??
      nested.cached_tokens ??
      nested.cachedTokens ??
      nested.cached_content_token_count ??
      nested.cachedContentTokenCount ??
      nested.cached ??
      nested.input_cache_read ??
      nested.total_cache_read_tokens ??
      promptDetails?.cached_tokens ??
      promptDetails?.cache_read_tokens ??
      promptDetails?.cachedTokens ??
      promptDetails?.cache_read_input_tokens ??
      promptDetails?.cached_input_tokens ??
      promptDetails?.cachedInputTokens,
  );
  const flatCacheWriteTokens = num(
    nested.cache_write_input_tokens ??
      nested.cacheWriteInputTokens ??
      nested.cache_creation_input_tokens ??
      nested.cacheCreationInputTokens ??
      nested.cache_creation_tokens ??
      nested.cacheCreationTokens ??
      nested.cache_write_tokens ??
      nested.cacheWriteInputTokens ??
      nested.cacheWriteTokens ??
      nested.cache_write ??
      nested.cachedWriteTokens ??
      nested.input_cache_creation ??
      nested.total_cache_write_tokens ??
      promptDetails?.cache_write_tokens ??
      promptDetails?.cache_creation_input_tokens ??
      promptDetails?.cache_write_input_tokens ??
      promptDetails?.cacheWriteInputTokens,
  );
  const cacheWriteTokens =
    flatCacheWriteTokens > 0 ? flatCacheWriteTokens : cacheCreationDetailTokens;

  // A few OpenAI-compatible proxies put cache reads under a details object.
  // Use it only when no flat alias was present so aliases are never summed.
  const cacheReadWithDetails =
    cacheReadTokens > 0
      ? cacheReadTokens
      : num(
          cacheReadDetails?.input_tokens ??
            cacheReadDetails?.cached_tokens ??
            cacheReadDetails?.tokens,
        );

  if (inputTokens + outputTokens + cacheReadWithDetails + cacheWriteTokens <= 0) return null;
  const inputIncludesCache =
    nested.cached_input_tokens != null ||
    nested.cachedInputTokens != null ||
    nested.cached_content_token_count != null ||
    nested.cachedContentTokenCount != null ||
    promptDetails?.cached_tokens != null ||
    promptDetails?.cachedTokens != null ||
    promptDetails?.cached_input_tokens != null ||
    promptDetails?.cachedInputTokens != null ||
    cacheReadDetails != null;
  // Presence, not magnitude: a source that emitted a cache key (even 0) or whose
  // read landed under a details object is a measurement of cache; a source with
  // no cache key at all is silence.
  const cacheReported =
    hasCacheField(nested) ||
    hasCacheField(promptDetails) ||
    hasCacheField(cacheReadDetails) ||
    hasCacheField(cacheCreationDetails) ||
    cacheReadWithDetails > 0 ||
    cacheWriteTokens > 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheReadWithDetails,
    cacheWriteTokens,
    ...(inputIncludesCache ? { inputIncludesCache: true } : {}),
    ...(cacheReported ? { cacheReported: true } : {}),
  };
}

export function extractModel(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      const n = normalizeModelName(c);
      if (n) return n;
    }
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      // Gateways such as LiteLLM expose the public model group separately from
      // the provider-native model path. Prefer that public identity when it is
      // available (for example openai/openclaw + model_group=glm-5.3).
      for (const key of [
        "model_group",
        "modelGroup",
        "displayModel",
        "display_model",
        "model",
        "modelId",
        "model_id",
        "model_name",
        "rawModel",
      ] as const) {
        if (typeof o[key] === "string" && (o[key] as string).trim()) {
          const n = normalizeModelName(o[key] as string);
          if (n) return n;
        }
      }
      if (o.message && typeof o.message === "object") {
        const m = o.message as Record<string, unknown>;
        if (typeof m.model === "string" && m.model.trim()) {
          const n = normalizeModelName(m.model);
          if (n) return n;
        }
      }
    }
  }
  return null;
}

/**
 * Timestamp keys probed on object candidates, in priority order.
 * Hoisted to module scope: this was an 11-element array literal allocated on
 * every extractTimestamp() call, i.e. once (or twice) per parsed log row.
 */
const TIMESTAMP_KEYS = [
  "timestamp",
  "ts",
  "created_at",
  "createdAt",
  "started_at",
  "startedAt",
  "completed_at",
  "completedAt",
  "time",
  "date",
  "mtime",
];

/**
 * Resolve a [startMs, endMs] span from loosely-typed candidates.
 *
 * Returns null unless BOTH ends parse to finite epoch ms with start <= end.
 * Ordering is not assumed: callers may pass (first, last) or (last, first) and
 * the pair is normalised here. Used to spread an aggregate row (one row holding
 * a whole session's request count) across the minutes it actually covered.
 */
export function resolveSpanMs(a: unknown, b: unknown): [number, number] | null {
  const toEpochMs = (n: number): number | null => {
    // epoch seconds vs ms; reject noise that cannot be a real date
    const ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : NaN;
    if (!Number.isFinite(ms) || ms < 1e11) return null;
    return ms;
  };
  const one = (v: unknown): number | null => {
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
    if (typeof v === "string" && v.trim()) {
      const ms = Date.parse(v);
      if (Number.isFinite(ms)) return ms;
      // numeric string epoch
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? toEpochMs(n) : null;
    }
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return toEpochMs(v);
    return null;
  };
  const x = one(a);
  const y = one(b);
  if (x == null || y == null) return null;
  const start = Math.min(x, y);
  const end = Math.max(x, y);
  return [start, end];
}

/**
 * Split a span into per-minute buckets, returning each bucket's timestamp plus
 * its share of the span as an exact fraction (all weights sum to exactly 1).
 *
 * Why this exists: some agents store a session (or a whole day) as ONE row with
 * aggregated totals under a single timestamp. Feeding that straight to a
 * per-minute peak makes the entire session look like it happened in 60 seconds —
 * a real case reported 3135 req/min from a 25-hour session spanning two calendar
 * days. Spreading the row over the span it actually covered keeps both the
 * per-minute rate and the per-day attribution honest.
 *
 * Weights sum to 1, so callers must MULTIPLY every additive field (requests,
 * tokens, cost) by its weight rather than copying the totals into each bucket —
 * copying would multiply the session's usage by the number of buckets.
 *
 * Weights are equal across buckets except that any remainder is front-loaded in
 * whole-request units via `requests`, so the request total is preserved exactly
 * with no fractional calls.
 */
export function splitSpanWeights(
  requests: number,
  startMs: number,
  endMs: number,
): Array<{ timestamp: string; weight: number; requestCount: number }> {
  const total = Math.max(1, Math.floor(requests));
  const startMinute = Math.floor(startMs / 60_000) * 60_000;
  const endMinute = Math.floor(endMs / 60_000) * 60_000;
  const minuteCount = Math.max(1, Math.floor((endMinute - startMinute) / 60_000) + 1);

  // Distribute whole requests first; `minuteCount` can exceed `total`, in which
  // case only the leading `total` minutes receive a request.
  const base = Math.floor(total / minuteCount);
  let remainder = total - base * minuteCount;

  const counts: number[] = [];
  for (let i = 0; i < minuteCount; i++) {
    let count = base;
    if (remainder > 0) {
      count += 1;
      remainder -= 1;
    }
    counts.push(count);
  }

  const out: Array<{ timestamp: string; weight: number; requestCount: number }> = [];
  for (let i = 0; i < minuteCount; i++) {
    const count = counts[i]!;
    // A minute with 0 requests carries no usage — skip it entirely.
    if (count <= 0) continue;
    out.push({
      timestamp: new Date(startMinute + i * 60_000).toISOString(),
      // Share of the session's requests, used to apportion tokens and cost too.
      weight: count / total,
      requestCount: count,
    });
  }
  return out;
}

/**
 * Split `requests` across the minutes of [startMs, endMs], returning only the
 * request counts. Thin wrapper over {@link splitSpanWeights} for callers that
 * need nothing but the request distribution.
 */
export function splitRequestsOverSpan(
  requests: number,
  startMs: number,
  endMs: number,
): Array<{ timestamp: string; requestCount: number }> {
  return splitSpanWeights(requests, startMs, endMs).map(({ timestamp, requestCount }) => ({
    timestamp,
    requestCount,
  }));
}

/**
 * Apportion an additive quantity across split buckets without losing the total.
 *
 * Rounds each share to an integer, then distributes whatever is left over
 * (positive or negative) one unit at a time so the parts always sum back to
 * `total`. Used for token counts and cost so a split session neither duplicates
 * nor drops usage.
 */
export function apportion(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const t = Number.isFinite(total) ? total : 0;
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return weights.map(() => 0);

  const raw = weights.map((w) => (t * w) / sum);
  const out = raw.map((v) => Math.floor(v));
  let assigned = out.reduce((a, b) => a + b, 0);
  let diff = Math.round(t) - assigned;

  // Hand out the remainder one unit at a time, largest-fraction first so the
  // rounding error lands on the buckets that were closest to rounding up.
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  let k = 0;
  while (diff > 0 && order.length > 0) {
    out[order[k % order.length]!.i] += 1;
    diff -= 1;
    k += 1;
  }
  k = order.length - 1;
  while (diff < 0 && order.length > 0) {
    const idx = order[k % order.length]!.i;
    if (out[idx]! > 0) {
      out[idx] -= 1;
      diff += 1;
    }
    k -= 1;
    if (k < -order.length) break;
  }
  return out;
}

/**
 * Apportion a float quantity (cost) across weights, keeping the exact total.
 * Unlike {@link apportion} this does not force integers.
 */
export function apportionFloat(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const t = Number.isFinite(total) ? total : 0;
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return weights.map(() => 0);
  const out = weights.map((w) => (t * w) / sum);
  // Correct accumulated float error on the largest bucket so the sum is exact.
  const drift = t - out.reduce((a, b) => a + b, 0);
  if (out.length > 0) out[0] = out[0]! + drift;
  return out;
}

/** Token/cost fields that must be apportioned, never copied, when splitting. */
export interface SplittableUsage {
  requestCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  estimatedCost?: number;
}

/**
 * Split one aggregate usage row across the minutes it actually covered.
 *
 * Every additive field is APPORTIONED by each bucket's share of the requests,
 * never copied: copying a session's token/cost totals into N minute-buckets
 * would multiply them by N (a 3-call, 1200-input-token session over 60 minutes
 * became 3600 input tokens across the split rows before this was fixed).
 *
 * Returns one row per covered minute, each carrying its own timestamp and the
 * portion of every field it is responsible for; the parts sum back to the
 * original totals (request counts exactly, tokens exactly, cost to float
 * precision).
 */
export function splitUsageRow(
  row: SplittableUsage,
  requests: number,
  startMs: number,
  endMs: number,
): Array<{ timestamp: string } & SplittableUsage> {
  const buckets = splitSpanWeights(requests, startMs, endMs);
  if (buckets.length === 0) return [];
  const weights = buckets.map((b) => b.weight);

  const inParts = apportion(row.inputTokens ?? 0, weights);
  const outParts = apportion(row.outputTokens ?? 0, weights);
  const crParts = apportion(row.cacheReadTokens ?? 0, weights);
  const cwParts = apportion(row.cacheWriteTokens ?? 0, weights);
  const reasonParts =
    row.reasoningTokens != null ? apportion(row.reasoningTokens, weights) : null;
  const costParts =
    row.estimatedCost != null ? apportionFloat(row.estimatedCost, weights) : null;

  return buckets.map((bucket, i) => {
    const inputTokens = inParts[i] ?? 0;
    const outputTokens = outParts[i] ?? 0;
    const cacheReadTokens = crParts[i] ?? 0;
    const cacheWriteTokens = cwParts[i] ?? 0;
    const reasoningTokens = reasonParts ? (reasonParts[i] ?? 0) : undefined;
    const estimatedCost = costParts ? (costParts[i] ?? 0) : undefined;
    const piece: { timestamp: string } & SplittableUsage = {
      timestamp: bucket.timestamp,
      requestCount: bucket.requestCount,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      // Recompute the total so it always matches the apportioned parts.
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    };
    if (reasoningTokens != null) piece.reasoningTokens = reasoningTokens;
    if (estimatedCost != null) piece.estimatedCost = estimatedCost;
    return piece;
  });
}

export function extractTimestamp(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (c instanceof Date && !Number.isNaN(c.getTime())) return c.toISOString();
    if (typeof c === "string" && c.trim() && !Number.isNaN(Date.parse(c))) return new Date(c).toISOString();
    if (typeof c === "number" && Number.isFinite(c)) {
      // epoch ms / sec, or treat small integers as invalid for time
      if (c <= 0) continue;
      const ms = c > 1e12 ? c : c > 1e9 ? c * 1000 : c;
      if (ms < 1e11) continue; // reject non-epoch noise
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    if (c && typeof c === "object" && !(c instanceof Date)) {
      const o = c as Record<string, unknown>;
      for (const k of TIMESTAMP_KEYS) {
        const v = o[k];
        if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
        if (typeof v === "number" && Number.isFinite(v) && v > 0) {
          const ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : NaN;
          if (Number.isFinite(ms)) return new Date(ms).toISOString();
        }
      }
      if (o.time && typeof o.time === "object") {
        const t = o.time as Record<string, unknown>;
        if (typeof t.created === "string" && !Number.isNaN(Date.parse(t.created))) {
          return new Date(t.created).toISOString();
        }
      }
    }
  }
  // Prefer "unknown time" sentinel only as last resort — callers should pass file mtime
  return new Date().toISOString();
}
