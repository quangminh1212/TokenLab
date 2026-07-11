import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";

import path from "node:path";
import { applyPricing } from "../../pricing.js";
import type { UsageEvent } from "../../types.js";
import { num, parseJsonl, pathExists, readText, stableId, walkFiles } from "../../util.js";
import { extractModel, extractTimestamp, extractTokenBuckets } from "../shared/usage-fields.js";

/**
 * Hermes Agent:
 * - Primary: ~/.hermes/state.db (sessions table) via node:sqlite
 * - Fallback: JSONL / JSON under HERMES_HOME
 */
export async function parseHermes(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];

  for (const root of roots) {
    if (!(await pathExists(root))) continue;

    // SQLite state.db
    for (const dbName of ["state.db", "hermes.db", "sessions.db"]) {
      const dbPath = path.join(root, dbName);
      if (await pathExists(dbPath)) {
        events.push(...(await parseHermesSqlite(dbPath)));
      }
    }

    // Nested state.db
    const nestedDbs = await walkFiles(root, {
      maxDepth: 4,
      match: (n) => n === "state.db" || n.endsWith(".db"),
    });
    for (const dbPath of nestedDbs) {
      if (path.basename(dbPath) === "state.db" || path.basename(dbPath).includes("hermes")) {
        events.push(...(await parseHermesSqlite(dbPath)));
      }
    }

    // JSONL fallback
    const files = await walkFiles(root, {
      maxDepth: 8,
      match: (n) => n.endsWith(".jsonl") || (n.includes("session") && n.endsWith(".json")),
    });
    for (const file of files) {
      const text = await readText(file);
      if (!text) continue;
      const rows = file.endsWith(".jsonl")
        ? parseJsonl(text)
        : (() => {
            try {
              const d = JSON.parse(text);
              return Array.isArray(d) ? d : [d];
            } catch {
              return [];
            }
          })();

      let idx = 0;
      for (const row of rows) {
        idx += 1;
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>;
        const buckets = extractTokenBuckets(r.usage ?? r.token_usage ?? r);
        if (!buckets) {
          // session rollup fields
          const inputTokens = num(r.input_tokens ?? r.total_input_tokens ?? r.prompt_tokens);
          const outputTokens = num(r.output_tokens ?? r.total_output_tokens ?? r.completion_tokens);
          const cacheReadTokens = num(r.cache_read_tokens ?? r.cache_read_input_tokens);
          const cacheWriteTokens = num(r.cache_write_tokens ?? r.cache_creation_input_tokens);
          if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0) continue;
          events.push(
            applyPricing({
              id: stableId("hermes", file, String(idx), String(inputTokens), String(outputTokens)),
              agent: "hermes",
              model: extractModel(r),
              timestamp: extractTimestamp(r),
              inputTokens,
              outputTokens,
              cacheReadTokens,
              cacheWriteTokens,
              workspace: typeof r.cwd === "string" ? r.cwd : null,
              sourcePath: file,
            }),
          );
          continue;
        }
        events.push(
          applyPricing({
            id: stableId("hermes", file, String(idx), String(buckets.inputTokens), String(buckets.outputTokens)),
            agent: "hermes",
            model: extractModel(r),
            timestamp: extractTimestamp(r),
            ...buckets,
            workspace: typeof r.cwd === "string" ? r.cwd : null,
            sourcePath: file,
          }),
        );
      }
    }
  }

  return events;
}

