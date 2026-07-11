import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "junie",
  label: "JetBrains Junie",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".junie"),
      path.join(xdgData, "junie"),
      path.join(appData, "JetBrains", "Junie"),
      path.join(localApp, "JetBrains"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "junie",
      match: (n) =>
        n === "events.jsonl" || n.endsWith(".jsonl") || n.endsWith(".json") || n.includes("usage"),
    }),
};
