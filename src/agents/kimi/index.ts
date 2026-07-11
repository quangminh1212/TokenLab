import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "kimi",
  label: "Kimi CLI",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      expandHome(process.env.KIMI_SHARE_DIR || path.join(home, ".kimi")),
      path.join(home, ".kimi"),
      path.join(home, ".kimi-code"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "kimi",
      match: (n) => n === "wire.jsonl" || n.endsWith(".jsonl") || n.includes("usage"),
    }),
};
