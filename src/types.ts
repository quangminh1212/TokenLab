export type AgentId =
  | "claude-code"
  | "codex"
  | "cursor"
  | "windsurf"
  | "grok"
  | "gemini"
  | "opencode"
  | "copilot"
  | "hermes"
  | "openclaw"
  | "pi"
  | "kimi"
  | "qwen"
  | "droid"
  | "amp"
  | "goose"
  | "cline"
  | "roocode"
  | "kilocode"
  | "antigravity"
  | "warp"
  | "trae"
  | "zed"
  | "custom";

export interface UsageEvent {
  id: string;
  agent: AgentId;
  model: string | null;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedCost: number | null;
  currency: string;
  pricingStatus: "priced" | "unknown_model" | "zero_rate" | "estimated";
  workspace: string | null;
  sourcePath: string;
  estimated?: boolean;
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedCost: number;
  currency: string;
  eventCount: number;
}

export interface GroupRow extends TokenTotals {
  key: string;
}

export interface StatsResult {
  totals: TokenTotals;
  groups: GroupRow[];
  groupBy: "agent" | "model" | "day" | "hour";
  period: { since: string | null; until: string | null };
}

export interface AgentStatus {
  id: AgentId;
  label: string;
  detected: boolean;
  enabled: boolean;
  paths: string[];
  lastEventAt: string | null;
  eventCount: number;
}

export interface ModelRate {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
}

export type GroupBy = "agent" | "model" | "day" | "hour";
