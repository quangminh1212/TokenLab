import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "crush",
  label: "Crush",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(xdgData, "crush"),
      path.join(home, ".local", "share", "crush"),
      path.join(home, ".crush"),
      path.join(appData, "crush"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "crush",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json") || n === "projects.json",
    }),
};
