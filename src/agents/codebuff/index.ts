import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "codebuff",
  label: "Codebuff",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      expandHome(process.env.CODEBUFF_DATA_DIR || path.join(xdgConfig, "manicode")),
      path.join(xdgConfig, "manicode"),
      path.join(xdgConfig, "manicode-dev"),
      path.join(xdgConfig, "manicode-staging"),
      path.join(home, ".config", "manicode"),
      path.join(home, ".codebuff"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "codebuff",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json") || n.includes("usage"),
    }),
};
