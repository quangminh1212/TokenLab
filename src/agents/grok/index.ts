import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
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

/**
 * Grok Build CLI: ~/.grok/sessions/<cwd>/<id>/
 *
 * Policy: prefer over-count over missing usage.
 * - Discover sessions via summary.json OR updates.jsonl OR chat_history.jsonl
 * - Prefer turn_completed.usage (input includes cache; split cache for pricing)
 * - Stream totalTokens floor for in-progress turns
 * - Chat text estimate only when no real counters (include synthetics — they are billed)
 */
export async function parseGrok(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];

  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    const sessionsRoot = path.join(root, "sessions");
    if (!(await pathExists(sessionsRoot))) continue;

    // Discover every session dir that has any artifact (never require summary.json)
    const markers = await walkFiles(sessionsRoot, {
      maxDepth: 14,
      match: (n) =>
        n === "summary.json" || n === "updates.jsonl" || n === "chat_history.jsonl",
    });
    const sessionDirs = unique(markers.map((m) => path.dirname(m)));

    for (const dir of sessionDirs) {
      const summaryPath = path.join(dir, "summary.json");
      let summary: Record<string, unknown> = {};
      if (await pathExists(summaryPath)) {
        const summaryText = await readText(summaryPath);
        if (summaryText) {
          try {
            summary = JSON.parse(summaryText) as Record<string, unknown>;
          } catch {
            summary = {};
          }
        }
      }

      const info = (summary.info ?? {}) as Record<string, unknown>;
      const model =
        (typeof summary.current_model_id === "string" && summary.current_model_id) ||
        (typeof summary.model === "string" && summary.model) ||
        "grok-4.5";
      const workspace =
        (typeof info.cwd === "string" && info.cwd) ||
        (typeof summary.git_root_dir === "string" && summary.git_root_dir) ||
        decodeWorkspaceFromSessionPath(dir) ||
        null;
      const ts =
        (typeof summary.updated_at === "string" && summary.updated_at) ||
        (typeof summary.last_active_at === "string" && summary.last_active_at) ||
        (typeof summary.created_at === "string" && summary.created_at) ||
        (await mtimeIso(path.join(dir, "updates.jsonl"))) ||
        (await mtimeIso(path.join(dir, "chat_history.jsonl"))) ||
        (await mtimeIso(summaryPath)) ||
        new Date().toISOString();
      const sessionId =
        (typeof info.id === "string" && info.id) || path.basename(dir);

      // 1) Real usage from updates.jsonl
      let hadRealUsage = false;
      const updatesPath = path.join(dir, "updates.jsonl");
      if (await pathExists(updatesPath)) {
        const fromUpdates = await parseUpdatesUsage(updatesPath, {
          sessionId,
          model,
          workspace,
          fallbackTs: ts,
        });
        if (fromUpdates.length > 0) {
          events.push(...fromUpdates);
          hadRealUsage = true;
        }
      }

      // 2) Explicit usage on summary
      const usage = (summary.usage ?? summary.token_usage) as Record<string, unknown> | undefined;
      if (!hadRealUsage && usage) {
        const buckets = bucketsFromUsage(usage);
        if (buckets) {
          events.push(
            applyPricing({
              id: stableId("grok", sessionId, "usage"),
              agent: "grok",
              model,
              timestamp: ts,
              ...buckets,
              workspace,
              sourcePath: summaryPath,
            }),
          );
          hadRealUsage = true;
        }
      }

      // 3) Chat text estimate only when no real counters
      if (hadRealUsage) continue;

      const chatPath = path.join(dir, "chat_history.jsonl");
      const chatText = await readText(chatPath);
      if (!chatText) continue;

      // Cumulative context chars → each assistant turn prices full history (over-count friendly)
      let contextChars = 0;
      let turn = 0;
      let emitted = 0;
      for (const row of parseJsonl(chatText)) {
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>;
        const type = String(r.type ?? r.role ?? "");
        // Count ALL text including synthetic injects / system / tool results when stored as text
        const content = extractText(r.content);
        if (!content) continue;
        if (
          type === "user" ||
          type === "human" ||
          type === "system" ||
          type === "tool_result" ||
          type === "tool"
        ) {
          contextChars += content.length;
          continue;
        }
        if (type === "assistant" || type === "ai" || type === "model" || type === "reasoning") {
          turn += 1;
          const inputTokens = estimateTokensFromText(
            contextChars > 0 ? "x".repeat(contextChars) : "",
          );
          const outputTokens = estimateTokensFromText(content);
          contextChars += content.length; // stays in context for later turns
          if (inputTokens + outputTokens <= 0) continue;
          const rowTs =
            (typeof r.timestamp === "string" && r.timestamp) ||
            (typeof r.created_at === "string" && r.created_at) ||
            (typeof r.ts === "string" && r.ts) ||
            ts;
          events.push(
            applyPricing({
              id: stableId("grok", sessionId, "turn", String(turn), String(inputTokens), String(outputTokens)),
              agent: "grok",
              model,
              timestamp: rowTs,
              inputTokens,
              outputTokens,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              workspace,
              sourcePath: chatPath,
              estimated: true,
            }),
          );
          emitted += 1;
        }
      }

      if (emitted === 0) {
        let userChars = 0;
        let assistantChars = 0;
        for (const row of parseJsonl(chatText)) {
          if (!row || typeof row !== "object") continue;
          const r = row as Record<string, unknown>;
          const type = String(r.type ?? r.role ?? "");
          const content = extractText(r.content);
          if (!content) continue;
          if (type === "user" || type === "human" || type === "system") userChars += content.length;
          if (type === "assistant" || type === "ai" || type === "model" || type === "reasoning") {
            assistantChars += content.length;
          }
        }
        if (userChars + assistantChars === 0) continue;
        const inputTokens = estimateTokensFromText("x".repeat(userChars));
        const outputTokens = estimateTokensFromText("x".repeat(assistantChars));
        events.push(
          applyPricing({
            id: stableId("grok", sessionId, "est", String(inputTokens), String(outputTokens)),
            agent: "grok",
            model,
            timestamp: ts,
            inputTokens,
            outputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            workspace,
            sourcePath: chatPath,
            estimated: true,
          }),
        );
      }
    }
  }

  return events;
}

