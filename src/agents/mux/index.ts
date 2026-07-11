import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import path from "node:path";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "mux",
  label: "Mux",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".mux"),
      path.join(xdgData, "mux"),
      path.join(appData, "mux"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "mux",
      match: (n, full) =>
        n.endsWith(".jsonl") ||
        n.endsWith(".json") ||
        full.includes(`${path.sep}sessions${path.sep}`),
    }),
};
