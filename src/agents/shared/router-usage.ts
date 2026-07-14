import path from "node:path";
import { applyPricing } from "../../pricing.js";
import type { AgentId, UsageEvent } from "../../types.js";
import { normalizeModelName, num, pathExists, readText, stableId } from "../../util.js";

/**
 * Shared parser for 9router / xlabrouter local data.
 *
 * International-style storage preference (aggregate, not per-request):
 *  1. usage-daily.json / usageDaily / dailySummary  ← primary
 *  2. byModel within each day when complete
 *  3. Per-request history (jsonl / usageHistory) only as fallback when no daily
 *
 * Why: request-level history (usage-history.jsonl) grows to tens of MB and is
 * redundant once daily rollups exist. Daily totals are the source of truth for
 * billing-style dashboards.
 */
export async function parseRouterUsage(
  roots: string[],
  agent: AgentId,
): Promise<UsageEvent[]> {
  const eventLevel: UsageEvent[] = [];
  const seen = new Set<string>();
  const dailyMaps: Array<{ source: string; daily: Record<string, unknown> }> = [];

  const pushEvents = (batch: UsageEvent[]) => {
    for (const e of batch) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      eventLevel.push(e);
    }
  };

  for (const root of roots) {
    if (!(await pathExists(root))) continue;

    let hasDailyForRoot = false;

    // --- A) Daily rollups first (canonical) ---
    for (const dbRel of ["db/data.sqlite", "data.sqlite", "db.sqlite"]) {
      const dbPath = path.join(root, dbRel);
      if (!(await pathExists(dbPath))) continue;
      const daily = await parseSqliteDaily(dbPath);
      if (daily) {
        dailyMaps.push({ source: dbPath + "#usageDaily", daily });
        hasDailyForRoot = true;
      }
    }

    const usagePath = path.join(root, "usage.json");
    if (await pathExists(usagePath)) {
      const daily = await readDailySummaryFromJsonFile(usagePath);
      if (daily) {
        dailyMaps.push({ source: usagePath, daily });
        hasDailyForRoot = true;
      }
    }

    const dbJsonPath = path.join(root, "db.json");
    if (await pathExists(dbJsonPath)) {
      const daily = await readDailySummaryFromDbJson(dbJsonPath);
      if (daily) {
        dailyMaps.push({ source: dbJsonPath, daily });
        hasDailyForRoot = true;
      }
    }

    const usageDataPath = path.join(root, "usageData.json");
    if (await pathExists(usageDataPath)) {
      const daily = await readDailySummaryFromJsonFile(usageDataPath);
      if (daily) {
        dailyMaps.push({ source: usageDataPath, daily });
        hasDailyForRoot = true;
      }
    }

    const dailyPath = path.join(root, "usage-daily.json");
    if (await pathExists(dailyPath)) {
      const daily = await readDailySummaryStandalone(dailyPath);
      if (daily) {
        dailyMaps.push({ source: dailyPath, daily });
        hasDailyForRoot = true;
      }
    }

    // --- B) Per-request history ---
    // Always try compact history so today is not missing while daily rollup is stale.
    // Still skip huge jsonl when daily already covers that root (avoid multi‑MB reread).
    for (const dbRel of ["db/data.sqlite", "data.sqlite", "db.sqlite"]) {
      const dbPath = path.join(root, dbRel);
      if (!(await pathExists(dbPath))) continue;
      // Cap SQLite history — used to fill gaps vs daily
      pushEvents(await parseSqliteUsage(dbPath, agent, hasDailyForRoot ? 2_000 : 20_000));
    }

    if (!hasDailyForRoot && (await pathExists(usagePath))) {
      pushEvents(await parseUsageJsonFile(usagePath, agent));
    }
    if (!hasDailyForRoot && (await pathExists(dbJsonPath))) {
      pushEvents(await parseDbJsonUsage(dbJsonPath, agent));
    }
    if (!hasDailyForRoot && (await pathExists(usageDataPath))) {
      pushEvents(await parseUsageJsonFile(usageDataPath, agent));
    }

    // Prefer compact JSON history over multi‑MB jsonl when both exist
    let loadedCompactHistory = false;
    for (const name of ["usage-history.json", "usageHistory.json", "request-details.json"]) {
      const p = path.join(root, name);
      if (!(await pathExists(p))) continue;
      pushEvents(await parseHistoryExport(p, agent));
      loadedCompactHistory = true;
    }
    if (!loadedCompactHistory) {
      for (const name of ["usage-history.jsonl", "request-details.jsonl"]) {
        const p = path.join(root, name);
        if (!(await pathExists(p))) continue;
        try {
          const { stat } = await import("node:fs/promises");
          const st = await stat(p);
          // With daily rollups: only small files (fresh tail). Without daily: allow larger.
          const maxBytes = hasDailyForRoot ? 2 * 1024 * 1024 : 12 * 1024 * 1024;
          if (st.size > maxBytes) {
            // Still read a small tail so RECENT EVENTS can stamp daily rows with real last-seen times
            // (full multi‑MB jsonl is skipped when daily already covers totals).
            if (hasDailyForRoot) {
              pushEvents(await parseHistoryExportTail(p, agent, 512 * 1024));
            }
            continue;
          }
        } catch {
          // ignore stat errors
        }
        pushEvents(await parseHistoryExport(p, agent));
      }
    }
  }

  return reconcileEventsAndDaily(eventLevel, dailyMaps, agent);
}

