import type { ModelRate, UsageEvent } from "./types.js";
import { getConfigSync } from "./config.js";
import { lookupOpenRouterRate } from "./openrouter-models.js";
import { normalizeModelName } from "./util.js";

/**
 * Bundled offline rates (USD per 1M tokens).
 * Prefer official vendor list prices when known (Anthropic / OpenAI / xAI docs, 2026).
 * Models only on OpenRouter still take live OR rates at runtime via lookupOpenRouterRate.
 */
export const BUNDLED_RATES: Record<string, ModelRate> = {
  // --- Anthropic (platform.claude.com/docs pricing) ---
  // Legacy Opus 4 / 4.1
  "claude-opus-4": { inputPer1M: 15, outputPer1M: 75, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75 },
  // Current Opus 4.5–4.8 family: $5 / $25 (not legacy $15/$75)
  "claude-opus-4.5": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-opus-4.6": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-opus-4.7": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-opus-4.8": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-opus-4-6": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-opus-4-6-thinking": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-opus-4.6-thinking": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-opus-4-7": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-opus-4-7-thinking": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-opus-4.7-thinking": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-opus-4-8": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-opus-4-8-medium": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-opus-4.8-thinking": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  // Opus 4.8 fast mode (standard tier $10/$50)
  "claude-opus-4.8-fast": { inputPer1M: 10, outputPer1M: 50, cacheReadPer1M: 1, cacheWritePer1M: 12.5 },
  "claude-opus-4-8-fast": { inputPer1M: 10, outputPer1M: 50, cacheReadPer1M: 1, cacheWritePer1M: 12.5 },
  // Sonnet
  "claude-sonnet-4": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  "claude-sonnet-4.5": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  "claude-sonnet-4.5-lite": { inputPer1M: 0.3, outputPer1M: 1.5, cacheReadPer1M: 0.03, cacheWritePer1M: 0.375 },
  "claude-sonnet-4.6": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  "claude-sonnet-4-6-thinking": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  "claude-3-5-sonnet": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  // Haiku
  "claude-3-5-haiku": { inputPer1M: 0.8, outputPer1M: 4, cacheReadPer1M: 0.08, cacheWritePer1M: 1 },
  "claude-haiku-4": { inputPer1M: 1, outputPer1M: 5, cacheReadPer1M: 0.1, cacheWritePer1M: 1.25 },
  "claude-haiku-4.5": { inputPer1M: 1, outputPer1M: 5, cacheReadPer1M: 0.1, cacheWritePer1M: 1.25 },

  // --- OpenAI (developers.openai.com/api/docs/pricing) ---
  "gpt-5.5": { inputPer1M: 5, outputPer1M: 30, cacheReadPer1M: 0.5 },
  "gpt-5.5-high": { inputPer1M: 5, outputPer1M: 30, cacheReadPer1M: 0.5 },
  "gpt-5.5-xhigh": { inputPer1M: 5, outputPer1M: 30, cacheReadPer1M: 0.5 },
  "gpt-5.5-openai-compact": { inputPer1M: 5, outputPer1M: 30, cacheReadPer1M: 0.5 },
  "gp-gpt-5.5": { inputPer1M: 5, outputPer1M: 30, cacheReadPer1M: 0.5 },
  // GPT-5.4 short-context standard
  "gpt-5.4": { inputPer1M: 2.5, outputPer1M: 15, cacheReadPer1M: 0.25 },
  "gpt-5.4-openai-compact": { inputPer1M: 2.5, outputPer1M: 15, cacheReadPer1M: 0.25 },
  "gpt-5.4-mini": { inputPer1M: 0.75, outputPer1M: 4.5, cacheReadPer1M: 0.075 },
  "gpt-5.4-nano": { inputPer1M: 0.2, outputPer1M: 1.25, cacheReadPer1M: 0.02 },
  // Codex family
  "gpt-5.3-codex": { inputPer1M: 1.75, outputPer1M: 14, cacheReadPer1M: 0.175 },
  "gpt-5.3-codex-high": { inputPer1M: 1.75, outputPer1M: 14, cacheReadPer1M: 0.175 },
  "gpt-5.3-codex-xhigh": { inputPer1M: 1.75, outputPer1M: 14, cacheReadPer1M: 0.175 },
  "gpt-5.3": { inputPer1M: 1.75, outputPer1M: 14, cacheReadPer1M: 0.175 },
  "gpt-5.3-openai-compact": { inputPer1M: 1.75, outputPer1M: 14, cacheReadPer1M: 0.175 },
  "gpt-5.2": { inputPer1M: 1.75, outputPer1M: 14, cacheReadPer1M: 0.175 },
  "gpt-5.2-openai-compact": { inputPer1M: 1.75, outputPer1M: 14, cacheReadPer1M: 0.175 },
  "gpt-5.1-openai-compact": { inputPer1M: 1.25, outputPer1M: 10, cacheReadPer1M: 0.125 },
  "gpt-4.1": { inputPer1M: 2, outputPer1M: 8, cacheReadPer1M: 0.5 },
  "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6, cacheReadPer1M: 0.1 },
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10, cacheReadPer1M: 1.25 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6, cacheReadPer1M: 0.075 },
  // o3 post price-cut (was $10/$40)
  "o3": { inputPer1M: 2, outputPer1M: 8, cacheReadPer1M: 0.5 },
  "o3-pro": { inputPer1M: 20, outputPer1M: 80 },
  "o4-mini": { inputPer1M: 1.1, outputPer1M: 4.4, cacheReadPer1M: 0.275 },

  // --- Google (ai.google.dev pricing, short context) ---
  "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10, cacheReadPer1M: 0.125 },
  "gemini-2.5-flash": { inputPer1M: 0.3, outputPer1M: 2.5, cacheReadPer1M: 0.03 },
  "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4, cacheReadPer1M: 0.025 },

  // --- xAI (docs.x.ai / x.ai pricing) ---
  "grok-4.5": { inputPer1M: 2, outputPer1M: 6, cacheReadPer1M: 0.5 },
  "grok-4.3": { inputPer1M: 1.25, outputPer1M: 2.5, cacheReadPer1M: 0.2 },
  "grok-4": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.75 },
  "grok-4-fast": { inputPer1M: 0.2, outputPer1M: 0.5, cacheReadPer1M: 0.05 },
  "grok-4-fast-reasoning": { inputPer1M: 0.2, outputPer1M: 0.5, cacheReadPer1M: 0.05 },
  "grok-3": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.75 },
  "grok-3-mini": { inputPer1M: 0.3, outputPer1M: 0.5, cacheReadPer1M: 0.075 },
  // grok-build-0.1 aliases: $1 in / $2 out / $0.20 cache
  "grok-build": { inputPer1M: 1, outputPer1M: 2, cacheReadPer1M: 0.2 },
  "grok-build-0.1": { inputPer1M: 1, outputPer1M: 2, cacheReadPer1M: 0.2 },
  "grok-code-fast-1": { inputPer1M: 1, outputPer1M: 2, cacheReadPer1M: 0.2 },
  "grok-code-fast": { inputPer1M: 1, outputPer1M: 2, cacheReadPer1M: 0.2 },

  // --- DeepSeek (api-docs.deepseek.com) ---
  "deepseek-v3": { inputPer1M: 0.27, outputPer1M: 1.1 },
  "deepseek-v3.2": { inputPer1M: 0.28, outputPer1M: 0.42 },
  // Official: cache-miss $0.14 / out $0.28; cache-hit $0.0028
  "deepseek-v4-flash": { inputPer1M: 0.14, outputPer1M: 0.28, cacheReadPer1M: 0.0028 },
  // Official: cache-miss $0.435 / out $0.87; cache-hit $0.003625
  "deepseek-v4-pro": { inputPer1M: 0.435, outputPer1M: 0.87, cacheReadPer1M: 0.003625 },
  // Legacy aliases → v4-flash (non-thinking / thinking), same rates
  "deepseek-chat": { inputPer1M: 0.14, outputPer1M: 0.28, cacheReadPer1M: 0.0028 },
  "deepseek-reasoner": { inputPer1M: 0.14, outputPer1M: 0.28, cacheReadPer1M: 0.0028 },

  // --- GLM / Zhipu (docs.z.ai official) ---
  "glm-5": { inputPer1M: 1, outputPer1M: 3.2, cacheReadPer1M: 0.2 },
  "glm-5.0": { inputPer1M: 1, outputPer1M: 3.2, cacheReadPer1M: 0.2 },
  "glm-5.1": { inputPer1M: 1.4, outputPer1M: 4.4, cacheReadPer1M: 0.26 },
  "glm-5.2": { inputPer1M: 1.4, outputPer1M: 4.4, cacheReadPer1M: 0.26 },
  "glm-5-2": { inputPer1M: 1.4, outputPer1M: 4.4, cacheReadPer1M: 0.26 },
  "glm-4.5": { inputPer1M: 0.6, outputPer1M: 2.2 },

  // --- MiniMax / Moonshot ---
  // MiniMax paygo (≤512k, 50% promo): $0.30 / $1.20 / cache $0.06
  "minimax-m3": { inputPer1M: 0.3, outputPer1M: 1.2, cacheReadPer1M: 0.06 },
  "minimax-m2.7": { inputPer1M: 0.3, outputPer1M: 1.2 },
  "kimi-k2-7": { inputPer1M: 0.6, outputPer1M: 2.5 },
  "kimi-k2.6": { inputPer1M: 0.66, outputPer1M: 3.41 },
  "kimi-k2.5": { inputPer1M: 0.375, outputPer1M: 2.025 },

  // --- Agent / router house models (still approx) ---
  "cursor-small": { inputPer1M: 0.2, outputPer1M: 0.8 },
  "mimo-auto": { inputPer1M: 0.2, outputPer1M: 0.8 },
  "swe-1-6": { inputPer1M: 0.5, outputPer1M: 2 },
  "swe-1-7": { inputPer1M: 0.5, outputPer1M: 2 },
  "windsurf-cascade": { inputPer1M: 1, outputPer1M: 4 },
  adaptive: { inputPer1M: 1, outputPer1M: 4 },
  "big-pickle": { inputPer1M: 0, outputPer1M: 0 },
  "nemotron-3-ultra-free": { inputPer1M: 0, outputPer1M: 0 },
  Digigo: { inputPer1M: 0, outputPer1M: 0 },
  digigo: { inputPer1M: 0, outputPer1M: 0 },
  default: { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
};

