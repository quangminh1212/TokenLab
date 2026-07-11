import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";

import { stat } from "node:fs/promises";
import path from "node:path";
import { applyPricing } from "../../pricing.js";
import type { UsageEvent } from "../../types.js";
import { parseJsonl, pathExists, readText, stableId, walkFiles } from "../../util.js";
import { extractModel, extractTimestamp, extractTokenBuckets } from "../shared/usage-fields.js";

/**
 * Windsurf / Codeium
 * --------------------
 * Local roots:
 *   - ~/.codeium/windsurf  (cascade sessions, settings)
 *   - %APPDATA%/Windsurf   (VS Code-fork user data when IDE is installed)
 *
 * Cascade stores chats as encrypted .pb (per-UUID encryption). Token counters
 * are not readable without Windsurf's keys. We still:
 *   1) parse any plain JSON/JSONL usage if present
 *   2) scan state.vscdb / SQLite for usage-like rows
 *   3) emit best-effort *estimated* events from cascade/*.pb size + mtime
 *      (marked estimated:true) so activity is visible on the dashboard
 */
export async function parseWindsurf(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    if (!(await pathExists(root))) continue;

    // 1) Plain JSON / JSONL usage artifacts
    events.push(...(await parseJsonArtifacts(root, seen)));

    // 2) VS Code-style SQLite (state.vscdb, etc.)
    events.push(...(await parseSqliteArtifacts(root, seen)));

    // 3) Encrypted cascade sessions → estimated usage
    events.push(...(await parseCascadeSessions(root, seen)));
  }

  return events;
}

async function parseJsonArtifacts(root: string, seen: Set<string>): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const files = await walkFiles(root, {
    maxDepth: 14,
    match: (name, full) => {
      const lower = name.toLowerCase();
      const pathLower = full.toLowerCase();
      if (lower.endsWith(".pb") || lower.endsWith(".lock")) return false;
      if (lower.endsWith(".jsonl")) return true;
      if (lower.includes("usage") && (lower.endsWith(".json") || lower.endsWith(".jsonl"))) return true;
      if (lower.includes("cascade") && lower.endsWith(".json")) return true;
      if (pathLower.includes(`${path.sep}logs${path.sep}`) && (lower.endsWith(".json") || lower.endsWith(".log")))
        return true;
      if (
        lower.endsWith(".json") &&
        (lower.includes("chat") ||
          lower.includes("transcript") ||
          lower.includes("session") ||
          lower.includes("token") ||
          lower.includes("billing") ||
          pathLower.includes("globalstorage") ||
          pathLower.includes("workspacestorage"))
      )
        return true;
      return false;
    },
  });

  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await readText(file);
    if (!text) continue;

    const rows = file.endsWith(".jsonl")
      ? parseJsonl(text)
      : (() => {
          try {
            const data = JSON.parse(text);
            if (Array.isArray(data)) return data;
            if (data && typeof data === "object") {
              const o = data as Record<string, unknown>;
              if (Array.isArray(o.messages)) return o.messages;
              if (Array.isArray(o.events)) return o.events;
              if (Array.isArray(o.usage)) return o.usage;
              if (Array.isArray(o.sessions)) return o.sessions;
              return [data];
            }
          } catch {
            return [];
          }
          return [];
        })();

    let idx = 0;
    for (const row of rows) {
      idx += 1;
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const buckets = extractTokenBuckets(
        r.usage ?? r.tokenUsage ?? r.token_usage ?? r.credits ?? r.token_count ?? r,
      );
      if (!buckets) continue;

      events.push(
        applyPricing({
          id: stableId(
            "windsurf",
            file,
            String(idx),
            String(buckets.inputTokens),
            String(buckets.outputTokens),
          ),
          agent: "windsurf",
          model: extractModel(r, r.usage, r.message),
          timestamp: extractTimestamp(r, r.usage, r.message),
          ...buckets,
          workspace:
            typeof r.cwd === "string"
              ? r.cwd
              : typeof r.workspace === "string"
                ? r.workspace
                : null,
          sourcePath: file,
        }),
      );
    }
  }

  return events;
}

