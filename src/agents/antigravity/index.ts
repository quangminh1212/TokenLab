import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "antigravity",
  label: "Antigravity",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".gemini"),
      path.join(appData, "Antigravity"),
      path.join(localApp, "Antigravity"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "antigravity",
      match: (n, full) =>
        n.endsWith(".json") ||
        n.endsWith(".jsonl") ||
        full.toLowerCase().includes("antigravity"),
    }),
};
