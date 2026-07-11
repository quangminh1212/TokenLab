import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "mimocode",
  label: "MiMo Code",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      expandHome(process.env.MIMOCODE_HOME || path.join(home, ".mimocode")),
        path.join(home, ".mimocode"),
        path.join(home, ".mimo"),
        path.join(xdgData, "mimocode"),
        path.join(appData, "mimocode"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "mimocode",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json") || n.includes("session") || n.includes("usage"),
    }),
};
