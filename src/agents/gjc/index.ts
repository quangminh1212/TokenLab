import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import path from "node:path";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "gjc",
  label: "Gajae-Code",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      expandHome(process.env.GJC_CODING_AGENT_DIR || path.join(home, ".gjc")),
      expandHome(process.env.GJC_CONFIG_DIR || path.join(home, ".gjc")),
      path.join(home, ".gjc"),
      path.join(xdgData, "gjc"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "gjc",
      match: (n, full) =>
        n.endsWith(".jsonl") ||
        n.endsWith(".json") ||
        full.includes(`${path.sep}sessions${path.sep}`),
    }),
};
