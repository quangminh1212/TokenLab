import path from "node:path";
import { applyPricing } from "../pricing.js";
import type { UsageEvent } from "../types.js";
import { num, parseJsonl, pathExists, readText, stableId, walkFiles } from "../util.js";

/**
 * Cursor: prefer JSON/JSONL usage caches under Application Support.
 * Full state.vscdb SQLite parsing is optional later (native dep).
 */
export async function parseCursor(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];

  for (const root of roots) {
    if (!(await pathExists(root))) continue;

    const candidates = await walkFiles(root, {
      maxDepth: 10,
      match: (name, full) => {
        const lower = name.toLowerCase();
        if (lower.endsWith(".jsonl")) return true;
        if (lower.includes("usage") && lower.endsWith(".json")) return true;
        if (lower.includes("token") && lower.endsWith(".json")) return true;
        // composer / aichat logs
        if (full.includes("anysphere") && lower.endsWith(".json")) return true;
        return false;
      },
    });

    for (const file of candidates) {
      const text = await readText(file);
      if (!text) continue;

      if (file.endsWith(".jsonl")) {
        let idx = 0;
        for (const row of parseJsonl(text)) {
          idx += 1;
          pushFromObject(events, row, file, idx);
        }
        continue;
      }

      try {
        const data = JSON.parse(text) as unknown;
        if (Array.isArray(data)) {
          data.forEach((row, i) => pushFromObject(events, row, file, i + 1));
        } else if (data && typeof data === "object") {
          const obj = data as Record<string, unknown>;
          if (Array.isArray(obj.usage)) {
            obj.usage.forEach((row, i) => pushFromObject(events, row, file, i + 1));
          } else {
            pushFromObject(events, data, file, 1);
          }
        }
      } catch {
        // ignore non-json
      }
    }
  }

  return events;
}

function pushFromObject(events: UsageEvent[], row: unknown, file: string, idx: number): void {
  if (!row || typeof row !== "object") return;
  const r = row as Record<string, unknown>;
  const usage = (r.usage ?? r.tokenUsage ?? r.token_usage ?? r) as Record<string, unknown>;

  const input = num(
    usage.input_tokens ?? usage.inputTokens ?? usage.promptTokens ?? usage.prompt_tokens ?? r.inputTokens,
  );
  const output = num(
    usage.output_tokens ?? usage.outputTokens ?? usage.completionTokens ?? usage.completion_tokens ?? r.outputTokens,
  );
  const cacheRead = num(usage.cache_read_tokens ?? usage.cacheReadTokens ?? usage.cacheRead);
  const cacheWrite = num(usage.cache_write_tokens ?? usage.cacheWriteTokens ?? usage.cacheWrite);

  if (input + output + cacheRead + cacheWrite <= 0) return;

  const model =
    (typeof r.model === "string" && r.model) ||
    (typeof usage.model === "string" && usage.model) ||
    null;
  const ts =
    (typeof r.timestamp === "string" && r.timestamp) ||
    (typeof r.createdAt === "string" && r.createdAt) ||
    (typeof r.date === "string" && r.date) ||
    new Date().toISOString();

  events.push(
    applyPricing({
      id: stableId("cursor", file, String(idx), String(input), String(output)),
      agent: "cursor",
      model,
      timestamp: ts,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      workspace: typeof r.workspace === "string" ? r.workspace : null,
      sourcePath: file,
    }),
  );
}
