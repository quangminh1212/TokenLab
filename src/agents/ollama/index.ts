import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "ollama",
  label: "Ollama",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".ollama"),
        path.join(xdgData, "ollama"),
        path.join(appData, "Ollama"),
        path.join(localApp, "Ollama"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "ollama",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json") || n.includes("history") || n.includes("usage"),
    }),
};
