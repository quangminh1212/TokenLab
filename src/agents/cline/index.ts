import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique, vscodeGlobalStorage } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "cline",
  label: "Cline",
  roots() {
    const { home, path } = pathEnv();
    return unique([
      path.join(home, ".cline"),
      ...vscodeGlobalStorage("saoudrizwan.claude-dev"),
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
