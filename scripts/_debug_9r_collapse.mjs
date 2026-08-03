import { parseRouterUsage } from "../src/agents/shared/router-usage.ts";
import { nineRouterRoots } from "../src/agents/9router/index.ts";
import { pathExists } from "../src/util.ts";
import { aggregate } from "../src/aggregate.ts";
import {
  collapseExactUsageDuplicates,
  collapseRouterDailyEvents,
  collapseSourcePathRollups,
} from "../src/backup.ts";

const roots = [];
for (const r of nineRouterRoots()) if (await pathExists(r)) roots.push(r);
console.log("roots", roots.length);
const nine = await parseRouterUsage(roots, "9router");
const day = "2026-07-27";
const t0 = nine.filter((e) => (e.timestamp || "").startsWith(day));
const a0 = aggregate(t0, "model", "cost");
console.log("parse n", t0.length, "req", a0.totals.eventCount, "cost", a0.totals.estimatedCost.toFixed(2), "tok", a0.totals.totalTokens);
console.log("est", t0.filter((e) => e.estimated).length, "live", t0.filter((e) => !e.estimated).length);

const c1 = collapseRouterDailyEvents(nine);
const t1 = c1.filter((e) => e.agent === "9router" && (e.timestamp || "").startsWith(day));
const a1 = aggregate(t1, "model", "cost");
console.log("collapse n", t1.length, "req", a1.totals.eventCount, "cost", a1.totals.estimatedCost.toFixed(2), "tok", a1.totals.totalTokens);
console.log("est", t1.filter((e) => e.estimated).length, "live", t1.filter((e) => !e.estimated).length);
for (const e of t1.slice(0, 8)) {
  console.log(
    " sample",
    e.model,
    "est",
    e.estimated,
    "rc",
    e.requestCount,
    "in",
    e.inputTokens,
    "cost",
    e.estimatedCost,
  );
}

const c2 = collapseExactUsageDuplicates(collapseSourcePathRollups(c1));
const t2 = c2.filter((e) => e.agent === "9router" && (e.timestamp || "").startsWith(day));
const a2 = aggregate(t2, "model", "cost");
console.log("final n", t2.length, "req", a2.totals.eventCount, "cost", a2.totals.estimatedCost.toFixed(2));
