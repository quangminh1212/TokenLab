import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import path from "node:path";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "copilot",
  label: "GitHub Copilot",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      expandHome(process.env.COPILOT_OTEL_FILE_EXPORTER_PATH || path.join(home, ".copilot")),
      path.join(home, ".copilot"),
      path.join(appData, "GitHub Copilot"),
      path.join(appData, "Code", "User", "globalStorage", "github.copilot-chat"),
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
