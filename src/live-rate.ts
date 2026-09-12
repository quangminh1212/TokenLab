/**
 * Live request-rate helpers.
 *
 * Scan-cache often collapses 9router/RouterLab/LiteLLM to estimated daily rollups for totals.
 * RPM must still count real per-call rows — read them from hot VPS mirror history tails.
 */
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { computeLiveRequestRate } from "./aggregate.js";
import type { UsageEvent } from "./types.js";
import { appDataDir, pathExists } from "./util.js";

function tokenlabDataRoot(): string {
  return process.env.TOKENLAB_DATA_DIR || process.env.XLAB_TOKEN_DATA_DIR || path.join(appDataDir(), "tokenlab");
}

/** Hot history files that update when remote routers serve traffic. */
function hotHistoryFiles(): Array<{ agent: string; file: string }> {
  const root = tokenlabDataRoot();
  return [
    { agent: "9router", file: path.join(root, "mirrors", "9router", "usage-history.jsonl") },
    { agent: "routerlab", file: path.join(root, "mirrors", "routerlab", "request-details.jsonl") },
    { agent: "routerlab", file: path.join(root, "mirrors", "routerlab", "usage-history.jsonl") },
    { agent: "routerlab", file: path.join(root, "mirrors", "xlabrouter", "request-details.jsonl") },
    { agent: "routerlab", file: path.join(root, "mirrors", "xlabrouter", "usage-history.jsonl") },
    { agent: "litellm", file: path.join(root, "mirrors", "litellm", "usage-history.jsonl") },
  ];
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read the last ~tailBytes of a jsonl file and return complete lines.
 */
async function readJsonlTail(file: string, tailBytes = 512 * 1024): Promise<string[]> {
  if (!(await pathExists(file))) return [];
  try {
    const st = await stat(file);
    if (st.size <= 0) return [];
    const start = Math.max(0, st.size - tailBytes);
    const fh = await open(file, "r");
    try {
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      const text = buf.toString("utf8");
      const lines = text.split(/\r?\n/);
      // First line may be partial when we mid-line seek
      if (start > 0 && lines.length) lines.shift();
      return lines.filter((l) => l.trim().length > 0);
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

function rowToLiveEvent(row: Record<string, unknown>, agent: string, source: string): UsageEvent | null {
  const tsRaw = row.timestamp ?? row.createdAt ?? row.created_at ?? row.ts ?? null;
  let ts: string | null = null;
  if (typeof tsRaw === "string" && tsRaw.trim() && !Number.isNaN(Date.parse(tsRaw))) {
    ts = new Date(tsRaw).toISOString();
  } else if (typeof tsRaw === "number" && Number.isFinite(tsRaw) && tsRaw > 0) {
    const ms = tsRaw > 1e12 ? tsRaw : tsRaw > 1e9 ? tsRaw * 1000 : NaN;
    if (Number.isFinite(ms)) ts = new Date(ms).toISOString();
  }
  if (!ts) return null;

  let tokensObj: Record<string, unknown> = {};
  if (row.tokens && typeof row.tokens === "object" && !Array.isArray(row.tokens)) {
    tokensObj = row.tokens as Record<string, unknown>;
  }
  const inputTokens = num(
    tokensObj.prompt_tokens ?? tokensObj.promptTokens ?? row.promptTokens ?? row.prompt_tokens ?? row.inputTokens,
  );
  const outputTokens = num(
    tokensObj.completion_tokens ??
      tokensObj.completionTokens ??
      row.completionTokens ??
      row.completion_tokens ??
      row.outputTokens,
  );
  const cacheReadTokens = num(tokensObj.cached_tokens ?? tokensObj.cache_read_tokens ?? row.cachedTokens);
  const cost = num(row.cost ?? row.estimatedCost ?? row.usd);
  // Zero-token stream probes do not count toward live RPM
  if (inputTokens + outputTokens + cacheReadTokens <= 0 && cost <= 0) return null;

  const nativeId = row.id != null ? String(row.id) : `${ts}:${inputTokens}:${outputTokens}`;
  return {
    id: `hotlive:${agent}:${nativeId}`,
    agent: agent as UsageEvent["agent"],
    model: typeof row.model === "string" ? row.model : null,
    timestamp: ts,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    totalTokens: inputTokens + outputTokens + cacheReadTokens,
    estimatedCost: cost > 0 ? cost : null,
    currency: "USD",
    pricingStatus: cost > 0 ? "priced" : "estimated",
    workspace: typeof row.provider === "string" ? `provider:${row.provider}` : null,
    sourcePath: source,
    estimated: false,
    requestCount: 1,
  };
}

/**
 * True for per-call rows suitable for RECENT EVENTS.
 * False for estimated daily/model rollups (e.g. 298M tokens · 3946 requests).
 *
 * Allows estimated *single-turn* rows (Antigravity brain transcripts, Grok
 * chat text estimates) so local agents without proxy counters still appear
 * in history next to real proxy/router rows.
 */
export function isLiveRequestEvent(e: UsageEvent | null | undefined): boolean {
  if (!e || typeof e.timestamp !== "string") return false;
  const rc = e.requestCount;
  // Fat multi-request packs are rollups, not a single API call
  if (typeof rc === "number" && Number.isFinite(rc) && rc > 5) return false;

  if (e.estimated) {
    // Estimated day/model blobs: either multi-RQ or absurd token totals
    if (typeof rc === "number" && Number.isFinite(rc) && rc > 1) return false;
    const total =
      (Number(e.totalTokens) || 0) ||
      (Number(e.inputTokens) || 0) +
        (Number(e.outputTokens) || 0) +
        (Number(e.cacheReadTokens) || 0) +
        (Number(e.cacheWriteTokens) || 0);
    // Single-turn estimates stay well below this; daily floors do not
    if (total > 2_000_000) return false;
    // Zero-token estimated shells are noise
    if (total <= 0 && !(Number(e.estimatedCost) > 0)) return false;
    return true;
  }
  return true;
}

/** Process-local hot-mirror cache — period switches must not re-read multi-MB jsonl each time. */
let hotMirrorCache: {
  at: number;
  lookbackMinutes: number;
  tailBytes: number;
  events: UsageEvent[];
} | null = null;

const HOT_MIRROR_TTL_MS = 3_000;

/**
 * Live per-call events from router mirrors (always fresh after VPS sync).
 * Used so RPM / RECENT EVENTS do not show only daily rollup blobs.
 *
 * Results are memoized ~3s so dashboard double-fetch (stats×2 + events) shares one disk pass.
 */
export async function loadHotMirrorLiveEvents(
  nowMs: number = Date.now(),
  /** How far back to keep (slightly larger than RPM window for lastRequestAt) */
  lookbackMinutes = 30,
  tailBytes = 512 * 1024,
): Promise<UsageEvent[]> {
  const mins = Math.max(1, lookbackMinutes);
  const bytes = Math.max(64 * 1024, tailBytes);
  // Reuse if same-or-wider prior read is still fresh
  if (
    hotMirrorCache &&
    nowMs - hotMirrorCache.at < HOT_MIRROR_TTL_MS &&
    hotMirrorCache.lookbackMinutes >= mins &&
    hotMirrorCache.tailBytes >= bytes
  ) {
    const start = nowMs - mins * 60_000;
    return hotMirrorCache.events.filter((e) => {
      const t = Date.parse(e.timestamp);
      return Number.isFinite(t) && t >= start && t <= nowMs + 5_000;
    });
  }

  const start = nowMs - mins * 60_000;
  const out: UsageEvent[] = [];
  const seen = new Set<string>();

  for (const { agent, file } of hotHistoryFiles()) {
    const lines = await readJsonlTail(file, bytes);
    for (const line of lines) {
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row || typeof row !== "object") continue;
      const e = rowToLiveEvent(row as Record<string, unknown>, agent, file);
      if (!e || !isLiveRequestEvent(e)) continue;
      const t = Date.parse(e.timestamp);
      if (!Number.isFinite(t) || t < start || t > nowMs + 5_000) continue;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
  }
  hotMirrorCache = { at: nowMs, lookbackMinutes: mins, tailBytes: bytes, events: out };
  return out;
}

/**
 * Build a newest-first RECENT EVENTS list: live cache rows + hot router history.
 * Daily estimated rollups (multi-million-token "events") are never included.
 *
 * Optimized for dashboard period switches: UI only shows ~25 rows, so we never
 * re-parse multi-day / multi-MB history tails for every 30D/All click.
 */
export async function buildRecentLiveEvents(
  cache: UsageEvent[],
  opts: {
    limit?: number;
    sinceMs?: number | null;
    untilMs?: number | null;
    agent?: string | null;
    nowMs?: number;
    /** Parallel ms index (ascending) when cache is time-sorted */
    timestampsMs?: number[] | null;
  } = {},
): Promise<UsageEvent[]> {
  const limit = Math.min(1000, Math.max(1, opts.limit ?? 50));
  const nowMs = opts.nowMs ?? Date.now();
  const sinceMs = opts.sinceMs ?? null;
  const untilMs = opts.untilMs ?? null;
  // RECENT list needs newest rows only — cap hot lookback to 24h and modest tail.
  // (Was 7d + 1.5MB×6 files on every 30D click → multi-second freezes.)
  const lookbackMin = Math.min(
    24 * 60,
    sinceMs != null && Number.isFinite(sinceMs)
      ? Math.max(60, Math.ceil((nowMs - sinceMs) / 60_000) + 15)
      : 6 * 60,
  );
  const hot = await loadHotMirrorLiveEvents(nowMs, lookbackMin, 256 * 1024);

  const inPeriod = (e: UsageEvent): boolean => {
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t)) return false;
    if (sinceMs != null && t < sinceMs) return false;
    if (untilMs != null && t > untilMs) return false;
    if (opts.agent && e.agent !== opts.agent) return false;
    return true;
  };

  const byKey = new Map<string, UsageEvent>();
  const keyOf = (e: UsageEvent): string => {
    // Collapse twin cache vs mirror copies of the same call
    const ts = (e.timestamp || "").slice(0, 19);
    return [
      e.agent,
      ts,
      e.model || "",
      e.inputTokens || 0,
      e.outputTokens || 0,
    ].join("|");
  };

  // Prefer reverse scan of sorted cache (newest first) — stop once we have enough.
  const ts = opts.timestampsMs;
  const sortedAsc = Array.isArray(ts) && ts.length === cache.length && cache.length > 0;
  const need = Math.max(limit * 4, 80);
  if (sortedAsc) {
    for (let i = cache.length - 1; i >= 0 && byKey.size < need; i--) {
      const e = cache[i]!;
      if (!isLiveRequestEvent(e) || !inPeriod(e)) continue;
      byKey.set(keyOf(e), e);
    }
  } else {
    for (const e of cache) {
      if (!isLiveRequestEvent(e) || !inPeriod(e)) continue;
      byKey.set(keyOf(e), e);
    }
  }
  for (const e of hot) {
    if (!inPeriod(e)) continue;
    const k = keyOf(e);
    if (!byKey.has(k)) byKey.set(k, e);
  }

  return [...byKey.values()]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, limit);
}

/**
 * Merge recent scan-cache + hot mirror live rows, then compute APM sliding-window RPM.
 * Also reports last live request time so UI can explain idle zeros.
 *
 * Critical: do NOT scan the full multi-day cache on every /api/stats — that blocked
 * the event loop for seconds and made period switches feel frozen.
 */
export async function computeDashboardLiveRate(
  cache: UsageEvent[],
  windowMinutes = 3,
  nowMs: number = Date.now(),
  opts: { timestampsMs?: number[] | null } = {},
): Promise<ReturnType<typeof computeLiveRequestRate> & { lastRequestAt: string | null; lastRequestAgeSec: number | null }> {
  const mins = Math.max(1, Math.min(60, Math.floor(windowMinutes) || 3));
  // Hot mirrors: short lookback only (RPM is 3m window)
  const hot = await loadHotMirrorLiveEvents(nowMs, Math.max(30, mins * 4), 256 * 1024);

  // Only feed computeLiveRequestRate rows that can fall inside the window (+skew).
  // Spreading 50k+ full-history events was the period-switch bottleneck.
  const windowStart = nowMs - mins * 60_000 - 5_000;
  const recent: UsageEvent[] = [];
  const ts = opts.timestampsMs;
  const sortedAsc = Array.isArray(ts) && ts.length === cache.length && cache.length > 0;

  let lastMs = 0;
  const considerLast = (e: UsageEvent) => {
    if (!isLiveRequestEvent(e)) return;
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t) || t > nowMs + 5_000) return;
    if (t > lastMs) lastMs = t;
  };

  if (sortedAsc) {
    // Ascending: walk from the end for recent window + lastRequestAt in one pass
    for (let i = cache.length - 1; i >= 0; i--) {
      const t = ts![i]!;
      if (!Number.isFinite(t) || t > nowMs + 5_000) continue;
      if (t > lastMs) {
        const e = cache[i]!;
        if (isLiveRequestEvent(e)) lastMs = t;
      }
      if (t < windowStart) break; // older than rate window
      const e = cache[i]!;
      if (!e.estimated) recent.push(e);
    }
  } else {
    for (const e of cache) {
      considerLast(e);
      if (e.estimated) continue;
      const t = Date.parse(e.timestamp);
      if (Number.isFinite(t) && t >= windowStart && t <= nowMs + 5_000) recent.push(e);
    }
  }
  for (const e of hot) {
    considerLast(e);
    recent.push(e);
  }

  const rate = computeLiveRequestRate(recent, mins, nowMs);

  return {
    ...rate,
    lastRequestAt: lastMs > 0 ? new Date(lastMs).toISOString() : null,
    lastRequestAgeSec: lastMs > 0 ? Math.max(0, Math.round((nowMs - lastMs) / 1000)) : null,
  };
}
