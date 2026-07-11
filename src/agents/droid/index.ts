import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "droid",
  label: "Factory Droid",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      expandHome(process.env.FACTORY_DIR || path.join(home, ".factory")),
      path.join(home, ".factory"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "droid",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
    }),
};
