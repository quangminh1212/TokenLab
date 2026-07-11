import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import path from "node:path";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "pi",
  label: "Pi / Oh My Pi",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".pi"),
      path.join(home, ".omp"),
      path.join(xdgData, "pi"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "pi",
      match: (n, full) =>
        n.endsWith(".jsonl") ||
        (full.includes(`${path.sep}sessions${path.sep}`) && n.endsWith(".json")),
    }),
};
