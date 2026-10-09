export type AgentId =
  | "claude-code"
  | "codex"
  | "cursor"
  | "windsurf"
  | "grok"
  | "gemini"
  | "opencode"
  | "dsh"
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
   * Runtime/persisted provenance scope used to keep foreign-machine restores
   * separate from local usage during deduplication and high-water merges.
   */
  machineScope?: string;
  /**
   * Real API request count represented by this row.
   * Per-call history rows = 1; daily byModel rollups = that model's `requests`.
   * Aggregate `eventCount` sums this (defaults to 1 when omitted).
   */
  requestCount?: number;
  /**
   * True when the source record actually exposed cache fields (even as zero),
   * false/absent when the provider said nothing about caching.
   *
   * Lets the dashboard tell a measured cache hit rate of 0 apart from "no cache
   * data in this feed", which otherwise both render as a bare 0.
   */
  cacheReported?: boolean;
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
  /**
   * Events in this bucket whose source actually reported a cache field (read or
   * write), versus events that said nothing about caching.
   *
   * `cacheReadTokens === 0` alone cannot tell the two apart, so CACHE $ rendered
   * "—" for both "this provider does not cache" and "we never saw the number".
   * With the count, the dashboard shows a measured $0.00 when every event in the
   * bucket reported cache, and "—" only when nothing did.
   */
  cacheReportedEvents?: number;
  /**
   * Cache-read tokens the bucket's rate table actually charges a discount on.
   *
   * Cache-hit tokens can be measured (and worth displaying) while the model's
   * published rate table gives them no discount at all. LiteLLM does exactly
   * this: its mirror bills Claude traffic as
   * `cost = inputPer1M * promptTokens + outputPer1M * completionTokens` with
   * `cacheReadPer1M === inputPer1M`, so those rows carry billions of cache-hit
   * tokens yet contribute $0.00 to `cacheCost`.
   *
   * Without this split "CACHE $ 0.00" is indistinguishable from "cache was never
   * scanned" — the two look identical in the dashboard.
   */
  cacheBilledTokens?: number;
  /**
   * Cache-read tokens that earned no discount because the rate table publishes
   * `cacheReadPer1M >= inputPer1M` for that model.
   *
   * `cacheFreeTokens + cacheBilledTokens === cacheReadTokens`.
   */
  cacheFreeTokens?: number;
}

export interface GroupRow extends TokenTotals {
  key: string;
  /**
   * Peak RPM inside this bucket: the busiest single calendar minute's request
   * count (hour/day/agent/model rows alike). See `rpmByGroup`.
   */
  rpm?: number;
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