/**
 * Daily-first reconciliation:
 *  - If a day has a rollup → use daily synthetic events only (ignore per-request for that day)
 *  - Else keep per-request events for that day
 */
function reconcileEventsAndDaily(
  eventLevel: UsageEvent[],
  dailyMaps: Array<{ source: string; daily: Record<string, unknown> }>,
  agent: AgentId,
): UsageEvent[] {
  // Merge all daily maps (richer request count wins)
  const mergedDaily = new Map<string, { source: string; day: Record<string, unknown> }>();
  for (const { source, daily } of dailyMaps) {
    for (const [dateKey, raw] of Object.entries(daily)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
      if (!raw || typeof raw !== "object") continue;
      const day = raw as Record<string, unknown>;
      const prev = mergedDaily.get(dateKey);
      const prevReq = prev ? num(prev.day.requests) : -1;
      const nextReq = num(day.requests);
      if (!prev || nextReq >= prevReq) {
        mergedDaily.set(dateKey, { source, day });
      }
    }
  }

  const eventsByDay = new Map<string, UsageEvent[]>();
  const noDay: UsageEvent[] = [];
  for (const e of eventLevel) {
    const day = (e.timestamp || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      noDay.push(e);
      continue;
    }
    const list = eventsByDay.get(day) || [];
    list.push(e);
    eventsByDay.set(day, list);
  }

  const out: UsageEvent[] = [...noDay];
  const allDays = new Set<string>([...eventsByDay.keys(), ...mergedDaily.keys()]);

  for (const dateKey of [...allDays].sort()) {
    const dayEvents = eventsByDay.get(dateKey) || [];
    const daily = mergedDaily.get(dateKey);

    // Canonical: daily rollup wins whenever present
    if (daily) {
      out.push(...expandOneDay(dateKey, daily.day, agent, daily.source, dayEvents));
      continue;
    }

    out.push(...dayEvents);
  }

  return out;
}

/**
 * Pick a stable, non-future timestamp for a synthetic daily rollup event.
 * Prefer real request times for that day; never invent noon-UTC while it is still in the future
 * (that made RECENT EVENTS stuck on "Just now" all morning local time).
 */
function syntheticDailyTimestamp(
  dateKey: string,
  preferred?: string | null,
): string {
  if (preferred) {
    const t = Date.parse(preferred);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  const noon = Date.parse(`${dateKey}T12:00:00.000Z`);
  const now = Date.now();
  // Mid-day anchor only when it is already in the past (completed mornings UTC / past days)
  if (Number.isFinite(noon) && noon <= now) {
    return `${dateKey}T12:00:00.000Z`;
  }
  // Day still in progress before noon UTC — use start of day so timeAgo progresses
  return `${dateKey}T00:00:00.000Z`;
}

/** Latest ISO timestamp among events (lexicographic ISO works for same format). */
function latestTimestamp(events: UsageEvent[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const e of events) {
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t)) continue;
    if (t >= bestMs) {
      bestMs = t;
      best = e.timestamp;
    }
  }
  return best;
}

