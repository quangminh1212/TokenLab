import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "iflow",
  label: "iFlow",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".iflow"),
        path.join(xdgData, "iflow"),
        path.join(appData, "iflow"),
        path.join(appData, "iFlow"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "iflow",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json") || n.includes("usage") || n.includes("session"),
    }),
};
