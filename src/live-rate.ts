/**
 * Live request-rate helpers.
 *
 * Scan-cache often collapses 9router/RouterLab/LiteLLM to estimated daily rollups for totals.
 * RPM must still count real per-call rows — read them from hot VPS mirror history tails.
 */
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { computeLiveRequestRate } from "./aggregate.js";
import { agentPathSpecs } from "./agents/index.js";
import type { UsageEvent } from "./types.js";
import { appDataDir } from "./util.js";

function tokenlabDataRoot(): string {
  return process.env.TOKENLAB_DATA_DIR || process.env.XLAB_TOKEN_DATA_DIR || path.join(appDataDir(), "tokenlab");
}

/** Hot history files that update when remote routers serve traffic. */
function hotHistoryFiles(): Array<{ agent: string; file: string }> {
  // Keep this list in sync with the router agent roots instead of assuming
  // only the current TokenLab mirror folder. Legacy mirrors, explicit agent
  // directories, and a local/VPS checkout can all be the freshest source.
  const historyNames = [
    "request-details.jsonl",
    "usage-history.jsonl",
    "request-details.json",
    "usage-history.json",
    "usageHistory.json",
    "usageData.json",
    "usage.json",
    "db.json",
    "db/data.sqlite",
    "data.sqlite",
    "db.sqlite",
  ];
  const out: Array<{ agent: string; file: string }> = [];
  const seen = new Set<string>();
  const hotAgents = new Set(["9router", "routerlab", "xlabrouter", "litellm"]);
  const configuredRoot =
    process.env.TOKENLAB_DATA_DIR?.trim() || process.env.XLAB_TOKEN_DATA_DIR?.trim() || "";
  const configuredKey = configuredRoot
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
  const isConfiguredPath = (root: string): boolean => {
    if (!configuredKey) return true;
    const key = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return key === configuredKey || key.startsWith(`${configuredKey}/`);
  };

  for (const spec of agentPathSpecs()) {
    const agent = String(spec.id);
    if (!hotAgents.has(agent)) continue;
    for (const root of spec.roots || []) {
      if (!root || !isConfiguredPath(root)) continue;
      for (const name of historyNames) {
        const file = path.join(root, name);
        const key = `${agent}\0${file.replace(/\\/g, "/").toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ agent: agent === "xlabrouter" ? "routerlab" : agent, file });
      }
    }
  }

  // The explicit fallback also keeps tests and portable installs working when
  // an agent module changes its roots before the hot reader is updated.
  const root = tokenlabDataRoot();
  for (const [agent, aliases] of [
    ["9router", ["9router"]],
    ["routerlab", ["routerlab", "xlabrouter"]],
    ["litellm", ["litellm"]],
  ] as Array<[string, string[]]>) {
    for (const alias of aliases) {
      for (const name of historyNames) {
        const file = path.join(root, "mirrors", alias, name);
        const key = `${agent}\0${file.replace(/\\/g, "/").toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ agent, file });
      }
    }
  }
  return out;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

type HotFileStat = { agent: string; file: string; size: number; mtimeMs: number };

/** Read one byte range from a file. */
async function readRange(file: string, start: number, length: number): Promise<string> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, length));
    const result = await fh.read(buf, 0, buf.length, Math.max(0, start));
    return buf.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

function completeJsonlLines(text: string, mode: "head" | "tail" | "full"): string[] {
  let value = text;
  if (mode === "tail") {
    // The first line can begin before the selected range.
    const firstNl = value.indexOf("\n");
    if (firstNl >= 0) value = value.slice(firstNl + 1);
  } else if (mode === "head") {
    // The last line can continue beyond the selected range.
    const lastNl = value.lastIndexOf("\n");
    if (lastNl >= 0) value = value.slice(0, lastNl);
  }
  return value.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

/**
 * Read both edges of a JSONL file. Most exports append oldest→newest, but
 * request-details exports have also been written newest→oldest. Reading only
 * the tail silently misses the newest rows in the latter format.
 */
async function readJsonlEdges(
  file: string,
  size: number,
  edgeBytes = 512 * 1024,
): Promise<string[]> {
  if (size <= 0) return [];
  // The mirror sync keeps normal request exports small (a few MB). Read
  // those completely so a 24h period is not missing the middle of the file;
  // edge sampling is only the safety valve for unexpectedly large histories.
  if (size <= 8 * 1024 * 1024) {
    return completeJsonlLines(await readRange(file, 0, size), "full");
  }
  const head = completeJsonlLines(await readRange(file, 0, edgeBytes), "head");
  const tail = completeJsonlLines(
    await readRange(file, Math.max(0, size - edgeBytes), edgeBytes),
    "tail",
  );
  return [...head, ...tail];
}

function historyRows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const o = data as Record<string, unknown>;
  for (const key of [
    "history",
    "records",
    "events",
    "usageHistory",
    "requestDetails",
    "request_details",
  ]) {
    if (Array.isArray(o[key])) return o[key] as unknown[];
  }
  for (const key of ["usageData", "usage", "data"]) {
    const nested = o[key];
    const rows = historyRows(nested);
    if (rows.length > 0) return rows;
  }
  return [];
}