function latestTimestampForModel(events: UsageEvent[], model: string | null): string | null {
  if (!model) return latestTimestamp(events);
  const matched = events.filter(
    (e) => (normalizeModelName(e.model) || e.model || "") === model,
  );
  return latestTimestamp(matched.length ? matched : events);
}

async function parseSqliteUsage(
  dbPath: string,
  agent: AgentId,
  limit = 5_000,
): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const lim = Math.max(100, Math.min(20_000, Math.floor(limit)));
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      let rows: Array<Record<string, unknown>> = [];
      try {
        rows = db
          .prepare(
            `SELECT id, timestamp, provider, model, connectionId, apiKey, endpoint,
                    promptTokens, completionTokens, cost, status, tokens, meta
             FROM usageHistory
             ORDER BY id DESC
             LIMIT ${lim}`,
          )
          .all() as Array<Record<string, unknown>>;
      } catch {
        // older / alternate schema
        try {
          rows = db
            .prepare(`SELECT * FROM usageHistory ORDER BY rowid DESC LIMIT ${lim}`)
            .all() as Array<Record<string, unknown>>;
        } catch {
          rows = [];
        }
      }

      for (const row of rows) {
        const e = rowToEvent(row, agent, dbPath, String(row.id ?? row.rowid ?? ""));
        if (e) events.push(e);
      }
    } finally {
      db.close();
    }
  } catch {
    // node:sqlite unavailable or locked
  }
  return events;
}

/** Read usageDaily table → dateKey map of day payloads. */
async function parseSqliteDaily(dbPath: string): Promise<Record<string, unknown> | null> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(`SELECT dateKey, data FROM usageDaily`)
        .all() as Array<{ dateKey: string; data: string }>;
      const daily: Record<string, unknown> = {};
      for (const row of rows) {
        if (!row?.dateKey) continue;
        try {
          const parsed = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
          if (parsed && typeof parsed === "object") daily[row.dateKey] = parsed;
        } catch {
          // skip bad day
        }
      }
      return Object.keys(daily).length ? daily : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

async function parseUsageJsonFile(file: string, agent: AgentId): Promise<UsageEvent[]> {
  const text = await readText(file);
  if (!text) return [];
  try {
    const data = JSON.parse(text) as unknown;
    const history = extractHistoryArray(data);
    return historyToEvents(history, agent, file);
  } catch {
    return [];
  }
}

async function parseDbJsonUsage(file: string, agent: AgentId): Promise<UsageEvent[]> {
  const text = await readText(file);
  if (!text) return [];
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const usageData = (data.usageData ?? data.usage ?? null) as Record<string, unknown> | null;
    if (!usageData || typeof usageData !== "object") return [];
    const history = extractHistoryArray(usageData);
    return historyToEvents(history, agent, file);
  } catch {
    return [];
  }
}

