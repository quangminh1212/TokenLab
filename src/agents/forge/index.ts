import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "forge",
  label: "Forge",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".forge"),
        path.join(xdgData, "forge"),
        path.join(appData, "forge"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "forge",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json") || n.includes("session") || n.includes("usage"),
    }),
};
