import { parseRouterUsage } from "../src/agents/shared/router-usage.ts";
import { liteLlmRoots } from "../src/agents/litellm/index.ts";
import { pathExists } from "../src/util.ts";
import { aggregate } from "../src/aggregate.ts";
import {
  collapseExactUsageDuplicates,
  collapseRouterDailyEvents,
  collapseSourcePathRollups,
  loadScanCache,
  pruneStaleSourceEvents,
  saveScanCache,
} from "../src/backup.ts";

/**
 * Replace the persisted litellm rows with a fresh parse of the VPS mirror.
 *
 * Why: the scan-cache keeps stale litellm rows by stable id, so a parser fix
 * (cacheReported + no double-counted rollup cache) is not visible in the
 * dashboard until the persisted rows are rewritten. Same shape as
 * scripts/_refresh_router_agents_cache.mjs, scoped to litellm.
 */
const roots = [];
for (const r of liteLlmRoots()) {
  if (await pathExists(r)) roots.push(r);
}
console.log("litellm roots with data:", roots.length);

const fresh = await parseRouterUsage(roots, "litellm");
const freshCache = fresh.reduce((a, e) => a + (e.cacheReadTokens || 0), 0);
console.log(
  "fresh litellm rows:",
  fresh.length,
  "cacheRead:",
  freshCache,
  "reported:",
  fresh.filter((e) => e.cacheReported).length,
);

const disk = await loadScanCache();
const stale = disk.filter((e) => e.agent === "litellm");
console.log(
  "stale litellm rows in scan-cache:",
  stale.length,
  "cacheRead:",
  stale.reduce((a, e) => a + (e.cacheReadTokens || 0), 0),
  "reported:",
  stale.filter((e) => e.cacheReported).length,
);

const others = disk.filter((e) => e.agent !== "litellm");

/**
 * Replace litellm rows like-for-like instead of unioning by id.
 *
 * A parser change alters row ids (the litellm cache fix re-derives the input
 * split), so the old rows have no counterpart in the fresh scan and a plain
 * union keeps BOTH — the server then re-merges them by day high-water and the
 * stale half-cache snapshot wins back the cache column. `pruneStaleSourceEvents`
 * drops previous rows whose (agent, sourcePath) the fresh scan just covered, so
 * only genuinely foreign rows (gist backups) survive.
 */
const kept = pruneStaleSourceEvents(others, fresh);
const keptBySource = new Map();
for (const e of kept) {
  const k = `${e.agent}|${e.sourcePath}`;
  keptBySource.set(k, (keptBySource.get(k) || 0) + 1);
}
const dropped = others.length - kept.length;
console.log("pruned stale rows:", dropped, "kept non-litellm rows:", kept.length);

let merged = collapseExactUsageDuplicates(
  collapseSourcePathRollups(collapseRouterDailyEvents([...kept, ...fresh])),
);
console.log("merged total rows:", merged.length);

const all = aggregate(merged, "agent", "cost");
const row = all.groups.find((g) => g.key === "litellm");
console.log(
  "AFTER litellm: rows",
  row?.eventCount,
  "cacheRead",
  row?.cacheReadTokens,
  "cacheCost",
  row?.cacheCost?.toFixed(2),
  "cacheReportedEvents",
  row?.cacheReportedEvents,
);

await saveScanCache(merged, { mode: "full" });
console.log("saved scan-cache", merged.length);
