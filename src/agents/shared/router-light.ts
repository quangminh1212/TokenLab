import { stat } from "node:fs/promises";
import path from "node:path";
import type { AgentId, UsageEvent } from "../../types.js";
import { parseRouterUsage } from "./router-usage.js";

/**
 * Files a light router scan can read. SQLite writes often land in the WAL
 * before the database file's mtime moves, so the WAL is part of the stamp.
 */
const ROUTER_STAMP_FILES = [
  "db/data.sqlite",
  "data.sqlite",
  "db.sqlite",
  "usage.json",
  "db.json",
  "usageData.json",
  "usage-daily.json",
  "request-details.json",
  "request-details.jsonl",
  "usage-history.json",
  "usageHistory.json",
  "usage-history.jsonl",
];

/** Unchanged router inputs are not opened again on the next minute tick. */
const routerLightStamp = new Map<string, string>();

async function stampOne(file: string, parts: string[]): Promise<void> {
  try {
    const st = await stat(file);
    parts.push(`${file}|${st.size}`);
  } catch {
    /* absent */
  }
}

async function routerSourceStamp(roots: string[]): Promise<string> {
  const parts: string[] = [];
  for (const root of roots) {
    for (const rel of ROUTER_STAMP_FILES) {
      const file = path.join(root, rel);
      await stampOne(file, parts);
      if (rel.endsWith(".sqlite")) await stampOne(`${file}-wal`, parts);
    }
  }
  parts.sort();
  return parts.join("\n");
}

/**
 * Minute scan for 9router, LiteLLM, and RouterLab.
 * The same size and mtime returns no rows, so the server keeps the cached history.
 * A changed file still runs the full recent parser.
 */
export async function parseRouterUsageLight(
  roots: string[],
  agent: AgentId,
): Promise<UsageEvent[]> {
  const key = `${agent}|${roots
    .map((root) => path.resolve(root).toLowerCase())
    .sort()
    .join("|")}`;
  const stamp = await routerSourceStamp(roots);
  if (routerLightStamp.get(key) === stamp) return [];
  const events = await parseRouterUsage(roots, agent, { recentOnly: true });
  // A sqlite read can bump the WAL mtime. Store the stamp after the read so
  // the next quiet tick does not open those files again.
  routerLightStamp.set(key, await routerSourceStamp(roots));
  return events;
}
