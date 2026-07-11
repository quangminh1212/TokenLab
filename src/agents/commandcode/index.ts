import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "commandcode",
  label: "Command Code",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".commandcode"),
      path.join(xdgData, "commandcode"),
      path.join(appData, "commandcode"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "commandcode",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
    }),
};