async function parseSqliteArtifacts(root: string, seen: Set<string>): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const dbs = await walkFiles(root, {
    maxDepth: 10,
    match: (n) =>
      n === "state.vscdb" ||
      n.endsWith(".vscdb") ||
      n === "state.db" ||
      n === "storage.db" ||
      (n.endsWith(".db") && !n.includes("lock")),
  });

  for (const dbPath of dbs) {
    if (seen.has(dbPath)) continue;
    seen.add(dbPath);
    events.push(...(await parseWindsurfSqlite(dbPath)));
  }
  return events;
}

async function parseWindsurfSqlite(dbPath: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
      ).map((t) => t.name);

      // VS Code ItemTable key/value store
      if (tables.some((t) => t.toLowerCase() === "itemtable")) {
        const rows = db
          .prepare(`SELECT key, value FROM ItemTable`)
          .all() as Array<{ key: string; value: unknown }>;
        let i = 0;
        for (const row of rows) {
          i += 1;
          const key = String(row.key ?? "");
          if (!/usage|token|cascade|chat|billing|credit|model/i.test(key)) continue;
          const value = coerceSqliteValue(row.value);
          if (value == null) continue;
          pushUsageFromUnknown(events, value, dbPath, `item:${key}:${i}`);
        }
      }

      // Generic tables with token columns
      for (const table of tables) {
        if (/sqlite_/i.test(table)) continue;
        try {
          const cols = (
            db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>
          ).map((c) => c.name);
          const colset = new Set(cols.map((c) => c.toLowerCase()));
          const hasTokens =
            [...colset].some((c) => /token|usage|credit|cost/.test(c)) ||
            (colset.has("key") && colset.has("value"));
          if (!hasTokens) continue;

          const sample = db.prepare(`SELECT * FROM ${quoteIdent(table)} LIMIT 5000`).all() as Array<
            Record<string, unknown>
          >;
          let i = 0;
          for (const row of sample) {
            i += 1;
            const buckets = extractTokenBuckets(row);
            if (buckets) {
              events.push(
                applyPricing({
                  id: stableId("windsurf", dbPath, table, String(i), String(buckets.inputTokens)),
                  agent: "windsurf",
                  model: extractModel(row),
                  timestamp: extractTimestamp(row),
                  ...buckets,
                  workspace: null,
                  sourcePath: dbPath,
                }),
              );
              continue;
            }
            // key/value blob
            if (row.value != null) {
              const value = coerceSqliteValue(row.value);
              if (value) pushUsageFromUnknown(events, value, dbPath, `${table}:${i}`);
            }
          }
        } catch {
          // table variance
        }
      }
    } finally {
      db.close();
    }
  } catch {
    // node:sqlite unavailable or locked
  }
  return events;
}

function pushUsageFromUnknown(
  events: UsageEvent[],
  value: unknown,
  sourcePath: string,
  tag: string,
): void {
  const candidates: unknown[] = [];
  if (Array.isArray(value)) candidates.push(...value);
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (Array.isArray(o.messages)) candidates.push(...o.messages);
    else if (Array.isArray(o.events)) candidates.push(...o.events);
    else if (Array.isArray(o.usage)) candidates.push(...o.usage);
    else candidates.push(value);
  } else return;

  let i = 0;
  for (const c of candidates) {
    i += 1;
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    const buckets = extractTokenBuckets(r.usage ?? r.tokenUsage ?? r.token_usage ?? r);
    if (!buckets) continue;
    events.push(
      applyPricing({
        id: stableId("windsurf", sourcePath, tag, String(i), String(buckets.inputTokens)),
        agent: "windsurf",
        model: extractModel(r),
        timestamp: extractTimestamp(r),
        ...buckets,
        workspace: null,
        sourcePath,
      }),
    );
  }
}

