import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "jcode",
  label: "Jcode",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      expandHome(process.env.JCODE_HOME || path.join(home, ".jcode")),
      path.join(home, ".jcode"),
      path.join(xdgData, "jcode"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "jcode",
      match: (n) =>
        n.startsWith("session_") ||
        n.endsWith(".jsonl") ||
        n.endsWith(".json") ||
        n.includes("journal"),
    }),
};
