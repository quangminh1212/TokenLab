import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique, vscodeGlobalStorage } from "../shared/env.js";
import path from "node:path";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "continue",
  label: "Continue.dev",
  roots() {
    const { home, appData, xdgData, xdgConfig, path: p } = pathEnv();
    return unique([
      p.join(home, ".continue"),
      p.join(xdgConfig, "continue"),
      p.join(xdgData, "continue"),
      p.join(appData, "Continue"),
      ...vscodeGlobalStorage("continue.continue"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "continue",
      match: (n, full) =>
        n.endsWith(".jsonl") ||
        n.endsWith(".json") ||
        full.includes(`${path.sep}sessions${path.sep}`) ||
        full.includes(`${path.sep}dev_data${path.sep}`) ||
        n.includes("usage") ||
        n.includes("token"),
    }),
};
