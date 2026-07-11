import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique, vscodeGlobalStorage } from "../shared/env.js";
import path from "node:path";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "kiro",
  label: "Kiro",
  roots() {
    const { home, appData, localApp, xdgData, path: p } = pathEnv();
    return unique([
      p.join(home, ".kiro"),
      p.join(xdgData, "kiro-cli"),
      p.join(appData, "kiro-cli"),
      p.join(appData, "Kiro"),
      p.join(localApp, "Kiro"),
      // macOS explicit (also covered by appData on darwin)
      p.join(home, "Library", "Application Support", "kiro-cli"),
      p.join(home, "Library", "Application Support", "Kiro"),
      ...vscodeGlobalStorage("kiro.kiroagent"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "kiro",
      match: (n, full) =>
        n.endsWith(".jsonl") ||
        n.endsWith(".json") ||
        full.toLowerCase().includes("kiro") ||
        full.includes(`${path.sep}sessions${path.sep}`),
    }),
};
