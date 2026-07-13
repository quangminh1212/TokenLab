import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

/** ZCode — Z.ai desktop agent (GLM), not generic zcode.ai finance apps. */
export const agent: AgentModule = {
  id: "zcode",
  label: "ZCode",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".zcode"),
      path.join(xdgData, "zcode"),
      path.join(xdgConfig, "zcode"),
      path.join(appData, "zcode"),
      path.join(appData, "ZCode"),
      path.join(localApp, "zcode"),
      path.join(localApp, "ZCode"),
      // Electron / Z.ai packaging variants
      path.join(appData, "z.ai", "zcode"),
      path.join(appData, "Z.ai", "ZCode"),
      path.join(localApp, "Programs", "ZCode"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "zcode",
      match: (n, full) => {
        const p = full.replace(/\\/g, "/").toLowerCase();
        if (p.includes("/node_modules/") || p.includes("/.git/")) return false;
        return (
          n.endsWith(".jsonl") ||
          n.endsWith(".json") ||
          n.includes("session") ||
          n.includes("usage") ||
          n.includes("history")
        );
      },
    }),
};
