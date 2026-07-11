import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import path from "node:path";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "kiro",
  label: "Kiro",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".kiro"),
      path.join(xdgData, "kiro-cli"),
      path.join(appData, "kiro-cli"),
      path.join(appData, "Kiro"),
      path.join(localApp, "Kiro"),
      path.join(home, "Library", "Application Support", "kiro-cli"),
      path.join(home, "Library", "Application Support", "Kiro"),
      path.join(appData, "Code", "User", "globalStorage", "kiro.kiroagent"),
      path.join(appData, "Cursor", "User", "globalStorage", "kiro.kiroagent"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "kiro",
      match: (n, full) =>
        n.endsWith(".jsonl") ||
        n.endsWith(".json") ||
        full.toLowerCase().includes("kiro") ||
        full.includes(`${path.sep}sessions${path.sep}`),
    }),
};
