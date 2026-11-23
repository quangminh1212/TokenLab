//! Port of `tests/openrouter-models.test.ts`.

use serde_json::json;
use tokenlab::openrouter_models::{open_router_lookup_candidates, per_token_to_per_1m};

fn p(v: &str) -> f64 {
    per_token_to_per_1m(Some(&json!(v)))
}

#[test]
fn converts_per_token_usd_to_per_1m() {
    assert_eq!(p("0.000001"), 1.0);
    assert_eq!(p("0.000006"), 6.0);
    assert_eq!(p("0"), 0.0);
    assert_eq!(p("-1"), 0.0);
}

#[test]
fn handles_cache_read_scale() {
    // 0.0000001 per token -> $0.1 / 1M
    assert_eq!(p("0.0000001"), 0.1);
}

fn has(list: &[String], s: &str) -> bool {
    list.iter().any(|x| x == s)
}

#[test]
fn expands_antigravity_gemini_tier_aliases() {
    let high = open_router_lookup_candidates("gemini-3.6-flash-high");
    assert!(has(&high, "gemini-3.6-flash-high"));
    assert!(has(&high, "gemini-3.6-flash"));
    assert!(has(&high, "google/gemini-3.6-flash"));

    let tiered = open_router_lookup_candidates("gemini-3.6-flash-tiered");
    assert!(has(&tiered, "gemini-3.6-flash"));

    let pro_low = open_router_lookup_candidates("gemini-3.1-pro-low");
    assert!(has(&pro_low, "gemini-3.1-pro"));
    assert!(has(&pro_low, "gemini-3.1-pro-preview"));
    assert!(has(&pro_low, "google/gemini-3.1-pro-preview"));

    let lite = open_router_lookup_candidates("gemini-3.1-flash-lite");
    assert!(has(&lite, "gemini-3.1-flash-lite"));
    assert!(has(&lite, "google/gemini-3.1-flash-lite"));
}
