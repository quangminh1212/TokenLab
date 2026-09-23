import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";

import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { applyPricing } from "../../pricing.js";
import type { UsageEvent } from "../../types.js";
import {
  appDataDir,
  homeDir,
  parseJsonl,
  pathExists,
  readText,
  stableId,
  walkFiles,
} from "../../util.js";
import {
  extractModel,
  extractTimestamp,
  extractTokenBuckets,
  type TokenBuckets,
} from "../shared/usage-fields.js";
import { liteLlmRoots } from "../litellm/index.js";
import { nineRouterRoots } from "../9router/index.js";

/** Skip Codex plugin fixtures / temp trees (fake usage with no real timestamps). */
function isNoisePath(full: string): boolean {
  const n = full.replace(/\\/g, "/").toLowerCase();
  const bad = [
    "/.tmp/",
    "/fixtures/",
    "/fixture/",
    "/plugin-eval/",
    "/observed-usage/",
    "/__tests__/",
    "/testdata/",
    "/mocks/",
    "/vendor_imports/",
    "/node_modules/",
  ];
  return bad.some((b) => n.includes(b));
}

interface ProxyUsageRow {
  id: string;
  tsMs: number;
  modelKey: string;
  modelRaw: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  sourcePath: string;
}

interface TurnBucket {
  startMs: number;
  endMs: number;
  userChars: number;
  asstChars: number;
  reasonChars: number;
  toolOutChars: number;
  model: string | null;
}

// Minute light scans must not keep reparsing duplicated, unchanged Codex/Orca
// histories. Full scans bypass this signature cache and remain authoritative.
const LIGHT_RESCAN_SKIP_BYTES = 8 * 1024 * 1024;
const lightFileSignatures = new Map<string, string>();

/**
 * Deep Codex support:
 * - ~/.codex/sessions (rollout-*.jsonl date tree) — classic layout
 * - archived / history / session logs
 * - state_*.sqlite threads.tokens_used + rollout_path (newer desktop/CLI)
 * - token_count events (absolute + cumulative)
 * - response.completed / event.usage shapes
 * - when token_count.info is null (common with custom 9router/LiteLLM providers):
 *     attribute matching LiteLLM/9Router history by turn windows, else estimate from content
 * - cwd/workspace from session meta when present
 */
interface ParseCodexOptions {
  recentOnly?: boolean;
  recentWindowMs?: number;
}

export async function parseCodex(roots: string[]): Promise<UsageEvent[]> {
  return parseCodexInternal(roots);
}

/**
 * Cheap hot-path parser used by the server's 60s tick. Codex appends to the
 * current rollout file, so checking only recently modified files is enough to
 * pick up new turns without re-reading the entire ~/.codex tree.
 */
export async function parseCodexLight(roots: string[]): Promise<UsageEvent[]> {
  return parseCodexInternal(roots, { recentOnly: true, recentWindowMs: 15 * 60_000 });
}

