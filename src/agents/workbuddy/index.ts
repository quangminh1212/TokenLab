import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "workbuddy",
  label: "WorkBuddy",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".workbuddy"),
      path.join(xdgData, "workbuddy"),
      path.join(appData, "WorkBuddy"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "workbuddy",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json") || n.includes("usage"),
    }),
};
