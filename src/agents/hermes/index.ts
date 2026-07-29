import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";

import path from "node:path";
import { applyPricing } from "../../pricing.js";
import type { UsageEvent } from "../../types.js";
import { num, parseJsonl, pathExists, readText, stableId, walkFiles } from "../../util.js";
import { extractModel, extractTimestamp, extractTokenBuckets } from "../shared/usage-fields.js";

/**
 * Hermes Agent (`%LOCALAPPDATA%/hermes` / `~/.hermes`):
 * - Prefer session_model_usage (per-model, slightly more complete than sessions rollup)
 * - Fall back to sessions table
 * - JSONL only under sessions/ (skip node_modules / venv noise)
 * - Never double-parse the same DB; skip obvious backups when live DB exists
 */
export async function parseHermes(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const seenDb = new Set<string>();

  for (const root of roots) {
    if (!(await pathExists(root))) continue;

    const dbPaths = await discoverHermesDbPaths(root);
    for (const dbPath of dbPaths) {
      const key = path.resolve(dbPath).toLowerCase();
      if (seenDb.has(key)) continue;
      seenDb.add(key);
      events.push(...(await parseHermesSqlite(dbPath)));
    }

    // JSONL / session JSON under sessions/ only (not hermes-agent source trees)
    const sessionsDir = path.join(root, "sessions");
    if (await pathExists(sessionsDir)) {
      const files = await walkFiles(sessionsDir, {
        maxDepth: 6,
        match: (n) => n.endsWith(".jsonl") || (n.includes("session") && n.endsWith(".json")),
      });
      for (const file of files) {
        events.push(...(await parseHermesJsonFile(file)));
      }
    }
  }

  return events;
}

/** Discover SQLite DBs that hold Hermes usage (live + unique historical snapshots). */
async function discoverHermesDbPaths(root: string): Promise<string[]> {
  const out: string[] = [];
  const preferNames = ["state.db", "hermes.db", "sessions.db"];

  for (const name of preferNames) {
    const p = path.join(root, name);
    if (await pathExists(p)) out.push(p);
  }

  // Nested DBs (maxDepth small): include state-snapshots for history not in live DB
  const nested = await walkFiles(root, {
    maxDepth: 5,
    match: (n) => n === "state.db" || n === "hermes.db" || n === "sessions.db",
  });
  for (const p of nested) {
    const base = path.basename(p).toLowerCase();
    // Skip WAL/SHM companions (not matched) and kanban/projects/verification DBs
    if (!preferNames.map((n) => n.toLowerCase()).includes(base)) continue;
    // Skip .bak copies next to live files
    if (p.toLowerCase().includes(".bak")) continue;
    out.push(p);
  }

  // Unique by resolved path
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const p of out) {
    const k = path.resolve(p).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(p);
  }
  return uniq;
}

