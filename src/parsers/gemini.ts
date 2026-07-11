import { applyPricing } from "../pricing.js";
import type { UsageEvent } from "../types.js";
import { num, pathExists, readText, stableId, walkFiles } from "../util.js";

// Gemini CLI: ~/.gemini/tmp/<project>/chats/session-*.json
export async function parseGemini(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];

  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    const files = await walkFiles(root, {
      maxDepth: 8,
      match: (n) => n.startsWith("session-") && n.endsWith(".json"),
    });

    for (const file of files) {
      const text = await readText(file);
      if (!text) continue;
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        continue;
      }

      const messages = Array.isArray(data)
        ? data
        : data && typeof data === "object" && Array.isArray((data as { messages?: unknown[] }).messages)
          ? (data as { messages: unknown[] }).messages
          : [data];

      let idx = 0;
      for (const msg of messages) {
        idx += 1;
        if (!msg || typeof msg !== "object") continue;
        const m = msg as Record<string, unknown>;
        const usage = (m.usage ?? m.tokenUsage ?? m) as Record<string, unknown>;
        let input = num(usage.input_tokens ?? usage.inputTokens ?? usage.promptTokenCount);
        let output = num(usage.output_tokens ?? usage.outputTokens ?? usage.candidatesTokenCount);
        let cacheRead = num(usage.cached_content_token_count ?? usage.cacheReadTokens ?? usage.cached);
        // Gemini often includes cache in input — avoid double charge when possible
        if (cacheRead > 0 && input >= cacheRead) input = input - cacheRead;
        if (input + output + cacheRead <= 0) continue;

        const model = (typeof m.model === "string" && m.model) || null;
        const ts =
          (typeof m.timestamp === "string" && m.timestamp) ||
          (typeof m.createdAt === "string" && m.createdAt) ||
          new Date().toISOString();

        events.push(
          applyPricing({
            id: stableId("gemini", file, String(idx), String(input), String(output)),
            agent: "gemini",
            model,
            timestamp: ts,
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: 0,
            workspace: null,
            sourcePath: file,
          }),
        );
      }
    }
  }

  return events;
}
