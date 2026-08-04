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
  | "qwencoder"
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
  | "codebuff"
  | "mux"
  | "crush"
  | "kiro"
  | "gjc"
  | "jcode"
  | "commandcode"
  | "junie"
  | "zcode"
  | "opencodereview"
  | "codebuddy"
  | "workbuddy"
  | "aider"
  | "continue"
  | "devin"
  | "ollama"
  | "codewhale"
  | "mimocode"
  | "qoder"
  | "iflow"
  | "blackbox"
  | "forge"
  | "void"
  | "amazon-q"
  | "9router"
  | "routerlab"
  /** @deprecated legacy id — normalized to routerlab on load */
  | "xlabrouter"
  | "litellm"
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
  /**
   * Real API request count represented by this row.
   * Per-call history rows = 1; daily byModel rollups = that model's `requests`.
   * Aggregate `eventCount` sums this (defaults to 1 when omitted).
   */
  requestCount?: number;
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedCost: number;
  /** Rate-weighted cost parts (not token-share of total). */
  inputCost?: number;
  cacheCost?: number;
  outputCost?: number;
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
  /**
   * When prompt tokens (uncached input + cache read) reach this threshold,
   * all token rates are billed at 2× (xAI long-context tier, docs.x.ai pricing).
   */
  longContextThresholdTokens?: number;
}

export type GroupBy = "agent" | "model" | "day" | "hour";
