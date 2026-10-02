import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";

import path from "node:path";
import { applyPricing } from "../../pricing.js";
import type { UsageEvent } from "../../types.js";
import { parseJsonl, pathExists, readText, stableId, walkFiles } from "../../util.js";
import { extractModel, extractTimestamp, extractTokenBuckets } from "../shared/usage-fields.js";

/**
 * OpenClaw (+ legacy clawdbot / moltbot / moldbot):
 * - ~/.openclaw/agents/<agent>/sessions/*.jsonl
 * - sessions.json index pointing at transcript files
 * Usage from assistant message.usage / modelId
 */
export async function parseOpenClaw(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const seenFiles = new Set<string>();
  const seenDatabases = new Set<string>();

  for (const root of roots) {
    if (!(await pathExists(root))) continue;

    // Follow sessions.json indexes
    const indexes = await walkFiles(root, {
      maxDepth: 8,
      match: (n) => n === "sessions.json" || n === "session-index.json",
    });
    for (const indexPath of indexes) {
      const text = await readText(indexPath);
      if (!text) continue;
      try {
        const data = JSON.parse(text) as unknown;
        const refs = collectPathRefs(data, path.dirname(indexPath));
        for (const ref of refs) {
          await parseSessionFile(events, ref, seenFiles);
        }
      } catch {
        // ignore bad index
      }
    }

    // Direct walk: agents, sessions, jsonl
    const files = await walkFiles(root, {
      maxDepth: 10,
      match: (n, full) => {
        if (n.endsWith(".jsonl")) return true;
        if (n.endsWith(".json") && /session|transcript|chat|agent/i.test(full)) return true;
        return false;
      },
    });

    for (const file of files) {
      if (path.basename(file) === "sessions.json") continue;
      await parseSessionFile(events, file, seenFiles);
    }

    // Current OpenClaw stores session transcripts in a SQLite event log.
    const databases = await walkFiles(root, {
      maxDepth: 10,
      match: (name) => name === "openclaw-agent.sqlite",
    });
    for (const database of databases) {
      const key = path.resolve(database).toLowerCase();
      if (seenDatabases.has(key)) continue;
      seenDatabases.add(key);
      events.push(...(await parseOpenClawDatabase(database)));
    }
  }

  return events;
}

async function parseOpenClawDatabase(dbPath: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      if (!tables.some((table) => table.name === "transcript_events")) return events;

      const sessionModels = new Map<string, string | null>();
      if (tables.some((table) => table.name === "session_windows")) {
        try {
          const columns = db
            .prepare("PRAGMA table_info(session_windows)")
            .all() as Array<{ name: string }>;
          const names = new Set(columns.map((column) => column.name));
          if (names.has("session_id") && names.has("model")) {
            const rows = db
              .prepare("SELECT session_id, model FROM session_windows")
              .all() as Array<Record<string, unknown>>;
            for (const row of rows) {
              const sessionId = String(row.session_id ?? "");
              const model = typeof row.model === "string" && row.model.trim() ? row.model.trim() : null;
              if (sessionId && model) sessionModels.set(sessionId, model);
            }
          }
        } catch {
          // Keep parsing event-local models when the session index differs by version.
        }
      }

      const rows = db
        .prepare("SELECT session_id, seq, event_json, created_at FROM transcript_events ORDER BY created_at, seq")
        .all() as Array<Record<string, unknown>>;
      const eventModels = new Map<string, string | null>();
      for (const row of rows) {
        const sessionId = String(row.session_id ?? "");
        if (!sessionId || typeof row.event_json !== "string") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.event_json);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== "object") continue;
        const record = parsed as Record<string, unknown>;
        const type = String(record.type ?? record.role ?? record.event ?? "");
        const currentModel = eventModels.get(sessionId) ?? sessionModels.get(sessionId) ?? null;

        if (type === "model_change" || type === "session_meta" || type === "system") {
          const model = extractModel(record, record.message, currentModel);
          if (model) eventModels.set(sessionId, model);
          continue;
        }

        const message =
          record.message && typeof record.message === "object"
            ? (record.message as Record<string, unknown>)
            : record;
        const role = String(message.role ?? record.role ?? "").toLowerCase();
        if (role && role !== "assistant") continue;
        const usage = message.usage ?? record.usage ?? record.token_usage;
        const buckets = extractTokenBuckets(usage ?? message);
        if (
          !buckets ||
          buckets.inputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens <= 0
        ) {
          continue;
        }

        const model = extractModel(record, message, currentModel) || null;
        if (model) eventModels.set(sessionId, model);
        const seq = String(row.seq ?? "");
        events.push(
          applyPricing({
            id: stableId("openclaw", dbPath, sessionId, seq, String(buckets.inputTokens), String(buckets.outputTokens)),
            agent: "openclaw",
            model,
            timestamp: extractTimestamp(record, message, row.created_at),
            ...buckets,
            workspace: typeof record.cwd === "string" ? record.cwd : null,
            sourcePath: dbPath,
          }),
        );
      }
    } finally {
      db.close();
    }
  } catch {
    // node:sqlite may be unavailable or a database may be mid-migration.
  }
  return events;
}