async function parseCodexInternal(
  roots: string[],
  options: ParseCodexOptions = {},
): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const seen = new Set<string>();
  const seenRollouts = new Set<string>();
  const seenFileSignatures = new Set<string>();
  const proxyIndex = await loadProxyUsageIndex(Boolean(options.recentOnly));
  const claimedProxyIds = new Set<string>();
  const recentCutoffMs = options.recentOnly
    ? Date.now() - (options.recentWindowMs ?? 15 * 60_000)
    : Number.NEGATIVE_INFINITY;

  for (const root of roots) {
    if (!(await pathExists(root))) continue;

    // Newer Codex: SQLite state (threads + tokens_used) even when sessions/ is empty
    if (!options.recentOnly) {
      events.push(...(await parseCodexSqliteState(root, seenRollouts, proxyIndex, claimedProxyIds)));
    }

    // Prefer real session trees; only fall back to root when those are absent
    const preferred = [
      path.join(root, "sessions"),
      path.join(root, "archived_sessions"),
      path.join(root, "session_index"),
      path.join(root, "history"),
      path.join(root, "logs"),
    ];
    const existingPreferred: string[] = [];
    for (const p of preferred) {
      if (await pathExists(p)) existingPreferred.push(p);
    }
    // Always include root so state/rollout files next to config are not missed when
    // an empty sessions/ folder exists (newer installs create dirs early).
    const scanRoots = existingPreferred.length > 0 ? [...existingPreferred, root] : [root];

    for (const base of scanRoots) {
      if (!(await pathExists(base))) continue;
      if (isNoisePath(base)) continue;
      const files = await walkFiles(base, {
        // In light mode the root itself is only for immediate files; the
        // session/history directories above still get their full depth.
        maxDepth: options.recentOnly && base === root ? 1 : 12,
        match: (n, full) => {
          if (isNoisePath(full)) return false;
          return (
            n.endsWith(".jsonl") ||
            n.startsWith("rollout-") ||
            (n.includes("session") && (n.endsWith(".json") || n.endsWith(".jsonl")))
          );
        },
      });
      // The Codex app keeps the active rollout file open and, on Windows, may
      // not update its filesystem mtime for every append. Keep the newest few
      // rollout files from the session directory in the light pass as a
      // fallback to mtime filtering.
      const hotRolloutFiles = options.recentOnly
        ? new Set(
            files
              .filter((file) => path.basename(file).startsWith("rollout-"))
              .sort()
              .slice(-4),
          )
        : new Set<string>();

      for (const file of files) {
        if (seen.has(file) || seenRollouts.has(file.toLowerCase())) continue;
        if (isNoisePath(file)) continue;
        seen.add(file);
        let fileMtime = new Date(0);
        let fileSize = -1;
        try {
          const st = await stat(file);
          fileMtime = st.mtime;
          fileSize = st.size;
        } catch {
          // ignore
        }
        if (fileMtime.getTime() < recentCutoffMs && !hotRolloutFiles.has(file)) continue;

        let signature = "";
        if (fileSize >= 0) {
          let relative = path.relative(root, file).replace(/\\/g, "/");
          if (process.platform === "win32") relative = relative.toLowerCase();
          signature = `${relative}|${fileSize}|${Math.trunc(fileMtime.getTime())}`;
          // The same relative rollout often exists under both .codex and Orca
          // roots. Read it once per scan when size and mtime match.
          if (seenFileSignatures.has(signature)) continue;
          seenFileSignatures.add(signature);
          const fileKey = process.platform === "win32" ? file.toLowerCase() : file;
          if (
            options.recentOnly &&
            fileSize > LIGHT_RESCAN_SKIP_BYTES &&
            lightFileSignatures.get(fileKey) === signature
          ) {
            continue;
          }
        }

        const text = await readText(file);
        if (!text) continue;

        if (file.endsWith(".json") && !file.endsWith(".jsonl")) {
          try {
            const data = JSON.parse(text) as unknown;
            collectFromJson(events, data, file, fileMtime);
          } catch {
            // ignore
          }
          if (options.recentOnly && fileSize > LIGHT_RESCAN_SKIP_BYTES && signature) {
            const fileKey = process.platform === "win32" ? file.toLowerCase() : file;
            lightFileSignatures.set(fileKey, signature);
          }
          continue;
        }

        parseJsonlFile(events, text, file, fileMtime, proxyIndex, claimedProxyIds);
        if (options.recentOnly && fileSize > LIGHT_RESCAN_SKIP_BYTES && signature) {
          const fileKey = process.platform === "win32" ? file.toLowerCase() : file;
          lightFileSignatures.set(fileKey, signature);
        }
      }
    }
  }

  return events;
}

/**
 * Newer Codex (desktop/app-server) stores thread summaries in state_*.sqlite:
 * threads(id, rollout_path, model, tokens_used, cwd, created_at, updated_at, …)
 * When tokens_used > 0 emit one event; also follow rollout_path for detailed jsonl.
 * When tokens_used is 0, still follow rollout_path so null-info sessions get proxy/estimate fallback.
 */
