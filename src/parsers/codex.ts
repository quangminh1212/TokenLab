import path from "node:path";
import { applyPricing } from "../pricing.js";
import type { UsageEvent } from "../types.js";
import { num, parseJsonl, pathExists, readText, stableId, walkFiles } from "../util.js";

// Codex: ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl
// token_count / event.usage style records
export async function parseCodex(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];

  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    const sessions = path.join(root, "sessions");
    const base = (await pathExists(sessions)) ? sessions : root;
    const files = await walkFiles(base, { match: (n) => n.endsWith(".jsonl") });

    for (const file of files) {
      const text = await readText(file);
      if (!text) continue;
      const rows = parseJsonl(text);
      let idx = 0;
      let lastIn = 0;
      let lastOut = 0;
      let lastCacheR = 0;
      let lastCacheW = 0;

      for (const row of rows) {
        idx += 1;
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>;
        const type = String(r.type ?? r.event_type ?? "");
        const payload = (r.payload ?? r) as Record<string, unknown>;
        const usage =
          (payload.usage as Record<string, unknown> | undefined) ||
          (payload.token_count as Record<string, unknown> | undefined) ||
          (r.usage as Record<string, unknown> | undefined) ||
          (type.includes("token") ? payload : undefined);

        if (!usage) continue;

        // Prefer cumulative deltas when available
        const cumIn = num(usage.total_input_tokens ?? usage.input_tokens ?? usage.inputTokens);
        const cumOut = num(usage.total_output_tokens ?? usage.output_tokens ?? usage.outputTokens);
        const cumCr = num(usage.total_cache_read_tokens ?? usage.cache_read_input_tokens ?? usage.cacheReadTokens);
        const cumCw = num(usage.total_cache_write_tokens ?? usage.cache_creation_input_tokens ?? usage.cacheWriteTokens);

        let input = cumIn;
        let output = cumOut;
        let cacheRead = cumCr;
        let cacheWrite = cumCw;

        // If values look cumulative and growing, convert to delta
        if (cumIn >= lastIn && cumOut >= lastOut && (cumIn > 0 || cumOut > 0)) {
          input = cumIn - lastIn;
          output = cumOut - lastOut;
          cacheRead = Math.max(0, cumCr - lastCacheR);
          cacheWrite = Math.max(0, cumCw - lastCacheW);
          lastIn = cumIn;
          lastOut = cumOut;
          lastCacheR = cumCr;
          lastCacheW = cumCw;
        }

        if (input + output + cacheRead + cacheWrite <= 0) continue;

        const model =
          (typeof payload.model === "string" && payload.model) ||
          (typeof r.model === "string" && r.model) ||
          null;
        const ts =
          (typeof r.timestamp === "string" && r.timestamp) ||
          (typeof r.ts === "string" && r.ts) ||
          (typeof payload.timestamp === "string" && payload.timestamp) ||
          new Date().toISOString();

        events.push(
          applyPricing({
            id: stableId("codex", file, String(idx), String(input), String(output)),
            agent: "codex",
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
