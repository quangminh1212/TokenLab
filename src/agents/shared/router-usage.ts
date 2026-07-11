import path from "node:path";
import { applyPricing } from "../../pricing.js";
import type { AgentId, UsageEvent } from "../../types.js";
import { num, pathExists, readText, stableId } from "../../util.js";

/**
 * Shared parser for 9router / xlabrouter local data.
 *
 * Sources (in priority order per root):
 *  1. db/data.sqlite → usageHistory (current production schema)
 *  2. usage.json → { history: [...] }
 *  3. db.json → usageData.history (+ dailySummary gap-fill)
 *  4. usage-history.jsonl / request-details.jsonl exports
 *  5. usage-daily.json / usageData.json exports (xlabrouter DATA_DIR mirrors)
 *
 * History row shape (either source):
 *  { provider, model, tokens: { prompt_tokens, completion_tokens, cached_tokens? },
 *    timestamp, cost?, connectionId?, endpoint?, apiKey? }
 *  or flat columns: promptTokens, completionTokens, cost, tokens (JSON string)
 *
 * xlabrouter often keeps only a short rolling `history` (e.g. 200 rows) while
 * `dailySummary` holds full multi-day totals — we gap-fill missing days from daily.
 */
export async function parseRouterUsage(
  roots: string[],
  agent: AgentId,
): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const seen = new Set<string>();
  const dailyBuckets: Array<{ source: string; daily: Record<string, unknown> }> = [];

  const pushAll = (batch: UsageEvent[]) => {
    for (const e of batch) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      events.push(e);
    }
  };

  for (const root of roots) {
    if (!(await pathExists(root))) continue;

    // 1) SQLite (preferred when present)
    for (const dbRel of ["db/data.sqlite", "data.sqlite", "db.sqlite"]) {
      const dbPath = path.join(root, dbRel);
      if (await pathExists(dbPath)) {
        pushAll(await parseSqliteUsage(dbPath, agent));
      }
    }

    // 2) usage.json
    const usagePath = path.join(root, "usage.json");
    if (await pathExists(usagePath)) {
      pushAll(await parseUsageJsonFile(usagePath, agent));
      const daily = await readDailySummaryFromJsonFile(usagePath);
      if (daily) dailyBuckets.push({ source: usagePath, daily });
    }

    // 3) db.json → usageData
    const dbJsonPath = path.join(root, "db.json");
    if (await pathExists(dbJsonPath)) {
      pushAll(await parseDbJsonUsage(dbJsonPath, agent));
      const daily = await readDailySummaryFromDbJson(dbJsonPath);
      if (daily) dailyBuckets.push({ source: dbJsonPath, daily });
    }

    // 4) exported history / request-details dumps (VPS mirror)
    for (const name of [
      "usage-history.jsonl",
      "usage-history.json",
      "usageHistory.json",
      "request-details.jsonl",
      "request-details.json",
    ]) {
      const p = path.join(root, name);
      if (!(await pathExists(p))) continue;
      pushAll(await parseHistoryExport(p, agent));
    }

    // 5) usageData.json export + usage-daily.json
    const usageDataPath = path.join(root, "usageData.json");
    if (await pathExists(usageDataPath)) {
      pushAll(await parseUsageJsonFile(usageDataPath, agent));
      const daily = await readDailySummaryFromJsonFile(usageDataPath);
      if (daily) dailyBuckets.push({ source: usageDataPath, daily });
    }
    const dailyPath = path.join(root, "usage-daily.json");
    if (await pathExists(dailyPath)) {
      const daily = await readDailySummaryStandalone(dailyPath);
      if (daily) dailyBuckets.push({ source: dailyPath, daily });
    }
  }

  // Gap-fill: days present in dailySummary but missing (or sparse) in event-level history
  const daysWithEvents = new Set<string>();
  const eventCountByDay = new Map<string, number>();
  for (const e of events) {
    const day = (e.timestamp || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    daysWithEvents.add(day);
    eventCountByDay.set(day, (eventCountByDay.get(day) || 0) + 1);
  }

  for (const { source, daily } of dailyBuckets) {
    pushAll(expandDailySummary(daily, agent, source, daysWithEvents, eventCountByDay));
  }

  return events;
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

/**
 * Expand dailySummary into synthetic UsageEvents (one per model per day).
 * Skips days that already have dense event-level history (>= 50% of daily.requests).
 */
function expandDailySummary(
  daily: Record<string, unknown>,
  agent: AgentId,
  source: string,
  daysWithEvents: Set<string>,
  eventCountByDay: Map<string, number>,
): UsageEvent[] {
  const out: UsageEvent[] = [];
  for (const [dateKey, raw] of Object.entries(daily)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
    if (!raw || typeof raw !== "object") continue;
    const day = raw as Record<string, unknown>;
    const existing = eventCountByDay.get(dateKey) || 0;
    // Prefer event-level rows when any exist for this day (avoids double-counting
    // short rolling history against the same day's dailySummary rollup).
    if (existing > 0) continue;

    const byModel = day.byModel;
    if (byModel && typeof byModel === "object" && !Array.isArray(byModel)) {
      for (const [modelKey, mraw] of Object.entries(byModel as Record<string, unknown>)) {
        if (!mraw || typeof mraw !== "object") continue;
        const m = mraw as Record<string, unknown>;
        const model =
          (typeof m.rawModel === "string" && m.rawModel) ||
          modelKey.split("|")[0] ||
          modelKey;
        const provider = typeof m.provider === "string" ? m.provider : null;
        const inputTokens = num(m.promptTokens ?? m.prompt_tokens ?? m.inputTokens);
        const outputTokens = num(m.completionTokens ?? m.completion_tokens ?? m.outputTokens);
        const cost = num(m.cost);
        if (inputTokens + outputTokens <= 0 && cost <= 0) continue;
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
      continue;
    }

    // Fallback: single rollup for the day
    const inputTokens = num(day.promptTokens ?? day.prompt_tokens);
    const outputTokens = num(day.completionTokens ?? day.completion_tokens);
    const cost = num(day.cost);
    if (inputTokens + outputTokens <= 0 && cost <= 0) continue;
    const e = rowToEvent(
      {
        id: `daily:${dateKey}:all`,
        timestamp: `${dateKey}T12:00:00.000Z`,
        model: "mixed",
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        cost,
        tokens: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
      },
      agent,
      source,
      `daily-${dateKey}`,
    );
    if (e) {
      e.estimated = true;
      out.push(e);
    }
  }
  return out;
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

  const model =
    (typeof r.model === "string" && r.model) ||
    (typeof r.rawModel === "string" && r.rawModel) ||
    null;
  const provider = typeof r.provider === "string" ? r.provider : null;
  const modelLabel = model || provider || null;

  const ts =
    (typeof r.timestamp === "string" && r.timestamp) ||
    (typeof r.createdAt === "string" && r.createdAt) ||
    (typeof r.date === "string" && r.date) ||
    new Date().toISOString();

  // Prefer router-reported cost when the field exists (including 0 — free/internal calls).
  // Only fall back to bundled price table when cost is absent.
  const hasRouterCost =
    r.cost != null ||
    r.estimatedCost != null ||
    r.usd != null ||
    (typeof r.meta === "object" &&
      r.meta != null &&
      ((r.meta as Record<string, unknown>).cost != null ||
        (r.meta as Record<string, unknown>).estimatedCost != null));
  const routerCost = num(
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
  });

  if (hasRouterCost) {
    event.estimatedCost = routerCost;
    event.pricingStatus = routerCost > 0 ? "priced" : "zero_rate";
  }

  // keep endpoint lightly in workspace when useful
  if (endpoint && !event.workspace) {
    event.workspace = endpoint;
  }

  return event;
}
