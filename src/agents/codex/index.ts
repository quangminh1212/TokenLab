import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { applyPricing } from "../../pricing.js";
import type { UsageEvent } from "../../types.js";
import {
  cachedEventsForFile,
  pathExists,
  readJsonlCached,
  readText,
  stableId,
  stampFile,
  walkFiles,
} from "../../util.js";
import {
  extractModel,
  extractTimestamp,
  extractTokenBuckets,
  type TokenBuckets,
} from "../shared/usage-fields.js";

/**
 * Substrings identifying Codex plugin fixtures / temp trees.
 * Hoisted: this array was rebuilt on every isNoisePath call, and the function runs
 * twice per candidate file (once in the walk predicate, once in the file loop).
 */
const CODEX_NOISE_MARKERS = [
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

/** Skip Codex plugin fixtures / temp trees (fake usage with no real timestamps). */
function isNoisePath(full: string): boolean {
  const n = full.replace(/\\/g, "/").toLowerCase();
  for (const marker of CODEX_NOISE_MARKERS) {
    if (n.includes(marker)) return true;
  }
  return false;
}

/**
 * Runtime mirror roots that duplicate a canonical config tree.
 *
 * The Orca harness keeps its own `codex-runtime-home/home` which mirrors
 * `~/.codex` (same session files, differing by a few metadata bytes). Parsing both
 * doubles Codex scan cost for no extra usage, so a canonical root always wins.
 */
function isMirrorCodexRoot(full: string): boolean {
  const n = full.replace(/\\/g, "/").toLowerCase();
  return n.includes("/codex-runtime-home/");
}

/**
 * Drop already-collected events that came from `filePath` (and any rows that
 * point at it via the "path ← extra" source form). Used when a later, preferred
 * copy of a mirrored session file supersedes one that was already parsed.
 * Mutates `events` in place to avoid copying a 100k+ array.
 */
function removeEventsFromPath(events: UsageEvent[], filePath: string): void {
  if (events.length === 0) return;
  const target = filePath.replace(/\\/g, "/").toLowerCase();
  let write = 0;
  for (let read = 0; read < events.length; read += 1) {
    const source = events[read]!.sourcePath;
    const normalized =
      typeof source === "string" ? source.split(" ← ", 1)[0]!.replace(/\\/g, "/").toLowerCase() : "";
    if (normalized !== target) {
      events[write] = events[read]!;
      write += 1;
    }
  }
  events.length = write;
}

/**
 * Decide which of two copies of the same session file to keep.
 * Canonical (non-mirror) roots beat mirror roots; otherwise the larger file wins.
 * Returns true when `existing` should be kept and `candidate` skipped.
 */
function preferCodexCopy(
  existing: { path: string; size: number },
  candidate: { path: string; size: number },
): boolean {
  const existingMirror = isMirrorCodexRoot(existing.path);
  const candidateMirror = isMirrorCodexRoot(candidate.path);
  if (existingMirror !== candidateMirror) return !existingMirror;
  if (existing.size !== candidate.size) return existing.size > candidate.size;
  // Equal size and same class: keep the first seen (stable, order-independent
  // once the mirror check above has already separated the two classes).
  return true;
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

/**
 * Files a light scan has already read, keyed by absolute path.
 * The value is relative path + size + mtime. A later tick that still sees that
 * signature does not open the file. The periodic full scan does not use this map.
 */
const lightFileSignatures = new Map<string, string>();
/** Roots whose historical session trees were listed once. Later light ticks skip them. */
const codexLightIndexedRoots = new Set<string>();
/** Rollout files kept warm: Windows may not bump mtime while Codex holds the file open. */
const codexLightHotByRoot = new Map<string, string[]>();

function codexRootKey(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Local and UTC today and yesterday, as sessions/YYYY/MM/DD segments. */
function recentCodexDayRels(now = Date.now()): string[] {
  const rels: string[] = [];
  for (const offset of [0, 1]) {
    const at = new Date(now - offset * 24 * 60 * 60 * 1000);
    const push = (year: number, month: number, day: number) => {
      rels.push(
        [String(year), String(month).padStart(2, "0"), String(day).padStart(2, "0")].join("/"),
      );
    };
    push(at.getFullYear(), at.getMonth() + 1, at.getDate());
    push(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
  }
  return [...new Set(rels)];
}

function isUnderRecentCodexDay(root: string, file: string, now = Date.now()): boolean {
  const rel = path.relative(root, file).replace(/\\/g, "/").toLowerCase();
  for (const day of recentCodexDayRels(now)) {
    if (rel.includes(`sessions/${day}/`)) return true;
  }
  return false;
}

/**
 * Deep Codex support:
 * - ~/.codex/sessions (rollout-*.jsonl date tree) — classic layout
 * - archived / history / session logs
 * - state_*.sqlite threads.tokens_used + rollout_path (newer desktop/CLI)
 * - token_count events (absolute + cumulative)
 * - response.completed / event.usage shapes
 * - when token_count.info is null, estimate from Codex turn content rather than
 *   attributing proxy requests by time/model, which cannot safely correlate them
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

/**
 * Order roots so canonical config trees are visited before runtime mirrors.
 *
 * Dedupe keeps the first copy of a session it sees (subject to preferCodexCopy),
 * so scanning ~/.codex before an Orca runtime home means the mirror files are the
 * ones skipped — and the ~8GB of mirrored sessions is never read or parsed.
 * Stable: preserves relative order within each class.
 */
function orderRootsCanonicalFirst(roots: string[]): string[] {
  const canonical: string[] = [];
  const mirrors: string[] = [];
  for (const root of roots) {
    if (isMirrorCodexRoot(root)) mirrors.push(root);
    else canonical.push(root);
  }
  return [...canonical, ...mirrors];
}

async function parseCodexInternal(
  roots: string[],
  options: ParseCodexOptions = {},
): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const seen = new Set<string>();
  const seenRollouts = new Set<string>();
  const seenFileSignatures = new Set<string>();
  /**
   * Session-identity dedupe across mirror roots.
   *
   * `seenFileSignatures` keys on root-relative path + size + mtime, so it cannot
   * collapse the same session stored under two roots: an Orca runtime home mirrors
   * ~/.codex/sessions and the copies differ by a few bytes (e.g. 83549 vs 83499),
   * which defeated the size component of the signature. That made every rollout
   * parse twice — measured at ~86s of redundant CPU, yielding 4 unique events out
   * of 146k on this host.
   *
   * Rollout/session filenames embed the session id and are unique per session, so
   * the basename is used as the identity. When a duplicate identity is found the
   * file with the smaller byte size is dropped, because the larger copy is the one
   * carrying extra metadata (verified: the mirror is a strict superset in content).
   */
  const sessionIdentity = new Map<string, { path: string; size: number }>();
  const droppedMirrorPaths = new Set<string>();
  const recentCutoffMs = options.recentOnly
    ? Date.now() - (options.recentWindowMs ?? 15 * 60_000)
    : Number.NEGATIVE_INFINITY;

  for (const root of orderRootsCanonicalFirst(roots)) {
    if (!(await pathExists(root))) continue;
    // The Orca runtime home mirrors ~/.codex, including gigabytes of copies.
    // Light scans read the canonical tree only; the periodic full scan still sees both.
    if (options.recentOnly && isMirrorCodexRoot(root)) {
      let canonical = false;
      for (const other of roots) {
        if (other === root || isMirrorCodexRoot(other)) continue;
        if (await pathExists(other)) {
          canonical = true;
          break;
        }
      }
      if (canonical) continue;
    }

    // Newer Codex: SQLite state (threads + tokens_used) even when sessions/ is empty
    if (!options.recentOnly) {
      const sqliteEvents = await parseCodexSqliteState(root, seenRollouts);
      for (const event of sqliteEvents) events.push(event);
    }

    const rootKey = codexRootKey(root);
    const indexed = Boolean(options.recentOnly && codexLightIndexedRoots.has(rootKey));
    const discoveredHot: string[] = [];
    const sessionsRoot = path.join(root, "sessions");

    // After one light listing, do not walk archived history again. New usage
    // lands in today's or yesterday's session folder, or in a file already
    // kept warm. The periodic full scan still walks every tree, including mirrors.
    let scanRoots: string[];
    if (indexed) {
      scanRoots = [root];
      if (await pathExists(sessionsRoot)) {
        for (const rel of recentCodexDayRels()) {
          const dir = path.join(sessionsRoot, ...rel.split("/"));
          if (await pathExists(dir)) scanRoots.push(dir);
        }
      }
    } else {
      const preferred = [
        sessionsRoot,
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
      scanRoots = existingPreferred.length > 0 ? [...existingPreferred, root] : [root];
    }

    const rememberSignature = (file: string, signature: string) => {
      if (!options.recentOnly || !signature) return;
      const fileKey = process.platform === "win32" ? file.toLowerCase() : file;
      lightFileSignatures.set(fileKey, signature);
    };

    const consume = async (file: string, hotRolloutFiles: Set<string>): Promise<void> => {
      if (seen.has(file) || seenRollouts.has(file.toLowerCase())) return;
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
      let signature = "";
      if (fileSize >= 0) {
        let relative = path.relative(root, file).replace(/\\/g, "/");
        if (process.platform === "win32") relative = relative.toLowerCase();
        signature = `${relative}|${fileSize}`;
        const fileKey = process.platform === "win32" ? file.toLowerCase() : file;
        if (options.recentOnly && lightFileSignatures.get(fileKey) === signature) return;
      }
      if (fileMtime.getTime() < recentCutoffMs && !hotRolloutFiles.has(file)) {
        // Already outside the light window. Remember it so the next tick,
        // which only reopens recent day folders, does not parse it.
        if (isUnderRecentCodexDay(root, file)) rememberSignature(file, signature);
        return;
      }

      // Mirror-root dedupe by session identity, before any parse work.
      // Keeps one copy of a session seen under multiple roots (an Orca runtime
      // home mirrors ~/.codex/sessions with byte-identical content).
      const identity = path.basename(file).toLowerCase();
      const knownIdentity = sessionIdentity.get(identity);
      if (knownIdentity) {
        const keepExisting = preferCodexCopy(knownIdentity, { path: file, size: fileSize });
        if (keepExisting) {
          droppedMirrorPaths.add(file);
          return;
        }
        droppedMirrorPaths.add(knownIdentity.path);
        removeEventsFromPath(events, knownIdentity.path);
        seenRollouts.delete(knownIdentity.path.toLowerCase());
      }
      if (fileSize >= 0) sessionIdentity.set(identity, { path: file, size: fileSize });

      if (signature) {
        const passSignature = `${signature}|${Math.trunc(fileMtime.getTime())}`;
        if (seenFileSignatures.has(passSignature)) return;
        seenFileSignatures.add(passSignature);
      }

      if (file.endsWith(".json") && !file.endsWith(".jsonl")) {
        const text = await readText(file);
        if (!text) return;
        try {
          collectFromJson(events, JSON.parse(text) as unknown, file, fileMtime);
        } catch {
          // ignore
        }
        rememberSignature(file, signature);
        return;
      }

      // A changed rollout is parsed whole. Replacing that source path is only
      // safe when every row from the file is in this result.
      const fileEvents = await cachedEventsForFile(file, async () => {
        const produced: UsageEvent[] = [];
        const rows = await readJsonlCached(file);
        if (rows) parseJsonlRows(produced, rows, file, fileMtime);
        return produced;
      });
      for (const event of fileEvents) events.push(event);
      rememberSignature(file, signature);
    };

    for (const base of scanRoots) {
      if (!(await pathExists(base))) continue;
      if (isNoisePath(base)) continue;
      const files = await walkFiles(base, {
        // Light mode lists the root and, after the first pass, only a day folder.
        // The first light pass and every full scan still walk the deep trees.
        maxDepth: !options.recentOnly ? 12 : base === root ? 1 : indexed ? 2 : 12,
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
      const underSessions = base === sessionsRoot || base.startsWith(sessionsRoot + path.sep);
      if (underSessions) {
        for (const file of hotRolloutFiles) discoveredHot.push(file);
      }
      for (const file of files) await consume(file, hotRolloutFiles);
    }

    if (indexed) {
      const remembered = new Set(codexLightHotByRoot.get(rootKey) ?? []);
      for (const file of remembered) {
        if (seen.has(file) || !(await pathExists(file))) continue;
        await consume(file, remembered);
      }
    }
    if (options.recentOnly) {
      const merged = [
        ...new Set([...(codexLightHotByRoot.get(rootKey) ?? []), ...discoveredHot]),
      ].sort();
      codexLightHotByRoot.set(rootKey, merged.slice(-4));
      codexLightIndexedRoots.add(rootKey);
    }
  }

  return events;
}

/**
 * Newer Codex (desktop/app-server) stores thread summaries in state_*.sqlite:
 * threads(id, rollout_path, model, tokens_used, cwd, created_at, updated_at, …)
 * When tokens_used > 0 emit one event; also follow rollout_path for detailed jsonl.
 * When tokens_used is 0, still follow rollout_path so null-info sessions can use content estimates.
 */
async function parseCodexSqliteState(
  root: string,
  seenRollouts: Set<string>,
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
        // Include zero-token threads so we still follow rollout_path for local estimates
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

          // Follow rollout jsonl for finer-grained events (or content estimates)
          const rp =
            rolloutCol && typeof row[rolloutCol] === "string"
              ? String(row[rolloutCol]).trim()
              : "";
          // Normalize Windows extended path \\?\C:\...
          const rolloutPath = rp.replace(/^\\\\\?\\/, "");
          if (rolloutPath && !isNoisePath(rolloutPath)) {
            const key = rolloutPath.toLowerCase();
            if (!seenRollouts.has(key)) {
              seenRollouts.add(key);
              try {
                // One stat drives both the mtime fallback and cache invalidation —
                // this used to stat the same path three times (exists + read + stat).
                const stamp = await stampFile(rolloutPath);
                if (stamp) {
                  const fileMtime = new Date(stamp.mtimeMs);
                  const before = events.length;
                  // Event-level cache: unchanged rollouts reuse derived events, so a
                  // warm rescan skips read + parse + pricing for the whole tree.
                  const fileEvents = await cachedEventsForFile(rolloutPath, async () => {
                    const produced: UsageEvent[] = [];
                    const rows = await readJsonlCached(rolloutPath);
                    if (rows) parseJsonlRows(produced, rows, rolloutPath, fileMtime);
                    return produced;
                  });
                  for (const event of fileEvents) events.push(event);
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
  /**
   * Whether the source row actually carried a cache field. Preserved through the
   * cumulative-counter delta above so a codex row that reports cache keeps
   * claiming it, instead of the dashboard's CACHE $ column reading "—".
   */
  cacheReported?: boolean;
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
    ...(buckets.cacheReported ? { cacheReported: true } : {}),
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

function parseJsonlRows(
  events: UsageEvent[],
  rows: unknown[],
  file: string,
  fileMtime: Date,
): void {
  // Orca writes both a per-request token_usage_record and a token_count
  // snapshot for the same turn. The record is authoritative; snapshots are
  // only used when a record is absent (older/newer format variants).
  const tokenUsageRecordCounts = new Map<string, number>();
  const tokenUsageRecords: Array<{ tsMs: number; buckets: CodexTokenBuckets }> = [];
  /**
   * Records bucketed by 2s window so the "is this token_count a mirror?" probe
   * is O(1)-ish instead of scanning every record per mirror row (the previous
   * `.some()` was O(rows × records) on large rollouts).
   *
   * A probe at time t must consider records in [t-2000, t+2000], which can span
   * up to three 2s buckets. Only buckets overlapping that exact interval are
   * visited, so the result matches the original `Math.abs(delta) <= 2000` test.
   */
  const tokenRecordsByWindow = new Map<number, Array<{ tsMs: number; buckets: CodexTokenBuckets }>>();
  const RECORD_WINDOW_MS = 2_000;
  const recordWindow = (tsMs: number): number => Math.floor(tsMs / RECORD_WINDOW_MS);
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
    if (Number.isFinite(tsMs)) {
      const record = { tsMs, buckets };
      tokenUsageRecords.push(record);
      const win = recordWindow(tsMs);
      const bucket = tokenRecordsByWindow.get(win);
      if (bucket) bucket.push(record);
      else tokenRecordsByWindow.set(win, [record]);
    }
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

    // Turn tracking for content estimates
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
    if (isTokenCountMirror && Number.isFinite(rowMs)) {
      // Visit exactly the buckets overlapping [rowMs-2000, rowMs+2000] — the same
      // interval the previous full-scan `.some()` tested, without the O(records)
      // walk per mirror row.
      const firstWin = recordWindow(rowMs - RECORD_WINDOW_MS);
      const lastWin = recordWindow(rowMs + RECORD_WINDOW_MS);
      let mirrored = false;
      for (let w = firstWin; w <= lastWin && !mirrored; w += 1) {
        const bucket = tokenRecordsByWindow.get(w);
        if (!bucket) continue;
        for (const candidate of bucket) {
          // Distance check is required: a bucket can hold records outside the
          // ±2000ms interval being probed. Mirrors the original predicate exactly.
          if (Math.abs(candidate.tsMs - rowMs) <= RECORD_WINDOW_MS &&
              sameTokenBuckets(candidate.buckets, buckets)) {
            mirrored = true;
            break;
          }
        }
      }
      if (mirrored) continue;
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
        ...(buckets.cacheReported ? { cacheReported: true } : {}),
      }),
    );
  }

  // Proxy logs are parsed under their own agent. Timestamp/model overlap alone
  // cannot safely identify which proxy requests belong to this Codex rollout.
  if (realTokenEvents === 0) {
    emitContentEstimates(events, file, model, workspace, turns, sessionEndMs, fileMtime);
  }
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
