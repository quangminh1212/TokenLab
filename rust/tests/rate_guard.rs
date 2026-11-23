//! Port of `tests/rate-guard.test.ts` (sliding-window guard reconstructed from
//! LiteLLM's `glm_rps_limit`).

use tokenlab::rate_guard::*;

fn rw(window_seconds: f64, limit: f64) -> RateWindow {
    RateWindow { window_seconds, limit }
}

fn spec(models: &[&str], windows: Vec<RateWindow>) -> RateLimitSpec {
    RateLimitSpec { models: models.iter().map(|s| s.to_string()).collect(), windows }
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn gated() -> Vec<String> {
    LITELLM_GATED_MODELS.iter().map(|x| x.to_string()).collect()
}

#[test]
fn litellm_default_spec_matches_the_recovered_constants() {
    let sp = litellm_default_spec();
    assert_eq!(sp.models, gated());
    let by = |w: f64| sp.windows.iter().find(|x| x.window_seconds == w).map(|x| x.limit);
    assert_eq!(by(1.0), Some(LITELLM_RPS_LIMIT), "1s window -> 1 req (RPS_LIMIT)");
    assert_eq!(by(60.0), Some(LITELLM_RPM_LIMIT), "60s window -> 60 req (RPM_LIMIT)");
}

#[test]
fn guard_only_gates_its_configured_models() {
    let guard = RequestRateGuard::new(&litellm_default_spec());
    assert!(guard.applies_to(Some("GLM-5.3")), "case-insensitive");
    assert!(guard.applies_to(Some("  GLM-5.53  ")), "whitespace trimmed");
    assert!(!guard.applies_to(Some("claude-opus-5.5")));
    assert!(!guard.applies_to(None));
}

#[test]
fn empty_model_list_gates_everything() {
    let guard = RequestRateGuard::new(&spec(&[], vec![rw(1.0, 2.0)]));
    assert!(guard.applies_to(Some("anything")));
    assert!(guard.applies_to(None));
}

#[test]
fn the_limit_is_exclusive_rps_limit_1_rejects_the_second_request() {
    let mut guard = RequestRateGuard::new(&spec(&["m"], vec![rw(1.0, 1.0)]));
    assert!(guard.admit(Some("m"), 100.0).allowed, "first request admitted");
    let second = guard.admit(Some("m"), 100.2);
    assert!(!second.allowed, "second request inside 1s rejected");
    assert_eq!(second.rejected_by, Some(RejectedBy { window_seconds: 1.0, limit: 1.0 }));
    assert_eq!(second.counts[0].count, 1.0, "count reflects the recorded request");
}

#[test]
fn exactly_one_second_later_the_request_is_allowed_again() {
    let mut guard = RequestRateGuard::new(&spec(&["m"], vec![rw(1.0, 1.0)]));
    guard.admit(Some("m"), 100.0);
    // Upstream window test is `now - t < window`, so a gap of exactly 1.0 is out.
    assert!(guard.admit(Some("m"), 101.0).allowed);
}

#[test]
fn sliding_window_differs_from_calendar_minute_bucketing() {
    let mut guard = RequestRateGuard::new(&spec(&["m"], vec![rw(60.0, 5.0)]));
    let times = [59.0, 59.5, 59.7, 59.9, 60.0, 60.2];
    let admitted = times.iter().filter(|t| guard.admit(Some("m"), **t).allowed).count();
    assert_eq!(admitted, 5, "rolling 60s window caps at the limit");
    let verdict = guard.check(Some("m"), 60.3);
    assert_eq!(verdict.counts[0].count, 5.0);
}

#[test]
fn rpm_check_uses_len_starts_and_can_reject_after_the_per_second_check_passes() {
    let mut guard = RequestRateGuard::new(&spec(&["m"], vec![rw(1.0, 10.0), rw(60.0, 3.0)]));
    assert!(guard.admit(Some("m"), 0.0).allowed);
    assert!(guard.admit(Some("m"), 20.0).allowed);
    let third = guard.admit(Some("m"), 40.0);
    assert!(third.allowed, "3rd request: count would be 3, check is >= 3 only before push");
    let fourth = guard.admit(Some("m"), 50.0);
    assert!(!fourth.allowed);
    assert_eq!(fourth.rejected_by, Some(RejectedBy { window_seconds: 60.0, limit: 3.0 }));
}

#[test]
fn retry_after_is_max_1_ceil_window_minus_age_of_oldest() {
    let mut guard = RequestRateGuard::new(&spec(&["m"], vec![rw(60.0, 1.0)]));
    guard.admit(Some("m"), 10.0);
    // At t=10.4 the entry is 0.4s old, so 60 - 0.4 = 59.6 -> ceil 60.
    let v = guard.check(Some("m"), 10.4);
    assert!(!v.allowed);
    assert_eq!(v.retry_after_seconds, Some(60.0));
    // At t=69.3 it is 59.3s old -> 0.7 remaining -> ceil 1.
    let w = guard.check(Some("m"), 69.3);
    assert!(!w.allowed, "still inside the 60s window");
    assert_eq!(w.retry_after_seconds, Some(1.0));
    // At t=70.0 the entry has aged out entirely.
    assert!(guard.check(Some("m"), 70.0).allowed);
}

#[test]
fn retry_after_never_returns_zero_or_a_fraction() {
    let mut guard = RequestRateGuard::new(&spec(&["m"], vec![rw(1.0, 1.0)]));
    guard.admit(Some("m"), 0.0);
    let v = guard.check(Some("m"), 0.999);
    assert_eq!(v.retry_after_seconds, Some(1.0));
    let r = v.retry_after_seconds.unwrap();
    assert_eq!(r, r.trunc(), "retry-after is an integer");
}

#[test]
fn a_rejected_request_is_not_recorded_so_a_retry_sees_fresh_state() {
    let mut guard = RequestRateGuard::new(&spec(&["m"], vec![rw(60.0, 1.0)]));
    guard.admit(Some("m"), 0.0);
    for i in 0..50 {
        guard.admit(Some("m"), 1.0 + (i as f64) * 0.001);
    }
    assert_eq!(guard.size(2.0), 1, "only the admitted request is in state");
    assert!(guard.check(Some("m"), 60.0).allowed);
}

#[test]
fn stale_entries_are_pruned_by_the_widest_window() {
    let mut guard = RequestRateGuard::new(&spec(&["m"], vec![rw(1.0, 100.0), rw(60.0, 100.0)]));
    guard.admit(Some("m"), 0.0);
    guard.admit(Some("m"), 30.0);
    assert_eq!(guard.size(30.0), 2);
    assert_eq!(guard.size(61.0), 1);
    assert_eq!(guard.size(91.0), 0);
}

#[test]
fn reset_clears_state() {
    let mut guard = RequestRateGuard::new(&spec(&["m"], vec![rw(60.0, 5.0)]));
    guard.admit(Some("m"), 0.0);
    assert_eq!(guard.size(0.5), 1);
    guard.reset();
    assert_eq!(guard.size(0.5), 0);
}

#[test]
fn a_non_gated_model_is_admitted_and_never_recorded() {
    let mut guard = RequestRateGuard::new(&litellm_default_spec());
    let v = guard.admit(Some("claude-opus-5.5"), 0.0);
    assert!(v.allowed);
    assert!(v.counts.is_empty(), "no windows reported for an un-gated model");
    assert_eq!(guard.size(0.0), 0, "un-gated requests do not consume the budget");
}

#[test]
fn message_is_shaped_like_the_upstream_proxy_rate_limit_error_detail() {
    let mut guard = RequestRateGuard::new(&spec(&["glm-5.3"], vec![rw(1.0, 1.0)]));
    guard.admit(Some("GLM-5.3"), 5.0);
    let v = guard.check(Some("GLM-5.3"), 5.1);
    assert_eq!(v.message.as_deref(), Some("glm-5.3 rate limit exceeded: maximum 1 requests per second"));
}

#[test]
fn replay_reports_exactly_where_upstream_would_have_raised() {
    let result = replay_through_guard(&spec(&["glm-5.3"], vec![rw(1.0, 1.0)]), Some("glm-5.3"), &[0.0, 0.1, 0.2]);
    assert_eq!(result.admitted, 1.0);
    assert_eq!(result.rejected, 2.0);
    let allowed: Vec<bool> = result.decisions.iter().map(|d| d.allowed).collect();
    assert_eq!(allowed, vec![true, false, false]);
    assert_eq!(result.decisions[1].retry_after_seconds, Some(1.0));
}

#[test]
fn replay_over_a_spread_out_stream_admits_everything() {
    let result = replay_through_guard(&litellm_default_spec(), Some("glm-5.3"), &[0.0, 1.0, 2.0, 3.0, 4.0]);
    assert_eq!(result.rejected, 0.0, "1 req/s is satisfied by exactly 1s spacing");
    assert_eq!(result.admitted, 5.0);
}

#[test]
fn parse_rate_windows_accepts_the_documented_syntax() {
    assert_eq!(parse_rate_windows(Some("5/30s,2/1s")), Some(vec![rw(30.0, 5.0), rw(1.0, 2.0)]));
    assert_eq!(parse_rate_windows(Some("1/1s,60/60s")), Some(vec![rw(1.0, 1.0), rw(60.0, 60.0)]));
    assert_eq!(parse_rate_windows(Some("10/5m")), Some(vec![rw(300.0, 10.0)]));
    assert_eq!(parse_rate_windows(Some(" 5 / 30 s ")), Some(vec![rw(30.0, 5.0)]));
    assert_eq!(parse_rate_windows(Some("")), None);
    assert_eq!(parse_rate_windows(None), None);
    assert_eq!(parse_rate_windows(Some("garbage")), None, "unparseable config must not silently pass");
    assert_eq!(parse_rate_windows(Some("0/1s")), None, "zero limit rejected");
}

#[test]
fn parse_rate_models_handles_all_lists_and_blanks() {
    assert_eq!(parse_rate_models(Some("glm-5.3,GLM-5.53")), Some(s(&["glm-5.3", "glm-5.53"])));
    assert_eq!(parse_rate_models(Some("*")), Some(vec![]), "'*' means every model");
    assert_eq!(parse_rate_models(Some("")), None);
    assert_eq!(parse_rate_models(None), None);
    assert_eq!(parse_rate_models(Some(" , , ")), None, "only separators is not a list");
}

#[test]
fn parse_rate_models_rejects_entries_that_cannot_be_a_model_id() {
    assert_eq!(parse_rate_models(Some("!!!bad!!!")), None);
    assert_eq!(parse_rate_models(Some("glm-5.3,@@@")), None, "one bad entry invalidates the list");
    assert_eq!(
        parse_rate_models(Some("anthropic/claude-opus-5.5")),
        Some(s(&["anthropic/claude-opus-5.5"]))
    );
    assert_eq!(
        parse_rate_models(Some("nvidia/nemotron-3-ultra-550b-a55b:free")),
        Some(s(&["nvidia/nemotron-3-ultra-550b-a55b:free"]))
    );
}

#[test]
fn a_configured_5_per_30s_guard_enforces_the_provider_style_limit() {
    let mut guard = RequestRateGuard::new(&spec(&[], vec![rw(1.0, 2.0), rw(30.0, 5.0)]));
    assert!(guard.admit(Some("m"), 0.0).allowed);
    assert!(guard.admit(Some("m"), 0.5).allowed);
    let third = guard.admit(Some("m"), 0.6);
    assert!(!third.allowed);
    assert_eq!(third.rejected_by, Some(RejectedBy { window_seconds: 1.0, limit: 2.0 }));
}