/**
 * Encrypted cascade sessions: no plaintext tokens available.
 * Emit one estimated event per session using size heuristic so activity shows up.
 *
 * Heuristic (conservative): encrypted payload ~ protobuf transcript size.
 * Approximate total tokens ≈ fileBytes / 12, split 60% input / 40% output.
 */
async function parseCascadeSessions(root: string, seen: Set<string>): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const cascadeDirs = [
    path.join(root, "cascade"),
    path.join(root, "windsurf", "cascade"),
  ];

  for (const dir of cascadeDirs) {
    if (!(await pathExists(dir))) continue;
    const files = await walkFiles(dir, {
      maxDepth: 3,
      match: (n) => n.endsWith(".pb"),
    });

    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);

      let st;
      try {
        st = await stat(file);
      } catch {
        continue;
      }
      // Skip tiny/empty blobs
      if (st.size < 512) continue;

      const sessionId = path.basename(file, ".pb");
      const totalTokens = Math.max(1, Math.round(st.size / 12));
      const inputTokens = Math.round(totalTokens * 0.6);
      const outputTokens = Math.max(1, totalTokens - inputTokens);
      const timestamp = st.mtime.toISOString();

      events.push(
        applyPricing({
          id: stableId("windsurf", "cascade", sessionId, String(st.size), timestamp),
          agent: "windsurf",
          model: "windsurf-cascade",
          timestamp,
          inputTokens,
          outputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          workspace: null,
          sourcePath: file,
          estimated: true,
        }),
      );
    }
  }

  // Also count implicit context blobs as lighter estimated sessions (optional, smaller weight)
  const implicitDir = path.join(root, "implicit");
  if (await pathExists(implicitDir)) {
    const files = await walkFiles(implicitDir, {
      maxDepth: 2,
      match: (n) => n.endsWith(".pb"),
    });
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      let st;
      try {
        st = await stat(file);
      } catch {
        continue;
      }
      if (st.size < 2048) continue; // skip tiny
      // Smaller weight: /24
      const totalTokens = Math.max(1, Math.round(st.size / 24));
      const inputTokens = Math.round(totalTokens * 0.7);
      const outputTokens = Math.max(1, totalTokens - inputTokens);
      const sessionId = path.basename(file, ".pb");
      const timestamp = st.mtime.toISOString();
      events.push(
        applyPricing({
          id: stableId("windsurf", "implicit", sessionId, String(st.size), timestamp),
          agent: "windsurf",
          model: "windsurf-cascade",
          timestamp,
          inputTokens,
          outputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          workspace: null,
          sourcePath: file,
          estimated: true,
        }),
      );
    }
  }

  return events;
}

function coerceSqliteValue(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === "string") {
    const t = value.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try {
        return JSON.parse(t);
      } catch {
        return null;
      }
    }
    return null;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    try {
      const t = Buffer.from(value).toString("utf8").trim();
      if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
        return JSON.parse(t);
      }
    } catch {
      return null;
    }
  }
  if (typeof value === "object") return value;
  return null;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export const agent: AgentModule = {
  id: "windsurf",
  label: "Windsurf",
  roots() {
    const { home, appData, localApp, path } = pathEnv();
    return unique([
      path.join(home, ".codeium", "windsurf"),
      path.join(home, ".codeium"),
      path.join(home, ".windsurf"),
      path.join(appData, "Windsurf"),
      path.join(appData, "Windsurf", "User"),
      path.join(appData, "Windsurf", "User", "globalStorage"),
      path.join(appData, "Windsurf", "User", "workspaceStorage"),
      path.join(appData, "Windsurf - Insiders"),
      path.join(localApp, "Windsurf"),
      path.join(localApp, "Programs", "Windsurf"),
      // Extension host leftovers under VS Code / Cursor
      path.join(appData, "Code", "User", "globalStorage", "codeium.windsurf"),
      path.join(appData, "Code", "User", "globalStorage", "codeium.codeium"),
      path.join(appData, "Cursor", "User", "globalStorage", "codeium.windsurf"),
      path.join(appData, "Cursor", "User", "globalStorage", "codeium.codeium"),
    ]);
  },
  parse: parseWindsurf,
};