async function parseHermesSqlite(dbPath: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);

      const sessionTable =
        tableNames.find((n) => n.toLowerCase() === "sessions") ||
        tableNames.find((n) => n.toLowerCase().includes("session"));

      if (sessionTable) {
        const cols = (
          db.prepare(`PRAGMA table_info(${quoteIdent(sessionTable)})`).all() as Array<{ name: string }>
        ).map((c) => c.name);
        const colset = new Set(cols.map((c) => c.toLowerCase()));

        const pick = (...names: string[]) => names.find((n) => colset.has(n.toLowerCase()));

        const modelCol = pick("model", "model_id", "model_name");
        const inCol = pick("input_tokens", "total_input_tokens", "prompt_tokens", "input");
        const outCol = pick("output_tokens", "total_output_tokens", "completion_tokens", "output");
        const crCol = pick("cache_read_tokens", "cache_read_input_tokens", "cache_read");
        const cwCol = pick("cache_write_tokens", "cache_creation_input_tokens", "cache_write");
        const tsCol = pick("started_at", "created_at", "timestamp", "updated_at", "start_time");
        const idCol = pick("id", "session_id", "uuid");
        const cwdCol = pick("cwd", "workdir", "workspace", "project");
        const costCol = pick("actual_cost_usd", "estimated_cost_usd", "cost_usd", "cost");

        if (inCol || outCol || costCol) {
          const rows = db.prepare(`SELECT * FROM ${quoteIdent(sessionTable)}`).all() as Array<
            Record<string, unknown>
          >;
          let i = 0;
          for (const row of rows) {
            i += 1;
            const inputTokens = inCol ? num(row[inCol]) : 0;
            const outputTokens = outCol ? num(row[outCol]) : 0;
            const cacheReadTokens = crCol ? num(row[crCol]) : 0;
            const cacheWriteTokens = cwCol ? num(row[cwCol]) : 0;
            if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0 && !costCol) continue;
            if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0) continue;

            const model = modelCol && typeof row[modelCol] === "string" ? String(row[modelCol]) : null;
            const tsRaw = tsCol ? row[tsCol] : null;
            const timestamp = extractTimestamp(tsRaw, row);
            const workspace = cwdCol && typeof row[cwdCol] === "string" ? String(row[cwdCol]) : null;
            const sid = idCol ? String(row[idCol] ?? i) : String(i);

            const priced = applyPricing({
              id: stableId("hermes", dbPath, sid, String(inputTokens), String(outputTokens)),
              agent: "hermes",
              model,
              timestamp,
              inputTokens,
              outputTokens,
              cacheReadTokens,
              cacheWriteTokens,
              workspace,
              sourcePath: dbPath,
            });

            // Prefer vendor cost when present
            if (costCol && row[costCol] != null && Number.isFinite(Number(row[costCol]))) {
              priced.estimatedCost = Number(row[costCol]);
              priced.pricingStatus = "priced";
            }
            events.push(priced);
          }
        }
      }

      // Also try messages table for per-turn usage
      const msgTable = tableNames.find((n) => /message/i.test(n));
      if (msgTable) {
        try {
          const rows = db.prepare(`SELECT * FROM ${quoteIdent(msgTable)} LIMIT 50000`).all() as Array<
            Record<string, unknown>
          >;
          let i = 0;
          for (const row of rows) {
            i += 1;
            const buckets = extractTokenBuckets(row);
            if (!buckets) continue;
            events.push(
              applyPricing({
                id: stableId("hermes", dbPath, "msg", String(i), String(buckets.inputTokens)),
                agent: "hermes",
                model: extractModel(row),
                timestamp: extractTimestamp(row),
                ...buckets,
                workspace: null,
                sourcePath: dbPath,
              }),
            );
          }
        } catch {
          // schema variance
        }
      }
    } finally {
      db.close();
    }
  } catch {
    // node:sqlite unavailable or locked db — skip
  }
  return events;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}


export const agent: AgentModule = {
  id: "hermes",
  label: "Hermes Agent",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      expandHome(process.env.HERMES_HOME || path.join(home, ".hermes")),
      path.join(home, ".hermes"),
      path.join(appData, "hermes"),
      path.join(localApp, "hermes"),
      path.join(xdgData, "hermes"),
      path.join(xdgConfig, "hermes"),
    ]);
  },
  parse: parseHermes,
};
