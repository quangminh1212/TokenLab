import { parseRouterUsage } from "../src/agents/shared/router-usage.ts";
import { xlabRouterRoots } from "../src/agents/xlabrouter/index.ts";
import { pathExists } from "../src/util.ts";
import { aggregate } from "../src/aggregate.ts";
import {
  collapseExactUsageDuplicates,
  collapseRouterDailyEvents,
  collapseSourcePathRollups,
  enforceMonotonicAgentDays,
  loadScanCache,
  saveScanCache,
} from "../src/backup.ts";

const roots = [];
for (const r of xlabRouterRoots()) {
  if (await pathExists(r)) roots.push(r);
}
console.log("roots", roots.slice(0, 6));
const fresh = await parseRouterUsage(roots, "routerlab");
const day = new Date().toISOString().slice(0, 10);
const today = fresh.filter((e) => (e.timestamp || "").startsWith(day));
const tStats = aggregate(today, "model", "cost");
console.log(
  "fresh today",
  day,
  "events",
  today.length,
  "req",
  tStats.totals.eventCount,
  "cost",
  tStats.totals.estimatedCost.toFixed(4),
  "tok",
  tStats.totals.totalTokens,
);

const disk = await loadScanCache();
const without = disk.filter((e) => e.agent !== "routerlab" && e.agent !== "xlabrouter");
const merged = enforceMonotonicAgentDays(
  disk,
  collapseExactUsageDuplicates(
    collapseSourcePathRollups(collapseRouterDailyEvents([...without, ...fresh])),
  ),
);
const final = collapseExactUsageDuplicates(
  collapseSourcePathRollups(collapseRouterDailyEvents(merged)),
);
const allToday = final.filter(
  (e) => e.agent === "routerlab" && (e.timestamp || "").startsWith(day),
);
const after = aggregate(allToday, "model", "cost");
console.log(
  "cache routerlab today req",
  after.totals.eventCount,
  "cost",
  after.totals.estimatedCost.toFixed(4),
);
const all = aggregate(final, "agent", "cost");
console.log("all-time cost", all.totals.estimatedCost.toFixed(2));
const rl = all.groups.find((g) => g.key === "routerlab");
console.log("routerlab all-time", rl?.eventCount, rl?.estimatedCost?.toFixed(2));
await saveScanCache(final, { mode: "full" });
console.log("saved", final.length);
