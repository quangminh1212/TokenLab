import type { AgentModule } from "../shared/types.js";
import { jetbrainsRoots, pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "junie",
  label: "JetBrains Junie",
  roots() {
    const { home, xdgData, path } = pathEnv();
    return unique([
      path.join(home, ".junie"),
      path.join(xdgData, "junie"),
      ...jetbrainsRoots("Junie"),
      ...jetbrainsRoots(),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "junie",
      match: (n) =>
        n === "events.jsonl" || n.endsWith(".jsonl") || n.endsWith(".json") || n.includes("usage"),
    }),
};
