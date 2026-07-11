import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique, vscodeGlobalStorage } from "../shared/env.js";
import path from "node:path";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "copilot",
  label: "GitHub Copilot",
  roots() {
    const { home, appData, path: p, expandHome } = pathEnv();
    return unique([
      expandHome(process.env.COPILOT_OTEL_FILE_EXPORTER_PATH || p.join(home, ".copilot")),
      p.join(home, ".copilot"),
      p.join(appData, "GitHub Copilot"),
      ...vscodeGlobalStorage("github.copilot-chat", "github.copilot"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "copilot",
      match: (n, full) =>
        n.endsWith(".jsonl") ||
        full.includes(`${path.sep}otel${path.sep}`) ||
        n.includes("usage") ||
        n.includes("transcript"),
    }),
};
