import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "qoder",
  label: "Qoder",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".qoder"),
        path.join(xdgData, "qoder"),
        path.join(appData, "qoder"),
        path.join(appData, "Qoder"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "qoder",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json") || n.includes("usage") || n.includes("session"),
    }),
};
