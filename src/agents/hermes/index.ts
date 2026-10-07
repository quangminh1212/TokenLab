import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { applyPricing } from "../../pricing.js";
import type { UsageEvent } from "../../types.js";
import { num, pathExists, readJsonCached, readJsonlCached, stableId, walkFiles } from "../../util.js";
import {
  extractModel,
  extractTimestamp,
  extractTokenBuckets,
  resolveSpanMs,
  splitUsageRow,
} from "../shared/usage-fields.js";

/**
 * Hermes Agent (`%LOCALAPPDATA%/hermes` / `~/.hermes`):
 * Policy: prefer over-count over missing usage (thừa hơn thiếu).
 * - session_model_usage (per-model) + gap-fill from sessions when session total is higher
 * - Always bill reasoning_tokens on top of output (Hermes stores them separately)
 * - state-snapshots: only sessions NOT already covered by live state.db (no double-count)
 * - JSONL only under sessions/ (skip node_modules / venv noise)
 */
export async function parseHermes(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const seenDb = new Set<string>();
  /** Session ids already counted from a preferred (live) DB — snapshots must skip these. */
  const coveredSessions = new Set<string>();

  for (const root of roots) {
    if (!(await pathExists(root))) continue;

    const { primary, snapshots } = await discoverHermesDbPaths(root);

    // 1) Live / primary DBs first (full read)
    for (const dbPath of primary) {
      const key = path.resolve(dbPath).toLowerCase();
      if (seenDb.has(key)) continue;
      seenDb.add(key);
      const { events: ev, sessionIds } = await parseHermesSqlite(dbPath, null);
      events.push(...ev);
      for (const sid of sessionIds) coveredSessions.add(sid);
    }

    // 2) Snapshots only for sessions missing from live (history after prune / migrate)
    for (const dbPath of snapshots) {
      const key = path.resolve(dbPath).toLowerCase();
      if (seenDb.has(key)) continue;
      seenDb.add(key);
      const { events: ev, sessionIds } = await parseHermesSqlite(dbPath, coveredSessions);
      events.push(...ev);
      for (const sid of sessionIds) coveredSessions.add(sid);
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

function isSnapshotDbPath(dbPath: string): boolean {
  const p = dbPath.toLowerCase().replace(/\\/g, "/");
  return p.includes("/state-snapshots/") || p.includes("/snapshots/") || p.includes("/state-snapshot/");
}

/** Discover SQLite DBs: primary (live) first, then historical snapshots. */
async function discoverHermesDbPaths(root: string): Promise<{ primary: string[]; snapshots: string[] }> {
  const preferNames = ["state.db", "hermes.db", "sessions.db"];
  const primary: string[] = [];
  const snapshots: string[] = [];

  for (const name of preferNames) {
    const p = path.join(root, name);
    if (await pathExists(p)) primary.push(p);
  }

  // Nested DBs: state-snapshots for history not in live DB
  const nested = await walkFiles(root, {
    maxDepth: 5,
    match: (n) => n === "state.db" || n === "hermes.db" || n === "sessions.db",
  });
  for (const p of nested) {
    const base = path.basename(p).toLowerCase();
    if (!preferNames.map((n) => n.toLowerCase()).includes(base)) continue;
    // Skip .bak / emergency pre-update copies
    if (p.toLowerCase().includes(".bak")) continue;
    if (p.toLowerCase().includes("pre-update-emergency")) continue;
    if (isSnapshotDbPath(p)) snapshots.push(p);
    else {
      // Nested non-snapshot (e.g. profiles/*/state.db) — treat as primary only if not already listed
      primary.push(p);
    }
  }

  const dedupe = (list: string[]) => {
    const seen = new Set<string>();
    const uniq: string[] = [];
    for (const p of list) {
      const k = path.resolve(p).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(p);
    }
    return uniq;
  };

  return { primary: dedupe(primary), snapshots: dedupe(snapshots) };
}

async function parseHermesJsonFile(file: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  // Cached by (size, mtime): unchanged files skip read + JSON.parse.
  const rows: unknown[] = file.endsWith(".jsonl")
    ? ((await readJsonlCached(file)) ?? [])
    : ((await readJsonCached(file)) ?? []);
  if (rows.length === 0) return events;

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

async function parseHermesSqlite(
  dbPath: string,
  /** When set (snapshots), skip any session already counted in a preferred DB. */
  skipSessionIds: Set<string> | null,
): Promise<{ events: UsageEvent[]; sessionIds: string[] }> {
  const events: UsageEvent[] = [];
  const sessionIds: string[] = [];
  const noteSession = (sid: string) => {
    if (sid) sessionIds.push(sid);
  };
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

      const sessionTable =
        tableNames.find((n) => n.toLowerCase() === "sessions") ||
        tableNames.find((n) => n.toLowerCase().includes("session") && !n.toLowerCase().includes("model"));

      // 1) Per-model rollups (real model ids: Kimi-k3, claude-opus-4.8, …)
      let smuEvents: UsageEvent[] = [];
      if (has("session_model_usage")) {
        smuEvents = readSessionModelUsage(db, dbPath, skipSessionIds, noteSession);
        events.push(...smuEvents);
      }

      // 2) Sessions: full rows when no SMU; gap-fill when session total > SMU sum
      if (sessionTable) {
        if (smuEvents.length === 0 && !has("session_model_usage")) {
          events.push(...readSessionsTable(db, dbPath, sessionTable, skipSessionIds, noteSession));
        } else if (smuEvents.length === 0 && has("session_model_usage") && skipSessionIds) {
          // Snapshot: SMU all skipped as overlap → still try sessions-only for unknown sids
          events.push(...readSessionsTable(db, dbPath, sessionTable, skipSessionIds, noteSession));
        } else if (smuEvents.length > 0) {
          events.push(
            ...gapFillSessionsOverSmu(db, dbPath, sessionTable, smuEvents, skipSessionIds, noteSession),
          );
        } else {
          events.push(...readSessionsTable(db, dbPath, sessionTable, skipSessionIds, noteSession));
        }
      }

      // 3) Messages only as last resort floor (token_count alone is weak)
      if (events.length === 0 && !skipSessionIds) {
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
  return { events, sessionIds };
}

/**
 * When a session rollup is richer than the sum of its SMU rows, emit a gap event
 * for the positive deltas only (over-count policy: never leave session tokens on the floor).
 */
function gapFillSessionsOverSmu(
  db: { prepare: (sql: string) => { all: () => unknown[] } },
  dbPath: string,
  sessionTable: string,
  smuEvents: UsageEvent[],
  skipSessionIds: Set<string> | null,
  noteSession: (sid: string) => void,
): UsageEvent[] {
  void smuEvents; // presence means SMU was scanned; gaps re-sum from SQL below
  const smuBySession = new Map<
    string,
    { input: number; output: number; cacheRead: number; cacheWrite: number; reqs: number }
  >();

  try {
    const sums = db
      .prepare(
        `SELECT session_id as sid,
          SUM(COALESCE(input_tokens,0)) as input,
          SUM(COALESCE(output_tokens,0)) as output,
          SUM(COALESCE(cache_read_tokens,0)) as cache_read,
          SUM(COALESCE(cache_write_tokens,0)) as cache_write,
          SUM(COALESCE(reasoning_tokens,0)) as reasoning,
          SUM(COALESCE(api_call_count,0)) as reqs
         FROM session_model_usage
         GROUP BY session_id`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const r of sums) {
      const sid = String(r.sid ?? "");
      if (!sid) continue;
      const out = num(r.output) + num(r.reasoning); // reasoning billed on top
      smuBySession.set(sid, {
        input: num(r.input),
        output: out,
        cacheRead: num(r.cache_read),
        cacheWrite: num(r.cache_write),
        reqs: num(r.reqs),
      });
    }
  } catch {
    /* no SMU table */
  }

  const gaps: UsageEvent[] = [];
  try {
    const rows = db.prepare(`SELECT * FROM ${quoteIdent(sessionTable)}`).all() as Array<
      Record<string, unknown>
    >;
    for (const row of rows) {
      const sid = String(row.id ?? row.session_id ?? "");
      if (!sid) continue;
      if (skipSessionIds?.has(sid)) continue;
      noteSession(sid);
      const sIn = num(row.input_tokens ?? row.total_input_tokens ?? row.prompt_tokens);
      let sOut = num(row.output_tokens ?? row.total_output_tokens ?? row.completion_tokens);
      const sCr = num(row.cache_read_tokens ?? row.cache_read_input_tokens);
      const sCw = num(row.cache_write_tokens ?? row.cache_creation_input_tokens);
      const sReason = num(row.reasoning_tokens);
      // Over-count: always add reasoning to session output
      if (sReason > 0) sOut += sReason;

      const u = smuBySession.get(sid) ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reqs: 0,
      };

      const dIn = Math.max(0, sIn - u.input);
      const dOut = Math.max(0, sOut - u.output);
      const dCr = Math.max(0, sCr - u.cacheRead);
      const dCw = Math.max(0, sCw - u.cacheWrite);
      if (dIn + dOut + dCr + dCw <= 0) continue;

      let model = typeof row.model === "string" ? row.model : null;
      if (typeof row.model_config === "string") {
        try {
          const cfg = JSON.parse(String(row.model_config)) as Record<string, unknown>;
          if (typeof cfg.model === "string" && (!model || isGatewayAlias(model))) model = cfg.model;
        } catch {
          /* ignore */
        }
      }

      const apiCalls = Math.max(0, num(row.api_call_count) - u.reqs);
      const cost = pickHermesCost(row);
      gaps.push(
        applyPricing({
          id: stableId("hermes", dbPath, "gap", sid, String(dIn), String(dOut), String(dCr)),
          agent: "hermes",
          model,
          timestamp: extractTimestamp(row.ended_at ?? row.started_at, row),
          inputTokens: dIn,
          outputTokens: dOut,
          cacheReadTokens: dCr,
          cacheWriteTokens: dCw,
          workspace: typeof row.cwd === "string" ? row.cwd : null,
          sourcePath: dbPath,
          estimated: true,
          ...(apiCalls > 0 ? { requestCount: Math.floor(apiCalls) } : {}),
          // Don't apply full session cost to a partial gap
          ...(cost != null && u.input + u.output === 0 ? { routerCost: cost } : {}),
        }),
      );
    }
  } catch {
    /* schema variance */
  }
  return gaps;
}

function readSessionModelUsage(
  db: { prepare: (sql: string) => { all: () => unknown[] } },
  dbPath: string,
  skipSessionIds: Set<string> | null,
  noteSession: (sid: string) => void,
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
      if (skipSessionIds?.has(sessionId)) continue;
      noteSession(sessionId);
      let model =
        (typeof row.model === "string" && row.model.trim()) ||
        extractModel(row) ||
        null;
      // Prefer concrete model from model_config when rollup label is a gateway alias
      if (typeof row.model_config === "string") {
        try {
          const cfg = JSON.parse(String(row.model_config)) as Record<string, unknown>;
          const cfgModel = typeof cfg.model === "string" ? cfg.model : null;
          if (cfgModel && (!model || isGatewayAlias(model))) model = cfgModel;
        } catch {
          /* ignore */
        }
      }
      const ts =
        extractTimestamp(row.last_seen, row.first_seen, row) ||
        sessionTs.get(sessionId) ||
        new Date().toISOString();
      const cost = pickHermesCost(row);
      const apiCalls = num(row.api_call_count);

      // Identity/metadata shared by both the single-row and split-row paths.
      // Tokens, cost and timestamp are added per path so the split rows cannot
      // accidentally inherit the whole session's totals.
      const base = {
        id: stableId(
          "hermes",
          dbPath,
          "smu",
          sessionId,
          model || "unknown",
          String(buckets.inputTokens),
          String(buckets.outputTokens),
        ),
        agent: "hermes" as const,
        model,
        workspace: sessionCwd.get(sessionId) ?? null,
        sourcePath: dbPath,
      };

      // This row is a per-model SESSION SUMMARY: one aggregate api_call_count for
      // the whole session. Split it across the session's real first_seen→last_seen
      // span so per-minute RPM and per-day attribution stay truthful. Without
      // this, a 3135-call session spanning 25h was billed as 3135 req in the
      // single minute of its last_seen timestamp (peak RPM 3135, all of it
      // dumped into the wrong calendar day).
      //
      // splitUsageRow apportions every additive field (requests, tokens, cost)
      // so the split rows sum back to the original totals instead of
      // duplicating them once per minute.
      const span = apiCalls > 0 ? resolveSpanMs(row.first_seen, row.last_seen) : null;
      if (span && apiCalls > 0) {
        const parts = splitUsageRow(
          {
            requestCount: apiCalls,
            inputTokens: buckets.inputTokens,
            outputTokens: buckets.outputTokens,
            cacheReadTokens: buckets.cacheReadTokens,
            cacheWriteTokens: buckets.cacheWriteTokens,
            ...(cost != null ? { estimatedCost: cost } : {}),
          },
          apiCalls,
          span[0],
          span[1],
        );
        for (let p = 0; p < parts.length; p++) {
          const part = parts[p]!;
          const { estimatedCost, ...tokenPiece } = part;
          events.push(
            applyPricing({
              ...base,
              // Suffix keeps each split row distinct and stable across rescans.
              id: parts.length > 1 ? `${base.id}-s${p}` : base.id,
              // This row's share of the session's tokens ...
              inputTokens: tokenPiece.inputTokens ?? 0,
              outputTokens: tokenPiece.outputTokens ?? 0,
              cacheReadTokens: tokenPiece.cacheReadTokens ?? 0,
              cacheWriteTokens: tokenPiece.cacheWriteTokens ?? 0,
              requestCount: tokenPiece.requestCount ?? 0,
              timestamp: part.timestamp,
              // ... and of its cost, passed as the router-reported cost so
              // applyPricing does not re-price the whole session onto every row.
              ...(cost != null && estimatedCost != null
                ? { routerCost: estimatedCost }
                : {}),
            }),
          );
        }
      } else {
        events.push(
          applyPricing({
            ...base,
            ...buckets,
            timestamp: ts,
            ...(cost != null ? { routerCost: cost } : {}),
            ...(apiCalls > 0 ? { requestCount: Math.floor(apiCalls) } : {}),
          }),
        );
      }
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
  skipSessionIds: Set<string> | null,
  noteSession: (sid: string) => void,
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
      const sid = idCol ? String(row[idCol] ?? i) : String(i);
      if (skipSessionIds?.has(sid)) continue;

      const inputTokens = inCol ? num(row[inCol]) : 0;
      let outputTokens = outCol ? num(row[outCol]) : 0;
      const cacheReadTokens = crCol ? num(row[crCol]) : 0;
      const cacheWriteTokens = cwCol ? num(row[cwCol]) : 0;
      const reasoning = reasonCol ? num(row[reasonCol]) : 0;
      // Policy: thừa hơn thiếu — always add reasoning_tokens as output
      if (reasoning > 0) outputTokens += reasoning;

      if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0) continue;
      noteSession(sid);

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
      const cost = pickHermesCost(row);
      const apiCalls = apiCol ? num(row[apiCol]) : 0;

      const startCol = pick("started_at", "first_seen", "created_at", "start_time");
      const endCol = pick("ended_at", "last_seen", "updated_at", "last_activity_at");
      const base = {
        id: stableId("hermes", dbPath, sid, String(inputTokens), String(outputTokens)),
        agent: "hermes" as const,
        model,
        workspace,
        sourcePath: dbPath,
      };

      // Same session-summary shape as above: split the aggregate call count over
      // the session's real start→end span instead of stamping it all on one
      // instant (which faked a huge per-minute peak). Tokens and cost are
      // apportioned too, so the split rows sum back to the session totals.
      const span =
        apiCalls > 0 && startCol && endCol
          ? resolveSpanMs(row[startCol], row[endCol])
          : null;
      if (span && apiCalls > 0) {
        const parts = splitUsageRow(
          {
            requestCount: apiCalls,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            ...(cost != null ? { estimatedCost: cost } : {}),
          },
          apiCalls,
          span[0],
          span[1],
        );
        for (let p = 0; p < parts.length; p++) {
          const part = parts[p]!;
          const { estimatedCost, ...tokenPiece } = part;
          events.push(
            applyPricing({
              ...base,
              id: parts.length > 1 ? `${base.id}-s${p}` : base.id,
              inputTokens: tokenPiece.inputTokens ?? 0,
              outputTokens: tokenPiece.outputTokens ?? 0,
              cacheReadTokens: tokenPiece.cacheReadTokens ?? 0,
              cacheWriteTokens: tokenPiece.cacheWriteTokens ?? 0,
              requestCount: tokenPiece.requestCount ?? 0,
              timestamp: part.timestamp,
              ...(cost != null && estimatedCost != null
                ? { routerCost: estimatedCost }
                : {}),
            }),
          );
        }
      } else {
        events.push(
          applyPricing({
            ...base,
            timestamp,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            ...(cost != null ? { routerCost: cost } : {}),
            ...(apiCalls > 0 ? { requestCount: Math.floor(apiCalls) } : {}),
          }),
        );
      }
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
    row.cache_read_tokens ??
      row.cache_read_input_tokens ??
      row.cacheReadTokens ??
      row.cached_tokens ??
      row.cachedTokens ??
      row.cached_content_token_count,
  );
  const cacheWriteTokens = num(
    row.cache_write_tokens ??
      row.cache_creation_input_tokens ??
      row.cacheWriteTokens ??
      row.cache_creation_tokens,
  );
  // Policy: thừa hơn thiếu — Hermes stores reasoning separately; always bill it as output.
  const reasoning = num(row.reasoning_tokens ?? row.reasoningTokens);
  if (reasoning > 0) outputTokens += reasoning;

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

/**
 * Last light-scan fingerprint per root set. Missing until that home is read
 * once. Later ticks with the same files return [] and the server keeps the
 * cached history. Keyed by roots so two homes do not erase each other.
 */
const hermesLightStampByRoot = new Map<string, string>();

const HERMES_DB_NAMES = ["state.db", "hermes.db", "sessions.db"];

/**
 * Session listing from the last light stamp. A quiet tick stats the directory
 * and the few session files that can be rewritten. It does not walk request
 * dumps again. A new file updates the directory mtime and drops this memo.
 */
type HermesSessionMemo = {
  dirMtime: number;
  subdirs: Array<{ dir: string; mtime: number }>;
  files: string[];
  sig: string;
  part: string;
};

const hermesSessionMemo = new Map<string, HermesSessionMemo>();

function hermesSessionFile(name: string): boolean {
  return name.endsWith(".jsonl") || (name.includes("session") && name.endsWith(".json"));
}

async function stampFile(file: string, parts: string[]): Promise<void> {
  try {
    const st = await stat(file);
    parts.push(`${file}|${st.size}`);
  } catch {
    /* missing */
  }
}

async function hermesSessionSubdirs(
  sessionsDir: string,
): Promise<Array<{ dir: string; mtime: number }>> {
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ dir: string; mtime: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(sessionsDir, entry.name);
    try {
      const st = await stat(dir);
      out.push({ dir, mtime: Math.floor(st.mtimeMs) });
    } catch {
      /* gone */
    }
  }
  return out;
}

async function stampHermesSessionFiles(
  files: string[],
): Promise<{ sig: string; bytes: number } | null> {
  const bits: string[] = [];
  let bytes = 0;
  for (const file of files) {
    try {
      const st = await stat(file);
      bits.push(`${file}|${st.size}`);
      bytes += st.size;
    } catch {
      return null;
    }
  }
  bits.sort();
  return { sig: bits.join("\n"), bytes };
}

/** True when no session file was created or removed since the memo was stored. */
async function hermesSessionShapeMatches(
  sessionsDir: string,
  memo: HermesSessionMemo,
): Promise<boolean> {
  let dirMtime = 0;
  try {
    dirMtime = Math.floor((await stat(sessionsDir)).mtimeMs);
  } catch {
    return false;
  }
  if (dirMtime !== memo.dirMtime) return false;
  for (const sub of memo.subdirs) {
    try {
      if (Math.floor((await stat(sub.dir)).mtimeMs) !== sub.mtime) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function appendHermesSessions(root: string, parts: string[]): Promise<void> {
  const sessionsDir = path.join(root, "sessions");
  if (!(await pathExists(sessionsDir))) return;
  const key = path.resolve(sessionsDir).toLowerCase();
  const memo = hermesSessionMemo.get(key);
  if (memo && (await hermesSessionShapeMatches(sessionsDir, memo))) {
    const stamped = await stampHermesSessionFiles(memo.files);
    if (stamped && stamped.sig === memo.sig) {
      parts.push(memo.part);
      return;
    }
    if (stamped) {
      const part = `sessions:${root}|${memo.files.length}|${stamped.bytes}`;
      hermesSessionMemo.set(key, { ...memo, sig: stamped.sig, part });
      parts.push(part);
      return;
    }
  }

  let dirMtime = 0;
  try {
    dirMtime = Math.floor((await stat(sessionsDir)).mtimeMs);
  } catch {
    return;
  }
  const files = await walkFiles(sessionsDir, {
    maxDepth: 6,
    match: (n) => hermesSessionFile(n),
  });
  const stamped = await stampHermesSessionFiles(files);
  const part = `sessions:${root}|${files.length}|${stamped?.bytes ?? 0}`;
  hermesSessionMemo.set(key, {
    dirMtime,
    subdirs: await hermesSessionSubdirs(sessionsDir),
    files,
    sig: stamped?.sig ?? "",
    part,
  });
  parts.push(part);
}

/**
 * Fingerprint live Hermes inputs without reading them.
 * Includes the SQLite WAL size (writes often land there before state.db grows)
 * and session file sizes. Mtime is ignored: a read or a mirror touch rewrites
 * it without new usage. Skips -shm: opening the DB for read rewrites it.
 */
async function hermesSourceStamp(roots: string[]): Promise<string> {
  const parts: string[] = [];
  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    for (const name of HERMES_DB_NAMES) {
      await stampFile(path.join(root, name), parts);
      await stampFile(path.join(root, `${name}-wal`), parts);
    }
    const profiles = path.join(root, "profiles");
    if (await pathExists(profiles)) {
      let entries: import("node:fs").Dirent[] = [];
      try {
        entries = await readdir(profiles, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        for (const name of HERMES_DB_NAMES) {
          const db = path.join(profiles, entry.name, name);
          await stampFile(db, parts);
          await stampFile(`${db}-wal`, parts);
        }
      }
    }
    await appendHermesSessions(root, parts);
  }
  parts.sort();
  return parts.join("\n");
}

/**
 * Minute scan. Unchanged files return no rows so the server keeps the cached
 * history (including snapshot DBs already loaded by a full scan). A changed
 * DB or session file runs the full parser, which remains the complete read.
 */
export async function parseHermesLight(roots: string[]): Promise<UsageEvent[]> {
  const rootKey = roots
    .map((root) => path.resolve(root).toLowerCase())
    .sort()
    .join("|");
  const stamp = await hermesSourceStamp(roots);
  if (hermesLightStampByRoot.get(rootKey) === stamp) return [];
  const events = await parseHermes(roots);
  // Opening the DB can bump the WAL mtime. Store the stamp after that read
  // so the next quiet tick does not parse the same history again.
  hermesLightStampByRoot.set(rootKey, await hermesSourceStamp(roots));
  return events;
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
  parseLight: parseHermesLight,
};
