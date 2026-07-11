import type { ModelRate, UsageEvent } from "./types.js";

/** Bundled offline rates (USD per 1M tokens). Inspired by public LiteLLM-style tables. */
export const BUNDLED_RATES: Record<string, ModelRate> = {
  // Anthropic
  "claude-opus-4": { inputPer1M: 15, outputPer1M: 75, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75 },
  "claude-sonnet-4": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  "claude-3-5-sonnet": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  "claude-3-5-haiku": { inputPer1M: 0.8, outputPer1M: 4, cacheReadPer1M: 0.08, cacheWritePer1M: 1 },
  "claude-haiku-4": { inputPer1M: 1, outputPer1M: 5, cacheReadPer1M: 0.1, cacheWritePer1M: 1.25 },
  // OpenAI
  "gpt-4.1": { inputPer1M: 2, outputPer1M: 8, cacheReadPer1M: 0.5 },
  "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6, cacheReadPer1M: 0.1 },
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10, cacheReadPer1M: 1.25 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6, cacheReadPer1M: 0.075 },
  "o3": { inputPer1M: 10, outputPer1M: 40, cacheReadPer1M: 2.5 },
  "o4-mini": { inputPer1M: 1.1, outputPer1M: 4.4, cacheReadPer1M: 0.275 },
  // Google
  "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10, cacheReadPer1M: 0.315 },
  "gemini-2.5-flash": { inputPer1M: 0.15, outputPer1M: 0.6, cacheReadPer1M: 0.0375 },
  "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4, cacheReadPer1M: 0.025 },
  // xAI
  "grok-4.5": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.75 },
  "grok-4": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.75 },
  "grok-3": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.75 },
  "grok-3-mini": { inputPer1M: 0.3, outputPer1M: 0.5, cacheReadPer1M: 0.075 },
  // Cursor house models (approx / public list)
  "cursor-small": { inputPer1M: 0.2, outputPer1M: 0.8 },
  "default": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
};

const ALIASES: Record<string, string> = {
  "claude-sonnet-4-20250514": "claude-sonnet-4",
  "claude-3-5-sonnet-20241022": "claude-3-5-sonnet",
  "claude-3-5-haiku-20241022": "claude-3-5-haiku",
  "gpt-4.1-2025-04-14": "gpt-4.1",
  "chatgpt-4o-latest": "gpt-4o",
  "grok-4-latest": "grok-4",
  "grok-build": "grok-4.5",
  "composer": "default",
};

export function resolveModelKey(model: string | null | undefined): string | null {
  if (!model) return null;
  const raw = model.trim().toLowerCase();
  if (!raw) return null;
  if (ALIASES[raw]) return ALIASES[raw];
  if (BUNDLED_RATES[raw]) return raw;
  // prefix fuzzy match
  const keys = Object.keys(BUNDLED_RATES).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (raw.includes(k) || k.includes(raw)) return k;
  }
  if (raw.includes("claude") && raw.includes("sonnet")) return "claude-sonnet-4";
  if (raw.includes("claude") && raw.includes("opus")) return "claude-opus-4";
  if (raw.includes("claude") && raw.includes("haiku")) return "claude-3-5-haiku";
  if (raw.includes("gpt-4o-mini")) return "gpt-4o-mini";
  if (raw.includes("gpt-4o")) return "gpt-4o";
  if (raw.includes("gpt-4.1")) return "gpt-4.1";
  if (raw.includes("gemini") && raw.includes("flash")) return "gemini-2.5-flash";
  if (raw.includes("gemini")) return "gemini-2.5-pro";
  if (raw.includes("grok")) return "grok-4.5";
  return null;
}

export function priceTokens(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  currency = "USD",
): Pick<UsageEvent, "estimatedCost" | "pricingStatus" | "currency"> {
  const key = resolveModelKey(model);
  // Fall back to default mid-tier rates so spend is never blank when tokens exist
  const rate = (key && BUNDLED_RATES[key]) || BUNDLED_RATES.default;
  const cost =
    (inputTokens * rate.inputPer1M +
      outputTokens * rate.outputPer1M +
      cacheReadTokens * (rate.cacheReadPer1M ?? rate.inputPer1M * 0.1) +
      cacheWriteTokens * (rate.cacheWritePer1M ?? rate.inputPer1M * 1.25)) /
    1_000_000;
  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) {
    return { estimatedCost: 0, pricingStatus: "zero_rate", currency };
  }
  return {
    estimatedCost: cost,
    pricingStatus: key ? "priced" : "unknown_model",
    currency,
  };
}

export function applyPricing(
  partial: Omit<UsageEvent, "estimatedCost" | "pricingStatus" | "currency" | "totalTokens"> & {
    estimatedCost?: number | null;
    pricingStatus?: UsageEvent["pricingStatus"];
    currency?: string;
  },
): UsageEvent {
  const totalTokens =
    partial.inputTokens + partial.outputTokens + partial.cacheReadTokens + partial.cacheWriteTokens;
  const priced = priceTokens(
    partial.model,
    partial.inputTokens,
    partial.outputTokens,
    partial.cacheReadTokens,
    partial.cacheWriteTokens,
  );
  return {
    ...partial,
    totalTokens,
    estimatedCost: priced.estimatedCost,
    pricingStatus: partial.estimated ? "estimated" : priced.pricingStatus,
    currency: priced.currency,
  };
}
