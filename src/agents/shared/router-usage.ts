import path from "node:path";
import { applyPricing } from "../../pricing.js";
import type { AgentId, UsageEvent } from "../../types.js";
import { normalizeModelName, num, pathExists, readText, stableId } from "../../util.js";

/**
 * Shared parser for 9router / routerlab (ex xlabrouter) / litellm local data.
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
    if (
      s.includes("/mirrors/routerlab") ||
      s.includes("/mirrors/9router") ||
      s.includes("/mirrors/litellm")
    )
      return 100;
    if (s.includes("/mirrors/xlabrouter")) return 90;
    if (
      s.includes("my.bnix.one") &&
      (s.includes("routerlab") ||
        s.includes("9router") ||
        s.includes("xlabrouter") ||
        s.includes("litellm"))
    )
      return 80;
    if (
      s.includes("/.9router") ||
      s.includes("/var/lib/xlabrouter") ||
      s.includes("/opt/litellm")
    )
      return 70;
    if (s.includes("xlab-token/mirrors")) return 60;
    return 10;
  };
  return [...roots].sort((a, b) => score(b) - score(a));
}

/**
 * Resolve the display model for router data.
 *
 * LiteLLM stores both the provider-native model (for example
 * `openai/openclaw`) and, in SpendLogs, the public model group
 * (`model_group=glm-5.3`). The public group is what TokenLab should show.
 * Older LiteLLM rows may contain only `openclaw`, so keep a narrowly scoped
 * compatibility alias for the LiteLLM agent.
 */
function routerModelFromRecord(
  agent: AgentId,
  record: Record<string, unknown>,
  fallback?: unknown,
): string | null {
  const candidates = [
    record.model_group,
    record.modelGroup,
    record.displayModel,
    record.display_model,
    record.model,
    record.modelId,
    record.model_id,
    record.model_name,
    record.rawModel,
    fallback,
  ];
  let model: string | null = null;
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    model = normalizeModelName(candidate);
    if (model) break;
  }
  if (!model) return null;

  if (agent === "litellm" && model.toLowerCase() === "openclaw") {
    return "glm-5.3";
  }
  return model;
}

export async function parseRouterUsage(
  roots: string[],
  agent: AgentId,
  options: { recentOnly?: boolean } = {},
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

    // Read each JSON once — previously daily + history paths re-read the same multi-MB files.
    const usagePath = path.join(root, "usage.json");
    const dbJsonPath = path.join(root, "db.json");
    const usageDataPath = path.join(root, "usageData.json");
    const usageParsed = await readJsonIfExists(usagePath);
    const dbJsonParsed = await readJsonIfExists(dbJsonPath);
    const usageDataParsed = await readJsonIfExists(usageDataPath);

    {
      const daily = dailyFromUsageJson(usageParsed);
      if (daily) {
        dailyMaps.push({ source: usagePath, daily });
        hasDailyForRoot = true;
      }
    }
    {
      const daily = dailyFromDbJson(dbJsonParsed);
      if (daily) {
        dailyMaps.push({ source: dbJsonPath, daily });
        hasDailyForRoot = true;
      }
    }
    {
      const daily = dailyFromUsageJson(usageDataParsed);
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
        const rows = await parseSqliteUsage(
          dbPath,
          agent,
          options.recentOnly ? 1_000 : hasDailyForRoot ? 5_000 : 20_000,
        );
        if (rows.length) {
          pushEvents(rows);
          gotHistory = true;
        }
      }

      // Embedded history from already-parsed JSON (no second disk read)
      {
        const rows = historyFromUsageJson(usageParsed, agent, usagePath);
        if (rows.length) {
          pushEvents(rows);
          gotHistory = true;
        }
      }
      {
        const rows = historyFromDbJson(dbJsonParsed, agent, dbJsonPath);
        if (rows.length) {
          pushEvents(rows);
          gotHistory = true;
        }
      }
      {
        const rows = historyFromUsageJson(usageDataParsed, agent, usageDataPath);
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
            const maxBytes = options.recentOnly ? 1 * 1024 * 1024 : 12 * 1024 * 1024;
            if (st.size > maxBytes) {
              pushEvents(
                await parseHistoryExportTail(
                  p,
                  agent,
                  options.recentOnly ? 512 * 1024 : 2 * 1024 * 1024,
                ),
              );
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

    // History is the single source for a day it covers. Daily rollups exist in
    // the same mirror exports (db.json carries usageData.dailySummary AND
    // usageData.history; usage-daily.json is a third copy), so combining them
    // counted a fully-covered day twice — 2.047x input / 2.045x requests on
    // 2026-10-07, where history alone already matched day.requests exactly.
    // Cost stays local: rows are priced by applyPricing from the rate table,
    // never from the router's own `cost` field.
    if (dayEvents.length > 0) {
      out.push(...dayEvents);
      continue;
    }

    // No history at all for this day → the daily rollup is all we have.
    if (!daily) continue;
    out.push(...expandOneDay(dateKey, daily.day, agent, daily.source, []));
  }

  return out;
}

/** One model's aggregated daily totals after key consolidation. */
interface DailyModelTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  rawModel?: string;
  provider?: string;
  /** Public display label for this group (also the map key). */
  display?: string;
}