async function readDailySummaryFromDbJson(file: string): Promise<Record<string, unknown> | null> {
  const text = await readText(file);
  if (!text) return null;
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const usageData = (data.usageData ?? null) as Record<string, unknown> | null;
    const daily = usageData?.dailySummary;
    if (daily && typeof daily === "object" && !Array.isArray(daily)) {
      return daily as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

async function readDailySummaryFromJsonFile(file: string): Promise<Record<string, unknown> | null> {
  const text = await readText(file);
  if (!text) return null;
  try {
    const data = JSON.parse(text) as unknown;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const o = data as Record<string, unknown>;
      const daily = o.dailySummary;
      if (daily && typeof daily === "object" && !Array.isArray(daily)) {
        return daily as Record<string, unknown>;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Standalone daily file shapes:
 *  A) map  { "2026-07-14": { requests, promptTokens, … }, … }
 *  B) VPS export array  [ { dateKey, data: "<json string|object>" }, … ]
 *  C) wrapper { dailySummary: { …map… } }
 */
async function readDailySummaryStandalone(file: string): Promise<Record<string, unknown> | null> {
  const text = await readText(file);
  if (!text) return null;
  try {
    const data = JSON.parse(text) as unknown;
    const normalized = normalizeDailyMap(data);
    return normalized && Object.keys(normalized).length ? normalized : null;
  } catch {
    // ignore
  }
  return null;
}

/** Normalize various daily export shapes into dateKey → day payload map. */
function normalizeDailyMap(data: unknown): Record<string, unknown> | null {
  if (!data) return null;

  // B) array of { dateKey, data }
  if (Array.isArray(data)) {
    const daily: Record<string, unknown> = {};
    for (const row of data) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const keyRaw = r.dateKey ?? r.date ?? r.day ?? r.key;
      const key = typeof keyRaw === "string" ? keyRaw.trim() : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      let payload: unknown = r.data !== undefined ? r.data : r.payload !== undefined ? r.payload : r;
      if (typeof payload === "string" && payload.trim()) {
        try {
          payload = JSON.parse(payload);
        } catch {
          continue;
        }
      }
      // If payload is the whole row, strip dateKey envelope
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const p = payload as Record<string, unknown>;
        if (p.dateKey && (p.data !== undefined || p.promptTokens !== undefined || p.requests !== undefined)) {
          // already day fields or nested
          if (p.promptTokens !== undefined || p.requests !== undefined || p.cost !== undefined || p.byModel) {
            daily[key] = p;
          } else if (p.data && typeof p.data === "object") {
            daily[key] = p.data as Record<string, unknown>;
          } else {
            daily[key] = p;
          }
        } else {
          daily[key] = p;
        }
      }
    }
    return Object.keys(daily).length ? daily : null;
  }

  if (typeof data !== "object") return null;
  const o = data as Record<string, unknown>;

  // C) wrapper
  if (o.dailySummary && typeof o.dailySummary === "object" && !Array.isArray(o.dailySummary)) {
    return o.dailySummary as Record<string, unknown>;
  }
  if (o.usageDaily && typeof o.usageDaily === "object" && !Array.isArray(o.usageDaily)) {
    return normalizeDailyMap(o.usageDaily);
  }
  if (Array.isArray(o.days)) {
    return normalizeDailyMap(o.days);
  }

  // A) plain dateKey map (or mixed — keep only date keys)
  const daily: Record<string, unknown> = {};
  let dateKeys = 0;
  for (const [k, v] of Object.entries(o)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    dateKeys += 1;
    if (v && typeof v === "object") daily[k] = v as Record<string, unknown>;
    else if (typeof v === "string") {
      try {
        const parsed = JSON.parse(v);
        if (parsed && typeof parsed === "object") daily[k] = parsed as Record<string, unknown>;
      } catch {
        // skip
      }
    }
  }
  if (dateKeys > 0) return Object.keys(daily).length ? daily : null;

  return null;
}

