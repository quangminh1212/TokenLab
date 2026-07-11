import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "zcode",
  label: "ZCode",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".zcode"),
      path.join(xdgData, "zcode"),
      path.join(appData, "zcode"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "zcode",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
    }),
};
