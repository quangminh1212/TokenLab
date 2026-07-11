import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "trae",
  label: "Trae",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([path.join(appData, "Trae"), path.join(home, ".trae")]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "trae",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
    }),
};
