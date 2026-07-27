/**
 * Live request-rate helpers.
 *
 * Scan-cache often collapses 9router/RouterLab to estimated daily rollups for totals.
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
 * Live per-call events from router mirrors (always fresh after VPS sync).
 * Used so RPM does not stay 0 when scan-cache only holds daily rollups.
 */
export async function loadHotMirrorLiveEvents(
  nowMs: number = Date.now(),
  /** How far back to keep (slightly larger than RPM window for lastRequestAt) */
  lookbackMinutes = 30,
): Promise<UsageEvent[]> {
  const start = nowMs - Math.max(1, lookbackMinutes) * 60_000;
  const out: UsageEvent[] = [];
  const seen = new Set<string>();

  for (const { agent, file } of hotHistoryFiles()) {
    const lines = await readJsonlTail(file);
    for (const line of lines) {
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row || typeof row !== "object") continue;
      const e = rowToLiveEvent(row as Record<string, unknown>, agent, file);
      if (!e) continue;
      const t = Date.parse(e.timestamp);
      if (!Number.isFinite(t) || t < start || t > nowMs + 5_000) continue;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
  }
  return out;
}

/**
 * Merge scan-cache + hot mirror live rows, then compute APM sliding-window RPM.
 * Also reports last live request time so UI can explain idle zeros.
 */
export async function computeDashboardLiveRate(
  cache: UsageEvent[],
  windowMinutes = 3,
  nowMs: number = Date.now(),
): Promise<ReturnType<typeof computeLiveRequestRate> & { lastRequestAt: string | null; lastRequestAgeSec: number | null }> {
  const hot = await loadHotMirrorLiveEvents(nowMs, Math.max(30, windowMinutes * 4));
  // Prefer cache live rows + hot mirror; computeLiveRequestRate skips estimated.
  const rate = computeLiveRequestRate([...cache, ...hot], windowMinutes, nowMs);

  let lastMs = 0;
  const consider = (e: UsageEvent) => {
    if (!e || e.estimated) return;
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t) || t > nowMs + 5_000) return;
    if (t > lastMs) lastMs = t;
  };
  for (const e of cache) consider(e);
  for (const e of hot) consider(e);

  return {
    ...rate,
    lastRequestAt: lastMs > 0 ? new Date(lastMs).toISOString() : null,
    lastRequestAgeSec: lastMs > 0 ? Math.max(0, Math.round((nowMs - lastMs) / 1000)) : null,
  };
}