async function parseSessionFile(
  events: UsageEvent[],
  file: string,
  seen: Set<string>,
): Promise<void> {
  if (seen.has(file)) return;
  seen.add(file);
  if (!(await pathExists(file))) return;
  const text = await readText(file);
  if (!text) return;

  const rows = file.endsWith(".jsonl")
    ? parseJsonl(text)
    : (() => {
        try {
          const d = JSON.parse(text);
          if (Array.isArray(d)) return d;
          if (d && typeof d === "object") {
            const o = d as Record<string, unknown>;
            if (Array.isArray(o.messages)) return o.messages;
            if (Array.isArray(o.events)) return o.events;
            return [d];
          }
        } catch {
          return [];
        }
        return [];
      })();

  let idx = 0;
  let model: string | null = null;
  let workspace: string | null = null;

  for (const row of rows) {
    idx += 1;
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const type = String(r.type ?? r.role ?? r.event ?? "");

    if (type === "model_change" || type === "session_meta" || type === "system") {
      model = extractModel(r, r.message, model) || model;
      if (typeof r.cwd === "string") workspace = r.cwd;
      continue;
    }

    // assistant / message with usage
    const msg = (r.message && typeof r.message === "object" ? r.message : r) as Record<string, unknown>;
    const usage = msg.usage ?? r.usage ?? r.token_usage;
    const buckets = extractTokenBuckets(usage ?? msg);
    if (!buckets) continue;

    model = extractModel(r, msg, model) || model;
    const ts = extractTimestamp(r, msg);

    events.push(
      applyPricing({
        id: stableId("openclaw", file, String(idx), String(buckets.inputTokens), String(buckets.outputTokens)),
        agent: "openclaw",
        model,
        timestamp: ts,
        ...buckets,
        workspace,
        sourcePath: file,
      }),
    );
  }
}

function collectPathRefs(data: unknown, baseDir: string): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (!v) return;
    if (typeof v === "string") {
      if (v.endsWith(".jsonl") || v.endsWith(".json")) {
        out.push(path.isAbsolute(v) ? v : path.resolve(baseDir, v));
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (/path|file|session|transcript/i.test(k) && typeof val === "string") {
          out.push(path.isAbsolute(val) ? val : path.resolve(baseDir, val));
        } else {
          visit(val);
        }
      }
    }
  };
  visit(data);
  return [...new Set(out)];
}


export const agent: AgentModule = {
  id: "openclaw",
  label: "OpenClaw",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".openclaw"),
      path.join(home, ".clawdbot"),
      path.join(home, ".moltbot"),
      path.join(home, ".moldbot"),
      path.join(appData, "openclaw"),
      path.join(localApp, "openclaw"),
      path.join(xdgData, "openclaw"),
      path.join(xdgConfig, "openclaw"),
    ]);
  },
  parse: parseOpenClaw,
};