/** Expand one dailySummary / usageDaily day into synthetic UsageEvents. */
function expandOneDay(
  dateKey: string,
  day: Record<string, unknown>,
  agent: AgentId,
  source: string,
  dayEvents: UsageEvent[] = [],
): UsageEvent[] {
  const dayInput = num(day.promptTokens ?? day.prompt_tokens);
  const dayOutput = num(day.completionTokens ?? day.completion_tokens);
  const dayCost = num(day.cost);
  const dayFallbackTs = syntheticDailyTimestamp(dateKey, latestTimestamp(dayEvents));

  const byModel = day.byModel;
  if (byModel && typeof byModel === "object" && !Array.isArray(byModel)) {
    const out: UsageEvent[] = [];
    let modelCost = 0;
    let modelTokens = 0;
    for (const [modelKey, mraw] of Object.entries(byModel as Record<string, unknown>)) {
      if (!mraw || typeof mraw !== "object") continue;
      const m = mraw as Record<string, unknown>;
      const model =
        normalizeModelName(
          (typeof m.rawModel === "string" && m.rawModel) ||
            modelKey.split("|")[0] ||
            modelKey,
        ) || "mixed";
      const provider = typeof m.provider === "string" ? m.provider : null;
      const inputTokens = num(m.promptTokens ?? m.prompt_tokens ?? m.inputTokens);
      const outputTokens = num(m.completionTokens ?? m.completion_tokens ?? m.outputTokens);
      const cost = num(m.cost);
      if (inputTokens + outputTokens <= 0 && cost <= 0) continue;
      modelCost += cost;
      modelTokens += inputTokens + outputTokens;
      const ts = syntheticDailyTimestamp(
        dateKey,
        latestTimestampForModel(dayEvents, model) || dayFallbackTs,
      );
      const e = rowToEvent(
        {
          id: `daily:${dateKey}:${modelKey}`,
          timestamp: ts,
          model,
          provider,
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          cost,
          tokens: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
        },
        agent,
        source,
        `daily-${dateKey}-${modelKey}`,
      );
      if (e) {
        e.estimated = true;
        out.push(e);
      }
    }
    // byModel is often incomplete vs day totals — only keep it when it covers ≥98%
    const dayTok = dayInput + dayOutput;
    const costOk = dayCost <= 0 || modelCost >= dayCost * 0.98;
    const tokOk = dayTok <= 0 || modelTokens >= dayTok * 0.98;
    if (out.length && costOk && tokOk) return out;
  }

  // Authoritative day rollup (full prompt/completion/cost for the calendar day)
  if (dayInput + dayOutput <= 0 && dayCost <= 0) return [];
  const e = rowToEvent(
    {
      id: `daily:${dateKey}:all`,
      timestamp: dayFallbackTs,
      model: "mixed",
      promptTokens: dayInput,
      completionTokens: dayOutput,
      cost: dayCost,
      tokens: { prompt_tokens: dayInput, completion_tokens: dayOutput },
    },
    agent,
    source,
    `daily-${dateKey}`,
  );
  if (!e) return [];
  e.estimated = true;
  return [e];
}

async function parseHistoryExport(file: string, agent: AgentId): Promise<UsageEvent[]> {
  const text = await readText(file);
  if (!text) return [];
  try {
    if (file.endsWith(".jsonl")) {
      return historyToEvents(parseJsonlRows(text), agent, file);
    }
    const data = JSON.parse(text) as unknown;
    return historyToEvents(extractHistoryArray(data), agent, file);
  } catch {
    return [];
  }
}

/**
 * Read only the last ~maxBytes of a large jsonl so daily-covered roots still get
 * recent request timestamps for RECENT EVENTS without loading tens of MB.
 */
async function parseHistoryExportTail(
  file: string,
  agent: AgentId,
  maxBytes: number,
): Promise<UsageEvent[]> {
  try {
    const { open } = await import("node:fs/promises");
    const fh = await open(file, "r");
    try {
      const st = await fh.stat();
      const size = st.size;
      if (size <= 0) return [];
      const start = Math.max(0, size - Math.max(64 * 1024, maxBytes));
      const len = size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      let text = buf.toString("utf8");
      // Drop partial first line when we did not start at byte 0
      if (start > 0) {
        const nl = text.indexOf("\n");
        if (nl >= 0) text = text.slice(nl + 1);
      }
      return historyToEvents(parseJsonlRows(text), agent, file);
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

function parseJsonlRows(text: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      // skip
    }
  }
  return rows;
}

function extractHistoryArray(data: unknown): unknown[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.history)) return o.history;
    if (Array.isArray(o.records)) return o.records;
    if (Array.isArray(o.events)) return o.events;
    if (Array.isArray(o.usageHistory)) return o.usageHistory;
  }
  return [];
}

function historyToEvents(history: unknown[], agent: AgentId, source: string): UsageEvent[] {
  const out: UsageEvent[] = [];
  let idx = 0;
  for (const row of history) {
    idx += 1;
    const e = rowToEvent(row, agent, source, String(idx));
    if (e) out.push(e);
  }
  return out;
}

