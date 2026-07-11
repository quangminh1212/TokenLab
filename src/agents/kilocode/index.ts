import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique, vscodeGlobalStorage } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "kilocode",
  label: "Kilo Code",
  roots() {
    const { home, xdgData, path } = pathEnv();
    return unique([
      path.join(xdgData, "kilo"),
      path.join(home, ".local", "share", "kilo"),
      ...vscodeGlobalStorage("kilocode.kilo-code"),
    ]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "kilocode",
      match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
    }),
};
