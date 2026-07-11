import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "blackbox",
  label: "Blackbox AI",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".blackboxai"),
        path.join(home, ".blackbox"),
        path.join(appData, "Blackbox"),
        path.join(appData, "Code", "User", "globalStorage", "blackboxapp.blackbox"),
        path.join(appData, "Cursor", "User", "globalStorage", "blackboxapp.blackbox"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "blackbox",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json") || n.includes("usage") || n.includes("chat"),
    }),
};
