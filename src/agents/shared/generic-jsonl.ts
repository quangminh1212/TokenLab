import { applyPricing } from "../../pricing.js";
import type { AgentId, UsageEvent } from "../../types.js";
import { pathExists, readJsonCached, readJsonlCached, stableId, walkFiles } from "../../util.js";
import { extractModel, extractTimestamp, extractTokenBuckets } from "./usage-fields.js";

export interface GenericJsonlOptions {
  agent: AgentId;
  maxDepth?: number;
  match?: (name: string, full: string) => boolean;
}

/** Shared walker for agents that store usage in JSON/JSONL trees. */
export async function parseGenericJsonl(
  roots: string[],
  options: GenericJsonlOptions,
): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const match =
    options.match ||
    ((name: string) => name.endsWith(".jsonl") || name.endsWith(".json"));

  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    const files = await walkFiles(root, { maxDepth: options.maxDepth ?? 10, match });

    for (const file of files) {
      // Cached JSONL parse: unchanged files skip read + JSON.parse.
      const rows: unknown[] = file.endsWith(".jsonl")
        ? ((await readJsonlCached(file)) ?? [])
        : ((await readJsonCached(file)) ?? []);
      if (rows.length === 0) continue;

      let idx = 0;
      for (const row of rows) {
        idx += 1;
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>;
        const buckets = extractTokenBuckets(
          r.usage ?? r.token_usage ?? r.tokenUsage ?? r.token_count ?? r.message ?? r,
        );
        if (!buckets) continue;

        events.push(
          applyPricing({
            id: stableId(
              options.agent,
              file,
              String(idx),
              String(buckets.inputTokens),
              String(buckets.outputTokens),
            ),
            agent: options.agent,
            model: extractModel(r, r.message),
            timestamp: extractTimestamp(r, r.message),
            ...buckets,
            workspace:
              typeof r.cwd === "string"
                ? r.cwd
                : typeof r.workspace === "string"
                  ? r.workspace
                  : null,
            sourcePath: file,
          }),
        );
      }
    }
  }

  return events;
}
