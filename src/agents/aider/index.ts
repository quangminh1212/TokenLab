import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "aider",
  label: "Aider",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".aider"),
      path.join(xdgConfig, "aider"),
      path.join(xdgData, "aider"),
      path.join(appData, "aider"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "aider",
      match: (n) =>
        n.endsWith(".jsonl") ||
        n.endsWith(".json") ||
        n.includes("usage") ||
        n.includes("analytics") ||
        n.includes("history"),
    }),
};