async function parseCodexSqliteState(
  root: string,
  seenRollouts: Set<string>,
  proxyIndex: ProxyUsageRow[],
  claimedProxyIds: Set<string>,
): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const candidates: string[] = [];

  // Root-level state/logs DBs + nested sqlite/ folder
  try {
    const ents = await readdir(root, { withFileTypes: true });
    for (const e of ents) {
      if (!e.isFile()) continue;
      const n = e.name.toLowerCase();
      if (
        (n.startsWith("state_") && n.endsWith(".sqlite")) ||
        n === "state.sqlite" ||
        n === "sessions.db" ||
        (n.includes("state") && n.endsWith(".db"))
      ) {
        candidates.push(path.join(root, e.name));
      }
    }
  } catch {
    // ignore
  }
  const sqliteDir = path.join(root, "sqlite");
  if (await pathExists(sqliteDir)) {
    try {
      const ents = await readdir(sqliteDir, { withFileTypes: true });
      for (const e of ents) {
        if (!e.isFile()) continue;
        const n = e.name.toLowerCase();
        if (n.endsWith(".sqlite") || n.endsWith(".db")) {
          candidates.push(path.join(sqliteDir, e.name));
        }
      }
    } catch {
      // ignore
    }
  }

  for (const dbPath of candidates) {
    if (isNoisePath(dbPath)) continue;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        // Discover a threads-like table
        const tables = db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
          .all() as Array<{ name: string }>;
        const threadTable =
          tables.find((t) => t.name === "threads")?.name ||
          tables.find((t) => /thread/i.test(t.name) && !/catalog|edge|goal|tool/i.test(t.name))
            ?.name;
        if (!threadTable) continue;

        const cols = (
          db.prepare(`PRAGMA table_info(${threadTable})`).all() as Array<{ name: string }>
        ).map((c) => c.name);
        const colSet = new Set(cols.map((c) => c.toLowerCase()));
        // Need either tokens_used or rollout_path to be useful
        if (
          !colSet.has("tokens_used") &&
          !colSet.has("tokensused") &&
          !colSet.has("rollout_path") &&
          !colSet.has("rolloutpath")
        ) {
          continue;
        }

        const tokenCol = colSet.has("tokens_used")
          ? "tokens_used"
          : colSet.has("tokensused")
            ? "tokensUsed"
            : null;
        const idCol = colSet.has("id") ? "id" : cols[0]!;
        const modelCol = colSet.has("model") ? "model" : null;
        const cwdCol = colSet.has("cwd") ? "cwd" : null;
        const rolloutCol = colSet.has("rollout_path")
          ? "rollout_path"
          : colSet.has("rolloutpath")
            ? "rolloutPath"
            : null;
        const createdCol = colSet.has("created_at_ms")
          ? "created_at_ms"
          : colSet.has("created_at")
            ? "created_at"
            : colSet.has("updated_at_ms")
              ? "updated_at_ms"
              : colSet.has("updated_at")
                ? "updated_at"
                : null;
        const updatedCol = colSet.has("updated_at_ms")
          ? "updated_at_ms"
          : colSet.has("updated_at")
            ? "updated_at"
            : createdCol;

        const selectCols = [idCol, tokenCol, modelCol, cwdCol, rolloutCol, createdCol, updatedCol]
          .filter(Boolean)
          .join(", ");
        // Include zero-token threads so we still follow rollout_path for proxy attribution
        const rows = db
          .prepare(
            `SELECT ${selectCols} FROM ${threadTable}
             ORDER BY ${updatedCol || idCol} DESC
             LIMIT 50000`,
          )
          .all() as Array<Record<string, unknown>>;

        for (const row of rows) {
          const tokens = tokenCol ? Number(row[tokenCol] ?? 0) : 0;
          const tid = String(row[idCol] ?? "");
          const model =
            modelCol && typeof row[modelCol] === "string" && row[modelCol]
              ? String(row[modelCol])
              : "codex";
          const cwd =
            cwdCol && typeof row[cwdCol] === "string" && row[cwdCol]
              ? String(row[cwdCol])
              : null;
          const ts = coerceSqliteTime(row[updatedCol || ""] ?? row[createdCol || ""]);

          if (Number.isFinite(tokens) && tokens > 0) {
            // Codex threads.tokens_used is typically total tokens (input+output unknown split)
            // Attribute all to input so totals match; mark estimated for UI honesty.
            events.push(
              applyPricing({
                id: stableId("codex", dbPath.toLowerCase(), "thread", tid, String(tokens)),
                agent: "codex",
                model,
                timestamp: ts,
                inputTokens: Math.round(tokens),
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                workspace: cwd,
                sourcePath: dbPath,
                estimated: true,
              }),
            );
          }

          // Follow rollout jsonl for finer-grained events (or proxy/estimate fallback)
          const rp =
            rolloutCol && typeof row[rolloutCol] === "string"
              ? String(row[rolloutCol]).trim()
              : "";
          // Normalize Windows extended path \\?\C:\...
          const rolloutPath = rp.replace(/^\\\\\?\\/, "");
          if (rolloutPath && (await pathExists(rolloutPath)) && !isNoisePath(rolloutPath)) {
            const key = rolloutPath.toLowerCase();
            if (!seenRollouts.has(key)) {
              seenRollouts.add(key);
              try {
                const text = await readText(rolloutPath);
                if (text) {
                  let fileMtime = new Date(ts);
                  try {
                    fileMtime = (await stat(rolloutPath)).mtime;
                  } catch {
                    // ignore
                  }
                  const before = events.length;
                  parseJsonlFile(
                    events,
                    text,
                    rolloutPath,
                    fileMtime,
                    proxyIndex,
                    claimedProxyIds,
                  );
                  // If detailed events were parsed, drop the coarse thread summary for this id
                  // to avoid double-counting (jsonl usually has better split + more events).
                  if (events.length > before && Number.isFinite(tokens) && tokens > 0) {
                    const summaryId = stableId(
                      "codex",
                      dbPath.toLowerCase(),
                      "thread",
                      tid,
                      String(tokens),
                    );
                    const idx = events.findIndex((e) => e.id === summaryId);
                    if (idx >= 0) events.splice(idx, 1);
                  }
                }
              } catch {
                // ignore unreadable rollout
              }
            }
          }
        }
      } finally {
        db.close();
      }
    } catch {
      // locked / not sqlite / schema variance
    }
  }

  return events;
}

