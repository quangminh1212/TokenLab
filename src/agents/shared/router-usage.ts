import path from "node:path";
import { applyPricing } from "../../pricing.js";
import type { AgentId, UsageEvent } from "../../types.js";
import { normalizeModelName, num, pathExists, readText, stableId } from "../../util.js";

/**
 * Shared parser for 9router / routerlab (ex xlabrouter) local data.
 *
 * Preference (request-first for RECENT EVENTS, daily as gap-fill):
 *  1. Per-request history (jsonl / usageHistory / request-details) when multi-RQ sample exists
 *  2. usage-daily / usageDaily / dailySummary byModel when history is missing or too sparse
 *
 * Why: daily byModel collapses an entire day into one row per model (e.g. 99× grok-4.5
 * → a single 5.2M-token "event"). RECENT EVENTS must show real individual requests.
 * Daily rollups remain the fallback so days without history still contribute totals.
 */
/**
 * Order roots so the VPS mirror (tokenlab/mirrors/{agent}) is scanned first,
 * and we can stop loading per-request history after the first rich root to
 * avoid multi-folder twin inflation (routerlab + xlabrouter + Dev\\VPS\\...).
 */
function prioritizeRouterRoots(roots: string[], agent: AgentId): string[] {
  const score = (r: string): number => {
    const s = r.replace(/\\/g, "/").toLowerCase();
    if (s.includes("/mirrors/routerlab") || s.includes("/mirrors/9router")) return 100;
    if (s.includes("/mirrors/xlabrouter")) return 90;
    if (s.includes("my.bnix.one") && (s.includes("routerlab") || s.includes("9router") || s.includes("xlabrouter")))
      return 80;
    if (s.includes("/.9router") || s.includes("/var/lib/xlabrouter")) return 70;
    if (s.includes("xlab-token/mirrors")) return 60;
    return 10;
  };
  return [...roots].sort((a, b) => score(b) - score(a));
}

export async function parseRouterUsage(
  roots: string[],
  agent: AgentId,
): Promise<UsageEvent[]> {
  const eventLevel: UsageEvent[] = [];
  const seenIds = new Set<string>();
  // Content fingerprint (ignore source path / native id / cache details) so twin
  // exports (db.json history + request-details.jsonl, multi-root mirrors) merge.
  // Second-precision timestamp absorbs 1ms drift between mirror copies.
  const contentIndex = new Map<string, number>();
  const dailyMaps: Array<{ source: string; daily: Record<string, unknown> }> = [];
  let loadedRequestHistoryFromRoot: string | null = null;

  const contentFingerprint = (e: UsageEvent): string => {
    const ts = (e.timestamp || "").slice(0, 19); // YYYY-MM-DDTHH:mm:ss
    return [
      e.agent,
      ts,
      e.model || "",
      e.inputTokens || 0,
      e.outputTokens || 0,
      e.workspace || "",
    ].join("|");
  };

  const tokenWeight = (e: UsageEvent): number =>
    (Number(e.inputTokens) || 0) +
    (Number(e.outputTokens) || 0) +
    (Number(e.cacheReadTokens) || 0) +
    (Number(e.cacheWriteTokens) || 0);

  const pushEvents = (batch: UsageEvent[]) => {
    for (const e of batch) {
      if (seenIds.has(e.id)) continue;
      const fp = contentFingerprint(e);
      const prevIdx = contentIndex.get(fp);
      if (prevIdx != null) {
        const prev = eventLevel[prevIdx];
        if (prev) {
          // Keep richer twin (e.g. row with cache_read filled in)
          const preferNext =
            tokenWeight(e) > tokenWeight(prev) ||
            ((Number(e.estimatedCost) || 0) > (Number(prev.estimatedCost) || 0) &&
              tokenWeight(e) >= tokenWeight(prev));
          if (preferNext) eventLevel[prevIdx] = e;
        }
        seenIds.add(e.id);
        continue;
      }
      seenIds.add(e.id);
      contentIndex.set(fp, eventLevel.length);
      eventLevel.push(e);
    }
  };

  // Prefer a single VPS-mirror root first for router agents so twin copies
  // (routerlab + xlabrouter + AppData) do not inflate request-level history.
  const orderedRoots = prioritizeRouterRoots(roots, agent);

  for (const root of orderedRoots) {
    if (!(await pathExists(root))) continue;

    let hasDailyForRoot = false;

    // --- A) Daily rollups (fallback when history is sparse/missing) ---
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

    // --- B) Per-request history (preferred for RECENT EVENTS) ---
    // Load request-level rows from the first rich root only — twin mirrors
    // (routerlab + xlabrouter) previously inflated same-day totals vs VPS dashboard.
    const loadHistoryHere =
      !loadedRequestHistoryFromRoot ||
      loadedRequestHistoryFromRoot === root;

    if (loadHistoryHere) {
      let gotHistory = false;
      for (const dbRel of ["db/data.sqlite", "data.sqlite", "db.sqlite"]) {
        const dbPath = path.join(root, dbRel);
        if (!(await pathExists(dbPath))) continue;
        // Prefer a larger recent window so RECENT EVENTS can list individual RQs
        const rows = await parseSqliteUsage(dbPath, agent, hasDailyForRoot ? 5_000 : 20_000);
        if (rows.length) {
          pushEvents(rows);
          gotHistory = true;
        }
      }

      // Embedded history inside usage/db wrappers
      if (await pathExists(usagePath)) {
        const rows = await parseUsageJsonFile(usagePath, agent);
        if (rows.length) {
          pushEvents(rows);
          gotHistory = true;
        }
      }
      if (await pathExists(dbJsonPath)) {
        const rows = await parseDbJsonUsage(dbJsonPath, agent);
        if (rows.length) {
          pushEvents(rows);
          gotHistory = true;
        }
      }
      if (await pathExists(usageDataPath)) {
        const rows = await parseUsageJsonFile(usageDataPath, agent);
        if (rows.length) {
          pushEvents(rows);
          gotHistory = true;
        }
      }

      // One preferred history stream per root: request-details first, then usage-history.
      const historyPreference = [
        "request-details.json",
        "request-details.jsonl",
        "usage-history.json",
        "usageHistory.json",
        "usage-history.jsonl",
      ];
      for (const name of historyPreference) {
        const p = path.join(root, name);
        if (!(await pathExists(p))) continue;
        if (name.endsWith(".jsonl")) {
          try {
            const { stat } = await import("node:fs/promises");
            const st = await stat(p);
            const maxBytes = 12 * 1024 * 1024;
            if (st.size > maxBytes) {
              pushEvents(await parseHistoryExportTail(p, agent, 2 * 1024 * 1024));
            } else {
              pushEvents(await parseHistoryExport(p, agent));
            }
          } catch {
            pushEvents(await parseHistoryExport(p, agent));
          }
        } else {
          pushEvents(await parseHistoryExport(p, agent));
        }
        gotHistory = true;
        break;
      }

      if (gotHistory) loadedRequestHistoryFromRoot = root;
    }
  }

  return reconcileEventsAndDaily(eventLevel, dailyMaps, agent);
}