/** Infer OpenRouter-style provider slug from a bare model id. */
export function guessProvider(modelId: string): string {
  const raw = String(modelId || "").trim().toLowerCase();
  if (!raw) return "other";
  if (raw.includes("/")) return raw.split("/")[0] || "other";
  if (raw.startsWith("claude")) return "anthropic";
  if (
    raw.startsWith("gpt") ||
    raw.startsWith("o1") ||
    raw.startsWith("o3") ||
    raw.startsWith("o4") ||
    raw.startsWith("chatgpt") ||
    raw.startsWith("gp-gpt")
  ) {
    return "openai";
  }
  if (raw.startsWith("gemini")) return "google";
  if (raw.startsWith("grok")) return "x-ai";
  if (raw.startsWith("deepseek")) return "deepseek";
  if (raw.startsWith("glm") || raw.startsWith("chatglm")) return "z-ai";
  if (raw.startsWith("kimi") || raw.startsWith("moonshot")) return "moonshotai";
  if (raw.startsWith("qwen")) return "qwen";
  if (raw.startsWith("minimax")) return "minimax";
  if (raw.startsWith("mistral") || raw.startsWith("mixtral") || raw.startsWith("codestral")) {
    return "mistralai";
  }
  if (raw.startsWith("llama") || raw.startsWith("meta-")) return "meta-llama";
  if (raw.startsWith("command") || raw.startsWith("cohere")) return "cohere";
  if (raw.includes("nemotron")) return "nvidia";
  if (raw.startsWith("mimo")) return "xiaomi";
  if (raw.includes("windsurf") || raw.startsWith("swe-") || raw === "cascade") return "windsurf";
  if (raw.includes("cursor")) return "cursor";
  if (raw.includes("digigo") || raw === "xlab" || raw.startsWith("9router")) return "other";
  return "other";
}

