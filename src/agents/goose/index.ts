import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "goose",
  label: "Goose",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(xdgData, "goose"),
      path.join(home, ".local", "share", "goose"),
      path.join(home, ".config", "goose"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "goose",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
    }),
};