function coerceSqliteTime(v: unknown): string {
  if (typeof v === "string" && v.trim() && !Number.isNaN(Date.parse(v))) {
    return new Date(v).toISOString();
  }
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    // ms vs sec vs possible float seconds
    const ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : v > 1e8 ? v * 1000 : NaN;
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

type CodexTokenBuckets = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/**
 * Orca/Codex reports input_tokens as the full prompt when a cache field is
 * present. Keep cache reads as their own bucket and make input the uncached
 * portion so totals and pricing do not count the same tokens twice.
 */
function codexBuckets(usage: unknown): CodexTokenBuckets | null {
  const buckets = extractTokenBuckets(usage);
  if (!buckets) return null;
  return {
    inputTokens: Math.max(
      0,
      buckets.inputTokens - (buckets.inputIncludesCache ? buckets.cacheReadTokens : 0),
    ),
    outputTokens: Math.max(0, buckets.outputTokens),
    cacheReadTokens: Math.max(0, buckets.cacheReadTokens),
    cacheWriteTokens: Math.max(0, buckets.cacheWriteTokens),
  };
}

function codexBucketKey(buckets: CodexTokenBuckets): string {
  return [
    buckets.inputTokens,
    buckets.outputTokens,
    buckets.cacheReadTokens,
    buckets.cacheWriteTokens,
  ].join(":");
}

function isTokenUsageRecord(type: string, payloadType: string): boolean {
  return type === "token_usage_record" || payloadType === "token_usage_record";
}

function parseJsonlFile(
  events: UsageEvent[],
  text: string,
  file: string,
  fileMtime: Date,
  proxyIndex: ProxyUsageRow[],
  claimedProxyIds: Set<string>,
): void {
  const rows = parseJsonl(text);
  // Orca writes both a per-request token_usage_record and a token_count
  // snapshot for the same turn. The record is authoritative; snapshots are
  // only used when a record is absent (older/newer format variants).
  const tokenUsageRecordCounts = new Map<string, number>();
  const tokenUsageRecords: Array<{ tsMs: number; buckets: CodexTokenBuckets }> = [];
  const tokenUsageRecordCount = rows.reduce<number>((count, row) => {
    if (!row || typeof row !== "object") return count;
    const r = row as Record<string, unknown>;
    const type = String(r.type ?? r.event_type ?? r.kind ?? "");
    const payload =
      r.payload && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : null;
    const payloadType = payload ? String(payload.type ?? "") : "";
    if (!isTokenUsageRecord(type, payloadType)) return count;

    const found = findUsageObject(r, type);
    const usage =
      payload?.usage ??
        r.usage ??
        payload?.token_usage ??
        r.token_usage ??
        found?.obj;
    const buckets = codexBuckets(usage);
    if (!buckets) return count;
    const key = codexBucketKey(buckets);
    tokenUsageRecordCounts.set(key, (tokenUsageRecordCounts.get(key) ?? 0) + 1);
    const tsMs = Date.parse(extractTimestamp(r, r.payload, usage, fileMtime));
    if (Number.isFinite(tsMs)) tokenUsageRecords.push({ tsMs, buckets });
    return count + 1;
  }, 0);
  const consumedTokenUsageRecords = new Map<string, number>();

  let idx = 0;
  let lastIn = 0;
  let lastOut = 0;
  let lastCr = 0;
  let lastCw = 0;
  let model: string | null = null;
  let workspace: string | null = null;
  let cumulativeMode: boolean | null = null;
  let realTokenEvents = 0;
  const turns: TurnBucket[] = [];
  let curTurn: TurnBucket | null = null;
  let sessionStartMs = fileMtime.getTime();
  let sessionEndMs = fileMtime.getTime();

  for (const row of rows) {
    idx += 1;
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const type = String(r.type ?? r.event_type ?? r.kind ?? "");
    const payload =
      r.payload && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : null;
    const payloadType = payload ? String(payload.type ?? "") : "";
    const info =
      payload && payload.info && typeof payload.info === "object"
        ? (payload.info as Record<string, unknown>)
        : null;
    const rowTs = extractTimestamp(r, r.payload, fileMtime);
    const rowMs = Date.parse(rowTs);
    if (Number.isFinite(rowMs)) {
      if (rowMs < sessionStartMs) sessionStartMs = rowMs;
      if (rowMs > sessionEndMs) sessionEndMs = rowMs;
    }

    // session metadata
    model = extractModel(r, r.payload, r.message, model) || model;
    workspace =
      pickString(r, ["cwd", "workdir", "workspace", "project"]) ||
      pickString(r.payload, ["cwd", "workdir", "workspace"]) ||
      workspace;

    if (type === "model_change" || type === "session_meta") {
      model = extractModel(r, r.payload, model) || model;
      if (type === "session_meta" && payload) {
        const m = extractModel(payload, payload.model, model);
        if (m) model = m;
      }
      continue;
    }

    if (type === "turn_context" && payload) {
      model = extractModel(payload, model) || model;
    }

    // Turn tracking for proxy join / content estimate
    if (type === "event_msg" && payloadType === "task_started" && Number.isFinite(rowMs)) {
      curTurn = {
        startMs: rowMs,
        endMs: rowMs,
        userChars: 0,
        asstChars: 0,
        reasonChars: 0,
        toolOutChars: 0,
        model,
      };
    }
    if (curTurn) {
      if (type === "response_item" && payload) {
        const pt = String(payload.type ?? "");
        if (pt === "message") {
          const textLen = contentCharLen(payload.content);
          const role = String(payload.role ?? "");
          if (role === "user") curTurn.userChars += textLen;
          else if (role === "assistant") curTurn.asstChars += textLen;
        } else if (pt === "reasoning") {
          curTurn.reasonChars += contentCharLen(payload.summary ?? payload.content);
        } else if (pt === "function_call_output") {
          curTurn.toolOutChars += String(payload.output ?? "").length;
        }
      }
      if (type === "event_msg" && payloadType === "task_complete" && Number.isFinite(rowMs)) {
        curTurn.endMs = rowMs;
        curTurn.model = model || curTurn.model;
        turns.push(curTurn);
        curTurn = null;
      }
    }

    const tokenRecord = isTokenUsageRecord(type, payloadType);
    const tokenCountSnapshot = type === "event_msg" && payloadType === "token_count";
    const usageResult = findUsageObject(r, type);
    let perCallUsage = usageResult?.isPerCall ?? tokenRecord;
    let usageObj: unknown = usageResult?.obj;

    if (tokenCountSnapshot) {
      const info =
        payload?.info && typeof payload.info === "object"
          ? (payload.info as Record<string, unknown>)
          : null;
      const lastUsage = info?.last_token_usage;
      const lastBuckets = codexBuckets(lastUsage);

      if (tokenUsageRecordCount > 0 && lastBuckets) {
        const key = codexBucketKey(lastBuckets);
        const matched = consumedTokenUsageRecords.get(key) ?? 0;
        const available = tokenUsageRecordCounts.get(key) ?? 0;
        if (matched < available) {
          // This is the mirror snapshot for a record already emitted.
          consumedTokenUsageRecords.set(key, matched + 1);
          continue;
        }
        // A last_token_usage without a matching record is a useful per-call
        // fallback. It can happen when a rollout is still being written.
        usageObj = lastUsage;
        perCallUsage = true;
      } else if (tokenUsageRecordCount > 0) {
        // A cumulative snapshot without a per-turn value would duplicate all
        // records in this file, so leave it out.
        continue;
      } else if (lastBuckets && !info?.total_token_usage) {
        // Some versions emit only last_token_usage. Treat it as per-call.
        usageObj = lastUsage;
        perCallUsage = true;
      }
    }

    if (!usageObj) continue;

    const buckets = codexBuckets(usageObj);
    if (!buckets) continue;

    // token_count carries both last_token_usage and total_token_usage. When a
    // matching token_usage_record was written within the same turn, it is a
    // duplicate of the same request rather than an additional request.
    const isTokenCountMirror =
      payloadType === "token_count" && !!info?.last_token_usage && !!info?.total_token_usage;
    if (
      isTokenCountMirror &&
      tokenUsageRecords.some(
        (record) =>
          Math.abs(record.tsMs - rowMs) <= 2_000 && sameTokenBuckets(record.buckets, buckets),
      )
    ) {
      continue;
    }

    let { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = buckets;

    if (!perCallUsage) {
      // Detect cumulative counters (common in Codex token_count streams).
      const looksCumulative =
        cumulativeMode === true ||
        (inputTokens >= lastIn &&
          outputTokens >= lastOut &&
          (inputTokens > lastIn || outputTokens > lastOut) &&
          (lastIn > 0 || lastOut > 0 || type.includes("token")));

      if (looksCumulative && (inputTokens >= lastIn || outputTokens >= lastOut)) {
        cumulativeMode = true;
        const dIn = Math.max(0, inputTokens - lastIn);
        const dOut = Math.max(0, outputTokens - lastOut);
        const dCr = Math.max(0, cacheReadTokens - lastCr);
        const dCw = Math.max(0, cacheWriteTokens - lastCw);
        lastIn = inputTokens;
        lastOut = outputTokens;
        lastCr = cacheReadTokens;
        lastCw = cacheWriteTokens;
        inputTokens = dIn;
        outputTokens = dOut;
        cacheReadTokens = dCr;
        cacheWriteTokens = dCw;
      } else if (cumulativeMode !== true) {
        // per-call absolute values
        lastIn = 0;
        lastOut = 0;
        lastCr = 0;
        lastCw = 0;
      }
    }

    if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0) continue;

    // Prefer event time; never use "now" for fixtures-without-ts (causes perpetual "Just now")
    const ts = extractTimestamp(r, r.payload, usageObj, fileMtime);
    const rowModel = extractModel(r, r.payload, usageObj, model);

    realTokenEvents += 1;
    events.push(
      applyPricing({
        // Stable id without wall-clock "now" so rescans do not multiply rows
        id: stableId("codex", file, String(idx), String(inputTokens), String(outputTokens)),
        agent: "codex",
        model: rowModel,
        timestamp: ts,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        workspace,
        sourcePath: file,
      }),
    );
  }

  // Custom providers (9router → LiteLLM) often emit token_count with info:null.
  // Attribute real billed usage from proxy history, else estimate from content.
  if (realTokenEvents === 0) {
    const attributed = attributeProxyUsage(
      events,
      file,
      model,
      workspace,
      turns,
      sessionStartMs,
      sessionEndMs,
      proxyIndex,
      claimedProxyIds,
    );
    if (attributed === 0) {
      emitContentEstimates(events, file, model, workspace, turns, sessionEndMs, fileMtime);
    }
  }
}

/**
 * Match LiteLLM/9Router per-request history into Codex turn windows (or whole session).
 * Returns number of events added.
 */
function attributeProxyUsage(
  events: UsageEvent[],
  file: string,
  model: string | null,
  workspace: string | null,
  turns: TurnBucket[],
  sessionStartMs: number,
  sessionEndMs: number,
  proxyIndex: ProxyUsageRow[],
  claimedProxyIds: Set<string>,
): number {
  if (!proxyIndex.length) return 0;
  const modelKey = normalizeModelKey(model);
  const windows =
    turns.length > 0
      ? turns.map((t) => ({
          startMs: t.startMs,
          // small pad for clock skew between desktop and proxy
          endMs: t.endMs + 2_000,
          model: t.model || model,
        }))
      : Number.isFinite(sessionStartMs) && Number.isFinite(sessionEndMs)
        ? [{ startMs: sessionStartMs, endMs: sessionEndMs + 2_000, model }]
        : [];
  if (!windows.length) return 0;

  let added = 0;
  for (const win of windows) {
    const winModel = normalizeModelKey(win.model);
    for (const row of proxyIndex) {
      if (claimedProxyIds.has(row.id)) continue;
      if (row.tsMs < win.startMs || row.tsMs > win.endMs) continue;
      // Prefer model match when both sides known; accept any if session model unknown
      if (winModel && row.modelKey && !modelsCompatible(winModel, row.modelKey)) continue;

      claimedProxyIds.add(row.id);
      // Tag so dashboard shows Codex as client of TokenRouter path (LiteLLM/9Router).
      const viaWs = workspace
        ? `${workspace} · via:tokenrouter`
        : "via:tokenrouter";
      events.push(
        applyPricing({
          id: stableId("codex", file, "proxy", row.id),
          agent: "codex",
          model: row.modelRaw || win.model || model || "codex",
          timestamp: new Date(row.tsMs).toISOString(),
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          workspace: viaWs,
          sourcePath: `${file} ← ${row.sourcePath}`,
          routerCost: row.cost > 0 ? row.cost : null,
        }),
      );
      added += 1;
    }
  }
  return added;
}

/** Last-resort: estimate tokens from message/tool content per turn (~4 chars/token). */
function emitContentEstimates(
  events: UsageEvent[],
  file: string,
  model: string | null,
  workspace: string | null,
  turns: TurnBucket[],
  sessionEndMs: number,
  fileMtime: Date,
): void {
  if (!turns.length) return;
  let i = 0;
  for (const t of turns) {
    i += 1;
    // Tool outputs re-enter the model context → count as input; reasoning as output.
    const inputTokens = charsToTokens(t.userChars + t.toolOutChars);
    const outputTokens = charsToTokens(t.asstChars + t.reasonChars);
    if (inputTokens + outputTokens <= 0) continue;
    const ts = Number.isFinite(t.endMs)
      ? new Date(t.endMs).toISOString()
      : Number.isFinite(sessionEndMs)
        ? new Date(sessionEndMs).toISOString()
        : fileMtime.toISOString();
    events.push(
      applyPricing({
        id: stableId(
          "codex",
          file,
          "est",
          String(i),
          String(inputTokens),
          String(outputTokens),
        ),
        agent: "codex",
        model: t.model || model || "codex",
        timestamp: ts,
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        workspace,
        sourcePath: file,
        estimated: true,
      }),
    );
  }
}

function charsToTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.max(1, Math.ceil(chars / 4));
}

