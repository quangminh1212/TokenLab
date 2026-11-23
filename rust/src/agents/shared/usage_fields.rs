//! Port of `src/agents/shared/usage-fields.ts`.
//!
//! Token-field extraction rules shared by many parsers, plus the span-splitting
//! helpers used to spread an aggregate row across the minutes it covered.
//!
//! All "unknown" JS inputs are modelled as `Option<&serde_json::Value>`: `None`
//! is JS `undefined`, `Some(Value::Null)` is JS `null`.

use crate::config::get_config_sync;
use crate::util::{
    js_date_parse, js_number_from_str, js_round, js_trim, normalize_model_name, now_ms, num,
    parse_timestamp_in_zone, to_iso_string,
};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct TokenBuckets {
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_write_tokens: f64,
    /// Some providers report prompt/input as a full value that already includes cache reads.
    pub input_includes_cache: Option<bool>,
    /// True when the source usage object actually carried a cache field (read or
    /// write), even when its value is 0. Distinct from `cache_read_tokens > 0`.
    pub cache_reported: Option<bool>,
}

// ---------------------------------------------------------------------------
// JS-ish value helpers
// ---------------------------------------------------------------------------

/// `typeof v === "object" && v` (objects and arrays; not null).
fn is_object_like(v: &Value) -> bool {
    matches!(v, Value::Object(_) | Value::Array(_))
}

/// `obj[key]` with `undefined` and `null` both mapped to `None` (what `??` skips).
/// Property reads on arrays / primitives yield `None` like a missing key.
fn g<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match v {
        Some(Value::Object(m)) => match m.get(key) {
            Some(Value::Null) | None => None,
            Some(x) => Some(x),
        },
        _ => None,
    }
}

/// `obj[key]` kept only when it is a non-null object-like value
/// (`obj[key] && typeof obj[key] === "object"`).
fn obj_at<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match v {
        Some(Value::Object(m)) => match m.get(key) {
            Some(x) if is_object_like(x) => Some(x),
            _ => None,
        },
        _ => None,
    }
}

/// `num(a ?? b ?? c ...)` over already-looked-up optionals.
fn first_num(candidates: &[Option<&Value>]) -> f64 {
    for c in candidates {
        if let Some(v) = c {
            return num(v);
        }
    }
    0.0
}

/// Exact key lookup of a list of aliases on one object, `??`-chained, then `num`.
fn num_keys(obj: Option<&Value>, keys: &[&str]) -> f64 {
    for k in keys {
        if let Some(v) = g(obj, k) {
            return num(v);
        }
    }
    0.0
}