/** Read the newest rows from a router SQLite mirror without blocking on a full scan. */
async function readSqliteRows(file: string): Promise<unknown[]> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      try {
        return db
          .prepare(
            `SELECT id, timestamp, provider, model, connectionId, apiKey, endpoint,
                    promptTokens, completionTokens, cost, status, tokens, meta
             FROM usageHistory
             ORDER BY id DESC
             LIMIT 5000`,
          )
          .all() as Array<Record<string, unknown>>;
      } catch {
        try {
          return db
            .prepare(`SELECT * FROM usageHistory ORDER BY rowid DESC LIMIT 5000`)
            .all() as Array<Record<string, unknown>>;
        } catch {
          return [];
        }
      }
    } finally {
      db.close();
    }
  } catch {
    // SQLite may be locked, unavailable on an older Node runtime, or not a
    // usage database. JSON/JSONL mirrors remain the normal fast path.
    return [];
  }
}

/** Read a hot history source without loading large JSONL histories in full. */
async function readHotRows(file: string, size: number, edgeBytes: number): Promise<unknown[]> {
  try {
    const lower = file.toLowerCase();
    if (lower.endsWith(".sqlite") || lower.endsWith(".db")) {
      return await readSqliteRows(file);
    }
    if (lower.endsWith(".jsonl")) {
      const rows: unknown[] = [];
      for (const line of await readJsonlEdges(file, size, edgeBytes)) {
        try {
          rows.push(JSON.parse(line));
        } catch {
          // Ignore a concurrently-written or malformed row.
        }
      }
      return rows;
    }
    // db.json / usageData.json are compact mirror snapshots. Do not turn an
    // unexpectedly huge JSON snapshot into an event-loop pause.
    if (size > 8 * 1024 * 1024) return [];
    return historyRows(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return [];
  }
}

async function hotFilesWithStats(): Promise<HotFileStat[]> {
  const entries = hotHistoryFiles();
  const found = await Promise.all(
    entries.map(async (entry): Promise<HotFileStat | null> => {
      try {
        const info = await stat(entry.file);
        if (!info.isFile() || info.size <= 0) return null;
        return { agent: entry.agent, file: entry.file, size: info.size, mtimeMs: info.mtimeMs };
      } catch {
        // Candidate source does not exist or is being replaced by a sync.
        return null;
      }
    }),
  );
  return found.filter((entry): entry is HotFileStat => entry != null);
}

function rowToLiveEvent(row: Record<string, unknown>, agent: string, source: string): UsageEvent | null {
  const tsRaw = row.timestamp ?? row.createdAt ?? row.created_at ?? row.date ?? row.ts ?? null;
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
  } else if (typeof row.tokens === "string" && row.tokens.trim()) {
    try {
      const parsed = JSON.parse(row.tokens) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        tokensObj = parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore an incomplete token blob while the source is being written.
    }
  }
  const inputTokens = num(
    tokensObj.prompt_tokens ??
      tokensObj.promptTokens ??
      tokensObj.input_tokens ??
      tokensObj.inputTokens ??
      row.promptTokens ??
      row.prompt_tokens ??
      row.inputTokens ??
      row.input_tokens,
  );
  const outputTokens = num(
    tokensObj.completion_tokens ??
      tokensObj.completionTokens ??
      tokensObj.output_tokens ??
      tokensObj.outputTokens ??
      row.completionTokens ??
      row.completion_tokens ??
      row.outputTokens ??
      row.output_tokens,
  );
  const promptDetails =
    tokensObj.prompt_tokens_details && typeof tokensObj.prompt_tokens_details === "object"
      ? (tokensObj.prompt_tokens_details as Record<string, unknown>)
      : tokensObj.promptTokensDetails && typeof tokensObj.promptTokensDetails === "object"
        ? (tokensObj.promptTokensDetails as Record<string, unknown>)
        : tokensObj.input_tokens_details && typeof tokensObj.input_tokens_details === "object"
          ? (tokensObj.input_tokens_details as Record<string, unknown>)
          : null;
  const cacheReadTokens = num(
    tokensObj.cached_tokens ??
      tokensObj.cache_read_tokens ??
      tokensObj.cache_read_input_tokens ??
      tokensObj.cacheReadTokens ??
      tokensObj.cachedReadTokens ??
      tokensObj.cached_content_token_count ??
      promptDetails?.cached_tokens ??
      promptDetails?.cache_read_tokens ??
      promptDetails?.cache_read_input_tokens ??
      promptDetails?.cachedTokens ??
      row.cachedTokens ??
      row.cached_tokens ??
      row.cachedReadTokens ??
      row.cacheReadTokens ??
      row.cache_read_tokens ??
      row.cache_read_input_tokens,
  );
  const cacheWriteTokens = num(
    tokensObj.cache_write_tokens ??
      tokensObj.cache_creation_input_tokens ??
      tokensObj.cache_creation_tokens ??
      tokensObj.cacheWriteTokens ??
      promptDetails?.cache_write_tokens ??
      promptDetails?.cache_creation_input_tokens ??
      row.cache_creation_tokens ??
      row.cacheWriteTokens ??
      row.cache_write_tokens ??
      row.cache_creation_input_tokens,
  );
  const cost = num(
    row.cost ??
      row.estimatedCost ??
      row.usd ??
      row.routerCost ??
      (row.meta && typeof row.meta === "object"
        ? (row.meta as Record<string, unknown>).cost ??
          (row.meta as Record<string, unknown>).estimatedCost
        : undefined),
  );
  // Zero-token stream probes do not count toward live RPM
  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0 && cost <= 0) return null;

  const nativeId =
    row.id != null
      ? String(row.id)
      : row.requestId != null
        ? String(row.requestId)
        : row.request_id != null
          ? String(row.request_id)
          : row.requestID != null
            ? String(row.requestID)
            : row.traceId != null
              ? String(row.traceId)
              : row.rowid != null
                ? String(row.rowid)
              : `${ts}:${inputTokens}:${outputTokens}`;
  const requestCountRaw = num(row.requests ?? row.requestCount ?? row.request_count);
  const requestCount = requestCountRaw > 0 ? Math.floor(requestCountRaw) : 1;
  return {
    id: `hotlive:${agent}:${nativeId}`,
    agent: agent as UsageEvent["agent"],
    model:
      typeof row.model === "string"
        ? row.model
        : typeof row.rawModel === "string"
          ? row.rawModel
          : typeof row.model_group === "string"
            ? row.model_group
            : null,
    timestamp: ts,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    estimatedCost: cost > 0 ? cost : null,
    currency: "USD",
    pricingStatus: cost > 0 ? "priced" : "estimated",
    workspace: typeof row.provider === "string" ? `provider:${row.provider}` : null,
    sourcePath: source,
    estimated: false,
    requestCount,
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
  files: HotFileStat[];
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
  const files = await hotFilesWithStats();
  const sameFiles = (a: HotFileStat[], b: HotFileStat[]): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const left = a[i]!;
      const right = b[i]!;
      if (
        left.agent !== right.agent ||
        left.file !== right.file ||
        left.size !== right.size ||
        left.mtimeMs !== right.mtimeMs
      ) {
        return false;
      }
    }
    return true;
  };
  // Reuse only when the source signatures are unchanged. A TTL alone made a
  // newly appended request invisible for up to 3s (and a snapshot replacement
  // could remain stale for the whole TTL).
  if (
    hotMirrorCache &&
    nowMs - hotMirrorCache.at < HOT_MIRROR_TTL_MS &&
    hotMirrorCache.lookbackMinutes >= mins &&
    hotMirrorCache.tailBytes >= bytes &&
    sameFiles(hotMirrorCache.files, files)
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

  for (const { agent, file, size } of files) {
    const rows = await readHotRows(file, size, bytes);
    for (const row of rows) {
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
  hotMirrorCache = { at: nowMs, lookbackMinutes: mins, tailBytes: bytes, files, events: out };
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
  // RECENT list normally needs newest rows only — keep the first pass cheap.
  // If the selected period has fewer than `limit` real rows in scan-cache,
  // expand below so a sparse/partial scan does not hide older requests that
  // still belong to the selected period.
  const requestedLookbackMin =
    sinceMs != null && Number.isFinite(sinceMs)
      ? Math.max(60, Math.ceil((nowMs - sinceMs) / 60_000) + 15)
      : 6 * 60;
  const fastLookbackMin = Math.min(24 * 60, requestedLookbackMin);
  const hot = await loadHotMirrorLiveEvents(nowMs, fastLookbackMin, 256 * 1024);

  const inPeriod = (e: UsageEvent): boolean => {
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t)) return false;
    // Daily rollups from older cache versions can carry a future anchor. Do
    // this before applying the page limit; the UI also filters future rows,
    // but filtering only there can make valid requests fall off the page.
    if (t > nowMs + 5_000) return false;
    if (sinceMs != null && t < sinceMs) return false;
    if (untilMs != null && t > untilMs) return false;
    if (opts.agent && e.agent !== opts.agent) return false;
    return true;
  };

  const byKey = new Map<string, UsageEvent>();
  const keyOf = (e: UsageEvent): string => {
    // Collapse twin cache vs mirror copies of the same call
    // at millisecond precision. Second precision dropped legitimate bursts
    // from the same model with equal token counts.
    const parsed = Date.parse(e.timestamp || "");
    const ts = Number.isFinite(parsed)
      ? new Date(parsed).toISOString().slice(0, 23)
      : e.timestamp || "";
    const agent = e.agent === "xlabrouter" ? "routerlab" : e.agent;
    return [
      agent,
      ts,
      e.model || "",
      e.inputTokens || 0,
      e.outputTokens || 0,
    ].join("|");
  };

  const tokenWeight = (e: UsageEvent): number =>
    (Number(e.inputTokens) || 0) +
    (Number(e.outputTokens) || 0) +
    (Number(e.cacheReadTokens) || 0) +
    (Number(e.cacheWriteTokens) || 0);
  const put = (e: UsageEvent): void => {
    const key = keyOf(e);
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, e);
      return;
    }
    const previousTs = Date.parse(previous.timestamp);
    const nextTs = Date.parse(e.timestamp);
    // Reverse cache traversal sees newest first. Never let an older duplicate
    // overwrite it; a same-time mirror row may still win when it is richer.
    if (
      nextTs > previousTs ||
      (nextTs === previousTs && tokenWeight(e) > tokenWeight(previous))
    ) {
      byKey.set(key, e);
    }
  };

  // Prefer reverse scan of sorted cache (newest first) — stop once we have enough.
  const ts = opts.timestampsMs;
  const sortedAsc = Array.isArray(ts) && ts.length === cache.length && cache.length > 0;
  const need = Math.max(limit * 4, 80);
  if (sortedAsc) {
    for (let i = cache.length - 1; i >= 0 && byKey.size < need; i--) {
      const e = cache[i]!;
      if (!isLiveRequestEvent(e) || !inPeriod(e)) continue;
      put(e);
    }
  } else {
    for (const e of cache) {
      if (!isLiveRequestEvent(e) || !inPeriod(e)) continue;
      put(e);
    }
  }
  const addHot = (rows: UsageEvent[]): void => {
    for (const e of rows) {
      if (!inPeriod(e)) continue;
      put(e);
    }
  };
  addHot(hot);

  // A 30D/All view with a thin cache can legitimately have its latest request
  // older than 24h. Only pay for the wider mirror edge read when the fast pass
  // did not already provide enough rows for the requested page.
  if (byKey.size < limit && requestedLookbackMin > fastLookbackMin) {
    const extendedLookbackMin = Math.min(30 * 24 * 60, requestedLookbackMin);
    const extended = await loadHotMirrorLiveEvents(nowMs, extendedLookbackMin, 1024 * 1024);
    addHot(extended);
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
