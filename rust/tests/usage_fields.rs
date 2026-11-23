//! Port of `tests/usage-fields.test.ts`.

use serde_json::{json, Value};
use tokenlab::agents::shared::usage_fields::{
    extract_model, extract_token_buckets, resolve_span_ms, split_requests_over_span, TokenBuckets,
};
use tokenlab::util::js_date_parse;

fn buckets(v: Value) -> Option<TokenBuckets> {
    extract_token_buckets(Some(&v))
}

#[test]
fn extract_token_buckets_reads_anthropic_style_usage() {
    let b = buckets(json!({
        "input_tokens": 10,
        "output_tokens": 5,
        "cache_read_input_tokens": 2,
        "cache_creation_input_tokens": 1,
    }));
    assert_eq!(
        b,
        Some(TokenBuckets {
            input_tokens: 10.0,
            output_tokens: 5.0,
            cache_read_tokens: 2.0,
            cache_write_tokens: 1.0,
            input_includes_cache: None,
            // The row carried cache keys, so the extractor measured cache.
            cache_reported: Some(true),
        })
    );
}

#[test]
fn extract_token_buckets_reads_nested_usage() {
    let b = buckets(json!({ "usage": { "prompt_tokens": 3, "completion_tokens": 4 } })).unwrap();
    assert_eq!(b.input_tokens, 3.0);
    assert_eq!(b.output_tokens, 4.0);
}

#[test]
fn extract_model_prefers_model_id() {
    let v = json!({ "modelId": "grok-4.5" });
    assert_eq!(extract_model(&[Some(&v)]), Some("grok-4.5".to_string()));
}

#[test]
fn cache_reported_distinguishes_a_measured_zero_from_a_silent_cache_field() {
    // A cache key present with value 0 is a MEASUREMENT.
    let measured_zero = buckets(json!({ "input_tokens": 100, "output_tokens": 20, "cached_tokens": 0 })).unwrap();
    assert_eq!(measured_zero.cache_read_tokens, 0.0);
    assert_eq!(measured_zero.cache_reported, Some(true));

    // No cache key at all is SILENCE.
    let silent = buckets(json!({ "input_tokens": 100, "output_tokens": 20 })).unwrap();
    assert_eq!(silent.cache_read_tokens, 0.0);
    assert_eq!(silent.cache_reported, None);

    // A nonzero cache read is reported regardless of the key spelling used.
    let nonzero = buckets(json!({ "input_tokens": 100, "output_tokens": 20, "cache_read_tokens": 60 })).unwrap();
    assert_eq!(nonzero.cache_reported, Some(true));
}

#[test]
fn extract_token_buckets_reads_devin_style_metadata_metrics() {
    let b = buckets(json!({
        "role": "assistant",
        "metadata": {
            "metrics": { "input_tokens": 100, "output_tokens": 20, "cache_read_tokens": 50 }
        }
    }))
    .unwrap();
    assert_eq!(b.input_tokens, 100.0);
    assert_eq!(b.output_tokens, 20.0);
    assert_eq!(b.cache_read_tokens, 50.0);
}

#[test]
fn extract_token_buckets_reads_cached_tokens_and_prompt_tokens_details() {
    let flat = buckets(json!({ "prompt_tokens": 1000, "completion_tokens": 20, "cached_tokens": 800 })).unwrap();
    assert_eq!(flat.cache_read_tokens, 800.0);
    assert_eq!(flat.input_tokens, 1000.0);

    let nested = buckets(json!({
        "usage": {
            "prompt_tokens": 500,
            "completion_tokens": 10,
            "prompt_tokens_details": { "cached_tokens": 400 }
        }
    }))
    .unwrap();
    assert_eq!(nested.input_tokens, 500.0);
    assert_eq!(nested.cache_read_tokens, 400.0);
}

#[test]
fn extract_token_buckets_reads_orca_full_input_cache_fields() {
    let b = buckets(json!({
        "input_tokens": 1_000,
        "cached_input_tokens": 800,
        "cache_write_input_tokens": 50,
        "reasoning_output_tokens": 7,
    }));
    assert_eq!(
        b,
        Some(TokenBuckets {
            input_tokens: 1000.0,
            output_tokens: 7.0,
            cache_read_tokens: 800.0,
            cache_write_tokens: 50.0,
            input_includes_cache: Some(true),
            cache_reported: Some(true),
        })
    );
}

#[test]
fn extract_token_buckets_reads_nested_claude_cache_creation_without_double_counting() {
    let b = buckets(json!({
        "input_tokens": 100,
        "output_tokens": 20,
        "cache_read_input_tokens": 50,
        "cache_creation_input_tokens": 0,
        "cache_creation": {
            "ephemeral_5m_input_tokens": 4,
            "ephemeral_1h_input_tokens": 6,
            "input_tokens": 10,
        },
    }))
    .unwrap();
    assert_eq!(b.cache_write_tokens, 10.0);
    assert_eq!(b.cache_read_tokens, 50.0);
}

