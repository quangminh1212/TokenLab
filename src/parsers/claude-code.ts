import path from "node:path";
import { applyPricing } from "../pricing.js";
import type { UsageEvent } from "../types.js";
import { num, parseJsonl, pathExists, readText, stableId, walkFiles } from "../util.js";

// Claude Code: ~/.claude/projects/<project>/<session>.jsonl
// Assistant messages often include usage: { input_tokens, output_tokens, cache_* }
export async function parseClaudeCode(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];

  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    const projects = path.join(root, "projects");
    const transcripts = path.join(root, "transcripts");
    const files = [
      ...(await walkFiles(projects, {
        match: (n) => n.endsWith(".jsonl"),
      })),
      ...(await walkFiles(transcripts, {
        match: (n) => n.endsWith(".jsonl"),
      })),
    ];

    for (const file of files) {
      const text = await readText(file);
      if (!text) continue;
      const rows = parseJsonl(text);
      let idx = 0;
      for (const row of rows) {
        idx += 1;
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>;
        const msg = (r.message ?? r) as Record<string, unknown>;
        const usage = (msg.usage ?? r.usage) as Record<string, unknown> | undefined;
        if (!usage) continue;

        const input =
          num(usage.input_tokens) +
          num(usage.inputTokens) +
          num(usage.prompt_tokens);
        const output =
          num(usage.output_tokens) +
          num(usage.outputTokens) +
          num(usage.completion_tokens);
        const cacheRead =
          num(usage.cache_read_input_tokens) +
          num(usage.cache_read_tokens) +
          num(usage.cacheReadTokens);
        const cacheWrite =
          num(usage.cache_creation_input_tokens) +
          num(usage.cache_write_tokens) +
          num(usage.cacheWriteTokens);

        if (input + output + cacheRead + cacheWrite <= 0) continue;

        const model =
          (typeof msg.model === "string" && msg.model) ||
          (typeof r.model === "string" && r.model) ||
          null;
        const ts =
          (typeof r.timestamp === "string" && r.timestamp) ||
          (typeof r.ts === "string" && r.ts) ||
          new Date().toISOString();

        // workspace from projects path segment
        const rel = path.relative(projects, file);
        const workspace = rel.includes(path.sep) ? rel.split(path.sep)[0] : null;

        events.push(
          applyPricing({
            id: stableId("claude-code", file, String(idx), String(input), String(output)),
            agent: "claude-code",
            model,
            timestamp: ts,
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            workspace,
            sourcePath: file,
          }),
        );
      }
    }
  }

  return events;
}
