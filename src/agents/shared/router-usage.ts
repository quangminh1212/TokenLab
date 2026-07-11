import path from "node:path";
import { applyPricing } from "../../pricing.js";
import type { AgentId, UsageEvent } from "../../types.js";
import { normalizeModelName, num, pathExists, readText, stableId } from "../../util.js";

/**
 * Shared parser for 9router / xlabrouter local data.
 *
 * Sources:
 *  1. SQLite usageHistory + usageDaily (9router production)
 *  2. usage.json / db.json usageData.history
 *  3. usage-history.jsonl / request-details.jsonl exports
 *  4. dailySummary / usage-daily.json (xlabrouter DATA_DIR + mirrors)
 *
 * Reconciliation (per calendar day, avoid double-count):
 *  - If event-level rows cover ≥95% of that day's daily.requests → keep events
 *  - Else if daily rollup exists → use daily synthetic events (drop sparse events)
 *  - Else keep whatever event-level rows exist
 *
 * Why: 9router usageHistory is capped (~134k) while usageDaily holds full day
 * totals (~218k req). xlabrouter history is a short rolling window (~200) while
 * dailySummary holds full multi-day totals (~433k req).
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

    // 1) SQLite history + daily
    for (const dbRel of ["db/data.sqlite", "data.sqlite", "db.sqlite"]) {
      const dbPath = path.join(root, dbRel);
      if (!(await pathExists(dbPath))) continue;
      pushEvents(await parseSqliteUsage(dbPath, agent));
      const daily = await parseSqliteDaily(dbPath);
      if (daily) dailyMaps.push({ source: dbPath + "#usageDaily", daily });
    }

    // 2) usage.json
    const usagePath = path.join(root, "usage.json");
    if (await pathExists(usagePath)) {
      pushEvents(await parseUsageJsonFile(usagePath, agent));
      const daily = await readDailySummaryFromJsonFile(usagePath);
      if (daily) dailyMaps.push({ source: usagePath, daily });
    }

    // 3) db.json → usageData
    const dbJsonPath = path.join(root, "db.json");
    if (await pathExists(dbJsonPath)) {
      pushEvents(await parseDbJsonUsage(dbJsonPath, agent));
      const daily = await readDailySummaryFromDbJson(dbJsonPath);
      if (daily) dailyMaps.push({ source: dbJsonPath, daily });
    }

    // 4) exported history / request-details
    for (const name of [
      "usage-history.jsonl",
      "usage-history.json",
      "usageHistory.json",
      "request-details.jsonl",
      "request-details.json",
    ]) {
      const p = path.join(root, name);
      if (!(await pathExists(p))) continue;
      pushEvents(await parseHistoryExport(p, agent));
    }

    // 5) usageData.json + usage-daily.json mirrors
    const usageDataPath = path.join(root, "usageData.json");
    if (await pathExists(usageDataPath)) {
      pushEvents(await parseUsageJsonFile(usageDataPath, agent));
      const daily = await readDailySummaryFromJsonFile(usageDataPath);
      if (daily) dailyMaps.push({ source: usageDataPath, daily });
    }
    const dailyPath = path.join(root, "usage-daily.json");
    if (await pathExists(dailyPath)) {
      const daily = await readDailySummaryStandalone(dailyPath);
      if (daily) dailyMaps.push({ source: dailyPath, daily });
    }
  }

  return reconcileEventsAndDaily(eventLevel, dailyMaps, agent);
}

/** Merge event-level + daily rollups without double-counting the same calendar day. */
function reconcileEventsAndDaily(
  eventLevel: UsageEvent[],
  dailyMaps: Array<{ source: string; daily: Record<string, unknown> }>,
  agent: AgentId,
): UsageEvent[] {
  // Merge all daily maps (later sources override same dateKey if richer)
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
    const dailyReq = daily ? num(daily.day.requests) : 0;
    const eventCount = dayEvents.length;

    // Prefer event-level when it covers nearly all daily requests
    if (eventCount > 0 && (dailyReq <= 0 || eventCount >= dailyReq * 0.95)) {
      out.push(...dayEvents);
      continue;
    }

    // Prefer complete daily rollup when history is missing/sparse
    if (daily) {
      out.push(...expandOneDay(dateKey, daily.day, agent, daily.source));
      continue;
    }

    // No daily — keep whatever events we have
    out.push(...dayEvents);
  }

  return out;
}

async function parseSqliteUsage(dbPath: string, agent: AgentId): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
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
             LIMIT 200000`,
          )
          .all() as Array<Record<string, unknown>>;
      } catch {
        // older / alternate schema
        try {
          rows = db
            .prepare(`SELECT * FROM usageHistory ORDER BY rowid DESC LIMIT 200000`)
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

async function readDailySummaryStandalone(file: string): Promise<Record<string, unknown> | null> {
  const text = await readText(file);
  if (!text) return null;
  try {
    const data = JSON.parse(text) as unknown;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Expand one dailySummary / usageDaily day into synthetic UsageEvents. */
function expandOneDay(
  dateKey: string,
  day: Record<string, unknown>,
  agent: AgentId,
  source: string,
): UsageEvent[] {
  const dayInput = num(day.promptTokens ?? day.prompt_tokens);
  const dayOutput = num(day.completionTokens ?? day.completion_tokens);
  const dayCost = num(day.cost);

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
      const e = rowToEvent(
        {
          id: `daily:${dateKey}:${modelKey}`,
          timestamp: `${dateKey}T12:00:00.000Z`,
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
      timestamp: `${dateKey}T12:00:00.000Z`,
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
      return historyToEvents(rows, agent, file);
    }
    const data = JSON.parse(text) as unknown;
    return historyToEvents(extractHistoryArray(data), agent, file);
  } catch {
    return [];
  }
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

  const ts =
    (typeof r.timestamp === "string" && r.timestamp) ||
    (typeof r.createdAt === "string" && r.createdAt) ||
    (typeof r.date === "string" && r.date) ||
    new Date().toISOString();

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
