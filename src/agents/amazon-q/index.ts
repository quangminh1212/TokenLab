import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "amazon-q",
  label: "Amazon Q",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".aws", "amazonq"),
        path.join(home, ".amazonq"),
        path.join(appData, "amazon-q"),
        path.join(appData, "Code", "User", "globalStorage", "amazonwebservices.amazon-q-vscode"),
        path.join(appData, "Cursor", "User", "globalStorage", "amazonwebservices.amazon-q-vscode"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "amazon-q",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json") || n.includes("usage") || n.includes("chat") || n.includes("session"),
    }),
};
