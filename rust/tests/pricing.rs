//! Port of `tests/pricing.test.ts` (everything except the OpenRouter-catalog
//! test, which lives in `pricing_openrouter.rs` because it needs its own
//! process-wide data dir).

use tokenlab::pricing::*;
use tokenlab::types::{AgentId, PricingStatus, UsageEvent};

fn price(model: &str, i: f64, o: f64, cr: f64, cw: f64) -> PricedTokens {
    price_tokens(Some(model), i, o, cr, cw, "USD")
}

#[test]
fn resolve_model_key_maps_claude_sonnet_aliases() {
    assert_eq!(resolve_model_key(Some("claude-sonnet-4-20250514")).as_deref(), Some("claude-sonnet-4"));
    assert_eq!(resolve_model_key(Some("grok-4.5")).as_deref(), Some("grok-4.5"));
}

#[test]
fn price_tokens_computes_positive_cost() {
    let r = price("claude-sonnet-4", 1_000_000.0, 0.0, 0.0, 0.0);
    assert_eq!(r.pricing_status, PricingStatus::Priced);
    assert!(r.estimated_cost > 0.0);
    assert_eq!(r.estimated_cost, 3.0);
}

#[test]
fn price_cost_parts_uses_cheaper_cache_read_rate_not_input_rate() {
    // claude-sonnet-4: in $3, out $15, cache read $0.3, cache write $3.75 per 1M
    let p = price_cost_parts(Some("claude-sonnet-4"), 1_000_000.0, 0.0, 1_000_000.0, 0.0, None);
    assert_eq!(p.input_cost, 3.0);
    assert_eq!(p.cache_cost, 0.3);
    assert_eq!(p.output_cost, 0.0);
    assert_eq!(p.table_total, 3.3);
    // Token-share would give cache half of total ($1.65): must NOT match that.
    assert!((p.cache_cost - 1.65).abs() > 0.5);
}

#[test]
fn price_cost_parts_scales_to_router_actual_total_keeping_rate_ratios() {
    let p = price_cost_parts(Some("claude-sonnet-4"), 1_000_000.0, 0.0, 1_000_000.0, 0.0, Some(6.6));
    assert!((p.input_cost - 6.0).abs() < 1e-9);
    assert!((p.cache_cost - 0.6).abs() < 1e-9);
}

#[test]
fn unknown_model_falls_back_to_default_rates() {
    let r = price("totally-unknown-model-xyz", 1_000_000.0, 0.0, 0.0, 0.0);
    assert_eq!(r.pricing_status, PricingStatus::UnknownModel);
    assert!(r.estimated_cost > 0.0);
}

#[test]
fn grok_4_5_uses_official_short_cache_030_and_2x_long_context_over_200k() {
    // Short: uncached 20k @ $2 + out 2k @ $6 + cache 80k @ $0.30
    let short = price("grok-4.5", 20_000.0, 2_000.0, 80_000.0, 0.0);
    let want = (20_000.0 * 2.0 + 2_000.0 * 6.0 + 80_000.0 * 0.3) / 1e6;
    assert!((short.estimated_cost - want).abs() < 1e-12);

    // Long: prompt 250k (50k uncached + 200k cache) -> 2x rates
    let long = price("grok-4.5", 50_000.0, 1_000.0, 200_000.0, 0.0);
    let expected = (50_000.0 * 4.0 + 1_000.0 * 12.0 + 200_000.0 * 0.6) / 1e6;
    assert!((long.estimated_cost - expected).abs() < 1e-12);
}

