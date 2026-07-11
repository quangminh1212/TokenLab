import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "roocode",
  label: "Roo Code",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(appData, "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline"),
      path.join(appData, "Cursor", "User", "globalStorage", "rooveterinaryinc.roo-cline"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "roocode",
      match: (n) => n === "ui_messages.json" || n.endsWith(".jsonl") || n.endsWith(".json"),
    }),
};
