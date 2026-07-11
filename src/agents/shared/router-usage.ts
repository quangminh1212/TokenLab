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
 *  3. db.json → usageData.history
 *
 * History row shape (either source):
 *  { provider, model, tokens: { prompt_tokens, completion_tokens, cached_tokens? },
 *    timestamp, cost?, connectionId?, endpoint?, apiKey? }
 *  or flat columns: promptTokens, completionTokens, cost, tokens (JSON string)
 */
export async function parseRouterUsage(
  roots: string[],
  agent: AgentId,
): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    if (!(await pathExists(root))) continue;

    // 1) SQLite (preferred when present)
    for (const dbRel of ["db/data.sqlite", "data.sqlite", "db.sqlite"]) {
      const dbPath = path.join(root, dbRel);
      if (await pathExists(dbPath)) {
        for (const e of await parseSqliteUsage(dbPath, agent)) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          events.push(e);
        }
      }
    }

    // 2) usage.json
    const usagePath = path.join(root, "usage.json");
    if (await pathExists(usagePath)) {
      for (const e of await parseUsageJsonFile(usagePath, agent)) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        events.push(e);
      }
    }

    // 3) db.json → usageData
    const dbJsonPath = path.join(root, "db.json");
    if (await pathExists(dbJsonPath)) {
      for (const e of await parseDbJsonUsage(dbJsonPath, agent)) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        events.push(e);
      }
    }

    // 4) exported history dump (VPS mirror / manual export)
    for (const name of ["usage-history.jsonl", "usage-history.json", "usageHistory.json"]) {
      const p = path.join(root, name);
      if (!(await pathExists(p))) continue;
      for (const e of await parseHistoryExport(p, agent)) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        events.push(e);
      }
    }
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

  const routerCost = num(r.cost ?? r.estimatedCost ?? r.usd);
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

  // Prefer router-reported cost when present (already billed estimate from 9router)
  if (routerCost > 0) {
    event.estimatedCost = routerCost;
    event.pricingStatus = "priced";
  }

  // keep endpoint lightly in workspace when useful
  if (endpoint && !event.workspace) {
    event.workspace = endpoint;
  }

  return event;
}
