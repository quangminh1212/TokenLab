import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "warp",
  label: "Warp AI",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(appData, "dev.warp.Warp-Stable"),
      path.join(home, "AppData", "Local", "warp"),
      path.join(home, "Library", "Group Containers", "2BBY89MBSN.dev.warp"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "warp",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
    }),
};