/**
 * Request-first reconciliation:
 *  - Multi-request history for a day → keep individual RQs (never one 5M+ model blob)
 *  - Sparse/missing history → daily rollup (byModel or whole-day) for totals
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

    if (!daily) {
      out.push(...dayEvents);
      continue;
    }

    if (shouldPreferRequestEvents(dayEvents, daily.day)) {
      // Keep individual RQs for RECENT EVENTS; gap-fill missing models + request/token deficit
      // so TOTAL REQUESTS matches router daily.requests (history tails are often incomplete).
      out.push(...dayEvents);
      out.push(...gapFillDailyDeficits(dateKey, daily.day, agent, daily.source, dayEvents));
      continue;
    }

    // Sparse or empty history → authoritative daily rollup
    out.push(...expandOneDay(dateKey, daily.day, agent, daily.source, dayEvents));
  }

  return out;
}

/**
 * Prefer real request rows when we have a multi-RQ sample that covers a meaningful
 * slice of the day (count or tokens). A single stray history row must not replace
 * a full daily rollup.
 *
 * Never short-circuit on raw count alone: a 2MB history tail can have 20+ rows of one
 * model while daily still holds the rest of the day (other models / majority tokens).
 */
function shouldPreferRequestEvents(
  dayEvents: UsageEvent[],
  day: Record<string, unknown>,
): boolean {
  const reqCount = dayEvents.length;
  if (reqCount < 2) return false;

  const dayReqTarget = num(day.requests);
  const dayTok =
    num(day.promptTokens ?? day.prompt_tokens) +
    num(day.completionTokens ?? day.completion_tokens);
  const dayCost = num(day.cost);
  const reqTok = dayEvents.reduce(
    (a, e) => a + (Number(e.inputTokens) || 0) + (Number(e.outputTokens) || 0),
    0,
  );

  // VPS dashboards (RouterLab :1212, 9router) use dailySummary as the day total.
  // Whenever we have a substantial daily rollup, prefer it over request tails —
  // partial/twin history was overshooting cost (e.g. $499 vs remote $146).
  if (dayReqTarget >= 20 && dayTok >= 10_000) {
    return false;
  }

  // History/RD twin copies often overshoot tiny dailies too.
  if (dayTok > 0 && reqTok > dayTok * 1.05) return false;

  // Zero-token stream probes (success / "say test") inflate RQ count while
  // tokens stay inside the daily envelope — keep dailySummary (e.g. 1 not 35).
  if (
    dayReqTarget > 0 &&
    reqCount > Math.max(dayReqTarget * 1.5, dayReqTarget + 5) &&
    (dayTok <= 0 || reqTok <= dayTok * 1.05)
  ) {
    return false;
  }

  // Any billed/non-empty daily is SoT for that calendar day on remote dashboards.
  if (dayReqTarget >= 1 && (dayCost > 0 || dayTok > 0) && reqCount > dayReqTarget * 1.25) {
    return false;
  }

  const coverageByCount = dayReqTarget > 0 ? reqCount / dayReqTarget : 1;
  const coverageByTok = dayTok > 0 ? reqTok / dayTok : 1;
  // ≥15% of the day observed as real RQs → prefer split events over one model blob
  return coverageByCount >= 0.15 || coverageByTok >= 0.15;
}

