import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique, vscodeGlobalStorage } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "blackbox",
  label: "Blackbox AI",
  roots() {
    const { home, appData, path } = pathEnv();
    return unique([
      path.join(home, ".blackboxai"),
      path.join(home, ".blackbox"),
      path.join(appData, "Blackbox"),
      ...vscodeGlobalStorage("blackboxapp.blackbox"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "blackbox",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json") || n.includes("usage") || n.includes("chat"),
    }),
};