#[test]
fn router_models_resolve_with_or_rates() {
    let key = |m: &str| resolve_model_key(Some(m));
    assert_eq!(key("qwen3-coder-next").as_deref(), Some("qwen3-coder-next"));
    assert_eq!(key("qwen/qwen3-coder-next").as_deref(), Some("qwen3-coder-next"));
    assert_eq!(key("step-3.7-flash").as_deref(), Some("step-3.7-flash"));
    assert_eq!(key("stepfun/step-3.7-flash").as_deref(), Some("step-3.7-flash"));
    assert_eq!(key("laguna-s-2.1").as_deref(), Some("laguna-s-2.1"));
    assert_eq!(key("poolside/laguna-s-2.1").as_deref(), Some("laguna-s-2.1"));
    assert_eq!(key("minimax-m2.7").as_deref(), Some("minimax-m2.7"));
    assert_eq!(key("deepseek-v4-flash").as_deref(), Some("deepseek-v4-flash"));

    // 1M in + 1M out at bundled rates
    let cost = |m: &str| price(m, 1_000_000.0, 1_000_000.0, 0.0, 0.0).estimated_cost;
    assert_eq!(cost("qwen3-coder-next"), 0.18 + 0.9);
    assert_eq!(cost("step-3.7-flash"), 0.2 + 1.15);
    assert_eq!(cost("laguna-s-2.1"), 0.1 + 0.2);
    assert_eq!(cost("minimax-m3"), 0.3 + 1.2);
    assert_eq!(cost("deepseek-v4-flash"), 0.14 + 0.28);
}

/// A priced row priced from the bundled table, used as the reprice input shape.
/// `router_cost` mirrors the `routerCost` field passed to `applyPricing`.
fn priced(cost_parity_gap: Option<bool>, router_cost: Option<f64>) -> UsageEvent {
    apply_pricing_with(
        UsageEvent {
            id: "e1".into(),
            agent: AgentId::Litellm,
            model: Some("claude-fable-5".into()),
            timestamp: "2026-10-11T05:32:12.000Z".into(),
            input_tokens: 2_000_000.0,
            output_tokens: 10_000.0,
            cache_read_tokens: 0.0,
            cache_write_tokens: 0.0,
            request_count: Some(1.0),
            cost_parity_gap,
            ..Default::default()
        },
        router_cost,
    )
}

#[test]
fn cost_parity_gap_reports_the_gateway_figure_not_the_token_implied_one() {
    // 2M in + 10k out on claude-fable-5 implies $20.50 from the table, but the
    // gateway billed $12.30 on a cheaper card.
    let implied = priced(None, None).estimated_cost.unwrap_or(0.0);
    assert!((implied - 20.5).abs() < 1e-9);

    let row = priced(Some(true), Some(12.3));
    assert_eq!(row.estimated_cost, Some(12.3));
    assert_eq!(row.pricing_status, PricingStatus::ZeroRate);
    assert_ne!(row.estimated_cost, Some(implied));
}

#[test]
fn cost_parity_gap_with_no_gateway_figure_is_zero_never_invented() {
    let row = priced(Some(true), None);
    assert_eq!(row.estimated_cost, Some(0.0));
    assert_eq!(row.pricing_status, PricingStatus::ZeroRate);
}

#[test]
fn a_row_billing_more_than_its_tokens_imply_is_left_alone() {
    let row = priced(None, Some(25.0));
    assert_eq!(row.estimated_cost, Some(25.0));
    assert_eq!(row.pricing_status, PricingStatus::Priced);
}

#[test]
fn cost_parity_gap_survives_a_forced_table_reprice() {
    let gap = priced(Some(true), Some(12.3));
    let normal = priced(None, None);
    let out = reprice_events(&[gap, normal], true);
    let (re_gap, re_normal) = (&out[0], &out[1]);

    assert_eq!(re_gap.estimated_cost, Some(12.3));
    assert_eq!(re_gap.pricing_status, PricingStatus::ZeroRate);
    assert_eq!(re_gap.cost_parity_gap, Some(true));
    // An ordinary row still gets re-derived from the table.
    assert_eq!(re_normal.estimated_cost, Some(20.5));
    assert_eq!(re_normal.pricing_status, PricingStatus::Priced);
}

#[test]
fn a_forced_reprice_keeps_a_gapless_rows_gateway_cost_out_of_the_table() {
    let row = priced(None, Some(25.0));
    let out = reprice_events(&[row], true);
    assert_eq!(out[0].estimated_cost, Some(20.5));
    assert_eq!(out[0].cost_parity_gap, None);
}
