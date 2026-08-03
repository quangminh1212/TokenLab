import { parseRouterUsage } from "../src/agents/shared/router-usage.ts";
import { xlabRouterRoots } from "../src/agents/xlabrouter/index.ts";
import { pathExists } from "../src/util.ts";
import { aggregate } from "../src/aggregate.ts";

const roots = [];
for (const r of xlabRouterRoots()) {
  if (await pathExists(r)) roots.push(r);
}
console.log("roots_existing", roots.length, roots.slice(0, 8));
const events = await parseRouterUsage(roots, "routerlab");
const stats = aggregate(events, "day", "tokens");
console.log(
  JSON.stringify(
    {
      events: events.length,
      totals: stats.totals,
      dayCount: stats.groups.length,
      oldestDays: [...stats.groups].sort((a, b) => a.key.localeCompare(b.key)).slice(0, 3),
      newestDays: [...stats.groups].sort((a, b) => b.key.localeCompare(a.key)).slice(0, 3),
    },
    null,
    2,
  ),
);