/**
 * When history is preferred but incomplete vs daily.byModel:
 *  - models absent from history → full daily model rollup
 *  - models present but fewer requests/tokens than daily → remainder rollup only
 * Request counts use daily `requests` so TOTAL REQUESTS is not stuck on history-row count.
 */
function gapFillDailyDeficits(
  dateKey: string,
  day: Record<string, unknown>,
  agent: AgentId,
  source: string,
  dayEvents: UsageEvent[],
): UsageEvent[] {
  const byModel = day.byModel;
  if (!byModel || typeof byModel !== "object" || Array.isArray(byModel)) return [];

  type Acc = { n: number; in: number; out: number; cache: number; cost: number };
  const histByModel = new Map<string, Acc>();
  for (const e of dayEvents) {
    const model = normalizeModelName(e.model) || e.model || "";
    if (!model) continue;
    const prev = histByModel.get(model) || { n: 0, in: 0, out: 0, cache: 0, cost: 0 };
    const reqs =
      typeof e.requestCount === "number" && e.requestCount > 0 ? Math.floor(e.requestCount) : 1;
    prev.n += reqs;
    prev.in += Number(e.inputTokens) || 0;
    prev.out += Number(e.outputTokens) || 0;
    prev.cache += Number(e.cacheReadTokens) || 0;
    prev.cost += Number(e.estimatedCost) || 0;
    histByModel.set(model, prev);
  }

  const deficitByModel: Record<string, unknown> = {};
  let sumReq = 0;
  let sumIn = 0;
  let sumOut = 0;
  let sumCost = 0;

  for (const [modelKey, mraw] of Object.entries(byModel as Record<string, unknown>)) {
    if (!mraw || typeof mraw !== "object") continue;
    const m = mraw as Record<string, unknown>;
    const model =
      normalizeModelName(
        (typeof m.rawModel === "string" && m.rawModel) ||
          modelKey.split("|")[0] ||
          modelKey,
      ) || "mixed";
    const dailyReq = num(m.requests);
    const dailyIn = num(m.promptTokens ?? m.prompt_tokens ?? m.inputTokens);
    const dailyOut = num(m.completionTokens ?? m.completion_tokens ?? m.outputTokens);
    const dailyCache = num(m.cachedTokens ?? m.cached_tokens ?? m.cacheReadTokens);
    const dailyCost = num(m.cost);
    const hist = histByModel.get(model) || { n: 0, in: 0, out: 0, cache: 0, cost: 0 };

    const remReq = Math.max(0, dailyReq - hist.n);
    const remIn = Math.max(0, dailyIn - hist.in);
    const remOut = Math.max(0, dailyOut - hist.out);
    const remCache = Math.max(0, dailyCache - hist.cache);
    const remCost = Math.max(0, dailyCost - hist.cost);

    // Nothing left to attribute
    if (remReq <= 0 && remIn + remOut + remCache <= 0 && remCost <= 0) continue;
    // History already at/over daily totals for this model
    if (hist.n >= dailyReq && hist.in + hist.out >= dailyIn + dailyOut && dailyReq > 0) continue;

    deficitByModel[modelKey] = {
      requests: remReq > 0 ? remReq : hist.n === 0 ? Math.max(1, dailyReq) : 0,
      promptTokens: remIn,
      completionTokens: remOut,
      cachedTokens: remCache,
      cost: remCost,
      rawModel: typeof m.rawModel === "string" ? m.rawModel : model,
      provider: typeof m.provider === "string" ? m.provider : undefined,
    };
    sumReq += remReq > 0 ? remReq : 0;
    sumIn += remIn;
    sumOut += remOut;
    sumCost += remCost;
  }

  if (Object.keys(deficitByModel).length === 0) return [];

  return expandOneDay(
    dateKey,
    {
      requests: sumReq,
      promptTokens: sumIn,
      completionTokens: sumOut,
      cost: sumCost,
      byModel: deficitByModel,
    },
    agent,
    source,
    dayEvents,
  );
}

