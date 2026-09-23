import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";

import { applyPricing } from "../../pricing.js";
import type { UsageEvent } from "../../types.js";
import { extractModel, extractTimestamp, extractTokenBuckets } from "../shared/usage-fields.js";
import { num, parseJsonl, pathExists, readText, stableId, walkFiles } from "../../util.js";

type JsonRecord = Record<string, unknown>;
type IndexedEvent = {
  event: UsageEvent;
  priority: number;
  kind: "message" | "rollup";
  sessionId?: string;
};
type EventIndex = Map<string, IndexedEvent>;
type OpenCodeSessionRollup = {
  directory: string | null;
  model: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function firstValue(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function parseOpenCodeRecord(
  value: unknown,
  sourcePath: string,
  sourceIdentity: string,
  fallbackTimestamp?: unknown,
  fallbackWorkspace?: string | null,
): { key: string; event: UsageEvent; sessionId?: string } | null {
  const message = asRecord(value);
  if (!message) return null;

  const role =
    typeof message.role === "string"
      ? message.role.toLowerCase()
      : typeof message.type === "string"
        ? message.type.toLowerCase()
        : "";
  if (role && role !== "assistant") return null;

  const nativeTokens = asRecord(message.tokens);
  const usage =
    asRecord(message.usage) ?? nativeTokens ?? asRecord(message.cost) ?? message;
  const cache = asRecord(usage.cache);
  const rawOutput = firstValue(
    usage.output,
    usage.output_tokens,
    usage.outputTokens,
    usage.completion_tokens,
    usage.completionTokens,
    usage.total_output_tokens,
  );
  const rawReasoning = firstValue(
    usage.reasoning,
    usage.reasoning_tokens,
    usage.reasoningTokens,
    usage.reasoning_output_tokens,
    usage.reasoningOutputTokens,
  );
  // OpenCode stores output and reasoning as separate, non-overlapping counts.
  const nativeOpenCodeTokens = usage === nativeTokens &&
    ("reasoning" in usage || cache !== null);
  const normalizedUsage: JsonRecord = {
    ...usage,
    ...(firstValue(
      usage.cache_read,
      usage.cache_read_tokens,
      usage.cacheReadTokens,
      usage.cachedReadTokens,
      cache?.read,
    ) !== undefined
      ? {
          cache_read_tokens: firstValue(
            usage.cache_read,
            usage.cache_read_tokens,
            usage.cacheReadTokens,
            usage.cachedReadTokens,
            cache?.read,
          ),
        }
      : {}),
    ...(firstValue(
      usage.cache_write,
      usage.cache_write_tokens,
      usage.cacheWriteTokens,
      usage.cachedWriteTokens,
      cache?.write,
    ) !== undefined
      ? {
          cache_write_tokens: firstValue(
            usage.cache_write,
            usage.cache_write_tokens,
            usage.cacheWriteTokens,
            usage.cachedWriteTokens,
            cache?.write,
          ),
        }
      : {}),
    ...(nativeOpenCodeTokens && (rawOutput != null || rawReasoning != null)
      ? { output_tokens: num(rawOutput) + num(rawReasoning) }
      : {}),
  };

  const extracted = extractTokenBuckets(normalizedUsage);
  const reportedTotal = num(
    firstValue(usage.total, usage.total_tokens, usage.totalTokens),
  );
  let buckets = extracted;
  let estimated = false;
  if (!buckets && reportedTotal > 0) {
    buckets = {
      inputTokens: reportedTotal,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    estimated = true;
  } else if (buckets && reportedTotal > 0) {
    const categorized =
      buckets.inputTokens +
      buckets.outputTokens +
      buckets.cacheReadTokens +
      buckets.cacheWriteTokens;
    if (reportedTotal > categorized) {
      buckets = { ...buckets, inputTokens: buckets.inputTokens + reportedTotal - categorized };
      estimated = true;
    }
  }
  if (!buckets) return null;

  const messageId = typeof message.id === "string" && message.id.trim()
    ? message.id.trim()
    : null;
  const key = messageId ? `message:${messageId}` : sourceIdentity;
  const rawSessionId = firstValue(message.sessionID, message.sessionId, message.session_id);
  const sessionId = typeof rawSessionId === "string" && rawSessionId ? rawSessionId : undefined;
  const modelRecord = asRecord(message.model);
  const model = extractModel(
    message.modelID,
    message.modelId,
    message.model_id,
    typeof message.model === "string" ? message.model : null,
    modelRecord?.id,
    modelRecord?.modelID,
    modelRecord?.modelId,
  );
  const messageTime = asRecord(message.time);
  const messagePath = asRecord(message.path);
  const workspace =
    (typeof messagePath?.cwd === "string" && messagePath.cwd) ||
    (typeof message.cwd === "string" && message.cwd) ||
    (typeof message.workspace === "string" && message.workspace) ||
    fallbackWorkspace ||
    null;

  return {
    key,
    sessionId,
    event: applyPricing({
      id: stableId("opencode", key),
      agent: "opencode",
      model,
      timestamp: extractTimestamp(
        message.timestamp,
        message.timeCreated,
        messageTime?.created,
        fallbackTimestamp,
      ),
      inputTokens: buckets.inputTokens,
      outputTokens: buckets.outputTokens,
      cacheReadTokens: buckets.cacheReadTokens,
      cacheWriteTokens: buckets.cacheWriteTokens,
      workspace,
      sourcePath,
      ...(estimated ? { estimated: true } : {}),
    }),
  };
}

function indexEvent(
  index: EventIndex,
  parsed: { key: string; event: UsageEvent; sessionId?: string },
  priority: number,
  kind: IndexedEvent["kind"] = "message",
): void {
  const current = index.get(parsed.key);
  if (!current || priority >= current.priority) {
    index.set(parsed.key, { event: parsed.event, priority, kind, sessionId: parsed.sessionId });
  }
}

async function parseOpenCodeJsonFiles(roots: string[], index: EventIndex): Promise<void> {
  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    const files = await walkFiles(root, {
      maxDepth: 10,
      match: (name) => name.endsWith(".jsonl") || (name.endsWith(".json") && name.includes("message")),
    });

    for (const file of files) {
      const text = await readText(file);
      if (!text) continue;
      const rows = file.endsWith(".jsonl")
        ? parseJsonl(text)
        : (() => {
            try {
              const data: unknown = JSON.parse(text);
              const object = asRecord(data);
              if (Array.isArray(data)) return data;
              if (Array.isArray(object?.messages)) return object.messages;
              return data == null ? [] : [data];
            } catch {
              return [];
            }
          })();

      let rowIndex = 0;
      for (const row of rows) {
        rowIndex += 1;
        const record = asRecord(row);
        const identity =
          typeof record?.id === "string" && record.id.trim()
            ? `message:${record.id.trim()}`
            : `file:${file}:${rowIndex}`;
        const parsed = parseOpenCodeRecord(row, file, identity);
        if (parsed) indexEvent(index, parsed, 1);
      }
    }
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function parseOpenCodeDatabase(dbPath: string, index: EventIndex): Promise<void> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      const tableNames = new Set(tables.map((table) => table.name));
      const sessionRollups = new Map<string, OpenCodeSessionRollup>();

      if (tableNames.has("session_v2")) {
        const sessionColumns = new Set(
          (
            db.prepare('PRAGMA table_info("session_v2")').all() as Array<{ name: string }>
          ).map((column) => column.name),
        );
        if (sessionColumns.has("id")) {
          const sessionColumn = (name: string) =>
            sessionColumns.has(name) ? quoteIdentifier(name) : "NULL";
          const sessions = db
            .prepare(`
              SELECT
                ${sessionColumn("id")} AS id,
                ${sessionColumn("directory")} AS directory,
                ${sessionColumn("model")} AS model,
                ${sessionColumn("time_created")} AS created_at,
                ${sessionColumn("time_updated")} AS updated_at,
                ${sessionColumn("tokens_input")} AS input_tokens,
                ${sessionColumn("tokens_output")} AS output_tokens,
                ${sessionColumn("tokens_reasoning")} AS reasoning_tokens,
                ${sessionColumn("tokens_cache_read")} AS cache_read_tokens,
                ${sessionColumn("tokens_cache_write")} AS cache_write_tokens
              FROM "session_v2"
            `)
            .all() as Array<Record<string, unknown>>;
          for (const session of sessions) {
            if (typeof session.id !== "string") continue;
            sessionRollups.set(session.id, {
              directory: typeof session.directory === "string" ? session.directory : null,
              model: session.model,
              createdAt: session.created_at,
              updatedAt: session.updated_at,
              inputTokens: num(session.input_tokens),
              outputTokens: num(session.output_tokens),
              reasoningTokens: num(session.reasoning_tokens),
              cacheReadTokens: num(session.cache_read_tokens),
              cacheWriteTokens: num(session.cache_write_tokens),
            });
          }
        }
      }

      for (const table of ["message", "session_message"] as const) {
        if (!tableNames.has(table)) continue;
        const columns = new Set(
          (
            db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{
              name: string;
            }>
          ).map((column) => column.name),
        );
        if (!columns.has("data")) continue;

        const column = (name: string) =>
          columns.has(name) ? quoteIdentifier(name) : "NULL";
        const payload = `CASE WHEN json_valid(${quoteIdentifier("data")}) THEN ${quoteIdentifier("data")} ELSE '{}' END`;
        const json = (path: string) => `json_extract(payload, '${path}')`;
        const idExpression = columns.has("id") ? quoteIdentifier("id") : "rowid";
        const roleExpression = `LOWER(CAST(COALESCE(${json("$.role")}, message_type, '') AS TEXT))`;
        const sql = `
          WITH records AS (
            SELECT
              ${idExpression} AS record_id,
              ${column("session_id")} AS session_id,
              ${column("type")} AS message_type,
              ${column("time_created")} AS row_timestamp,
              ${payload} AS payload
            FROM ${quoteIdentifier(table)}
          )
          SELECT
            record_id,
            session_id,
            message_type,
            row_timestamp,
            ${json("$.modelID")} AS model_id,
            ${json("$.modelId")} AS model_id_alt,
            ${json("$.model.id")} AS nested_model_id,
            ${json("$.model.modelID")} AS nested_model_id_alt,
            ${json("$.model")} AS model_value,
            ${json("$.path.cwd")} AS cwd,
            ${json("$.cwd")} AS cwd_alt,
            ${json("$.workspace")} AS workspace,
            ${json("$.time.created")} AS message_created,
            ${json("$.timestamp")} AS message_timestamp,
            ${json("$.tokens.input")} AS input_tokens,
            ${json("$.tokens.input_tokens")} AS input_tokens_alt,
            ${json("$.tokens.output")} AS output_tokens,
            ${json("$.tokens.reasoning")} AS reasoning_tokens,
            ${json("$.tokens.cache.read")} AS cache_read_tokens,
            ${json("$.tokens.cache.write")} AS cache_write_tokens,
            ${json("$.tokens.total")} AS total_tokens
          FROM records
          WHERE ${roleExpression} = 'assistant'
        `;
        const rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
        const priority = table === "session_message" ? 3 : 2;

        for (const row of rows) {
          const messageId =
            typeof row.record_id === "string" || typeof row.record_id === "number"
              ? String(row.record_id)
              : "";
          const sessionId = typeof row.session_id === "string" ? row.session_id : "";
          let modelValue = row.model_value;
          if (typeof modelValue === "string" && modelValue.startsWith("{")) {
            try {
              modelValue = JSON.parse(modelValue);
            } catch {
              // Keep the raw value; the explicit model id columns remain preferred.
            }
          }
          const modelValueRecord = asRecord(modelValue);
          const record: JsonRecord = {
            id: messageId,
            role: "assistant",
            modelID: firstValue(row.model_id, row.model_id_alt),
            model: firstValue(
              row.nested_model_id,
              row.nested_model_id_alt,
              typeof modelValue === "string" ? modelValue : null,
              modelValueRecord?.id,
              modelValueRecord?.modelID,
            ),
            path: {
              cwd: firstValue(
                row.cwd,
                row.cwd_alt,
                row.workspace,
                sessionId ? sessionRollups.get(sessionId)?.directory : null,
              ),
            },
            sessionID: sessionId,
            time: { created: firstValue(row.message_created, row.message_timestamp) },
            tokens: {
              input: firstValue(row.input_tokens, row.input_tokens_alt),
              output: row.output_tokens,
              reasoning: row.reasoning_tokens,
              total: row.total_tokens,
              cache: { read: row.cache_read_tokens, write: row.cache_write_tokens },
            },
          };
          const identity = messageId
            ? `message:${messageId}`
            : `database:${dbPath}:${table}:${String(row.row_timestamp ?? "")}`;
          const parsed = parseOpenCodeRecord(
            record,
            dbPath,
            identity,
            row.row_timestamp,
          );
          if (parsed) indexEvent(index, parsed, priority);
        }
      }

      // OpenCode compacts old messages, but session_v2 keeps cumulative usage.
      // Add only the positive difference so compacted history remains included.
      const detailsBySession = new Map<
        string,
        {
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheWriteTokens: number;
          models: Set<string>;
        }
      >();
      for (const indexed of index.values()) {
        if (indexed.kind !== "message" || !indexed.sessionId) continue;
        let detail = detailsBySession.get(indexed.sessionId);
        if (!detail) {
          detail = {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            models: new Set<string>(),
          };
          detailsBySession.set(indexed.sessionId, detail);
        }
        detail.inputTokens += indexed.event.inputTokens;
        detail.outputTokens += indexed.event.outputTokens;
        detail.cacheReadTokens += indexed.event.cacheReadTokens;
        detail.cacheWriteTokens += indexed.event.cacheWriteTokens;
        if (indexed.event.model) detail.models.add(indexed.event.model);
      }

      for (const [sessionId, rollup] of sessionRollups) {
        const detail = detailsBySession.get(sessionId);
        const inputTokens = Math.max(0, rollup.inputTokens - (detail?.inputTokens ?? 0));
        const outputTokens = Math.max(
          0,
          rollup.outputTokens + rollup.reasoningTokens - (detail?.outputTokens ?? 0),
        );
        const cacheReadTokens = Math.max(
          0,
          rollup.cacheReadTokens - (detail?.cacheReadTokens ?? 0),
        );
        const cacheWriteTokens = Math.max(
          0,
          rollup.cacheWriteTokens - (detail?.cacheWriteTokens ?? 0),
        );
        if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0) continue;

        let model: string | null = null;
        if ((detail?.models.size ?? 0) === 1) {
          model = [...detail!.models][0] ?? null;
        } else if (!detail?.models.size) {
          let rawModel = rollup.model;
          if (typeof rawModel === "string" && rawModel.startsWith("{")) {
            try {
              rawModel = JSON.parse(rawModel);
            } catch {
              // The stored model may still be a useful plain string.
            }
          }
          const modelRecord = asRecord(rawModel);
          model = extractModel(
            modelRecord?.id,
            modelRecord?.modelID,
            modelRecord?.modelId,
            typeof rawModel === "string" ? rawModel : null,
          );
        }

        const key = `session-rollup:${sessionId}`;
        indexEvent(
          index,
          {
            key,
            sessionId,
            event: applyPricing({
              id: stableId("opencode", key),
              agent: "opencode",
              model,
              timestamp: extractTimestamp(rollup.updatedAt, rollup.createdAt),
              inputTokens,
              outputTokens,
              cacheReadTokens,
              cacheWriteTokens,
              workspace: rollup.directory,
              sourcePath: dbPath,
              estimated: true,
            }),
          },
          4,
          "rollup",
        );
      }
    } finally {
      db.close();
    }
  } catch {
    // OpenCode may be running or the file may be an older/non-SQLite installation.
  }
}

/** OpenCode stores current usage in SQLite and older installs in JSON/JSONL. */
export async function parseOpenCode(roots: string[]): Promise<UsageEvent[]> {
  const index: EventIndex = new Map();

  // Keep legacy JSON support. Database rows have higher priority for duplicate message IDs.
  await parseOpenCodeJsonFiles(roots, index);

  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    const databases = await walkFiles(root, {
      maxDepth: 2,
      match: (name) => /^opencode(?:[-_].*)?\.(?:db|sqlite|sqlite3)$/i.test(name),
    });
    for (const dbPath of databases) {
      await parseOpenCodeDatabase(dbPath, index);
    }
  }

  return [...index.values()].map(({ event }) => event);
}

export const agent: AgentModule = {
  id: "opencode",
  label: "OpenCode",
  roots() {
    const { home, appData, localApp, xdgData, path } = pathEnv();
    return unique([
      path.join(xdgData, "opencode"),
      path.join(home, ".local", "share", "opencode"),
      path.join(home, ".opencode"),
      path.join(appData, "opencode"),
      path.join(localApp, "opencode"),
    ]);
  },
  parse: parseOpenCode,
};
