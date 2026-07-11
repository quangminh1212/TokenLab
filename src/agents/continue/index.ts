import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import path from "node:path";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "continue",
  label: "Continue.dev",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".continue"),
      path.join(xdgConfig, "continue"),
      path.join(xdgData, "continue"),
      path.join(appData, "Continue"),
      path.join(appData, "Code", "User", "globalStorage", "continue.continue"),
      path.join(appData, "Cursor", "User", "globalStorage", "continue.continue"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "continue",
      match: (n, full) =>
        n.endsWith(".jsonl") ||
        n.endsWith(".json") ||
        full.includes(`${path.sep}sessions${path.sep}`) ||
        full.includes(`${path.sep}dev_data${path.sep}`) ||
        n.includes("usage") ||
        n.includes("token"),
    }),
};