/// `/cach/i.test(key)` over the keys of `obj`.
fn has_cache_field(obj: Option<&Value>) -> bool {
    match obj {
        Some(Value::Object(m)) => m.keys().any(|k| k.to_lowercase().contains("cach")),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// extractTokenBuckets
// ---------------------------------------------------------------------------

/// Extract token buckets from heterogeneous vendor usage objects.
pub fn extract_token_buckets(usage: Option<&Value>) -> Option<TokenBuckets> {
    let usage = usage?;
    if !is_object_like(usage) {
        return None;
    }
    let u = Some(usage);

    // Nested shapes: usage / token_usage / metrics (Devin) / metadata.metrics
    let meta = obj_at(u, "metadata");
    let nested_v: &Value = obj_at(u, "usage")
        .or_else(|| obj_at(u, "token_usage"))
        .or_else(|| obj_at(u, "tokenUsage"))
        .or_else(|| obj_at(u, "tokens"))
        .or_else(|| obj_at(u, "token_count"))
        .or_else(|| obj_at(u, "metrics"))
        .or_else(|| obj_at(meta, "metrics"))
        .unwrap_or(usage);
    let nested = Some(nested_v);

    let input_tokens = num_keys(
        nested,
        &[
            "input_tokens",
            "inputTokens",
            "prompt_tokens",
            "promptTokens",
            "prompt_token_count",
            "input",
            "total_input_tokens",
            "input_other",
        ],
    );
    let explicit_output_tokens = num_keys(
        nested,
        &[
            "output_tokens",
            "outputTokens",
            "completion_tokens",
            "completionTokens",
            "candidatesTokenCount",
            "output",
            "total_output_tokens",
            "completion",
        ],
    );
    // Codex/Orca can emit reasoning_output_tokens alongside (or instead of)
    // output_tokens. In the normal shape reasoning is already included in
    // output_tokens, so only use it as a fallback when output is absent/zero.
    let reasoning_output_tokens = num_keys(
        nested,
        &[
            "reasoning_output_tokens",
            "reasoningOutputTokens",
            "reasoning_tokens",
            "reasoningTokens",
        ],
    );
    let output_tokens = if explicit_output_tokens > 0.0 { explicit_output_tokens } else { reasoning_output_tokens };

    // Nested OpenAI / LiteLLM shapes: prompt_tokens_details.cached_tokens
    let prompt_details = obj_at(nested, "prompt_tokens_details")
        .or_else(|| obj_at(nested, "promptTokensDetails"))
        .or_else(|| obj_at(nested, "input_tokens_details"));
    let pd = prompt_details;

    // Anthropic/Claude Code 2.x can expose cache creation as a nested
    // breakdown while retaining the flat cache_creation_input_tokens field.
    let cache_creation_details = obj_at(nested, "cache_creation");
    let ccd = cache_creation_details;
    let ephemeral_cache_creation_tokens = first_num(&[g(ccd, "ephemeral_5m_input_tokens")])
        + first_num(&[g(ccd, "ephemeral_1h_input_tokens")]);
    let cache_creation_detail_tokens = if ephemeral_cache_creation_tokens > 0.0 {
        ephemeral_cache_creation_tokens
    } else {
        num_keys(ccd, &["input_tokens", "tokens"])
    };

    let cache_read_details = obj_at(nested, "cache_read");
    let crd = cache_read_details;

    // Order matches the TS `??` chain exactly (including its repeated aliases).
    let cache_read_tokens = first_num(&[
        g(nested, "cached_input_tokens"),
        g(nested, "cachedInputTokens"),
        g(nested, "cache_read_input_tokens"),
        g(nested, "cache_read_tokens"),
        g(nested, "cacheReadTokens"),
        g(nested, "cached_input_tokens"),
        g(nested, "cachedInputTokens"),
        g(nested, "cachedReadTokens"),
        g(nested, "cacheReadInputTokens"),
        g(nested, "cache_read"),
        g(nested, "cached_tokens"),
        g(nested, "cachedTokens"),
        g(nested, "cached_content_token_count"),
        g(nested, "cachedContentTokenCount"),
        g(nested, "cached"),
        g(nested, "input_cache_read"),
        g(nested, "total_cache_read_tokens"),
        g(pd, "cached_tokens"),
        g(pd, "cache_read_tokens"),
        g(pd, "cachedTokens"),
        g(pd, "cache_read_input_tokens"),
        g(pd, "cached_input_tokens"),
        g(pd, "cachedInputTokens"),
    ]);
    let flat_cache_write_tokens = first_num(&[
        g(nested, "cache_write_input_tokens"),
        g(nested, "cacheWriteInputTokens"),
        g(nested, "cache_creation_input_tokens"),
        g(nested, "cacheCreationInputTokens"),
        g(nested, "cache_creation_tokens"),
        g(nested, "cacheCreationTokens"),
        g(nested, "cache_write_tokens"),
        g(nested, "cacheWriteInputTokens"),
        g(nested, "cacheWriteTokens"),
        g(nested, "cache_write"),
        g(nested, "cachedWriteTokens"),
        g(nested, "input_cache_creation"),
        g(nested, "total_cache_write_tokens"),
        g(pd, "cache_write_tokens"),
        g(pd, "cache_creation_input_tokens"),
        g(pd, "cache_write_input_tokens"),
        g(pd, "cacheWriteInputTokens"),
    ]);
    let cache_write_tokens =
        if flat_cache_write_tokens > 0.0 { flat_cache_write_tokens } else { cache_creation_detail_tokens };

    // A few OpenAI-compatible proxies put cache reads under a details object.
    // Use it only when no flat alias was present so aliases are never summed.
    let cache_read_with_details = if cache_read_tokens > 0.0 {
        cache_read_tokens
    } else {
        first_num(&[g(crd, "input_tokens"), g(crd, "cached_tokens"), g(crd, "tokens")])
    };

    if input_tokens + output_tokens + cache_read_with_details + cache_write_tokens <= 0.0 {
        return None;
    }
    let input_includes_cache = g(nested, "cached_input_tokens").is_some()
        || g(nested, "cachedInputTokens").is_some()
        || g(nested, "cached_content_token_count").is_some()
        || g(nested, "cachedContentTokenCount").is_some()
        || g(pd, "cached_tokens").is_some()
        || g(pd, "cachedTokens").is_some()
        || g(pd, "cached_input_tokens").is_some()
        || g(pd, "cachedInputTokens").is_some()
        || cache_read_details.is_some();
    // Presence, not magnitude: a source that emitted a cache key (even 0) or whose
    // read landed under a details object is a measurement of cache.
    let cache_reported = has_cache_field(nested)
        || has_cache_field(prompt_details)
        || has_cache_field(cache_read_details)
        || has_cache_field(cache_creation_details)
        || cache_read_with_details > 0.0
        || cache_write_tokens > 0.0;
    Some(TokenBuckets {
        input_tokens,
        output_tokens,
        cache_read_tokens: cache_read_with_details,
        cache_write_tokens,
        input_includes_cache: if input_includes_cache { Some(true) } else { None },
        cache_reported: if cache_reported { Some(true) } else { None },
    })
}

// ---------------------------------------------------------------------------
// extractModel
// ---------------------------------------------------------------------------

const MODEL_KEYS: [&str; 9] = [
    "model_group",
    "modelGroup",
    "displayModel",
    "display_model",
    "model",
    "modelId",
    "model_id",
    "model_name",
    "rawModel",
];

fn nonblank_str(v: Option<&Value>) -> Option<&str> {
    match v {
        Some(Value::String(s)) if !js_trim(s).is_empty() => Some(s.as_str()),
        _ => None,
    }
}

/// First candidate that yields a normalized model name. Candidates are strings
/// (used directly) or objects (probed for the gateway/model keys, then
/// `message.model`).
pub fn extract_model(candidates: &[Option<&Value>]) -> Option<String> {
    for c in candidates {
        let c = match c {
            Some(v) => *v,
            None => continue,
        };
        if let Value::String(s) = c {
            if !js_trim(s).is_empty() {
                if let Some(n) = normalize_model_name(Some(s.as_str())) {
                    if !n.is_empty() {
                        return Some(n);
                    }
                }
            }
        }
        if let Value::Object(o) = c {
            // Gateways such as LiteLLM expose the public model group separately
            // from the provider-native model path. Prefer that public identity.
            for key in MODEL_KEYS {
                if let Some(s) = nonblank_str(o.get(key)) {
                    if let Some(n) = normalize_model_name(Some(s)) {
                        if !n.is_empty() {
                            return Some(n);
                        }
                    }
                }
            }
            if let Some(Value::Object(m)) = o.get("message") {
                if let Some(s) = nonblank_str(m.get("model")) {
                    if let Some(n) = normalize_model_name(Some(s)) {
                        if !n.is_empty() {
                            return Some(n);
                        }
                    }
                }
            }
        }
    }
    None
}

/// `extractModel` for plain string candidates (e.g. a model name pulled out by the caller).
pub fn extract_model_strs(candidates: &[Option<&str>]) -> Option<String> {
    for c in candidates.iter().flatten() {
        if !js_trim(c).is_empty() {
            if let Some(n) = normalize_model_name(Some(*c)) {
                if !n.is_empty() {
                    return Some(n);
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/// Timestamp keys probed on object candidates, in priority order.
const TIMESTAMP_KEYS: [&str; 11] = [
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
];

/// `n > 1e12 ? n : n > 1e9 ? n * 1000 : NaN`, rejecting `< 1e11` and non-finite.
fn to_epoch_ms(n: f64) -> Option<f64> {
    let ms = if n > 1e12 {
        n
    } else if n > 1e9 {
        n * 1000.0
    } else {
        f64::NAN
    };
    if !ms.is_finite() || ms < 1e11 {
        return None;
    }
    Some(ms)
}

/// Resolve a `[startMs, endMs]` span from loosely-typed candidates.
///
/// Returns `None` unless BOTH ends parse to finite epoch ms. Ordering is not
/// assumed: the pair is normalised so `start <= end`.
pub fn resolve_span_ms(a: Option<&Value>, b: Option<&Value>) -> Option<(f64, f64)> {
    fn one(v: Option<&Value>) -> Option<f64> {
        match v {
            Some(Value::String(s)) if !js_trim(s).is_empty() => {
                let ms = js_date_parse(s);
                if ms.is_finite() {
                    return Some(ms);
                }
                // numeric string epoch
                let n = js_number_from_str(s);
                if n.is_finite() && n > 0.0 {
                    to_epoch_ms(n)
                } else {
                    None
                }
            }
            Some(Value::Number(n)) => {
                let f = n.as_f64()?;
                if f.is_finite() && f > 0.0 {
                    to_epoch_ms(f)
                } else {
                    None
                }
            }
            _ => None,
        }
    }
    let x = one(a)?;
    let y = one(b)?;
    Some((x.min(y), x.max(y)))
}

/// One minute-bucket of a split span.
#[derive(Debug, Clone, PartialEq)]
pub struct SpanWeight {
    pub timestamp: String,
    pub weight: f64,
    pub request_count: f64,
}

/// `Math.max(a, b)` with JS NaN propagation.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// Split a span into per-minute buckets, returning each bucket's timestamp plus
/// its share of the span as an exact fraction (all weights sum to exactly 1).
///
/// Equal across buckets except that any remainder is front-loaded in whole-request
/// units via `requests`, so the request total is preserved with no fractional calls.
pub fn split_span_weights(requests: f64, start_ms: f64, end_ms: f64) -> Vec<SpanWeight> {
    let total = js_max(1.0, requests.floor());
    let start_minute = (start_ms / 60_000.0).floor() * 60_000.0;
    let end_minute = (end_ms / 60_000.0).floor() * 60_000.0;
    let minute_count = js_max(1.0, ((end_minute - start_minute) / 60_000.0).floor() + 1.0);

    // Distribute whole requests first; `minute_count` can exceed `total`, in which
    // case only the leading `total` minutes receive a request.
    let base = (total / minute_count).floor();
    let mut remainder = total - base * minute_count;

    let mut counts: Vec<f64> = Vec::new();
    let mut i = 0.0_f64;
    while i < minute_count {
        let mut count = base;
        if remainder > 0.0 {
            count += 1.0;
            remainder -= 1.0;
        }
        counts.push(count);
        i += 1.0;
    }

    let mut out = Vec::new();
    for (i, count) in counts.iter().enumerate() {
        let count = *count;
        // A minute with 0 requests carries no usage - skip it entirely.
        if count <= 0.0 {
            continue;
        }
        out.push(SpanWeight {
            timestamp: to_iso_string(start_minute + (i as f64) * 60_000.0).unwrap_or_default(),
            // Share of the session's requests, used to apportion tokens and cost too.
            weight: count / total,
            request_count: count,
        });
    }
    out
}

/// Split `requests` across the minutes of `[start_ms, end_ms]`, returning only
/// `(timestamp, requestCount)`.
pub fn split_requests_over_span(requests: f64, start_ms: f64, end_ms: f64) -> Vec<(String, f64)> {
    split_span_weights(requests, start_ms, end_ms)
        .into_iter()
        .map(|b| (b.timestamp, b.request_count))
        .collect()
}

/// Apportion an additive quantity across split buckets without losing the total.
///
/// Rounds each share down to an integer, then distributes whatever is left over
/// one unit at a time (largest fraction first) so the parts always sum back to
/// `total`.
pub fn apportion(total: f64, weights: &[f64]) -> Vec<f64> {
    if weights.is_empty() {
        return Vec::new();
    }
    let t = if total.is_finite() { total } else { 0.0 };
    let sum: f64 = weights.iter().fold(0.0, |a, b| a + b);
    if !(sum > 0.0) {
        return weights.iter().map(|_| 0.0).collect();
    }

    let raw: Vec<f64> = weights.iter().map(|w| (t * w) / sum).collect();
    let mut out: Vec<f64> = raw.iter().map(|v| v.floor()).collect();
    let assigned: f64 = out.iter().fold(0.0, |a, b| a + b);
    let mut diff = js_round(t) - assigned;

    // Hand out the remainder one unit at a time, largest-fraction first.
    let mut order: Vec<(usize, f64)> = raw.iter().enumerate().map(|(i, v)| (i, v - v.floor())).collect();
    // Stable sort, descending by fraction (`b.frac - a.frac`).
    order.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let len = order.len() as i64;
    let mut k: i64 = 0;
    while diff > 0.0 && len > 0 {
        out[order[(k % len) as usize].0] += 1.0;
        diff -= 1.0;
        k += 1;
    }
    k = len - 1;
    while diff < 0.0 && len > 0 {
        let r = k % len;
        if r < 0 {
            // JS would read `order[negative]` (undefined) and throw; unreachable
            // for integer totals, stop instead of panicking.
            break;
        }
        let idx = order[r as usize].0;
        if out[idx] > 0.0 {
            out[idx] -= 1.0;
            diff += 1.0;
        }
        k -= 1;
        if k < -len {
            break;
        }
    }
    out
}

/// Apportion a float quantity (cost) across weights, keeping the exact total.
/// Unlike [`apportion`] this does not force integers.
pub fn apportion_float(total: f64, weights: &[f64]) -> Vec<f64> {
    if weights.is_empty() {
        return Vec::new();
    }
    let t = if total.is_finite() { total } else { 0.0 };
    let sum: f64 = weights.iter().fold(0.0, |a, b| a + b);
    if !(sum > 0.0) {
        return weights.iter().map(|_| 0.0).collect();
    }
    let mut out: Vec<f64> = weights.iter().map(|w| (t * w) / sum).collect();
    // Correct accumulated float error on the first bucket so the sum is exact.
    let drift = t - out.iter().fold(0.0, |a, b| a + b);
    if !out.is_empty() {
        out[0] += drift;
    }
    out
}

/// Token/cost fields that must be apportioned, never copied, when splitting.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SplittableUsage {
    pub request_count: Option<f64>,
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub cache_read_tokens: Option<f64>,
    pub cache_write_tokens: Option<f64>,
    pub total_tokens: Option<f64>,
    pub reasoning_tokens: Option<f64>,
    pub estimated_cost: Option<f64>,
}

/// One per-minute piece of a split usage row.
#[derive(Debug, Clone, PartialEq)]
pub struct SplitPiece {
    pub timestamp: String,
    pub request_count: f64,
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_write_tokens: f64,
    pub total_tokens: f64,
    pub reasoning_tokens: Option<f64>,
    pub estimated_cost: Option<f64>,
}

/// Split one aggregate usage row across the minutes it actually covered.
///
/// Every additive field is APPORTIONED by each bucket's share of the requests,
/// never copied. The parts sum back to the original totals.
pub fn split_usage_row(row: &SplittableUsage, requests: f64, start_ms: f64, end_ms: f64) -> Vec<SplitPiece> {
    let buckets = split_span_weights(requests, start_ms, end_ms);
    if buckets.is_empty() {
        return Vec::new();
    }
    let weights: Vec<f64> = buckets.iter().map(|b| b.weight).collect();

    let in_parts = apportion(row.input_tokens.unwrap_or(0.0), &weights);
    let out_parts = apportion(row.output_tokens.unwrap_or(0.0), &weights);
    let cr_parts = apportion(row.cache_read_tokens.unwrap_or(0.0), &weights);
    let cw_parts = apportion(row.cache_write_tokens.unwrap_or(0.0), &weights);
    let reason_parts = row.reasoning_tokens.map(|r| apportion(r, &weights));
    let cost_parts = row.estimated_cost.map(|c| apportion_float(c, &weights));

    buckets
        .iter()
        .enumerate()
        .map(|(i, bucket)| {
            let input_tokens = in_parts.get(i).copied().unwrap_or(0.0);
            let output_tokens = out_parts.get(i).copied().unwrap_or(0.0);
            let cache_read_tokens = cr_parts.get(i).copied().unwrap_or(0.0);
            let cache_write_tokens = cw_parts.get(i).copied().unwrap_or(0.0);
            SplitPiece {
                timestamp: bucket.timestamp.clone(),
                request_count: bucket.request_count,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
                // Recompute the total so it always matches the apportioned parts.
                total_tokens: input_tokens + output_tokens + cache_read_tokens + cache_write_tokens,
                reasoning_tokens: reason_parts.as_ref().map(|p| p.get(i).copied().unwrap_or(0.0)),
                estimated_cost: cost_parts.as_ref().map(|p| p.get(i).copied().unwrap_or(0.0)),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// extractTimestamp
// ---------------------------------------------------------------------------

/// Resolve the first usable timestamp (ISO string) from loosely-typed candidates.
/// Falls back to "now" when nothing parses - callers should pass file mtime.
pub fn extract_timestamp(candidates: &[Option<&Value>]) -> String {
    let zone = get_config_sync().timezone.clone();
    let stamp = |raw: &str| -> Option<String> {
        let ms = parse_timestamp_in_zone(raw, zone.as_deref());
        if ms.is_nan() {
            None
        } else {
            to_iso_string(ms)
        }
    };
    for c in candidates {
        let c = match c {
            Some(v) => *v,
            None => continue,
        };
        match c {
            Value::String(s) => {
                if !js_trim(s).is_empty() {
                    if let Some(iso) = stamp(s) {
                        return iso;
                    }
                }
            }
            Value::Number(n) => {
                if let Some(f) = n.as_f64() {
                    if f.is_finite() {
                        // epoch ms / sec, or treat small integers as invalid for time
                        if f <= 0.0 {
                            continue;
                        }
                        let ms = if f > 1e12 {
                            f
                        } else if f > 1e9 {
                            f * 1000.0
                        } else {
                            f
                        };
                        if ms < 1e11 {
                            continue; // reject non-epoch noise
                        }
                        if let Some(iso) = to_iso_string(ms) {
                            return iso;
                        }
                    }
                }
            }
            Value::Object(o) => {
                for k in TIMESTAMP_KEYS {
                    match o.get(k) {
                        Some(Value::String(s)) => {
                            if let Some(iso) = stamp(s) {
                                return iso;
                            }
                        }
                        Some(Value::Number(n)) => {
                            if let Some(v) = n.as_f64() {
                                if v.is_finite() && v > 0.0 {
                                    let ms = if v > 1e12 {
                                        v
                                    } else if v > 1e9 {
                                        v * 1000.0
                                    } else {
                                        f64::NAN
                                    };
                                    if ms.is_finite() {
                                        if let Some(iso) = to_iso_string(ms) {
                                            return iso;
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
                if let Some(Value::Object(t)) = o.get("time") {
                    if let Some(Value::String(s)) = t.get("created") {
                        if let Some(iso) = stamp(s) {
                            return iso;
                        }
                    }
                }
            }
            _ => {}
        }
    }
    // Prefer "unknown time" sentinel only as last resort - callers should pass file mtime
    to_iso_string(now_ms()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn openai_shape_with_cached() {
        let u = json!({"prompt_tokens": 100, "completion_tokens": 20,
            "prompt_tokens_details": {"cached_tokens": 40}});
        let b = extract_token_buckets(Some(&u)).unwrap();
        assert_eq!(b.input_tokens, 100.0);
        assert_eq!(b.output_tokens, 20.0);
        assert_eq!(b.cache_read_tokens, 40.0);
        assert_eq!(b.input_includes_cache, Some(true));
        assert_eq!(b.cache_reported, Some(true));
    }

    #[test]
    fn anthropic_ephemeral_breakdown_and_nesting() {
        let u = json!({"message": {"x": 1}, "usage": {"input_tokens": 5, "output_tokens": 0,
            "reasoning_tokens": 7,
            "cache_creation": {"ephemeral_5m_input_tokens": 3, "ephemeral_1h_input_tokens": 4}}});
        let b = extract_token_buckets(Some(&u)).unwrap();
        assert_eq!(b.output_tokens, 7.0);
        assert_eq!(b.cache_write_tokens, 7.0);
        assert_eq!(b.input_includes_cache, None);
        assert_eq!(b.cache_reported, Some(true));
    }

    #[test]
    fn zero_cache_key_is_reported_but_empty_is_none() {
        let u = json!({"input_tokens": 1, "cache_read_input_tokens": 0});
        let b = extract_token_buckets(Some(&u)).unwrap();
        assert_eq!(b.cache_reported, Some(true));
        let u = json!({"input_tokens": 1});
        assert_eq!(extract_token_buckets(Some(&u)).unwrap().cache_reported, None);
        assert!(extract_token_buckets(Some(&json!({"input_tokens": 0}))).is_none());
        assert!(extract_token_buckets(Some(&json!([1, 2]))).is_none());
        assert!(extract_token_buckets(Some(&json!("x"))).is_none());
    }

    #[test]
    fn null_alias_falls_through() {
        let u = json!({"input_tokens": null, "inputTokens": 9});
        assert_eq!(extract_token_buckets(Some(&u)).unwrap().input_tokens, 9.0);
    }

    #[test]
    fn model_group_preferred() {
        let r = json!({"model": "openai/openclaw", "model_group": "glm-5.3"});
        assert_eq!(extract_model(&[Some(&r)]).as_deref(), Some("glm-5.3"));
    }

    #[test]
    fn timestamp_forms() {
        let r = json!({"ts": 1_700_000_000});
        assert_eq!(extract_timestamp(&[Some(&r)]), "2023-11-14T22:13:20.000Z");
        let r = json!({"timestamp": "2024-01-02T03:04:05Z"});
        assert_eq!(extract_timestamp(&[Some(&r)]), "2024-01-02T03:04:05.000Z");
        let r = json!({"time": {"created": "2024-01-02T03:04:05Z"}});
        assert_eq!(extract_timestamp(&[Some(&r)]), "2024-01-02T03:04:05.000Z");
    }

    #[test]
    fn span_split_preserves_totals() {
        let (s, e) = resolve_span_ms(Some(&json!(1_700_000_000_000_u64)), Some(&json!(1_700_000_000_000_u64 + 5 * 60_000)))
            .unwrap();
        let row = SplittableUsage {
            input_tokens: Some(1200.0),
            output_tokens: Some(7.0),
            estimated_cost: Some(0.3),
            ..Default::default()
        };
        let parts = split_usage_row(&row, 3.0, s, e);
        assert_eq!(parts.len(), 3);
        assert_eq!(parts.iter().map(|p| p.request_count).sum::<f64>(), 3.0);
        assert_eq!(parts.iter().map(|p| p.input_tokens).sum::<f64>(), 1200.0);
        assert_eq!(parts.iter().map(|p| p.output_tokens).sum::<f64>(), 7.0);
        assert!((parts.iter().map(|p| p.estimated_cost.unwrap()).sum::<f64>() - 0.3).abs() < 1e-12);
    }

    #[test]
    fn apportion_sums() {
        let w = [1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0];
        let p = apportion(10.0, &w);
        assert_eq!(p.iter().sum::<f64>(), 10.0);
        assert_eq!(apportion(5.0, &[]), Vec::<f64>::new());
    }
}