/**
 * Collapse a daily `byModel` map into one entry per exported model group.
 *
 * LiteLLM exports the same day under several `byModel` keys that are NOT additive
 * fragments — they are overlapping views of one another, so summing them double
 * counts. Measured on the live mirror for 2026-10-05:
 *
 *   anthropic/claude-fable-5|openai  in=470,461,648  req=4426
 *   openai/Claude-Fable|openai       in=475,049,638  req=4533
 *   day                              in=474,522,782  req=4674
 *
 * Both rows describe the whole day; their SUM is 945.5M / 8959 (~2x day), while
 * the LARGER one alone is within 0.1% of the day. Same shape on 10-04 and 10-06.
 * Keying by `rawModel` and taking the largest row therefore reconstructs a day,
 * which summing either by raw key or by rawModel could not.
 *
 * Identity is `rawModel` (provider-native id). The display name must NOT be the
 * identity: normalization maps `claude-fable-5` and `Claude-Fable` to different
 * strings for one model, and two keys can also share one display label.
 */
function groupDailyByModel(
  agent: AgentId,
  byModel: Record<string, unknown>,
): Map<string, DailyModelTotals> {
  interface Group extends DailyModelTotals {
    /** Best display name seen for this group across all keys. */
    display: string;
  }
  const grouped = new Map<string, Group>();
  for (const [modelKey, mraw] of Object.entries(byModel)) {
    if (!mraw || typeof mraw !== "object" || Array.isArray(mraw)) continue;
    const m = mraw as Record<string, unknown>;
    const model = routerModelFromRecord(agent, m, modelKey.split("|")[0] || modelKey) || "mixed";
    const rawModel = typeof m.rawModel === "string" && m.rawModel ? m.rawModel : model;
    const key = normalizeModelName(rawModel) || rawModel;

    const row = {
      requests: num(m.requests),
      promptTokens: num(m.promptTokens ?? m.prompt_tokens ?? m.inputTokens),
      completionTokens: num(m.completionTokens ?? m.completion_tokens ?? m.outputTokens),
      cachedTokens: num(m.cachedTokens ?? m.cached_tokens ?? m.cacheReadTokens),
      cost: num(m.cost),
      rawModel,
      provider: typeof m.provider === "string" ? m.provider : undefined,
      display: model,
    };

    const prev = grouped.get(key);
    if (!prev) {
      grouped.set(key, row);
      continue;
    }
    // Overlapping views of the same day → keep the most complete one, never sum.
    const prevWeight = prev.promptTokens + prev.completionTokens + prev.cachedTokens;
    const nextWeight = row.promptTokens + row.completionTokens + row.cachedTokens;
    if (nextWeight > prevWeight) {
      // Preserve the most descriptive label even when the numbers come from a
      // less readable key.
      grouped.set(key, {
        ...row,
        display: model.length > prev.display.length ? model : prev.display,
        // The views overlap, so the winner's cache count is not always the
        // largest one — several keys for one model report the SAME prompt/output
        // totals while only one of them carries the cache count. Measured on the
        // live mirror (2026-10-07, model `openai/claude-opus-5.5`):
        //
        //   anthropic/claude-opus-5.5|openai  in=1000 out=100 cache=236416
        //   claude-opus-5.5|openai            in=1000 out=100 cache=0
        //
        // Both describe one model, so taking only the winner dropped the whole
        // day's cache. Cache is a *slice* of prompt_tokens for litellm, so the
        // larger count is the more complete reading of the same tokens; for
        // 9router/routerlab (cache not inside prompt) it is likewise the larger
        // measured hit count. Never additive in either case.
        cachedTokens: Math.max(prev.cachedTokens, row.cachedTokens),
      });
    } else if (model.length > prev.display.length || row.cachedTokens > prev.cachedTokens) {
      if (row.cachedTokens > prev.cachedTokens) prev.cachedTokens = row.cachedTokens;
      if (model.length > prev.display.length) prev.display = model;
    }
  }

  // Key by the resolved raw model so downstream model labels, rate lookups and
  // stable ids all agree on one identity per real model.
  const out = new Map<string, DailyModelTotals>();
  for (const [key, g] of grouped) {
    out.set(key, {
      requests: g.requests,
      promptTokens: g.promptTokens,
      completionTokens: g.completionTokens,
      cachedTokens: g.cachedTokens,
      cost: g.cost,
      rawModel: g.rawModel,
      provider: g.provider,
      display: g.display,
    });
  }
  return out;
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
            `SELECT id, timestamp, provider, model, model_group, connectionId, apiKey, endpoint,
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

/** Single disk read + JSON.parse; null when missing or invalid. */
async function readJsonIfExists(file: string): Promise<unknown | null> {
  if (!(await pathExists(file))) return null;
  const text = await readText(file);
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function dailyFromUsageJson(data: unknown | null): Record<string, unknown> | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  const daily =
    o.dailySummary ??
    o.daily ??
    o.usageDaily ??
    (o.usageData && typeof o.usageData === "object" && !Array.isArray(o.usageData)
      ? (o.usageData as Record<string, unknown>).dailySummary
      : null);
  if (daily && typeof daily === "object" && !Array.isArray(daily)) {
    return daily as Record<string, unknown>;
  }
  return null;
}

function dailyFromDbJson(data: unknown | null): Record<string, unknown> | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  const usageData = (o.usageData ?? o.usage ?? null) as Record<string, unknown> | null;
  const daily = usageData?.dailySummary;
  if (daily && typeof daily === "object" && !Array.isArray(daily)) {
    return daily as Record<string, unknown>;
  }
  return null;
}

function historyFromUsageJson(
  data: unknown | null,
  agent: AgentId,
  source: string,
): UsageEvent[] {
  if (data == null) return [];
  return historyToEvents(extractHistoryArray(data), agent, source);
}

function historyFromDbJson(
  data: unknown | null,
  agent: AgentId,
  source: string,
): UsageEvent[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const o = data as Record<string, unknown>;
  const usageData = (o.usageData ?? o.usage ?? null) as Record<string, unknown> | null;
  if (!usageData || typeof usageData !== "object") return [];
  return historyToEvents(extractHistoryArray(usageData), agent, source);
}

async function parseUsageJsonFile(file: string, agent: AgentId): Promise<UsageEvent[]> {
  return historyFromUsageJson(await readJsonIfExists(file), agent, file);
}

async function parseDbJsonUsage(file: string, agent: AgentId): Promise<UsageEvent[]> {
  return historyFromDbJson(await readJsonIfExists(file), agent, file);
}

async function readDailySummaryFromDbJson(file: string): Promise<Record<string, unknown> | null> {
  return dailyFromDbJson(await readJsonIfExists(file));
}

async function readDailySummaryFromJsonFile(file: string): Promise<Record<string, unknown> | null> {
  return dailyFromUsageJson(await readJsonIfExists(file));
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
  const dayCache = num(day.cachedTokens ?? day.cached_tokens ?? day.cacheReadTokens);
  const dayCost = num(day.cost);
  const dayFallbackTs = syntheticDailyTimestamp(dateKey, latestTimestamp(dayEvents));

  const byModel = day.byModel;
  if (byModel && typeof byModel === "object" && !Array.isArray(byModel)) {
    const out: UsageEvent[] = [];
    let modelCost = 0;
    let modelTokens = 0;
    let modelCache = 0;
    // Group first: several raw byModel keys can describe one real model, and
    // emitting them separately made modelCost overshoot dayCost (see
    // groupDailyByModel), which discarded an otherwise valid byModel.
    for (const [model, m] of groupDailyByModel(agent, byModel as Record<string, unknown>)) {
      const modelKey = model;
      // `model` is the raw export key (identity); show the readable label on the
      // row so the dashboard groups two fragments of one model together.
      const label = m.display || model;
      const provider = m.provider ?? null;
      const inputTokens = m.promptTokens;
      const outputTokens = m.completionTokens;
      const cacheReadTokens = m.cachedTokens;
      const cost = m.cost;
      const modelRequests = m.requests;
      if (inputTokens + outputTokens + cacheReadTokens <= 0 && cost <= 0 && modelRequests <= 0) {
        continue;
      }
      modelCost += cost;
      modelTokens += inputTokens + outputTokens;
      modelCache += cacheReadTokens;
      const ts = syntheticDailyTimestamp(
        dateKey,
        latestTimestampForModel(dayEvents, model) || dayFallbackTs,
      );
      const e = rowToEvent(
        {
          id: `daily:${dateKey}:${modelKey}`,
          timestamp: ts,
          model: label,
          provider,
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          cachedTokens: cacheReadTokens,
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
    // Price per real model, not as one "mixed" blob: the local rate table is
    // keyed by model, so collapsing a day into "mixed" makes every token
    // unpricable (pricingStatus "unknown_model") and the day total meaningless.
    // Where byModel does not cover the day, the remainder is emitted as its own
    // row below rather than forcing the whole day into "mixed".
    const dayTok = dayInput + dayOutput + dayCache;
    if (out.length) {
      const coveredReq = out.reduce((a, e) => a + (e.requestCount ?? 1), 0);
      const coveredIn = out.reduce((a, e) => a + e.inputTokens, 0);
      const coveredOut = out.reduce((a, e) => a + e.outputTokens, 0);
      const coveredTok = modelTokens + modelCache;
      const remReq = Math.max(0, num(day.requests) - coveredReq);
      // Compare like with like: inputs against inputs, outputs against outputs.
      // Using modelTokens (in+out) for the output remainder dropped real output
      // tokens whenever a day had any mix of models.
      const remIn = Math.max(0, dayInput - coveredIn);
      const remOut = Math.max(0, dayOutput - coveredOut);
      const remCache = Math.max(0, dayCache - modelCache);
      // Nothing material left over → byModel is the whole day.
      if (coveredTok >= dayTok * 0.98 && coveredTok <= dayTok * 1.02) return out;
      /*
       * Cache is NOT additive across the overlapping byModel views.
       *
       * `groupDailyByModel` dedupes keys that describe the same model, so
       * `modelCache` ends up with only the winning view's cache while `dayCache`
       * is the whole day. When input+output are already fully covered by the
       * per-model rows, the "missing" cache is just the dropped mirror of the
       * same tokens — measured on the live LiteLLM mirror for 2026-07-31:
       *
       *   day        in=1310221946 out=7806517 cache=2176363904 req=22797
       *   kimi-k3    in=1209500081 out=6795583 cache=1088118336
       *   unattributed       in=0 out=0      cache=1088181952
       *
       * in+out already balanced against the day (remIn = remOut = 0), yet the
       * remainder restated half the cache, so the day's cache was counted twice
       * under two labels and the cache column did not reconcile with the source.
       *
       * The original guard for that (`remainderHasOwnPrompt = remIn > 0 || remOut > 0`)
       * only fired on the exact case it was written from — a `byModel` that lands
       * 0 on the day. `byModel` routinely *overshoots* instead (it summed 22967
       * requests against a 22797-request day above), which clamps remIn/remOut to 0
       * anyway, so the guard never fired and the remainder still restated the cache:
       * litellm kept 4,488,779,697 of the day-level 8,498,526,641 cached tokens —
       * 47.2% of all cache served, silently dropped. Use the real cache remainder
       * instead of inferring it from prompt tokens.
       */
      const remainder = remainderRow(
        dateKey,
        agent,
        source,
        dayFallbackTs,
        remReq,
        remIn,
        remOut,
        remCache,
        dayCost,
        modelCost,
      );
      return remainder ? [...out, remainder] : out;
    }
  }

  // No usable byModel → emit the whole day as one row. The model stays
  // "unattributed" rather than "mixed" so it is visibly unpriced instead of
  // looking like a real model that happens to have no rate.
  if (dayInput + dayOutput + dayCache <= 0 && dayCost <= 0) return [];
  const dayRequests = num(day.requests);
  const e = rowToEvent(
    {
      id: `daily:${dateKey}:all`,
      timestamp: dayFallbackTs,
      model: "unattributed",
      promptTokens: dayInput,
      completionTokens: dayOutput,
      cachedTokens: dayCache,
      cost: dayCost,
      requests: dayRequests > 0 ? dayRequests : 1,
      tokens: {
        prompt_tokens: dayInput,
        completion_tokens: dayOutput,
        cached_tokens: dayCache,
      },
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

/**
 * Emit the slice of a day that `byModel` did not cover.
 *
 * Kept as a separate "unattributed" row so the per-model rows stay priceable
 * (the rate table is keyed by model) instead of collapsing the whole day into
 * one unpricable "mixed" blob. Returns null when there is nothing material left.
 */
function remainderRow(
  dateKey: string,
  agent: AgentId,
  source: string,
  timestamp: string,
  requests: number,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  dayCost: number,
  modelCost: number,
): UsageEvent | null {
  if (inputTokens + outputTokens + cacheReadTokens <= 0 && requests <= 0) return null;
  const cost = Math.max(0, dayCost - modelCost);
  const e = rowToEvent(
    {
      id: `daily:${dateKey}:unattributed`,
      timestamp,
      model: "unattributed",
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      cachedTokens: cacheReadTokens,
      cost,
      requests: requests > 0 ? requests : 1,
      tokens: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        cached_tokens: cacheReadTokens,
      },
    },
    agent,
    source,
    `daily-${dateKey}-unattributed`,
  );
  if (!e) return null;
  e.id = stableId(agent, "daily-rollup", dateKey, "unattributed");
  e.estimated = true;
  e.requestCount = requests > 0 ? requests : 1;
  return e;
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
  const promptDetails =
    (tokensObj.prompt_tokens_details && typeof tokensObj.prompt_tokens_details === "object"
      ? (tokensObj.prompt_tokens_details as Record<string, unknown>)
      : null) ||
    (tokensObj.promptTokensDetails && typeof tokensObj.promptTokensDetails === "object"
      ? (tokensObj.promptTokensDetails as Record<string, unknown>)
      : null) ||
    (tokensObj.input_tokens_details && typeof tokensObj.input_tokens_details === "object"
      ? (tokensObj.input_tokens_details as Record<string, unknown>)
      : null);

  const cacheReadTokens = num(
    tokensObj.cached_tokens ??
      tokensObj.cache_read_tokens ??
      tokensObj.cache_read_input_tokens ??
      tokensObj.cacheReadTokens ??
      tokensObj.cachedReadTokens ??
      tokensObj.cached_content_token_count ??
      promptDetails?.cached_tokens ??
      promptDetails?.cache_read_tokens ??
      promptDetails?.cachedTokens ??
      promptDetails?.cache_read_input_tokens ??
      r.cachedTokens ??
      r.cached_tokens ??
      r.cacheReadTokens ??
      r.cache_read_input_tokens ??
      r.cache_read_tokens,
  );
  const cacheWriteTokens = num(
    tokensObj.cache_write_tokens ??
      tokensObj.cache_creation_input_tokens ??
      tokensObj.cacheWriteTokens ??
      tokensObj.cache_creation_tokens ??
      promptDetails?.cache_write_tokens ??
      promptDetails?.cache_creation_input_tokens ??
      r.cacheWriteTokens ??
      r.cache_write_tokens ??
      r.cache_creation_input_tokens,
  );

  /**
   * Did the source actually expose a cache field, even as an explicit zero?
   *
   * Router exports (LiteLLM `cachedTokens`, 9router `cached_tokens`, …) always
   * carry the key, so a `0` there is a *measurement* ("this request re-used no
   * cache"), not silence. Without this flag the dashboard cannot tell the two
   * apart and renders CACHE $ as "—" for every router bucket — litellm included
   * — even while it is carrying billions of real cache-read tokens.
   */
  const hasCacheField =
    tokensObj.cached_tokens != null ||
    tokensObj.cache_read_tokens != null ||
    tokensObj.cache_read_input_tokens != null ||
    tokensObj.cacheReadTokens != null ||
    tokensObj.cachedReadTokens != null ||
    tokensObj.cached_content_token_count != null ||
    tokensObj.cache_write_tokens != null ||
    tokensObj.cache_creation_input_tokens != null ||
    tokensObj.cacheWriteTokens != null ||
    tokensObj.cache_creation_tokens != null ||
    promptDetails?.cached_tokens != null ||
    promptDetails?.cache_read_tokens != null ||
    promptDetails?.cachedTokens != null ||
    promptDetails?.cache_read_input_tokens != null ||
    promptDetails?.cache_write_tokens != null ||
    promptDetails?.cache_creation_input_tokens != null ||
    r.cachedTokens != null ||
    r.cached_tokens != null ||
    r.cacheReadTokens != null ||
    r.cache_read_input_tokens != null ||
    r.cache_read_tokens != null ||
    r.cacheWriteTokens != null ||
    r.cache_write_tokens != null ||
    r.cache_creation_input_tokens != null;

  const requestHint = num(r.requests ?? r.requestCount ?? r.request_count);
  const routerCostHint = num(
    r.cost ?? r.estimatedCost ?? r.usd,
  );

  /**
   * LiteLLM's prompt count is INCLUSIVE of cache reads — split it into our buckets.
   *
   * `litellm/cost_calculator.py` L455-460 states the invariant outright:
   *
   *   - Claude-Fable-compatible: usage.prompt_tokens_details.cached_tokens
   *     (prompt_tokens already INCLUDES cached_tokens)
   *
   * and `litellm/proxy/spend_tracking/spend_tracking_utils.py` L762-765 maps
   * `prompt_tokens_details.cached_tokens` onto `cache_read_input_tokens`, which the
   * VPS UI then exports as the row's `cachedTokens`. So for litellm, `cachedTokens`
   * is the cache-HIT count and a SUBSET of `promptTokens` — never a second bucket.
   *
   * TokenLab keeps input and cache-read apart, so subtract the hit out of the prompt
   * count: `inputTokens + cacheReadTokens === promptTokens` exactly. Without this the
   * hit was counted in both columns and `totalTokens` overstated the prompt by 4.5B.
   *
   * Only rows that actually publish a cache count are split. LiteLLM bills the hit at
   * `cache_read_input_token_cost` only for those rows; the Claude-Fable-compatible
   * aggregate rows in this mirror carry no cache field at all and were billed at the
   * plain input rate (verified: claude-fable-5 cost = 10*prompt + 50*out on every
   * billed row), so splitting them would invent a discount LiteLLM never charged.
   */
  let effectiveInputTokens = inputTokens;
  if (agent === "litellm" && cacheReadTokens > 0) {
    const billedCacheRead = Math.min(cacheReadTokens, inputTokens);
    effectiveInputTokens = inputTokens - billedCacheRead;
  }

  // Empty stream probes (0 tokens, 0 cost) must never become usage events —
  // even when a caller stamps requests:1. VPS dailySummary already ignores them.
  if (
    effectiveInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0 &&
    routerCostHint <= 0
  ) {
    return null;
  }
  if (
    effectiveInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0 &&
    requestHint <= 0
  ) {
    return null;
  }

  const model = routerModelFromRecord(agent, r);
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
      String(effectiveInputTokens),
      String(outputTokens),
      ts,
      connectionId,
      modelLabel || "",
    ),
    agent,
    model: modelLabel,
    timestamp: ts,
    inputTokens: effectiveInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    workspace: provider ? `provider:${provider}` : null,
    sourcePath: source,
    requestCount,
    cacheReported: hasCacheField,
    routerCost: hasRouterCostField && routerCostRaw > 0 ? routerCostRaw : null,
  });

  // keep endpoint lightly in workspace when useful
  if (endpoint && !event.workspace) {
    event.workspace = endpoint;
  }
  event.requestCount = requestCount;

  return event;
}