/** Best-effort workspace from encoded session folder path. */
function decodeWorkspaceFromSessionPath(dir: string): string | null {
  // .../sessions/C%3A%5CDev%5CXLab_Token/<id>
  const parent = path.basename(path.dirname(dir));
  if (!parent || parent === "sessions") return null;
  try {
    const decoded = decodeURIComponent(parent);
    if (decoded.includes(":") || decoded.startsWith("/") || decoded.startsWith("\\")) return decoded;
  } catch {
    /* ignore */
  }
  return null;
}

async function mtimeIso(file: string): Promise<string | null> {
  try {
    if (!(await pathExists(file))) return null;
    const st = await stat(file);
    return st.mtime.toISOString();
  } catch {
    return null;
  }
}

/** Stream updates.jsonl and emit one event per turn_completed with usage. */
async function parseUpdatesUsage(
  updatesPath: string,
  ctx: {
    sessionId: string;
    model: string;
    workspace: string | null;
    fallbackTs: string;
  },
): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  let idx = 0;
  let maxStreamTokens = 0;
  let maxStreamTs = ctx.fallbackTs;

  const stream = createReadStream(updatesPath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const maybeTurn = line.includes("turn_completed") && line.includes("usage");
      const maybeStream = line.includes("totalTokens");
      if (!maybeTurn && !maybeStream) continue;

      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const params = row.params as Record<string, unknown> | undefined;
      const update = params?.update as Record<string, unknown> | undefined;
      if (!update) continue;

      const meta = (update._meta ?? params?._meta) as Record<string, unknown> | undefined;
      const tt = num(meta?.totalTokens ?? update.totalTokens);
      if (tt > maxStreamTokens) {
        maxStreamTokens = tt;
        maxStreamTs = timestampFromUpdate(row, ctx.fallbackTs);
      }

      if (update.sessionUpdate !== "turn_completed") continue;

      const usage = update.usage as Record<string, unknown> | undefined;
      if (!usage || typeof usage !== "object") continue;

      const buckets = bucketsFromUsage(usage);
      if (!buckets) continue;

      idx += 1;

      const modelUsage = usage.modelUsage as Record<string, unknown> | undefined;
      let model = ctx.model;
      if (modelUsage && typeof modelUsage === "object") {
        const keys = Object.keys(modelUsage);
        if (keys.length === 1 && keys[0]) model = keys[0];
        else if (keys.length > 1) {
          let best = keys[0];
          let bestTot = -1;
          for (const k of keys) {
            const m = modelUsage[k] as Record<string, unknown> | undefined;
            const t = num(m?.totalTokens ?? m?.inputTokens);
            if (t > bestTot) {
              bestTot = t;
              best = k;
            }
          }
          if (best) model = best;
        }
      }

      const promptId =
        (typeof update.prompt_id === "string" && update.prompt_id) ||
        (typeof update.promptId === "string" && update.promptId) ||
        String(idx);

      const ts = timestampFromUpdate(row, ctx.fallbackTs);

      events.push(
        applyPricing({
          id: stableId(
            "grok",
            ctx.sessionId,
            "tc",
            promptId,
            String(buckets.inputTokens),
            String(buckets.outputTokens),
            String(buckets.cacheReadTokens),
          ),
          agent: "grok",
          model,
          timestamp: ts,
          ...buckets,
          workspace: ctx.workspace,
          sourcePath: updatesPath,
          estimated: false,
        }),
      );
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  // In-progress only: no turn_completed yet, but stream already reported tokens.
  // Do NOT add residual on top of completed turns (peak context ≠ unbilled delta).
  if (events.length === 0 && maxStreamTokens > 0) {
    events.push(
      applyPricing({
        id: stableId("grok", ctx.sessionId, "stream-floor", String(maxStreamTokens)),
        agent: "grok",
        model: ctx.model,
        timestamp: maxStreamTs,
        inputTokens: maxStreamTokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        workspace: ctx.workspace,
        sourcePath: updatesPath,
        estimated: true,
      }),
    );
  }
  return events;
}

