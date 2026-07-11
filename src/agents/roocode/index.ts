import type { AgentModule } from "../shared/types.js";
import { unique, vscodeGlobalStorage } from "../shared/env.js";
import { parseGenericJsonl } from "../shared/generic-jsonl.js";

export const agent: AgentModule = {
  id: "roocode",
  label: "Roo Code",
  roots() {
    return unique([...vscodeGlobalStorage("rooveterinaryinc.roo-cline")]);
  },
  parse: (roots) =>
    parseGenericJsonl(roots, {
      agent: "roocode",
      match: (n) => n === "ui_messages.json" || n.endsWith(".jsonl") || n.endsWith(".json"),
    }),
};
