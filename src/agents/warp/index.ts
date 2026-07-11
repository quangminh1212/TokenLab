import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "warp",
  label: "Warp AI",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path } = pathEnv();
    return unique([
      // Cross-platform app data (Electron / native)
      path.join(appData, "dev.warp.Warp-Stable"),
      path.join(appData, "dev.warp.Warp"),
      path.join(appData, "Warp"),
      path.join(localApp, "warp"),
      path.join(localApp, "dev.warp.Warp-Stable"),
      path.join(xdgData, "warp"),
      path.join(xdgConfig, "warp"),
      path.join(home, ".warp"),
      // Windows legacy
      path.join(home, "AppData", "Local", "warp"),
      // macOS group container
      path.join(home, "Library", "Group Containers", "2BBY89MBSN.dev.warp"),
      path.join(home, "Library", "Application Support", "dev.warp.Warp-Stable"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "warp",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
    }),
};
