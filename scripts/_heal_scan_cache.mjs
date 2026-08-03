import {
  collapseExactUsageDuplicates,
  collapseRouterDailyEvents,
  collapseSourcePathRollups,
  enforceMonotonicAgentDays,
  loadImportedEvents,
  loadScanCache,
  mergeLocalPreferOverGistRollups,
  saveScanCache,
} from "../src/backup.ts";
import { aggregate } from "../src/aggregate.ts";

const disk = await loadScanCache();
const imported = await loadImportedEvents();
console.log("disk", disk.length, "imported", imported.length);
const before = aggregate(disk, "agent", "cost");
console.log(
  "BEFORE cost",
  before.totals.estimatedCost.toFixed(2),
  "tok",
  before.totals.totalTokens,
  "req",
  before.totals.eventCount,
);

const merged = collapseExactUsageDuplicates(
  collapseSourcePathRollups(
    collapseRouterDailyEvents(
      enforceMonotonicAgentDays(disk, mergeLocalPreferOverGistRollups(disk, imported)),
    ),
  ),
);
const after = aggregate(merged, "agent", "cost");
console.log(
  "AFTER  cost",
  after.totals.estimatedCost.toFixed(2),
  "tok",
  after.totals.totalTokens,
  "req",
  after.totals.eventCount,
);
for (const g of after.groups.slice(0, 12)) {
  console.log(
    " ",
    g.key.padEnd(14),
    "cost",
    g.estimatedCost.toFixed(2).padStart(12),
    "tok",
    String(g.totalTokens).padStart(14),
    "req",
    g.eventCount,
  );
}
await saveScanCache(merged, { mode: "full" });
console.log("saved healed scan-cache", merged.length);
