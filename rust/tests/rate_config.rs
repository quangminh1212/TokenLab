//! Port of `tests/rate-config.test.ts` (`resolveRateSpec` + `resolveFlagThresholds`).

use serde_json::json;
use std::collections::HashMap;
use tokenlab::flag_report::{default_flag_thresholds, resolve_flag_thresholds};
use tokenlab::rate_guard::*;

fn env(pairs: &[(&str, &str)]) -> Option<HashMap<String, String>> {
    Some(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
}

fn rw(window_seconds: f64, limit: f64) -> RateWindow {
    RateWindow { window_seconds, limit }
}

fn gated() -> Vec<String> {
    LITELLM_GATED_MODELS.iter().map(|x| x.to_string()).collect()
}

#[test]
fn resolve_rate_spec_falls_back_to_the_recovered_upstream_constants() {
    let r = resolve_rate_spec(&RateConfigInput { env: env(&[]), ..Default::default() });
    assert_eq!(r.windows_source, RateSpecSource::UpstreamDefault);
    assert_eq!(r.models_source, RateSpecSource::UpstreamDefault);
    assert_eq!(r.windows_source.as_str(), "upstream-default");
    assert!(r.is_upstream_default);
    assert_eq!(r.spec.models, gated());
    let by = |w: f64| r.spec.windows.iter().find(|x| x.window_seconds == w).map(|x| x.limit);
    assert_eq!(by(1.0), Some(LITELLM_RPS_LIMIT));
    assert_eq!(by(60.0), Some(LITELLM_RPM_LIMIT));
}

#[test]
fn env_overrides_config_for_windows_and_models() {
    let r = resolve_rate_spec(&RateConfigInput {
        config_windows: Some("1/1s,60/60s".into()),
        config_models: Some("glm-5.3".into()),
        env: env(&[("TOKENLAB_RATE_LIMIT_WINDOWS", "5/30s,2/1s"), ("TOKENLAB_RATE_LIMIT_MODELS", "*")]),
    });
    assert_eq!(r.windows_source, RateSpecSource::Env);
    assert_eq!(r.models_source, RateSpecSource::Env);
    assert!(!r.is_upstream_default);
    assert_eq!(r.spec.windows, vec![rw(30.0, 5.0), rw(1.0, 2.0)]);
    assert!(r.spec.models.is_empty(), "'*' means every model");
    assert!(r.warnings.is_empty());
}

#[test]
fn config_is_used_when_no_env_override_is_present() {
    let r = resolve_rate_spec(&RateConfigInput {
        config_windows: Some("10/60s".into()),
        config_models: Some("glm-5.53".into()),
        env: env(&[]),
    });
    assert_eq!(r.windows_source, RateSpecSource::Config);
    assert_eq!(r.models_source, RateSpecSource::Config);
    assert_eq!(r.spec.windows, vec![rw(60.0, 10.0)]);
    assert_eq!(r.spec.models, vec!["glm-5.53".to_string()]);
}

#[test]
fn a_malformed_env_override_warns_and_falls_back_rather_than_being_ignored() {
    let r = resolve_rate_spec(&RateConfigInput {
        config_windows: Some("10/60s".into()),
        env: env(&[("TOKENLAB_RATE_LIMIT_WINDOWS", "not-a-limit")]),
        ..Default::default()
    });
    assert_eq!(r.windows_source, RateSpecSource::Config, "falls through to the config value");
    assert_eq!(r.warnings.len(), 1);
    assert!(r.warnings[0].contains("TOKENLAB_RATE_LIMIT_WINDOWS"));
    assert_eq!(r.spec.windows, vec![rw(60.0, 10.0)]);
}

#[test]
fn a_malformed_override_with_no_config_falls_back_to_upstream_defaults() {
    let r = resolve_rate_spec(&RateConfigInput {
        env: env(&[("TOKENLAB_RATE_LIMIT_MODELS", "!!!bad!!!")]),
        ..Default::default()
    });
    assert_eq!(r.models_source, RateSpecSource::UpstreamDefault);
    assert_eq!(r.warnings.len(), 1);
    assert_eq!(r.spec.models, gated());
}

#[test]
fn blank_override_strings_are_treated_as_absent_not_as_errors() {
    let r = resolve_rate_spec(&RateConfigInput {
        config_windows: Some("  ".into()),
        env: env(&[("TOKENLAB_RATE_LIMIT_WINDOWS", ""), ("TOKENLAB_RATE_LIMIT_MODELS", "   ")]),
        ..Default::default()
    });
    assert!(r.is_upstream_default);
    assert!(r.warnings.is_empty());
}

#[test]
fn resolve_flag_thresholds_returns_the_documented_defaults() {
    let t = resolve_flag_thresholds(None);
    assert_eq!(t, default_flag_thresholds());
    assert_eq!(t.span_hours, 18.0);
    assert_eq!(t.automated_gap_share, 0.9);
    // `null` in TS is the same as no override.
    assert_eq!(resolve_flag_thresholds(Some(&serde_json::Value::Null)), default_flag_thresholds());
}

#[test]
fn resolve_flag_thresholds_applies_valid_overrides() {
    let t = resolve_flag_thresholds(Some(&json!({
        "spanHours": 12,
        "activeHours": 8,
        "continuousGapSeconds": 120,
        "maxIdleHours": 2,
        "automatedGapShare": 0.75
    })));
    assert_eq!(t.span_hours, 12.0);
    assert_eq!(t.active_hours, 8.0);
    assert_eq!(t.continuous_gap_seconds, 120.0);
    assert_eq!(t.max_idle_hours, 2.0);
    assert_eq!(t.automated_gap_share, 0.75);
}

#[test]
fn resolve_flag_thresholds_rejects_out_of_range_values_per_field() {
    let base = default_flag_thresholds();
    let t = resolve_flag_thresholds(Some(&json!({
        "spanHours": -5,
        "activeHours": 999,
        "continuousGapSeconds": 0,
        "automatedGapShare": 1.5
    })));
    assert_eq!(t.span_hours, base.span_hours, "negative hours rejected");
    assert_eq!(t.active_hours, base.active_hours, "absurd hours rejected");
    assert_eq!(t.continuous_gap_seconds, base.continuous_gap_seconds, "zero gap rejected");
    assert_eq!(t.automated_gap_share, base.automated_gap_share, "share > 1 rejected");
}

#[test]
fn max_idle_hours_accepts_0_which_is_a_meaningful_threshold() {
    let t = resolve_flag_thresholds(Some(&json!({ "maxIdleHours": 0 })));
    assert_eq!(t.max_idle_hours, 0.0);
}

#[test]
fn a_full_spec_round_trips_through_the_guard() {
    let resolved = resolve_rate_spec(&RateConfigInput {
        env: env(&[("TOKENLAB_RATE_LIMIT_WINDOWS", "3/10s")]),
        ..Default::default()
    });
    assert_eq!(resolved.spec.windows, vec![rw(10.0, 3.0)]);
    // The resolved spec is directly consumable by the guard.
    let mut guard = RequestRateGuard::new(&resolved.spec);
    assert!(guard.admit(Some("glm-5.3"), 0.0).allowed);
}