/**
 * Pick a stable, non-future timestamp for a synthetic daily rollup event.
 *
 * Prefer a real same-UTC-day request time **before noon UTC** (accurate timeAgo for
 * morning activity). Never inherit late-evening UTC request times (e.g. 17:12Z):
 * for UTC+7 that is 00:12 local next day, and stamping yesterday's full daily
 * rollup there leaked ~$400+ of prior-day 9router cost into TokenLab "Today".
 *
 * After noon UTC on dateKey, anchor at noon. While the UTC day is still before
 * noon and has no safe preferred time, use start-of-day (not a future noon).
 */
function syntheticDailyTimestamp(
  dateKey: string,
  preferred?: string | null,
): string {
  const noon = Date.parse(`${dateKey}T12:00:00.000Z`);
  const dayStart = Date.parse(`${dateKey}T00:00:00.000Z`);
  const now = Date.now();

  if (preferred) {
    const t = Date.parse(preferred);
    if (Number.isFinite(t) && Number.isFinite(dayStart) && Number.isFinite(noon)) {
      const prefDay = new Date(t).toISOString().slice(0, 10);
      // Only accept preferred times that fall on the same UTC calendar dateKey
      // and not after noon (late UTC = next local morning for SEA UTC+7).
      if (prefDay === dateKey && t >= dayStart && t <= noon) {
        return new Date(t).toISOString();
      }
    }
  }

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
      const cacheReadTokens = num(m.cachedTokens ?? m.cached_tokens ?? m.cacheReadTokens);
      const cost = num(m.cost);
      const modelRequests = num(m.requests);
      if (inputTokens + outputTokens + cacheReadTokens <= 0 && cost <= 0 && modelRequests <= 0) {
        continue;
      }
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
          requests: modelRequests > 0 ? modelRequests : 1,
          tokens: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            cached_tokens: cacheReadTokens,
          },
        },
        agent,
        source,
        `daily-${dateKey}-${modelKey}`,
      );
      if (e) {
        // Stable id across rollup growth — token counts must NOT be in the hash
        // or each mid-day update creates a new row and all-time totals explode.
        e.id = stableId(agent, "daily-rollup", dateKey, modelKey);
        e.estimated = true;
        e.requestCount = modelRequests > 0 ? modelRequests : 1;
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
  const dayRequests = num(day.requests);
  const e = rowToEvent(
    {
      id: `daily:${dateKey}:all`,
      timestamp: dayFallbackTs,
      model: "mixed",
      promptTokens: dayInput,
      completionTokens: dayOutput,
      cost: dayCost,
      requests: dayRequests > 0 ? dayRequests : 1,
      tokens: { prompt_tokens: dayInput, completion_tokens: dayOutput },
    },
    agent,
    source,
    `daily-${dateKey}`,
  );
  if (!e) return [];
  e.id = stableId(agent, "daily-rollup", dateKey, "all");
  e.estimated = true;
  e.requestCount = dayRequests > 0 ? dayRequests : 1;
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

  const requestHint = num(r.requests ?? r.requestCount ?? r.request_count);
  const routerCostHint = num(
    r.cost ?? r.estimatedCost ?? r.usd,
  );
  // Empty stream probes (0 tokens, 0 cost) must never become usage events —
  // even when a caller stamps requests:1. VPS dailySummary already ignores them.
  if (
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0 &&
    routerCostHint <= 0
  ) {
    return null;
  }
  if (
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0 &&
    requestHint <= 0
  ) {
    return null;
  }

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

  // Per-call history = 1 request; daily/export may carry explicit requests count
  const requestCountRaw = num(r.requests ?? r.requestCount ?? r.request_count);
  const requestCount = requestCountRaw > 0 ? Math.floor(requestCountRaw) : 1;

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
    requestCount,
    routerCost: hasRouterCostField && routerCostRaw > 0 ? routerCostRaw : null,
  });

  // keep endpoint lightly in workspace when useful
  if (endpoint && !event.workspace) {
    event.workspace = endpoint;
  }
  event.requestCount = requestCount;

  return event;
}
