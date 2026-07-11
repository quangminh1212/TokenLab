import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "zed",
  label: "Zed Agent",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path } = pathEnv();
    return unique([
      path.join(appData, "Zed"),
      path.join(localApp, "Zed"),
      path.join(xdgData, "zed"),
      path.join(xdgConfig, "zed"),
      path.join(home, ".zed"),
      path.join(home, "Library", "Application Support", "Zed"),
      path.join(home, "Library", "Logs", "Zed"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "zed",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
    }),
};