#[test]
fn extract_token_buckets_reads_codex_cached_input_tokens_fields() {
    let b = buckets(json!({
        "input_tokens": 1000,
        "cached_input_tokens": 800,
        "cache_write_input_tokens": 120,
        "output_tokens": 25,
    }));
    assert_eq!(
        b,
        Some(TokenBuckets {
            input_tokens: 1000.0,
            output_tokens: 25.0,
            cache_read_tokens: 800.0,
            cache_write_tokens: 120.0,
            input_includes_cache: Some(true),
            cache_reported: Some(true),
        })
    );
}

// --- resolveSpanMs -------------------------------------------------------

fn span(a: Value, b: Value) -> Option<(f64, f64)> {
    resolve_span_ms(Some(&a), Some(&b))
}

#[test]
fn resolve_span_ms_accepts_epoch_seconds_epoch_ms_iso_and_date_in_either_order() {
    let iso = "2026-08-03T16:43:14.076Z";
    let s = 1785775394_i64; // epoch seconds
    let ms = 1785775394076_i64;
    let iso_ms = js_date_parse(iso);
    assert_eq!(span(json!(iso), json!(iso)), Some((iso_ms, iso_ms)));
    assert_eq!(span(json!(s), json!(ms)), Some((1785775394000.0, ms as f64)));
    // `new Date(iso)` is an epoch-ms instant; the JSON-value equivalent is its ms number.
    assert_eq!(span(json!(iso_ms as i64), json!(ms)), Some((iso_ms, ms as f64)));
    // order-insensitive: last, first must normalise to start <= end
    assert_eq!(span(json!(1785866257_i64), json!(1785775394_i64)), Some((1785775394000.0, 1785866257000.0)));
}

#[test]
fn resolve_span_ms_rejects_non_spans_instead_of_inventing_one() {
    assert_eq!(span(Value::Null, json!("2026-08-03T00:00:00.000Z")), None);
    assert_eq!(span(json!(0), json!(1785775394_i64)), None); // 0 is not a real timestamp
    assert_eq!(span(json!("not a date"), json!(1785775394_i64)), None);
    assert_eq!(span(json!(123), json!(456)), None); // tiny numbers are noise, not epochs
}

// --- splitRequestsOverSpan ----------------------------------------------

#[test]
fn split_requests_over_span_preserves_the_total_exactly() {
    let parts = split_requests_over_span(
        3135.0,
        js_date_parse("2026-08-03T16:00:00.000Z"),
        js_date_parse("2026-08-04T17:00:00.000Z"),
    );
    let sum: f64 = parts.iter().map(|p| p.1).sum();
    assert_eq!(sum, 3135.0);
}

#[test]
fn split_requests_over_span_spreads_a_session_so_the_per_minute_rate_is_not_the_session_total() {
    let start = js_date_parse("2026-08-03T16:43:14.000Z");
    let end = js_date_parse("2026-08-04T17:57:37.000Z");
    let parts = split_requests_over_span(3135.0, start, end);
    let peak = parts.iter().map(|p| p.1).fold(f64::MIN, f64::max);
    assert!(peak < 100.0, "peak per minute should be far below the 3135 session total, got {peak}");
    assert!(parts.len() > 1000, "expected one bucket per covered minute, got {}", parts.len());
    let lo = (start / 60000.0).floor() * 60000.0;
    for p in &parts {
        let t = js_date_parse(&p.0);
        assert!(t >= lo && t <= end, "bucket {} escaped the span", p.0);
    }
}

#[test]
fn split_requests_over_span_gives_a_single_minute_for_a_zero_length_span() {
    let t = js_date_parse("2026-08-03T16:43:00.000Z");
    let parts = split_requests_over_span(7.0, t, t);
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].1, 7.0);
    assert_eq!(Some(parts[0].0.clone()), tokenlab::util::to_iso_string(t));
}

#[test]
fn split_requests_over_span_never_emits_a_zero_request_minute() {
    // More minutes than requests: trailing minutes must be omitted, not emitted with 0.
    let start = js_date_parse("2026-08-03T00:00:00.000Z");
    let end = js_date_parse("2026-08-03T02:00:00.000Z"); // 121 minutes
    let parts = split_requests_over_span(3.0, start, end);
    assert_eq!(parts.len(), 3);
    assert_eq!(parts.iter().map(|p| p.1).collect::<Vec<_>>(), vec![1.0, 1.0, 1.0]);
    assert_eq!(parts.iter().map(|p| p.1).sum::<f64>(), 3.0);
}

#[test]
fn split_requests_over_span_clamps_a_non_positive_request_count_to_one() {
    let t = js_date_parse("2026-08-03T00:00:00.000Z");
    let parts = split_requests_over_span(0.0, t, t);
    assert_eq!(parts.iter().map(|p| p.1).sum::<f64>(), 1.0);
}
