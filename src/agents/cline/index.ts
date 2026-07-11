import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "cline",
  label: "Cline",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".cline"),
      path.join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev"),
      path.join(appData, "Cursor", "User", "globalStorage", "saoudrizwan.claude-dev"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "cline",
      match: (n) =>
        n === "ui_messages.json" ||
        n.includes("api_req") ||
        n.endsWith(".jsonl") ||
        n.endsWith(".json"),
    }),
};
