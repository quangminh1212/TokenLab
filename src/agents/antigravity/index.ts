import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { applyPricing } from "../../pricing.js";
import type { UsageEvent } from "../../types.js";
import { num, pathExists, stableId } from "../../util.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

/**
 * Antigravity + antigravity-proxy usage.
 *
 * Primary source of truth (when proxy is used):
 *   ~/.antigravity/data/proxy.db  → table `requests`
 *   (prompt_tokens, output_tokens, cost, model, resolved_model)
 *
 * Secondary:
 *   ~/.gemini/antigravity  /  %APPDATA%/Antigravity — any JSON/JSONL usage export
 *   (Electron app dirs alone are not enough; they rarely store token counters)
 */
export function antigravityRoots(): string[] {
  const { home, appData, localApp, xdgData, xdgConfig, path: p, expandHome } = pathEnv();
  return unique([
    expandHome(process.env.TOKENLAB_ANTIGRAVITY_DIR || process.env.ANTIGRAVITY_HOME || ""),
    p.join(home, ".antigravity"),
    // Local Antigravity IDE data (conversations / brain) under Gemini home
    p.join(home, ".gemini", "antigravity"),
    p.join(appData, "Antigravity"),
    p.join(localApp, "Antigravity"),
    p.join(xdgConfig, "Antigravity"),
    p.join(xdgData, "Antigravity"),
    p.join(home, "Library", "Application Support", "Antigravity"),
  ]);
}

/** Prefer backend model id when it looks real; else Antigravity alias. */
function pickModel(model: unknown, resolved: unknown): string | null {
  const m = typeof model === "string" ? model.trim() : "";
  const r = typeof resolved === "string" ? resolved.trim() : "";
  // Real model ids usually contain - / .  (kimi-k3, gemini-2.5-flash, openai/gpt-…)
  // Short brand labels like "XLab" stay as resolved only if no alias is present.
  if (r && (/[./-]/.test(r) || r.length > 8)) return r;
  if (m) return m;
  return r || null;
}

function requestTimestamp(ts: unknown): string {
  if (typeof ts === "string" && ts.trim()) return ts.trim();
  if (typeof ts === "number" && Number.isFinite(ts)) {
    // seconds vs ms
    const ms = ts > 1e12 ? ts : ts * 1000;
    return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

/**
 * Parse antigravity-proxy SQLite (`requests` table from @12errh/antigravity-proxy).
 * Rows with zero tokens and zero cost are skipped (errors / empty probes).
 */
export async function parseAntigravityProxyDb(dbPath: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all() as Array<{ name: string }>;
      const hasRequests = tables.some((t) => t.name.toLowerCase() === "requests");
      if (!hasRequests) return events;

      let rows: Array<Record<string, unknown>> = [];
      try {
        rows = db
          .prepare(
            `SELECT id, timestamp, model, resolved_model, provider, direction, type,
                    prompt_tokens, output_tokens, cost
             FROM requests
             ORDER BY timestamp ASC`,
          )
          .all() as Array<Record<string, unknown>>;
      } catch {
        // Column variance — fall back to SELECT *
        try {
          rows = db
            .prepare(`SELECT * FROM requests ORDER BY rowid ASC`)
            .all() as Array<Record<string, unknown>>;
        } catch {
          return events;
        }
      }

      // Same id may appear as incoming then outgoing (INSERT OR REPLACE keeps one);
      // if both somehow exist, keep the richer / outgoing row.
      const byId = new Map<string, Record<string, unknown>>();
      let autoIdx = 0;
      for (const row of rows) {
        autoIdx += 1;
        const id = String(row.id ?? row.rowid ?? `row-${autoIdx}`);
        const prev = byId.get(id);
        if (!prev) {
          byId.set(id, row);
          continue;
        }
        const prevDir = String(prev.direction || "");
        const nextDir = String(row.direction || "");
        const prevTok =
          num(prev.prompt_tokens ?? prev.promptTokens) +
          num(prev.output_tokens ?? prev.outputTokens);
        const nextTok =
          num(row.prompt_tokens ?? row.promptTokens) +
          num(row.output_tokens ?? row.outputTokens);
        const preferNext =
          (nextDir === "outgoing" && prevDir !== "outgoing") ||
          nextTok > prevTok ||
          (num(row.cost) > num(prev.cost) && nextTok >= prevTok);
        if (preferNext) byId.set(id, row);
      }

      for (const [nativeId, row] of byId) {
        const inputTokens = num(row.prompt_tokens ?? row.promptTokens);
        const outputTokens = num(row.output_tokens ?? row.outputTokens);
        const routerCost = num(row.cost);
        if (inputTokens + outputTokens <= 0 && routerCost <= 0) continue;

        // Skip pure incoming shells when an outgoing twin was preferred above;
        // still allow lone incoming with tokens (interrupted write).
        if (String(row.direction || "") === "incoming" && routerCost <= 0 && outputTokens <= 0) {
          // Keep incoming-with-prompt if it is the only row (useful partial).
          // Already deduped; include when prompt tokens exist.
          if (inputTokens <= 0) continue;
        }

        const model = pickModel(row.model, row.resolved_model ?? row.resolvedModel);
        const ts = requestTimestamp(row.timestamp);

        events.push(
          applyPricing({
            id: stableId("antigravity", dbPath, nativeId, String(inputTokens), String(outputTokens)),
            agent: "antigravity",
            model,
            timestamp: ts,
            inputTokens,
            outputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            workspace: null,
            sourcePath: dbPath,
            requestCount: 1,
            routerCost: routerCost > 0 ? routerCost : null,
          }),
        );
      }
    } finally {
      db.close();
    }
  } catch {
    // node:sqlite unavailable or DB locked / not sqlite
  }
  return events;
}

