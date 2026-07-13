import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

/**
 * Open Code Review — Alibaba Group agentic code-review CLI
 * (@alibaba-group/open-code-review / alibaba/open-code-review)
 */
export const agent: AgentModule = {
  id: "opencodereview",
  label: "Open Code Review",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".opencodereview"),
      path.join(home, ".open-code-review"),
      path.join(xdgData, "opencodereview"),
      path.join(xdgConfig, "opencodereview"),
      path.join(xdgConfig, "open-code-review"),
      path.join(appData, "opencodereview"),
      path.join(appData, "open-code-review"),
      path.join(localApp, "opencodereview"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "opencodereview",
      match: (n, full) => {
        const p = full.replace(/\\/g, "/").toLowerCase();
        if (p.includes("/node_modules/") || p.includes("/.git/")) return false;
        return (
          n.endsWith(".jsonl") ||
          n.endsWith(".json") ||
          n.includes("review") ||
          n.includes("usage") ||
          n.includes("session")
        );
      },
    }),
};