const ALIASES: Record<string, string> = {
  "claude-sonnet-4-20250514": "claude-sonnet-4",
  "claude-3-5-sonnet-20241022": "claude-3-5-sonnet",
  "claude-3-5-haiku-20241022": "claude-3-5-haiku",
  "claude-sonnet-4-5": "claude-sonnet-4.5",
  "claude-sonnet-4-5-lite": "claude-sonnet-4.5-lite",
  "gpt-4.1-2025-04-14": "gpt-4.1",
  "chatgpt-4o-latest": "gpt-4o",
  "grok-4-latest": "grok-4",
  "grok-code-fast-1-0825": "grok-code-fast-1",
  composer: "default",
  "deep-seek-v4-flash": "deepseek-v4-flash",
  "deep-seek-v4-pro": "deepseek-v4-pro",
  "deepseek-v3.2": "deepseek-v3.2",
  "deepseek-v3-2": "deepseek-v3.2",
  "glm-5-1": "glm-5.1",
  "minimax-m2-7": "minimax-m2.7",
};

function customRates(): Record<string, ModelRate> {
  return getConfigSync().pricing?.customRates || {};
}

/** Resolve to a rate table key (bundled or custom). */
export function resolveModelKey(model: string | null | undefined): string | null {
  if (!model) return null;
  const raw = (normalizeModelName(model) || model).trim().toLowerCase();
  if (!raw) return null;

  const custom = customRates();
  if (custom[raw]) return raw;
  if (ALIASES[raw]) return ALIASES[raw];
  if (BUNDLED_RATES[raw]) return raw;
  if (custom[ALIASES[raw]]) return ALIASES[raw];

  // Longest bundled/custom key contained in model name (min length 5 to avoid "gpt"→"gpt-4.1")
  const keys = [
    ...Object.keys(custom),
    ...Object.keys(BUNDLED_RATES).filter((k) => k !== "default"),
  ].sort((a, b) => b.length - a.length);

  for (const k of keys) {
    const kl = k.toLowerCase();
    if (raw === kl) return k;
    if (kl.length >= 5 && (raw.includes(kl) || raw.replace(/_/g, "-").includes(kl))) return k;
  }

  // Family heuristics (only with enough signal)
  if (raw.includes("claude") && raw.includes("sonnet") && raw.includes("lite")) return "claude-sonnet-4.5-lite";
  if (raw.includes("claude") && raw.includes("sonnet")) return "claude-sonnet-4";
  if (raw.includes("claude") && raw.includes("opus")) return "claude-opus-4";
  if (raw.includes("claude") && raw.includes("haiku")) return "claude-3-5-haiku";
  if (raw.includes("gpt-5.5")) return "gpt-5.5";
  if (raw.includes("gpt-5.4")) return "gpt-5.4";
  if (raw.includes("gpt-5.3") && raw.includes("codex")) return "gpt-5.3-codex";
  if (raw.includes("gpt-5.3")) return "gpt-5.3";
  if (raw.includes("gpt-4o-mini")) return "gpt-4o-mini";
  if (raw.includes("gpt-4o")) return "gpt-4o";
  if (raw.includes("gpt-4.1")) return "gpt-4.1";
  if (raw.includes("deepseek") || raw.includes("deep-seek")) {
    if (raw.includes("flash")) return "deepseek-v4-flash";
    if (raw.includes("pro")) return "deepseek-v4-pro";
    if (raw.includes("v3")) return "deepseek-v3.2";
    return "deepseek-v3";
  }
  if (raw.includes("gemini") && raw.includes("flash")) return "gemini-2.5-flash";
  if (raw.includes("gemini")) return "gemini-2.5-pro";
  if (raw.includes("grok") && raw.includes("fast")) return "grok-4-fast";
  if (raw.includes("grok")) return "grok-4.5";
  if (raw.includes("glm")) return "glm-5.1";
  if (raw.includes("minimax")) return "minimax-m3";
  return null;
}

