import path from "node:path";
import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { applyPricing } from "../../pricing.js";
import type { UsageEvent } from "../../types.js";
import { pathExists, stableId } from "../../util.js";
import { extractModel, extractTimestamp, extractTokenBuckets } from "../shared/usage-fields.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

/**
 * Devin Desktop (Cognition):
 * - %APPDATA%/devin/cli/sessions.db  (message_nodes.chat_message JSON + metrics)
 * - %APPDATA%/devin/User/**           (VS Code fork storage)
 * - ~/.devin
 */
export async function parseDevin(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  // Windows paths are case-insensitive — normalize to avoid double-counting
  // e.g. %APPDATA%/devin vs %APPDATA%/Devin
  const seenDb = new Set<string>();

  for (const root of roots) {
    if (!(await pathExists(root))) continue;

    // SQLite sessions
    for (const rel of ["cli/sessions.db", "sessions.db", "state.db"]) {
      const dbPath = path.join(root, rel);
      const dbKey = dbPath.toLowerCase();
      if (await pathExists(dbPath) && !seenDb.has(dbKey)) {
        seenDb.add(dbKey);
        events.push(...(await parseDevinSqlite(dbPath)));
      }
    }

    // JSON/JSONL fallback under root
    events.push(
      ...(await parseGenericJsonl([root], {
        agent: "devin",
        maxDepth: 8,
        match: (n, full) =>
          n.endsWith(".jsonl") ||
          (n.endsWith(".json") &&
            (n.includes("usage") ||
              n.includes("session") ||
              full.includes(`${path.sep}summaries${path.sep}`) === false)),
      })),
    );
  }

  return events;
}

async function parseDevinSqlite(dbPath: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const sessionModels = new Map<string, string | null>();
      try {
        const sessions = db.prepare(`SELECT id, model, working_directory FROM sessions`).all() as Array<{
          id: string;
          model?: string;
          working_directory?: string;
        }>;
        for (const s of sessions) {
          const m = typeof s.model === "string" ? s.model.trim() : "";
          sessionModels.set(String(s.id), m || null);
        }
      } catch {
        // schema variance
      }

      const rows = db
        .prepare(
          `SELECT row_id, session_id, chat_message, created_at, metadata
           FROM message_nodes
           WHERE chat_message IS NOT NULL
           LIMIT 100000`,
        )
        .all() as Array<{
        row_id: number | string;
        session_id: string;
        chat_message: unknown;
        created_at?: string;
        metadata?: unknown;
      }>;

      for (const row of rows) {
        const raw =
          typeof row.chat_message === "string"
            ? row.chat_message
            : Buffer.isBuffer(row.chat_message)
              ? row.chat_message.toString("utf8")
              : row.chat_message instanceof Uint8Array
                ? Buffer.from(row.chat_message).toString("utf8")
                : null;
        if (!raw) continue;

        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          continue;
        }

        const buckets = extractTokenBuckets(msg);
        if (!buckets) continue;

        const sid = String(row.session_id ?? "");
        // Some Devin sessions leave model empty in sessions table (legacy / adaptive routing)
        const model =
          extractModel(msg, msg.metadata, sessionModels.get(sid)) ||
          sessionModels.get(sid) ||
          null;
        const ts =
          extractTimestamp(msg, msg.metadata, row.created_at) ||
          (typeof row.created_at === "string" ? row.created_at : new Date().toISOString());

        events.push(
          applyPricing({
            id: stableId(
              "devin",
              // stable across path casing so remounts don't duplicate
              dbPath.toLowerCase(),
              sid,
              String(row.row_id),
              String(buckets.inputTokens),
              String(buckets.outputTokens),
            ),
            agent: "devin",
            model,
            timestamp: ts,
            ...buckets,
            workspace: null,
            sourcePath: dbPath,
          }),
        );
      }
    } finally {
      db.close();
    }
  } catch {
    // locked or unavailable
  }
  return events;
}

export const agent: AgentModule = {
  id: "devin",
  label: "Devin",
  roots() {
    const { home, appData, localApp, path } = pathEnv();
    return unique([
      path.join(appData, "devin"),
      path.join(home, ".devin"),
      path.join(localApp, "devin"),
      path.join(appData, "Devin"),
    ]);
  },
  parse: parseDevin,
};
