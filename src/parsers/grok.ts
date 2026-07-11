import path from "node:path";
import { applyPricing } from "../pricing.js";
import type { UsageEvent } from "../types.js";
import {
  estimateTokensFromText,
  num,
  parseJsonl,
  pathExists,
  readText,
  stableId,
  walkFiles,
} from "../util.js";

// Grok Build CLI: ~/.grok/sessions/<cwd>/<id>/chat_history.jsonl + summary.json
// When API usage counters are missing, estimate from message text length.
export async function parseGrok(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];

  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    const sessionsRoot = path.join(root, "sessions");
    if (!(await pathExists(sessionsRoot))) continue;

    const summaries = await walkFiles(sessionsRoot, {
      maxDepth: 6,
      match: (n) => n === "summary.json",
    });

    for (const summaryPath of summaries) {
      const dir = path.dirname(summaryPath);
      const summaryText = await readText(summaryPath);
      if (!summaryText) continue;

      let summary: Record<string, unknown> = {};
      try {
        summary = JSON.parse(summaryText) as Record<string, unknown>;
      } catch {
        continue;
      }

      const info = (summary.info ?? {}) as Record<string, unknown>;
      const model =
        (typeof summary.current_model_id === "string" && summary.current_model_id) ||
        (typeof summary.model === "string" && summary.model) ||
        "grok-4.5";
      const workspace =
        (typeof info.cwd === "string" && info.cwd) ||
        (typeof summary.git_root_dir === "string" && summary.git_root_dir) ||
        null;
      const ts =
        (typeof summary.updated_at === "string" && summary.updated_at) ||
        (typeof summary.last_active_at === "string" && summary.last_active_at) ||
        (typeof summary.created_at === "string" && summary.created_at) ||
        new Date().toISOString();
      const sessionId =
        (typeof info.id === "string" && info.id) || path.basename(dir);

      // Prefer explicit usage if present in summary or companion files
      const usage = (summary.usage ?? summary.token_usage) as Record<string, unknown> | undefined;
      if (usage) {
        const input = num(usage.input_tokens ?? usage.inputTokens);
        const output = num(usage.output_tokens ?? usage.outputTokens);
        const cacheRead = num(usage.cache_read_tokens ?? usage.cacheReadTokens);
        const cacheWrite = num(usage.cache_write_tokens ?? usage.cacheWriteTokens);
        if (input + output + cacheRead + cacheWrite > 0) {
          events.push(
            applyPricing({
              id: stableId("grok", sessionId, "usage"),
              agent: "grok",
              model,
              timestamp: ts,
              inputTokens: input,
              outputTokens: output,
              cacheReadTokens: cacheRead,
              cacheWriteTokens: cacheWrite,
              workspace,
              sourcePath: summaryPath,
            }),
          );
          continue;
        }
      }

      const chatPath = path.join(dir, "chat_history.jsonl");
      const chatText = await readText(chatPath);
      if (!chatText) continue;

      let userChars = 0;
      let assistantChars = 0;
      let turn = 0;
      for (const row of parseJsonl(chatText)) {
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>;
        const type = String(r.type ?? r.role ?? "");
        const content = extractText(r.content);
        if (!content) continue;
        if (type === "user" || type === "human") userChars += content.length;
        if (type === "assistant" || type === "ai" || type === "model") {
          assistantChars += content.length;
          turn += 1;
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

  return events;
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
