import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "void",
  label: "Void",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(appData, "Void"),
        path.join(home, ".void-editor"),
        path.join(home, ".void"),
        path.join(localApp, "Void"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "void",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json") || n.includes("usage") || n === "state.vscdb",
    }),
};
