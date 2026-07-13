import { normalizeModelName, num } from "../../util.js";

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
