import { num } from "../util.js";

export interface TokenBuckets {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Extract token buckets from heterogeneous vendor usage objects. */
export function extractTokenBuckets(usage: unknown): TokenBuckets | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;

  // Nested shapes: { usage: {...} }, { token_usage: {...} }, { tokens: {...} }
  const nested =
    (u.usage && typeof u.usage === "object" ? (u.usage as Record<string, unknown>) : null) ||
    (u.token_usage && typeof u.token_usage === "object" ? (u.token_usage as Record<string, unknown>) : null) ||
    (u.tokenUsage && typeof u.tokenUsage === "object" ? (u.tokenUsage as Record<string, unknown>) : null) ||
    (u.tokens && typeof u.tokens === "object" ? (u.tokens as Record<string, unknown>) : null) ||
    (u.token_count && typeof u.token_count === "object" ? (u.token_count as Record<string, unknown>) : null) ||
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
  const outputTokens = num(
    nested.output_tokens ??
      nested.outputTokens ??
      nested.completion_tokens ??
      nested.completionTokens ??
      nested.candidatesTokenCount ??
      nested.output ??
      nested.total_output_tokens ??
      nested.completion,
  );
  const cacheReadTokens = num(
    nested.cache_read_input_tokens ??
      nested.cache_read_tokens ??
      nested.cacheReadTokens ??
      nested.cache_read ??
      nested.cached_content_token_count ??
      nested.cached ??
      nested.input_cache_read ??
      nested.total_cache_read_tokens,
  );
  const cacheWriteTokens = num(
    nested.cache_creation_input_tokens ??
      nested.cache_write_tokens ??
      nested.cacheWriteTokens ??
      nested.cache_write ??
      nested.input_cache_creation ??
      nested.total_cache_write_tokens,
  );

  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0) return null;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

export function extractModel(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      if (typeof o.model === "string" && o.model.trim()) return o.model.trim();
      if (typeof o.modelId === "string" && o.modelId.trim()) return o.modelId.trim();
      if (typeof o.model_id === "string" && o.model_id.trim()) return o.model_id.trim();
      if (typeof o.model_name === "string" && o.model_name.trim()) return o.model_name.trim();
      if (o.message && typeof o.message === "object") {
        const m = o.message as Record<string, unknown>;
        if (typeof m.model === "string" && m.model.trim()) return m.model.trim();
      }
    }
  }
  return null;
}

export function extractTimestamp(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() && !Number.isNaN(Date.parse(c))) return new Date(c).toISOString();
    if (typeof c === "number" && Number.isFinite(c)) {
      const ms = c > 1e12 ? c : c * 1000;
      return new Date(ms).toISOString();
    }
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      for (const k of ["timestamp", "ts", "created_at", "createdAt", "started_at", "time", "date"]) {
        const v = o[k];
        if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
        if (typeof v === "number" && Number.isFinite(v)) {
          const ms = v > 1e12 ? v : v * 1000;
          return new Date(ms).toISOString();
        }
      }
      if (o.time && typeof o.time === "object") {
        const t = o.time as Record<string, unknown>;
        if (typeof t.created === "string") return new Date(t.created).toISOString();
      }
    }
  }
  return new Date().toISOString();
}
