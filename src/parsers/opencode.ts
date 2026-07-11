import { applyPricing } from "../pricing.js";
import type { UsageEvent } from "../types.js";
import { num, parseJsonl, pathExists, readText, stableId, walkFiles } from "../util.js";

/** OpenCode: JSONL under storage/message or similar local folders */
export async function parseOpenCode(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];

  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    const files = await walkFiles(root, {
      maxDepth: 10,
      match: (n) => n.endsWith(".jsonl") || (n.endsWith(".json") && n.includes("message")),
    });

    for (const file of files) {
      const text = await readText(file);
      if (!text) continue;
      const rows = file.endsWith(".jsonl")
        ? parseJsonl(text)
        : (() => {
            try {
              const d = JSON.parse(text);
              return Array.isArray(d) ? d : [d];
            } catch {
              return [];
            }
          })();

      let idx = 0;
      for (const row of rows) {
        idx += 1;
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>;
        const usage = (r.usage ?? r.tokens ?? r.cost ?? r) as Record<string, unknown>;
        const input = num(usage.input ?? usage.input_tokens ?? usage.inputTokens);
        const output = num(usage.output ?? usage.output_tokens ?? usage.outputTokens);
        const cacheRead = num(usage.cache_read ?? usage.cacheReadTokens);
        const cacheWrite = num(usage.cache_write ?? usage.cacheWriteTokens);
        if (input + output + cacheRead + cacheWrite <= 0) continue;

        events.push(
          applyPricing({
            id: stableId("opencode", file, String(idx), String(input), String(output)),
            agent: "opencode",
            model: (typeof r.model === "string" && r.model) || null,
            timestamp:
              (typeof r.timestamp === "string" && r.timestamp) ||
              (typeof r.time === "object" &&
                r.time &&
                typeof (r.time as { created?: string }).created === "string" &&
                (r.time as { created: string }).created) ||
              new Date().toISOString(),
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            workspace: null,
            sourcePath: file,
          }),
        );
      }
    }
  }

  return events;
}
