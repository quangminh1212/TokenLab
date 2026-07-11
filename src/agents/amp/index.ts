import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "amp",
  label: "Amp",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([path.join(home, ".amp"), path.join(home, ".cache", "amp"), path.join(xdgData, "amp")]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "amp",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
    }),
};