function contentCharLen(content: unknown): number {
  if (content == null) return 0;
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const c of content) {
      if (typeof c === "string") n += c.length;
      else if (c && typeof c === "object") {
        const o = c as Record<string, unknown>;
        n += String(o.text ?? o.input_text ?? o.content ?? "").length;
      }
    }
    return n;
  }
  if (typeof content === "object") {
    const o = content as Record<string, unknown>;
    return String(o.text ?? o.input_text ?? o.content ?? "").length;
  }
  return String(content).length;
}

function sameTokenBuckets(a: TokenBuckets, b: TokenBuckets): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheWriteTokens === b.cacheWriteTokens
  );
}

function normalizeModelKey(model: string | null | undefined): string {
  if (!model) return "";
  let m = model.trim().toLowerCase();
  // strip provider prefixes: openai/Kimi-k3 → kimi-k3
  const slash = m.lastIndexOf("/");
  if (slash >= 0) m = m.slice(slash + 1);
  m = m.replace(/[_\s]+/g, "-");
  return m;
}

function modelsCompatible(a: string, b: string): boolean {
  if (!a || !b) return true;
  if (a === b) return true;
  // kimi-k3 vs kimi-k3-... or partial contains
  if (a.includes(b) || b.includes(a)) return true;
  // strip effort suffixes
  const strip = (s: string) => s.replace(/-\(x?high\)$/i, "").replace(/-x?high$/i, "");
  return strip(a) === strip(b);
}