async function parseHermesJsonFile(file: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const text = await readText(file);
  if (!text) return events;

  // Skip error request dumps (no usage counters)
  if (file.includes("request_dump_") && !text.includes("input_tokens") && !text.includes("usage")) {
    return events;
  }

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
      const has = (name: string) =>
        tableNames.some((n) => n.toLowerCase() === name.toLowerCase());

      // 1) Prefer per-model rollups (real model ids: Kimi-k3, claude-opus-4.8, …)
      if (has("session_model_usage")) {
        const fromSmu = readSessionModelUsage(db, dbPath);
        if (fromSmu.length > 0) {
          events.push(...fromSmu);
          return events;
        }
      }

      // 2) Session-level rollups
      const sessionTable =
        tableNames.find((n) => n.toLowerCase() === "sessions") ||
        tableNames.find((n) => n.toLowerCase().includes("session"));
      if (sessionTable) {
        events.push(...readSessionsTable(db, dbPath, sessionTable));
      }

      // 3) Messages only when no session rollups (token_count alone is not billed usage)
      if (events.length === 0) {
        const msgTable = tableNames.find((n) => /^messages?$/i.test(n));
        if (msgTable) {
          events.push(...readMessagesUsage(db, dbPath, msgTable));
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

function readSessionModelUsage(
  db: { prepare: (sql: string) => { all: () => unknown[] } },
  dbPath: string,
): UsageEvent[] {
  const events: UsageEvent[] = [];
  try {
    const rows = db.prepare(`SELECT * FROM session_model_usage`).all() as Array<
      Record<string, unknown>
    >;
    // Optional join timestamps from sessions
    let sessionTs = new Map<string, string>();
    let sessionCwd = new Map<string, string | null>();
    try {
      const sess = db.prepare(`SELECT id, started_at, ended_at, cwd FROM sessions`).all() as Array<
        Record<string, unknown>
      >;
      for (const s of sess) {
        const id = String(s.id ?? "");
        if (!id) continue;
        sessionTs.set(id, extractTimestamp(s.ended_at ?? s.started_at, s));
        sessionCwd.set(id, typeof s.cwd === "string" ? s.cwd : null);
      }
    } catch {
      /* no sessions table */
    }

    let i = 0;
    for (const row of rows) {
      i += 1;
      const buckets = tokenBucketsFromHermesRow(row);
      if (!buckets) continue;

      const sessionId = String(row.session_id ?? i);
      const model =
        (typeof row.model === "string" && row.model.trim()) ||
        extractModel(row) ||
        null;
      const ts =
        extractTimestamp(row.last_seen, row.first_seen, row) ||
        sessionTs.get(sessionId) ||
        new Date().toISOString();
      const cost = pickHermesCost(row);
      const apiCalls = num(row.api_call_count);

      const priced = applyPricing({
        id: stableId(
          "hermes",
          dbPath,
          "smu",
          sessionId,
          model || "unknown",
          String(buckets.inputTokens),
          String(buckets.outputTokens),
        ),
        agent: "hermes",
        model,
        timestamp: ts,
        ...buckets,
        workspace: sessionCwd.get(sessionId) ?? null,
        sourcePath: dbPath,
        ...(apiCalls > 0 ? { requestCount: Math.floor(apiCalls) } : {}),
        ...(cost != null ? { routerCost: cost } : {}),
      });
      events.push(priced);
    }
  } catch {
    /* schema variance */
  }
  return events;
}

function readSessionsTable(
  db: { prepare: (sql: string) => { all: () => unknown[] } },
  dbPath: string,
  sessionTable: string,
): UsageEvent[] {
  const events: UsageEvent[] = [];
  try {
    const cols = (
      db.prepare(`PRAGMA table_info(${quoteIdent(sessionTable)})`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    const colset = new Set(cols.map((c) => c.toLowerCase()));
    const pick = (...names: string[]) => names.find((n) => colset.has(n.toLowerCase()));

    const modelCol = pick("model", "model_id", "model_name");
    const modelConfigCol = pick("model_config");
    const inCol = pick("input_tokens", "total_input_tokens", "prompt_tokens", "input");
    const outCol = pick("output_tokens", "total_output_tokens", "completion_tokens", "output");
    const crCol = pick("cache_read_tokens", "cache_read_input_tokens", "cache_read");
    const cwCol = pick("cache_write_tokens", "cache_creation_input_tokens", "cache_write");
    const reasonCol = pick("reasoning_tokens", "reasoning");
    const tsCol = pick("ended_at", "started_at", "created_at", "timestamp", "updated_at", "start_time");
    const idCol = pick("id", "session_id", "uuid");
    const cwdCol = pick("cwd", "workdir", "workspace", "project");
    const apiCol = pick("api_call_count", "request_count");

    if (!inCol && !outCol) return events;

    const rows = db.prepare(`SELECT * FROM ${quoteIdent(sessionTable)}`).all() as Array<
      Record<string, unknown>
    >;
    let i = 0;
    for (const row of rows) {
      i += 1;
      const inputTokens = inCol ? num(row[inCol]) : 0;
      let outputTokens = outCol ? num(row[outCol]) : 0;
      const cacheReadTokens = crCol ? num(row[crCol]) : 0;
      const cacheWriteTokens = cwCol ? num(row[cwCol]) : 0;
      const reasoning = reasonCol ? num(row[reasonCol]) : 0;
      // Hermes stores reasoning separately; bill as output when not already covered
      if (reasoning > 0 && outputTokens > 0 && reasoning > outputTokens) {
        outputTokens = reasoning;
      } else if (reasoning > 0 && outputTokens === 0) {
        outputTokens = reasoning;
      } else if (reasoning > 0) {
        // reasoning typically subset of generation — do not double-add when already in output
      }

      if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0) continue;

      let model =
        modelCol && typeof row[modelCol] === "string" ? String(row[modelCol]) : null;
      // Prefer concrete model from model_config when rollup label is a gateway alias
      if (modelConfigCol && typeof row[modelConfigCol] === "string") {
        try {
          const cfg = JSON.parse(String(row[modelConfigCol])) as Record<string, unknown>;
          const cfgModel = typeof cfg.model === "string" ? cfg.model : null;
          if (cfgModel && (!model || isGatewayAlias(model))) model = cfgModel;
        } catch {
          /* ignore */
        }
      }

      const tsRaw = tsCol ? row[tsCol] : null;
      const timestamp = extractTimestamp(tsRaw, row);
      const workspace = cwdCol && typeof row[cwdCol] === "string" ? String(row[cwdCol]) : null;
      const sid = idCol ? String(row[idCol] ?? i) : String(i);
      const cost = pickHermesCost(row);
      const apiCalls = apiCol ? num(row[apiCol]) : 0;

      events.push(
        applyPricing({
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
          ...(apiCalls > 0 ? { requestCount: Math.floor(apiCalls) } : {}),
          ...(cost != null ? { routerCost: cost } : {}),
        }),
      );
    }
  } catch {
    /* schema variance */
  }
  return events;
}

function readMessagesUsage(
  db: { prepare: (sql: string) => { all: () => unknown[] } },
  dbPath: string,
  msgTable: string,
): UsageEvent[] {
  const events: UsageEvent[] = [];
  try {
    const rows = db
      .prepare(`SELECT * FROM ${quoteIdent(msgTable)} LIMIT 50000`)
      .all() as Array<Record<string, unknown>>;
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
    /* schema variance */
  }
  return events;
}

function tokenBucketsFromHermesRow(row: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} | null {
  const inputTokens = num(
    row.input_tokens ?? row.total_input_tokens ?? row.prompt_tokens ?? row.inputTokens,
  );
  let outputTokens = num(
    row.output_tokens ?? row.total_output_tokens ?? row.completion_tokens ?? row.outputTokens,
  );
  const cacheReadTokens = num(
    row.cache_read_tokens ?? row.cache_read_input_tokens ?? row.cacheReadTokens,
  );
  const cacheWriteTokens = num(
    row.cache_write_tokens ?? row.cache_creation_input_tokens ?? row.cacheWriteTokens,
  );
  const reasoning = num(row.reasoning_tokens ?? row.reasoningTokens);
  if (reasoning > 0 && outputTokens === 0) outputTokens = reasoning;
  else if (reasoning > 0 && reasoning > outputTokens) outputTokens = reasoning;

  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0) return null;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

/** Prefer actual_cost_usd, then estimated_cost_usd when positive. */
function pickHermesCost(row: Record<string, unknown>): number | null {
  for (const key of ["actual_cost_usd", "estimated_cost_usd", "cost_usd", "cost"] as const) {
    if (row[key] == null) continue;
    const v = Number(row[key]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

function isGatewayAlias(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m === "xlab" || m === "hermes" || m === "default" || m === "auto" || m === "custom";
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export const agent: AgentModule = {
  id: "hermes",
  label: "Hermes Agent",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path: p, expandHome } = pathEnv();
    return unique([
      expandHome(process.env.HERMES_HOME || p.join(localApp, "hermes")),
      p.join(localApp, "hermes"),
      p.join(home, ".hermes"),
      p.join(appData, "hermes"),
      p.join(xdgData, "hermes"),
      p.join(xdgConfig, "hermes"),
    ]);
  },
  parse: parseHermes,
};
