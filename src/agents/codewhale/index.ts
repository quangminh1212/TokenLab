import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "codewhale",
  label: "CodeWhale",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".codewhale"),
        path.join(home, ".deepseek"),
        path.join(xdgConfig, "codewhale"),
        path.join(xdgData, "codewhale"),
        path.join(appData, "codewhale"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "codewhale",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json") || n.includes("session") || n.includes("usage"),
    }),
};