/**
 * Load per-request proxy history (LiteLLM + 9Router mirrors) for attribution.
 * Caps to recent tail of large jsonl files for scan performance.
 */
async function loadProxyUsageIndex(recentOnly = false): Promise<ProxyUsageRow[]> {
  const rows: ProxyUsageRow[] = [];
  const seenIds = new Set<string>();
  // TOKENLAB_DATA_DIR override (tests + portable installs) isolates the proxy
  // index to the override dir only — default appData/home roots are skipped so
  // tests never pick up the developer's real LiteLLM mirrors (same convention
  // as legacyDataRoot()/dataRoot() in backup.ts).
  const envDataDir =
    process.env.TOKENLAB_DATA_DIR?.trim() || process.env.XLAB_TOKEN_DATA_DIR?.trim() || "";
  const roots = envDataDir
    ? [path.join(envDataDir, "mirrors", "litellm"), path.join(envDataDir, "mirrors", "9router")]
    : unique([
        ...liteLlmRoots(),
        ...nineRouterRoots(),
        path.join(appDataDir(), "tokenlab", "mirrors", "litellm"),
        path.join(appDataDir(), "tokenlab", "mirrors", "9router"),
        path.join(homeDir(), ".tokenlab", "mirrors", "litellm"),
        path.join(homeDir(), ".tokenlab", "mirrors", "9router"),
      ]);

  const historyNames = [
    "usage-history.jsonl",
    "usageHistory.jsonl",
    "request-details.jsonl",
  ];

  for (const root of roots) {
    if (!root || !(await pathExists(root))) continue;
    for (const name of historyNames) {
      const p = path.join(root, name);
      if (!(await pathExists(p))) continue;
      try {
        let text: string | null;
        const maxBytes = 4 * 1024 * 1024;
        const fileStat = await stat(p);
        if (recentOnly && fileStat.size > maxBytes) {
          const handle = await open(p, "r");
          try {
            const start = Math.max(0, fileStat.size - maxBytes);
            const buffer = Buffer.alloc(Math.min(fileStat.size, maxBytes));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
            text = buffer.subarray(0, bytesRead).toString("utf8");
            if (start > 0) {
              const firstNewline = text.indexOf("\n");
              if (firstNewline >= 0) text = text.slice(firstNewline + 1);
            }
          } finally {
            await handle.close();
          }
        } else {
          text = await readText(p);
        }
        if (!text) continue;
        // Keep last ~4MB for large histories (recent traffic matters for live Codex)
        if (text.length > maxBytes) {
          const slice = text.slice(-maxBytes);
          const nl = slice.indexOf("\n");
          text = nl >= 0 ? slice.slice(nl + 1) : slice;
        }
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let o: Record<string, unknown>;
          try {
            o = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            continue;
          }
          const row = proxyRowFromObject(o, p);
          if (!row) continue;
          if (seenIds.has(row.id)) continue;
          seenIds.add(row.id);
          rows.push(row);
        }
      } catch {
        // ignore unreadable mirror
      }
    }
  }

  rows.sort((a, b) => a.tsMs - b.tsMs);
  return rows;
}

