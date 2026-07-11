import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "opencodereview",
  label: "OpenCodeReview",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".opencodereview"),
      path.join(xdgData, "opencodereview"),
      path.join(appData, "opencodereview"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "opencodereview",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
    }),
};
