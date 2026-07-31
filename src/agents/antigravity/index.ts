import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { applyPricing } from "../../pricing.js";
import type { UsageEvent } from "../../types.js";
import {
  estimateTokensFromText,
  num,
  parseJsonl,
  pathExists,
  readText,
  stableId,
  walkFiles,
} from "../../util.js";
import { extractTokenBuckets } from "../shared/usage-fields.js";

/**
 * Antigravity IDE + antigravity-proxy usage.
 *
 * Sources (all scanned):
 *  1. antigravity-proxy SQLite  ~/.antigravity/data/proxy.db  → real prompt/output/cost
 *  2. Local IDE brain transcripts  ~/.gemini/antigravity/brain/<id>/.../transcript*.jsonl
 *     → estimated tokens from user + model text (Antigravity does not store token counters)
 *  3. Conversation DBs  ~/.gemini/antigravity/conversations/*.db
 *     → model id + fallback estimate when transcript missing
 *  4. Explicit usage JSON/JSONL under antigravity roots (if any)
 *
 * Policy: prefer real proxy rows; always include local transcript estimates so
 * full IDE history is tracked (not only proxied requests).
 */
export function antigravityRoots(): string[] {
  const { home, appData, localApp, xdgData, xdgConfig, path: p, expandHome } = pathEnv();
  return unique([
    expandHome(process.env.TOKENLAB_ANTIGRAVITY_DIR || process.env.ANTIGRAVITY_HOME || ""),
    p.join(home, ".antigravity"),
    p.join(home, ".gemini", "antigravity"),
    p.join(home, ".gemini"), // nested antigravity/ discovered below
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
  if (r && (/[./-]/.test(r) || r.length > 8)) return r;
  if (m) return m;
  return r || null;
}

function requestTimestamp(ts: unknown): string {
  if (typeof ts === "string" && ts.trim()) return ts.trim();
  if (typeof ts === "number" && Number.isFinite(ts)) {
    const ms = ts > 1e12 ? ts : ts * 1000;
    return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

function extractPrintableStrings(buf: Buffer): string[] {
  const strs: string[] = [];
  let cur = "";
  for (const b of buf) {
    if (b >= 32 && b < 127) cur += String.fromCharCode(b);
    else {
      if (cur.length >= 3) strs.push(cur);
      cur = "";
    }
  }
  if (cur.length >= 3) strs.push(cur);
  return strs;
}

/** Pull model aliases from free text / protobuf strings. */
function extractModelFromText(...parts: string[]): string | null {
  const blob = parts.filter(Boolean).join("\n");
  if (!blob) return null;
  // Explicit Antigravity model ids
  const id =
    blob.match(/\b(gemini-[\w.-]+)\b/i)?.[1] ||
    blob.match(/\b(claude-[\w.-]+)\b/i)?.[1] ||
    blob.match(/\b(gpt-[\w.-]+)\b/i)?.[1] ||
    blob.match(/\b(kimi-[\w.-]+)\b/i)?.[1] ||
    blob.match(/\b(qwen[\w.-]+)\b/i)?.[1];
  if (id) return id;
  // UI label: "Model Selection` from None to Gemini 3.6 Flash (High)"
  const ui = blob.match(/Model Selection[^.\n]{0,80}?to\s+([^\n.<]{3,60})/i)?.[1];
  if (ui) {
    const cleaned = ui.trim().replace(/\s+/g, "-").toLowerCase();
    if (cleaned.includes("gemini")) {
      if (cleaned.includes("flash") && cleaned.includes("high")) return "gemini-3.6-flash-high";
      if (cleaned.includes("flash") && cleaned.includes("tiered")) return "gemini-3.6-flash-tiered";
      if (cleaned.includes("flash")) return "gemini-3.6-flash";
      if (cleaned.includes("pro")) return "gemini-3.6-pro";
      return "gemini";
    }
    return cleaned.slice(0, 64);
  }
  return null;
}

function textFromUnknown(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(textFromUnknown).join("\n");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (typeof o.content === "string") return o.content;
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * Parse antigravity-proxy SQLite (`requests` table).
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
                    prompt_tokens, output_tokens, cost, content
             FROM requests
             ORDER BY timestamp ASC`,
          )
          .all() as Array<Record<string, unknown>>;
      } catch {
        try {
          rows = db
            .prepare(`SELECT * FROM requests ORDER BY rowid ASC`)
            .all() as Array<Record<string, unknown>>;
        } catch {
          return events;
        }
      }

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

        if (String(row.direction || "") === "incoming" && routerCost <= 0 && outputTokens <= 0) {
          if (inputTokens <= 0) continue;
        }

        const model = pickModel(row.model, row.resolved_model ?? row.resolvedModel);
        const ts = requestTimestamp(row.timestamp);

        events.push(
          applyPricing({
            id: stableId("antigravity", "proxy", dbPath, nativeId, String(inputTokens), String(outputTokens)),
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
    // node:sqlite unavailable or DB locked
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
        if (
          n === "proxy.db" ||
          ((n.endsWith(".db") || n.endsWith(".sqlite")) &&
            (n.includes("proxy") || n === "data.sqlite" || n === "usage.db"))
        ) {
          out.push(path.join(dataDir, e.name));
        }
      }
    }
  } catch {
    // ignore
  }

  return [...new Set(out.map((p) => path.resolve(p)))];
}

/**
 * Discover local Antigravity IDE data roots under a scanned root.
 * Handles `~/.gemini/antigravity`, `~/.gemini` (nested), and portable trees
 * that already contain `brain/` or `conversations/` at the root.
 */
function ideDataCandidates(root: string): string[] {
  const out: string[] = [root];
  const lower = root.replace(/\\/g, "/").toLowerCase();
  out.push(path.join(root, "antigravity"));
  // gemini home → nested antigravity
  if (lower.endsWith("/.gemini") || lower.endsWith("/gemini")) {
    out.push(path.join(root, "antigravity"));
  }
  return unique(out);
}

/** Model map conversationId → model from conversations/*.db gen_metadata. */
async function loadConversationModels(ideRoot: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const convDir = path.join(ideRoot, "conversations");
  if (!(await pathExists(convDir))) return map;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const ents = await readdir(convDir, { withFileTypes: true });
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith(".db")) continue;
      const convId = e.name.replace(/\.db$/i, "");
      const dbPath = path.join(convDir, e.name);
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          const rows = db.prepare(`SELECT data FROM gen_metadata LIMIT 20`).all() as Array<{
            data: Buffer | string;
          }>;
          let model: string | null = null;
          for (const r of rows) {
            const buf = Buffer.isBuffer(r.data) ? r.data : Buffer.from(String(r.data));
            const strs = extractPrintableStrings(buf);
            model = extractModelFromText(...strs);
            if (model) break;
          }
          if (model) map.set(convId, model);
        } finally {
          db.close();
        }
      } catch {
        // locked / not sqlite
      }
    }
  } catch {
    // ignore
  }
  return map;
}

/**
 * Estimate usage from brain transcripts.
 * Prefer transcript_full.jsonl over transcript.jsonl (same folder).
 * Emits one event per MODEL step (cumulative context like Grok estimate).
 */
export async function parseAntigravityTranscripts(
  ideRoot: string,
  modelByConv: Map<string, string>,
): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const brain = path.join(ideRoot, "brain");
  if (!(await pathExists(brain))) return events;

  // Collect preferred transcript paths per conversation
  const files = await walkFiles(brain, {
    maxDepth: 10,
    match: (n) => n === "transcript_full.jsonl" || n === "transcript.jsonl",
  });

  // Prefer full: skip plain if full exists in same dir
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const dir = path.dirname(f);
    const list = byDir.get(dir) || [];
    list.push(f);
    byDir.set(dir, list);
  }

  const selected: string[] = [];
  for (const [, list] of byDir) {
    const full = list.find((p) => path.basename(p) === "transcript_full.jsonl");
    selected.push(full || list[0]!);
  }

  for (const file of selected) {
    // conversation id = first path segment under brain/
    const rel = path.relative(brain, file);
    const convId = rel.split(path.sep)[0] || path.basename(path.dirname(file));
    const text = await readText(file);
    if (!text) continue;

    let model =
      modelByConv.get(convId) ||
      extractModelFromText(text.slice(0, 50_000)) ||
      "gemini";

    let contextChars = 0;
    let turn = 0;
    let lastUserTs: string | null = null;

    for (const row of parseJsonl(text)) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const type = String(r.type || "");
      const source = String(r.source || "");
      const ts =
        (typeof r.created_at === "string" && r.created_at) ||
        (typeof r.timestamp === "string" && r.timestamp) ||
        lastUserTs ||
        new Date().toISOString();

      // Model switch in user metadata
      if (type === "USER_INPUT" || source === "USER_EXPLICIT") {
        const content = textFromUnknown(r.content);
        const m = extractModelFromText(content);
        if (m) model = m;
        contextChars += content.length;
        lastUserTs = ts;
        continue;
      }

      // System / history / tool results expand context for later model turns
      if (
        source === "SYSTEM" ||
        type === "CONVERSATION_HISTORY" ||
        type === "SYSTEM_MESSAGE" ||
        type === "TOOL_RESULT" ||
        type === "GENERIC" ||
        type === "CHECKPOINT"
      ) {
        const extra =
          textFromUnknown(r.content) +
          textFromUnknown(r.thinking) +
          textFromUnknown(r.tool_calls) +
          textFromUnknown(r.result);
        contextChars += extra.length;
        continue;
      }

      // Model turns (planner / response / code action with thinking)
      const isModel =
        source === "MODEL" ||
        type === "PLANNER_RESPONSE" ||
        type === "MODEL_RESPONSE" ||
        type === "CODE_ACTION" ||
        type === "ERROR_MESSAGE";
      if (!isModel) {
        // Other steps (list_dir, run_command, …) still contribute tool result text to context
        const extra =
          textFromUnknown(r.content) +
          textFromUnknown(r.thinking) +
          textFromUnknown(r.tool_calls) +
          textFromUnknown(r.result);
        contextChars += extra.length;
        continue;
      }

      const outText =
        textFromUnknown(r.thinking) +
        textFromUnknown(r.content) +
        textFromUnknown(r.tool_calls);
      // Skip empty model shells
      if (!outText.trim() && contextChars <= 0) continue;

      turn += 1;
      const inputTokens = estimateTokensFromText(contextChars > 0 ? "x".repeat(contextChars) : "");
      const outputTokens = estimateTokensFromText(outText || " ");
      contextChars += outText.length;
      if (inputTokens + outputTokens <= 0) continue;

      events.push(
        applyPricing({
          id: stableId(
            "antigravity",
            "transcript",
            convId,
            file,
            String(turn),
            String(r.step_index ?? turn),
            String(inputTokens),
            String(outputTokens),
          ),
          agent: "antigravity",
          model,
          timestamp: ts,
          inputTokens,
          outputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          workspace: null,
          sourcePath: file,
          estimated: true,
          requestCount: 1,
        }),
      );
    }
  }

  return events;
}

/**
 * Fallback when a conversation has a DB but no usable transcript:
 * estimate from gen_metadata blob sizes + step count.
 */
export async function parseAntigravityConversationDbs(
  ideRoot: string,
  alreadyCoveredConvIds: Set<string>,
): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const convDir = path.join(ideRoot, "conversations");
  if (!(await pathExists(convDir))) return events;

  try {
    const { DatabaseSync } = await import("node:sqlite");
    const ents = await readdir(convDir, { withFileTypes: true });
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith(".db")) continue;
      const convId = e.name.replace(/\.db$/i, "");
      if (alreadyCoveredConvIds.has(convId)) continue;
      const dbPath = path.join(convDir, e.name);
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          let model: string | null = null;
          let genBytes = 0;
          let genCount = 0;
          try {
            const gens = db.prepare(`SELECT data FROM gen_metadata`).all() as Array<{
              data: Buffer | string;
            }>;
            genCount = gens.length;
            for (const g of gens) {
              const buf = Buffer.isBuffer(g.data) ? g.data : Buffer.from(String(g.data));
              genBytes += buf.length;
              if (!model) model = extractModelFromText(...extractPrintableStrings(buf));
            }
          } catch {
            // no gen_metadata
          }

          let stepCount = 0;
          let payloadBytes = 0;
          try {
            const steps = db
              .prepare(`SELECT step_type, step_payload FROM steps`)
              .all() as Array<{ step_type: string; step_payload: Buffer | string | null }>;
            stepCount = steps.length;
            for (const s of steps) {
              if (s.step_payload == null) continue;
              const buf = Buffer.isBuffer(s.step_payload)
                ? s.step_payload
                : Buffer.from(String(s.step_payload));
              payloadBytes += buf.length;
            }
          } catch {
            // ignore
          }

          if (genCount + stepCount <= 0) continue;
          // Rough: gen_metadata ≈ model I/O envelopes; payloads ≈ tool/user text
          const inputTokens = estimateTokensFromText("x".repeat(Math.max(payloadBytes, genBytes)));
          const outputTokens = estimateTokensFromText(
            "x".repeat(Math.max(genBytes, Math.floor(payloadBytes * 0.25))),
          );
          if (inputTokens + outputTokens <= 0) continue;

          let ts = new Date().toISOString();
          try {
            const st = await stat(dbPath);
            ts = st.mtime.toISOString();
          } catch {
            // keep now
          }

          events.push(
            applyPricing({
              id: stableId(
                "antigravity",
                "convdb",
                convId,
                String(genCount),
                String(stepCount),
                String(inputTokens),
                String(outputTokens),
              ),
              agent: "antigravity",
              model: model || "gemini",
              timestamp: ts,
              inputTokens,
              outputTokens,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              workspace: null,
              sourcePath: dbPath,
              estimated: true,
              requestCount: Math.max(1, genCount || Math.ceil(stepCount / 4)),
            }),
          );
        } finally {
          db.close();
        }
      } catch {
        // skip
      }
    }
  } catch {
    // ignore
  }
  return events;
}

/** Explicit usage objects in JSON/JSONL (rare exports). */
async function parseExplicitUsageFiles(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    const files = await walkFiles(root, {
      maxDepth: 8,
      match: (n, full) => {
        const lower = full.toLowerCase().replace(/\\/g, "/");
        if (
          lower.includes("/cache/") ||
          lower.includes("/code cache/") ||
          lower.includes("/gpucache/") ||
          lower.includes("/blob_storage/") ||
          lower.includes("/node_modules/") ||
          lower.includes("/brain/") || // handled by transcript parser
          lower.includes("/conversations/")
        ) {
          return false;
        }
        const nl = n.toLowerCase();
        return (
          (nl.endsWith(".jsonl") || nl.endsWith(".json")) &&
          (nl.includes("usage") || nl.includes("history") || nl.includes("billing") || nl.includes("token"))
        );
      },
    });

    for (const file of files) {
      const text = await readText(file);
      if (!text) continue;
      const rows = file.endsWith(".jsonl")
        ? parseJsonl(text)
        : (() => {
            try {
              const data = JSON.parse(text) as unknown;
              if (Array.isArray(data)) return data;
              if (data && typeof data === "object") {
                const o = data as Record<string, unknown>;
                if (Array.isArray(o.messages)) return o.messages;
                if (Array.isArray(o.events)) return o.events;
                if (Array.isArray(o.usage)) return o.usage;
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
          r.usage ?? r.token_usage ?? r.tokenUsage ?? r.token_count ?? r,
        );
        if (!buckets) continue;
        events.push(
          applyPricing({
            id: stableId(
              "antigravity",
              "export",
              file,
              String(idx),
              String(buckets.inputTokens),
              String(buckets.outputTokens),
            ),
            agent: "antigravity",
            model:
              (typeof r.model === "string" && r.model) ||
              extractModelFromText(JSON.stringify(r).slice(0, 500)) ||
              null,
            timestamp: requestTimestamp(r.timestamp ?? r.created_at ?? r.createdAt),
            ...buckets,
            workspace: null,
            sourcePath: file,
            requestCount: 1,
          }),
        );
      }
    }
  }
  return events;
}

export async function parseAntigravity(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const seenDb = new Set<string>();
  const seenEventIds = new Set<string>();
  const seenIde = new Set<string>();
  const transcriptConvIds = new Set<string>();

  const push = (batch: UsageEvent[]) => {
    for (const e of batch) {
      if (seenEventIds.has(e.id)) continue;
      seenEventIds.add(e.id);
      events.push(e);
    }
  };

  // 1) Proxy real usage
  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    for (const dbPath of await discoverProxyDbs(root)) {
      const key = dbPath.toLowerCase();
      if (seenDb.has(key)) continue;
      seenDb.add(key);
      push(await parseAntigravityProxyDb(dbPath));
    }
  }

  // 2) Local IDE: transcripts + conversation DBs
  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    for (const ide of ideDataCandidates(root)) {
      if (!(await pathExists(ide))) continue;
      const ideKey = path.resolve(ide).toLowerCase();
      if (seenIde.has(ideKey)) continue;
      // Must look like antigravity data (brain or conversations)
      const hasBrain = await pathExists(path.join(ide, "brain"));
      const hasConv = await pathExists(path.join(ide, "conversations"));
      if (!hasBrain && !hasConv) continue;
      seenIde.add(ideKey);

      const modelByConv = await loadConversationModels(ide);
      const transcriptEvents = await parseAntigravityTranscripts(ide, modelByConv);
      for (const e of transcriptEvents) {
        // sourcePath .../brain/<convId>/...
        const m = e.sourcePath.replace(/\\/g, "/").match(/\/brain\/([^/]+)\//i);
        if (m?.[1]) transcriptConvIds.add(m[1]);
      }
      push(transcriptEvents);
      push(await parseAntigravityConversationDbs(ide, transcriptConvIds));
    }
  }

  // 3) Explicit usage exports
  push(await parseExplicitUsageFiles(roots));

  return events;
}

export const agent: AgentModule = {
  id: "antigravity",
  label: "Antigravity",
  roots: antigravityRoots,
  parse: parseAntigravity,
};
