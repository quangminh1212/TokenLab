import { normalizeModelName, num } from "../../util.js";

export interface TokenBuckets {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Some providers report prompt/input as a full value that already includes cache reads. */
  inputIncludesCache?: boolean;
}

/** Extract token buckets from heterogeneous vendor usage objects. */
export function extractTokenBuckets(usage: unknown): TokenBuckets | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;

  // Nested shapes: usage / token_usage / metrics (Devin) / metadata.metrics
  const meta =
    u.metadata && typeof u.metadata === "object" ? (u.metadata as Record<string, unknown>) : null;
  const nested =
    (u.usage && typeof u.usage === "object" ? (u.usage as Record<string, unknown>) : null) ||
    (u.token_usage && typeof u.token_usage === "object" ? (u.token_usage as Record<string, unknown>) : null) ||
    (u.tokenUsage && typeof u.tokenUsage === "object" ? (u.tokenUsage as Record<string, unknown>) : null) ||
    (u.tokens && typeof u.tokens === "object" ? (u.tokens as Record<string, unknown>) : null) ||
    (u.token_count && typeof u.token_count === "object" ? (u.token_count as Record<string, unknown>) : null) ||
    (u.metrics && typeof u.metrics === "object" ? (u.metrics as Record<string, unknown>) : null) ||
    (meta?.metrics && typeof meta.metrics === "object" ? (meta.metrics as Record<string, unknown>) : null) ||
    u;

  const inputTokens = num(
    nested.input_tokens ??
      nested.inputTokens ??
      nested.prompt_tokens ??
      nested.promptTokens ??
      nested.prompt_token_count ??
      nested.input ??
      nested.total_input_tokens ??
      nested.input_other,
  );
  const explicitOutputTokens = num(
    nested.output_tokens ??
      nested.outputTokens ??
      nested.completion_tokens ??
      nested.completionTokens ??
      nested.candidatesTokenCount ??
      nested.output ??
      nested.total_output_tokens ??
      nested.completion,
  );
  // Codex/Orca can emit reasoning_output_tokens alongside (or instead of)
  // output_tokens. In the normal shape reasoning is already included in
  // output_tokens, so only use it as a fallback when output is absent/zero.
  const reasoningOutputTokens = num(
    nested.reasoning_output_tokens ??
      nested.reasoningOutputTokens ??
      nested.reasoning_tokens ??
      nested.reasoningTokens,
  );
  const outputTokens = explicitOutputTokens > 0 ? explicitOutputTokens : reasoningOutputTokens;
  // Nested OpenAI / LiteLLM shapes: prompt_tokens_details.cached_tokens
  const promptDetails =
    (nested.prompt_tokens_details && typeof nested.prompt_tokens_details === "object"
      ? (nested.prompt_tokens_details as Record<string, unknown>)
      : null) ||
    (nested.promptTokensDetails && typeof nested.promptTokensDetails === "object"
      ? (nested.promptTokensDetails as Record<string, unknown>)
      : null) ||
    (nested.input_tokens_details && typeof nested.input_tokens_details === "object"
      ? (nested.input_tokens_details as Record<string, unknown>)
      : null);

  const cacheReadTokens = num(
    nested.cached_input_tokens ??
      nested.cachedInputTokens ??
      nested.cache_read_input_tokens ??
      nested.cache_read_tokens ??
      nested.cacheReadTokens ??
      nested.cachedReadTokens ??
      nested.cacheReadInputTokens ??
      nested.cache_read ??
      nested.cached_tokens ??
      nested.cachedTokens ??
      nested.cached_content_token_count ??
      nested.cachedContentTokenCount ??
      nested.cached ??
      nested.input_cache_read ??
      nested.total_cache_read_tokens ??
      promptDetails?.cached_tokens ??
      promptDetails?.cache_read_tokens ??
      promptDetails?.cachedTokens ??
      promptDetails?.cache_read_input_tokens ??
      promptDetails?.cached_input_tokens ??
      promptDetails?.cachedInputTokens,
  );
  const cacheWriteTokens = num(
    nested.cache_write_input_tokens ??
      nested.cacheWriteInputTokens ??
      nested.cache_creation_input_tokens ??
      nested.cacheCreationInputTokens ??
      nested.cache_creation_tokens ??
      nested.cacheCreationTokens ??
      nested.cache_write_tokens ??
      nested.cacheWriteTokens ??
      nested.cache_write ??
      nested.cachedWriteTokens ??
      nested.input_cache_creation ??
      nested.total_cache_write_tokens ??
      promptDetails?.cache_write_tokens ??
      promptDetails?.cache_creation_input_tokens ??
      promptDetails?.cache_write_input_tokens ??
      promptDetails?.cacheWriteInputTokens,
  );

  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0) return null;
  const inputIncludesCache =
    nested.cached_input_tokens != null ||
    nested.cachedInputTokens != null ||
    nested.cached_content_token_count != null ||
    nested.cachedContentTokenCount != null ||
    promptDetails?.cached_tokens != null ||
    promptDetails?.cachedTokens != null ||
    promptDetails?.cached_input_tokens != null ||
    promptDetails?.cachedInputTokens != null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(inputIncludesCache ? { inputIncludesCache: true } : {}),
  };
}

export function extractModel(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      const n = normalizeModelName(c);
      if (n) return n;
    }
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      for (const key of ["model", "modelId", "model_id", "model_name", "rawModel"] as const) {
        if (typeof o[key] === "string" && (o[key] as string).trim()) {
          const n = normalizeModelName(o[key] as string);
          if (n) return n;
        }
      }
      if (o.message && typeof o.message === "object") {
        const m = o.message as Record<string, unknown>;
        if (typeof m.model === "string" && m.model.trim()) {
          const n = normalizeModelName(m.model);
          if (n) return n;
        }
      }
    }
  }
  return null;
}

export function extractTimestamp(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (c instanceof Date && !Number.isNaN(c.getTime())) return c.toISOString();
    if (typeof c === "string" && c.trim() && !Number.isNaN(Date.parse(c))) return new Date(c).toISOString();
    if (typeof c === "number" && Number.isFinite(c)) {
      // epoch ms / sec, or treat small integers as invalid for time
      if (c <= 0) continue;
      const ms = c > 1e12 ? c : c > 1e9 ? c * 1000 : c;
      if (ms < 1e11) continue; // reject non-epoch noise
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    if (c && typeof c === "object" && !(c instanceof Date)) {
      const o = c as Record<string, unknown>;
      for (const k of [
        "timestamp",
        "ts",
        "created_at",
        "createdAt",
        "started_at",
        "startedAt",
        "completed_at",
        "completedAt",
        "time",
        "date",
        "mtime",
      ]) {
        const v = o[k];
        if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
        if (typeof v === "number" && Number.isFinite(v) && v > 0) {
          const ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : NaN;
          if (Number.isFinite(ms)) return new Date(ms).toISOString();
        }
      }
      if (o.time && typeof o.time === "object") {
        const t = o.time as Record<string, unknown>;
        if (typeof t.created === "string" && !Number.isNaN(Date.parse(t.created))) {
          return new Date(t.created).toISOString();
        }
      }
    }
  }
  // Prefer "unknown time" sentinel only as last resort — callers should pass file mtime
  return new Date().toISOString();
}