function rowToEvent(
  row: unknown,
  agent: AgentId,
  source: string,
  tag: string,
): UsageEvent | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;

  let tokensObj: Record<string, unknown> = {};
  if (r.tokens && typeof r.tokens === "object" && !Array.isArray(r.tokens)) {
    tokensObj = r.tokens as Record<string, unknown>;
  } else if (typeof r.tokens === "string" && r.tokens.trim()) {
    try {
      const parsed = JSON.parse(r.tokens) as unknown;
      if (parsed && typeof parsed === "object") tokensObj = parsed as Record<string, unknown>;
    } catch {
      // ignore
    }
  }

  const inputTokens = num(
    tokensObj.prompt_tokens ??
      tokensObj.promptTokens ??
      tokensObj.input_tokens ??
      tokensObj.inputTokens ??
      r.promptTokens ??
      r.prompt_tokens ??
      r.inputTokens ??
      r.input_tokens,
  );
  const outputTokens = num(
    tokensObj.completion_tokens ??
      tokensObj.completionTokens ??
      tokensObj.output_tokens ??
      tokensObj.outputTokens ??
      r.completionTokens ??
      r.completion_tokens ??
      r.outputTokens ??
      r.output_tokens,
  );
  const cacheReadTokens = num(
    tokensObj.cached_tokens ??
      tokensObj.cache_read_tokens ??
      tokensObj.cacheReadTokens ??
      r.cachedTokens ??
      r.cacheReadTokens,
  );
  const cacheWriteTokens = num(
    tokensObj.cache_write_tokens ?? tokensObj.cacheWriteTokens ?? r.cacheWriteTokens,
  );

  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0) return null;

  const model = normalizeModelName(
    (typeof r.model === "string" && r.model) ||
      (typeof r.rawModel === "string" && r.rawModel) ||
      null,
  );
  const provider = typeof r.provider === "string" ? r.provider : null;
  // Prefer clean model id; never append provider/connection id into the label
  const modelLabel = model;

  // Prefer real event time. Never fall back to wall-clock "now" — that makes
  // rescans show perpetual "Just now" on the dashboard (see codex agent note).
  const tsRaw =
    r.timestamp ?? r.createdAt ?? r.created_at ?? r.date ?? r.ts ?? null;
  let ts: string | null = null;
  if (typeof tsRaw === "string" && tsRaw.trim() && !Number.isNaN(Date.parse(tsRaw))) {
    ts = new Date(tsRaw).toISOString();
  } else if (typeof tsRaw === "number" && Number.isFinite(tsRaw) && tsRaw > 0) {
    const ms = tsRaw > 1e12 ? tsRaw : tsRaw > 1e9 ? tsRaw * 1000 : NaN;
    if (Number.isFinite(ms)) ts = new Date(ms).toISOString();
  }
  if (!ts) {
    // Last resort: stable epoch-free marker from id/tag — use start of unix only if
    // nothing else exists so the row is not re-stamped on every scan.
    return null;
  }

  // Router-reported cost: use when > 0. Zero is NOT locked — fall back to rate table / custom rates.
  const hasRouterCostField =
    r.cost != null ||
    r.estimatedCost != null ||
    r.usd != null ||
    (typeof r.meta === "object" &&
      r.meta != null &&
      ((r.meta as Record<string, unknown>).cost != null ||
        (r.meta as Record<string, unknown>).estimatedCost != null));
  const routerCostRaw = num(
    r.cost ??
      r.estimatedCost ??
      r.usd ??
      (typeof r.meta === "object" && r.meta
        ? (r.meta as Record<string, unknown>).cost ??
          (r.meta as Record<string, unknown>).estimatedCost
        : undefined),
  );
  const connectionId = typeof r.connectionId === "string" ? r.connectionId : "";
  const endpoint = typeof r.endpoint === "string" ? r.endpoint : "";
  const nativeId = r.id != null ? String(r.id) : tag;

  // id omits source path so the same VPS row mirrored into two folders is not double-counted
  const event = applyPricing({
    id: stableId(
      agent,
      nativeId,
      String(inputTokens),
      String(outputTokens),
      ts,
      connectionId,
      modelLabel || "",
    ),
    agent,
    model: modelLabel,
    timestamp: ts,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    workspace: provider ? `provider:${provider}` : null,
    sourcePath: source,
    routerCost: hasRouterCostField && routerCostRaw > 0 ? routerCostRaw : null,
  });

  // keep endpoint lightly in workspace when useful
  if (endpoint && !event.workspace) {
    event.workspace = endpoint;
  }

  return event;
}