export function getRateForModel(model: string | null | undefined): {
  key: string | null;
  rate: ModelRate;
  source: "custom" | "bundled" | "openrouter" | "default";
} {
  const raw = (normalizeModelName(model) || model || "").trim().toLowerCase();
  const custom = customRates();
  if (raw && custom[raw]) {
    return { key: raw, rate: custom[raw], source: "custom" };
  }
  // Custom keyed by full OpenRouter id
  if (model) {
    const full = String(model).trim().toLowerCase();
    if (full && custom[full]) return { key: full, rate: custom[full], source: "custom" };
  }
  const key = resolveModelKey(model);
  if (key && custom[key.toLowerCase()]) {
    return { key, rate: custom[key.toLowerCase()], source: "custom" };
  }
  if (key && BUNDLED_RATES[key]) {
    return { key, rate: BUNDLED_RATES[key], source: "bundled" };
  }
  // OpenRouter live catalog (full id / slug match)
  const or = lookupOpenRouterRate(model) || (raw ? lookupOpenRouterRate(raw) : null);
  if (or) {
    if (custom[or.key.toLowerCase()]) {
      return { key: or.key, rate: custom[or.key.toLowerCase()], source: "custom" };
    }
    if (custom[or.entry.slug.toLowerCase()]) {
      return { key: or.entry.slug, rate: custom[or.entry.slug.toLowerCase()], source: "custom" };
    }
    return { key: or.key, rate: or.rate, source: "openrouter" };
  }
  return { key: key || "default", rate: BUNDLED_RATES.default, source: "default" };
}