async function discoverProxyDbs(root: string): Promise<string[]> {
  const out: string[] = [];
  const candidates = [
    path.join(root, "data", "proxy.db"),
    path.join(root, "proxy.db"),
    path.join(root, "data", "data.sqlite"),
  ];
  for (const c of candidates) {
    if (await pathExists(c)) out.push(c);
  }

  // Shallow scan one level for proxy.db / *proxy*.db (portable installs)
  try {
    const ents = await readdir(root, { withFileTypes: true });
    for (const e of ents) {
      if (!e.isFile()) continue;
      const n = e.name.toLowerCase();
      if (n === "proxy.db" || (n.includes("proxy") && (n.endsWith(".db") || n.endsWith(".sqlite")))) {
        out.push(path.join(root, e.name));
      }
    }
    const dataDir = path.join(root, "data");
    if (await pathExists(dataDir)) {
      const dataEnts = await readdir(dataDir, { withFileTypes: true });
      for (const e of dataEnts) {
        if (!e.isFile()) continue;
        const n = e.name.toLowerCase();
        if (n === "proxy.db" || n.endsWith(".db") || n.endsWith(".sqlite")) {
          // Only names that look like proxy usage DBs
          if (n.includes("proxy") || n === "data.sqlite" || n === "usage.db") {
            out.push(path.join(dataDir, e.name));
          }
        }
      }
    }
  } catch {
    // ignore
  }

  return [...new Set(out.map((p) => path.resolve(p)))];
}

export async function parseAntigravity(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const seenDb = new Set<string>();
  const seenEventIds = new Set<string>();

  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    for (const dbPath of await discoverProxyDbs(root)) {
      const key = dbPath.toLowerCase();
      if (seenDb.has(key)) continue;
      seenDb.add(key);
      for (const e of await parseAntigravityProxyDb(dbPath)) {
        if (seenEventIds.has(e.id)) continue;
        seenEventIds.add(e.id);
        events.push(e);
      }
    }
  }

  // Secondary: JSON/JSONL usage under antigravity roots (exports, brain logs with usage)
  const jsonl = await parseGenericJsonl(roots, {
    agent: "antigravity",
    maxDepth: 8,
    match: (n, full) => {
      const lower = full.toLowerCase().replace(/\\/g, "/");
      // Skip huge electron caches / code caches
      if (
        lower.includes("/cache/") ||
        lower.includes("/code cache/") ||
        lower.includes("/gpucache/") ||
        lower.includes("/blob_storage/") ||
        lower.includes("/node_modules/")
      ) {
        return false;
      }
      return (
        n.endsWith(".jsonl") ||
        (n.endsWith(".json") &&
          (n.includes("usage") ||
            n.includes("history") ||
            n.includes("session") ||
            lower.includes("/antigravity/")))
      );
    },
  });

  for (const e of jsonl) {
    if (seenEventIds.has(e.id)) continue;
    seenEventIds.add(e.id);
    events.push(e);
  }

  return events;
}

export const agent: AgentModule = {
  id: "antigravity",
  label: "Antigravity",
  roots: antigravityRoots,
  parse: parseAntigravity,
};
