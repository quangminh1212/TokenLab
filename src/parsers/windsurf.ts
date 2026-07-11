import path from "node:path";
import { applyPricing } from "../pricing.js";
import type { UsageEvent } from "../types.js";
import { num, parseJsonl, pathExists, readText, stableId, walkFiles } from "../util.js";

/**
 * Windsurf / Codeium: cascade transcripts and usage-like JSON under app data.
 */
export async function parseWindsurf(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];

  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    const files = await walkFiles(root, {
      maxDepth: 12,
      match: (name, full) => {
        const lower = name.toLowerCase();
        if (lower.endsWith(".jsonl")) return true;
        if (lower.includes("cascade") && lower.endsWith(".json")) return true;
        if (lower.includes("usage") && (lower.endsWith(".json") || lower.endsWith(".jsonl"))) return true;
        if (full.toLowerCase().includes("cascade") && lower.endsWith(".pb")) return false;
        return lower.endsWith(".json") && (lower.includes("chat") || lower.includes("transcript"));
      },
    });

    for (const file of files) {
      const text = await readText(file);
      if (!text) continue;

      const rows = file.endsWith(".jsonl")
        ? parseJsonl(text)
        : (() => {
            try {
              const data = JSON.parse(text);
              return Array.isArray(data) ? data : [data];
            } catch {
              return [];
            }
          })();

      let idx = 0;
      for (const row of rows) {
        idx += 1;
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>;
        const usage = (r.usage ?? r.tokenUsage ?? r.token_usage ?? r.credits ?? r) as Record<
          string,
          unknown
        >;

        const input = num(
          usage.input_tokens ?? usage.inputTokens ?? usage.promptTokens ?? r.inputTokens,
        );
        const output = num(
          usage.output_tokens ?? usage.outputTokens ?? usage.completionTokens ?? r.outputTokens,
        );
        const cacheRead = num(usage.cache_read_tokens ?? usage.cacheReadTokens);
        const cacheWrite = num(usage.cache_write_tokens ?? usage.cacheWriteTokens);

        if (input + output + cacheRead + cacheWrite <= 0) continue;

        const model =
          (typeof r.model === "string" && r.model) ||
          (typeof usage.model === "string" && usage.model) ||
          null;
        const ts =
          (typeof r.timestamp === "string" && r.timestamp) ||
          (typeof r.createdAt === "string" && r.createdAt) ||
          new Date().toISOString();

        events.push(
          applyPricing({
            id: stableId("windsurf", file, String(idx), String(input), String(output)),
            agent: "windsurf",
            model,
            timestamp: ts,
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