export function priceTokens(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  currency = "USD",
): Pick<UsageEvent, "estimatedCost" | "pricingStatus" | "currency"> {
  const { key, rate, source } = getRateForModel(model);
  const cost =
    (inputTokens * rate.inputPer1M +
      outputTokens * rate.outputPer1M +
      cacheReadTokens * (rate.cacheReadPer1M ?? rate.inputPer1M * 0.1) +
      cacheWriteTokens * (rate.cacheWritePer1M ?? rate.inputPer1M * 1.25)) /
    1_000_000;
  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) {
    return { estimatedCost: 0, pricingStatus: "zero_rate", currency };
  }
  // Explicit free tier (both rates 0)
  if (rate.inputPer1M === 0 && rate.outputPer1M === 0) {
    return { estimatedCost: 0, pricingStatus: "zero_rate", currency };
  }
  return {
    estimatedCost: cost,
    pricingStatus: source === "default" && !key ? "unknown_model" : source === "default" ? "unknown_model" : "priced",
    currency,
  };
}

export function applyPricing(
  partial: Omit<UsageEvent, "estimatedCost" | "pricingStatus" | "currency" | "totalTokens"> & {
    estimatedCost?: number | null;
    pricingStatus?: UsageEvent["pricingStatus"];
    currency?: string;
    /** When set and > 0 (and preferRouterCost), use instead of table. */
    routerCost?: number | null;
  },
): UsageEvent {
  const totalTokens =
    partial.inputTokens + partial.outputTokens + partial.cacheReadTokens + partial.cacheWriteTokens;
  const currency = getConfigSync().pricing?.currency || partial.currency || "USD";
  const preferRouter = getConfigSync().pricing?.preferRouterCost !== false;
  const routerCost =
    typeof partial.routerCost === "number" && Number.isFinite(partial.routerCost)
      ? partial.routerCost
      : typeof partial.estimatedCost === "number" && partial.pricingStatus === "priced"
        ? partial.estimatedCost
        : null;

  const priced = priceTokens(
    partial.model,
    partial.inputTokens,
    partial.outputTokens,
    partial.cacheReadTokens,
    partial.cacheWriteTokens,
    currency,
  );

  // Prefer positive router-reported cost; never lock in router $0 when table/custom has rates
  if (preferRouter && routerCost != null && routerCost > 0) {
    return {
      ...partial,
      totalTokens,
      estimatedCost: routerCost,
      pricingStatus: partial.estimated ? "estimated" : "priced",
      currency,
    };
  }

  return {
    ...partial,
    totalTokens,
    estimatedCost: priced.estimatedCost,
    pricingStatus: partial.estimated ? "estimated" : priced.pricingStatus,
    currency: priced.currency,
  };
}

/**
 * Recompute costs after rate table / custom rate changes.
 * - forceTable: ignore sticky router costs — always use bundled + custom rates
 * - default: custom-rated models use table; others keep previous positive cost
 */
export function repriceEvents(
  events: UsageEvent[],
  opts: { forceTable?: boolean } = {},
): UsageEvent[] {
  const custom = customRates();
  const forceTable = opts.forceTable === true;
  return events.map((e) => {
    const norm = (normalizeModelName(e.model) || e.model || "").trim().toLowerCase();
    const hasCustom = Boolean(norm && custom[norm]);
    const useTable = forceTable || hasCustom || (e.estimatedCost ?? 0) <= 0;
    return applyPricing({
      id: e.id,
      agent: e.agent,
      model: e.model,
      timestamp: e.timestamp,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheReadTokens: e.cacheReadTokens,
      cacheWriteTokens: e.cacheWriteTokens,
      workspace: e.workspace,
      sourcePath: e.sourcePath,
      estimated: e.estimated,
      routerCost: useTable ? null : e.estimatedCost,
    });
  });
}

export function listPricingCatalog(models: string[] = []): Array<{
  model: string;
  key: string | null;
  source: "custom" | "bundled" | "openrouter" | "default";
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
}> {
  const custom = customRates();
  const names = new Set<string>([
    ...Object.keys(custom),
    ...Object.keys(BUNDLED_RATES).filter((k) => k !== "default"),
    ...models.map((m) => normalizeModelName(m) || m).filter(Boolean),
  ]);
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((model) => {
      const { key, rate, source } = getRateForModel(model);
      return {
        model,
        key,
        source,
        inputPer1M: rate.inputPer1M,
        outputPer1M: rate.outputPer1M,
        cacheReadPer1M: rate.cacheReadPer1M,
        cacheWritePer1M: rate.cacheWritePer1M,
      };
    });
}
