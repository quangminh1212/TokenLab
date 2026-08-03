import { parseRouterUsage } from "../src/agents/shared/router-usage.ts";
import { nineRouterRoots } from "../src/agents/9router/index.ts";
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

async function parseAgent(agent, rootsFn) {
  const roots = [];
  for (const r of rootsFn()) {
    if (await pathExists(r)) roots.push(r);
  }
  const events = await parseRouterUsage(roots, agent);
  const day = new Date().toISOString().slice(0, 10);
  const today = events.filter((e) => (e.timestamp || "").startsWith(day));
  const t = aggregate(today, "model", "cost");
  console.log(
    agent,
    "today",
    day,
    "events",
    today.length,
    "req",
    t.totals.eventCount,
    "cost",
    t.totals.estimatedCost.toFixed(4),
    "tok",
    t.totals.totalTokens,
  );
  // last 3 days
  const byDay = aggregate(events, "day", "cost");
  for (const g of [...byDay.groups].sort((a, b) => b.key.localeCompare(a.key)).slice(0, 3)) {
    console.log(
      " ",
      g.key,
      "req",
      g.eventCount,
      "cost",
      g.estimatedCost.toFixed(2),
      "tok",
      g.totalTokens,
    );
  }
  return events;
}

const nine = await parseAgent("9router", nineRouterRoots);
const rl = await parseAgent("routerlab", xlabRouterRoots);

const disk = await loadScanCache();
// Force-replace router agents with freshly parsed VPS mirrors (do not keep
// old inflated request-level days that disagree with remote dailySummary).
const others = disk.filter(
  (e) => !["9router", "routerlab", "xlabrouter"].includes(e.agent),
);
let merged = [...others, ...nine, ...rl];
merged = collapseExactUsageDuplicates(
  collapseSourcePathRollups(collapseRouterDailyEvents(merged)),
);
// Monotonic only for non-router agents already in `others`; routers are SoT from VPS.

const all = aggregate(merged, "agent", "cost");
console.log("ALL cost", all.totals.estimatedCost.toFixed(2), "req", all.totals.eventCount);
for (const g of all.groups.filter((x) =>
  ["9router", "routerlab", "hermes"].includes(x.key),
)) {
  console.log(" ", g.key, "req", g.eventCount, "cost", g.estimatedCost.toFixed(2));
}

const day = new Date().toISOString().slice(0, 10);
for (const agent of ["9router", "routerlab"]) {
  const t = aggregate(
    merged.filter((e) => e.agent === agent && (e.timestamp || "").startsWith(day)),
    "model",
    "cost",
  );
  console.log(
    "CACHE",
    agent,
    "today req",
    t.totals.eventCount,
    "cost",
    t.totals.estimatedCost.toFixed(4),
  );
}

await saveScanCache(merged, { mode: "full" });
console.log("saved", merged.length);
