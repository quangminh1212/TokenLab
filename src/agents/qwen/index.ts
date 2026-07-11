import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "qwen",
  label: "Qwen CLI",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      expandHome(process.env.QWEN_DATA_DIR || path.join(home, ".qwen")),
      path.join(home, ".qwen"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "qwen",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
    }),
};