/**
 * Grok turn_completed.usage:
 * - inputTokens = full prompt tokens (includes cache hits)
 * - cachedReadTokens = cache hit portion of input
 * - outputTokens includes reasoning
 */
function bucketsFromUsage(usage: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} | null {
  const fullInput = num(
    usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokens,
  );
  let output = num(
    usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens ?? usage.completionTokens,
  );
  // If reasoning is reported separately and not already in output, add it (over-count safe)
  const reasoning = num(
    usage.reasoningTokens ?? usage.reasoning_tokens ?? usage.thinking_tokens,
  );
  if (reasoning > 0 && output > 0 && reasoning > output) {
    // reasoning reported as larger than output — treat as total generation
    output = reasoning;
  } else if (reasoning > 0 && output === 0) {
    output = reasoning;
  }

  const cacheRead = num(
    usage.cachedReadTokens ??
      usage.cache_read_input_tokens ??
      usage.cacheReadInputTokens ??
      usage.cache_read_tokens ??
      usage.cacheReadTokens ??
      usage.cached_tokens,
  );
  const cacheWrite = num(
    usage.cache_creation_input_tokens ??
      usage.cacheWriteTokens ??
      usage.cache_write_tokens ??
      usage.cachedWriteTokens,
  );

  const uncached = Math.max(0, fullInput - cacheRead);

  if (uncached + output + cacheRead + cacheWrite <= 0) return null;
  return {
    inputTokens: uncached,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

function timestampFromUpdate(row: Record<string, unknown>, fallback: string): string {
  const t = row.timestamp;
  if (typeof t === "number" && Number.isFinite(t) && t > 0) {
    const ms = t > 1e12 ? t : t * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof t === "string" && t.trim() && !Number.isNaN(Date.parse(t))) {
    return new Date(t).toISOString();
  }
  const params = row.params as Record<string, unknown> | undefined;
  const update = params?.update as Record<string, unknown> | undefined;
  const meta = (update?._meta ?? params?._meta ?? row._meta) as Record<string, unknown> | undefined;
  for (const key of ["agentTimestampMs", "streamStartMs", "turnStartMs"] as const) {
    const v = meta?.[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 1e11) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return fallback;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
        }
        return "";
      })
      .join("");
  }
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
  }
  return "";
}

export const agent: AgentModule = {
  id: "grok",
  label: "Grok (xAI)",
  roots() {
    const { home, appData, path: p } = pathEnv();
    return unique([p.join(home, ".grok"), p.join(appData, "Grok")]);
  },
  parse: parseGrok,
};