function proxyRowFromObject(o: Record<string, unknown>, sourcePath: string): ProxyUsageRow | null {
  const tokensObj =
    o.tokens && typeof o.tokens === "object" ? (o.tokens as Record<string, unknown>) : null;
  const inputTokens = Math.max(
    0,
    Math.round(
      Number(
        o.promptTokens ??
          o.prompt_tokens ??
          o.inputTokens ??
          o.input_tokens ??
          tokensObj?.prompt_tokens ??
          tokensObj?.input_tokens ??
          0,
      ) || 0,
    ),
  );
  const outputTokens = Math.max(
    0,
    Math.round(
      Number(
        o.completionTokens ??
          o.completion_tokens ??
          o.outputTokens ??
          o.output_tokens ??
          tokensObj?.completion_tokens ??
          tokensObj?.output_tokens ??
          0,
      ) || 0,
    ),
  );
  if (inputTokens + outputTokens <= 0) return null;

  const tsRaw = o.timestamp ?? o.ts ?? o.created_at ?? o.createdAt ?? o.time;
  let tsMs = NaN;
  if (typeof tsRaw === "string" && tsRaw.trim()) tsMs = Date.parse(tsRaw);
  else if (typeof tsRaw === "number" && Number.isFinite(tsRaw)) {
    tsMs = tsRaw > 1e12 ? tsRaw : tsRaw > 1e9 ? tsRaw * 1000 : tsRaw;
  }
  if (!Number.isFinite(tsMs) || tsMs <= 0) return null;

  const modelRaw = String(o.model ?? o.Model ?? "unknown");
  const id = String(
    o.id ?? o.request_id ?? o.requestId ?? `${tsMs}:${modelRaw}:${inputTokens}:${outputTokens}`,
  );
  const cost = Number(o.cost ?? o.spend ?? o.total_cost ?? 0) || 0;

  return {
    id,
    tsMs,
    modelKey: normalizeModelKey(modelRaw),
    modelRaw,
    inputTokens,
    outputTokens,
    cost,
    sourcePath,
  };
}

