import type { AgentId, UsageEvent } from "../../types.js";

export interface AgentModule {
  id: AgentId;
  label: string;
  /** Local data roots to scan on this machine. */
  roots: () => string[];
  /** Parse usage events from existing roots. */
  parse: (roots: string[]) => Promise<UsageEvent[]>;
}

export interface AgentPathSpec {
  id: AgentId;
  label: string;
  roots: string[];
}
