import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "codebuddy",
  label: "CodeBuddy",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".codebuddy"),
      path.join(xdgData, "codebuddy"),
      path.join(appData, "CodeBuddy"),
      path.join(appData, "Code", "User", "globalStorage", "tencent-cloud.codebuddy"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "codebuddy",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json") || n.includes("usage"),
    }),
};