type UsageResult = { obj: unknown; isPerCall: boolean };

function findUsageObject(r: Record<string, unknown>, type: string): UsageResult | null {
  const payload = (r.payload && typeof r.payload === "object" ? r.payload : null) as Record<
    string,
    unknown
  > | null;
  const info =
    payload && payload.info && typeof payload.info === "object"
      ? (payload.info as Record<string, unknown>)
      : null;
  const response =
    payload && payload.response && typeof payload.response === "object"
      ? (payload.response as Record<string, unknown>)
      : r.response && typeof r.response === "object"
        ? (r.response as Record<string, unknown>)
        : null;
  const directUsageIsPerCall = type === "token_usage_record";

  // last_token_usage is a per-turn delta (not cumulative) — caller should NOT
  // apply cumulative detection to it.  total_token_usage is cumulative.
  const candidates: Array<{ val: unknown; perCall: boolean }> = [
    { val: r.usage, perCall: directUsageIsPerCall },
    { val: r.token_count, perCall: false },
    { val: r.tokenCount, perCall: false },
    { val: payload?.usage, perCall: directUsageIsPerCall },
    { val: payload?.token_count, perCall: false },
    { val: payload?.tokenCount, perCall: false },
    { val: info?.usage, perCall: false },
    { val: info?.token_count, perCall: false },
    // Prefer last_token_usage (per-turn delta) over total_token_usage (cumulative session total)
    { val: info?.last_token_usage, perCall: true },
    { val: info?.total_token_usage, perCall: false },
    { val: response?.usage, perCall: false },
    // whole payload if event type hints tokens
    { val: type.includes("token") || type.includes("usage") ? payload : null, perCall: false },
    { val: type.includes("token") || type.includes("usage") ? r : null, perCall: false },
  ];

  for (const c of candidates) {
    if (c.val && typeof c.val === "object" && extractTokenBuckets(c.val))
      return { obj: c.val, isPerCall: c.perCall };
  }
  // Nested total_token_usage under info (Codex sometimes stores cumulative here)
  if (info) {
    for (const key of ["total_token_usage", "last_token_usage", "token_usage"] as const) {
      const nested = info[key];
      if (nested && typeof nested === "object" && extractTokenBuckets(nested))
        return { obj: nested, isPerCall: key === "last_token_usage" };
    }
  }
  return null;
}

function collectFromJson(
  events: UsageEvent[],
  data: unknown,
  file: string,
  fileMtime: Date,
): void {
  if (Array.isArray(data)) {
    data.forEach((row, i) => {
      if (!row || typeof row !== "object") return;
      const r = row as Record<string, unknown>;
      const buckets = codexBuckets(r.usage ?? r.token_count ?? r);
      if (!buckets) return;
      events.push(
        applyPricing({
          id: stableId("codex", file, "json", String(i), String(buckets.inputTokens)),
          agent: "codex",
          model: extractModel(r),
          timestamp: extractTimestamp(r, fileMtime),
          ...buckets,
          workspace: pickString(r, ["cwd", "workspace"]),
          sourcePath: file,
        }),
      );
    });
    return;
  }
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.events)) collectFromJson(events, o.events, file, fileMtime);
    if (Array.isArray(o.sessions)) collectFromJson(events, o.sessions, file, fileMtime);
  }
}

function pickString(obj: unknown, keys: string[]): string | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    if (typeof o[k] === "string" && (o[k] as string).trim()) return (o[k] as string).trim();
  }
  return null;
}

export const agent: AgentModule = {
  id: "codex",
  label: "OpenAI Codex (App)",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      expandHome(process.env.CODEX_HOME || path.join(home, ".codex")),
      ...(process.env.ORCA_CODEX_HOME ? [expandHome(process.env.ORCA_CODEX_HOME)] : []),
      // Orca desktop stores its Codex runtime outside the normal ~/.codex tree.
      path.join(appData, "orca", "codex-runtime-home", "home"),
      path.join(home, ".codex"),
      path.join(xdgConfig, "codex"),
      path.join(appData, "Codex"),
      path.join(localApp, "Codex"),
      // Windows desktop installer layout
      path.join(localApp, "OpenAI", "Codex"),
      path.join(appData, "OpenAI", "Codex"),
    ]);
  },
  parse: parseCodex,
  parseLight: parseCodexLight,
};
