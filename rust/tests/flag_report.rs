//! Port of `tests/flag-report.test.ts`.
//!
//! Fixtures reproduce the measured shape of real LiteLLM mirror days (bursts of
//! sub-minute cadence separated by short pauses), not an invented even cadence.

use tokenlab::flag_report::*;
use tokenlab::types::{AgentId, PricingStatus, UsageEvent};
use tokenlab::util::{js_date_parse, to_iso_string};

fn ev(iso: &str) -> UsageEvent {
    UsageEvent {
        id: iso.into(),
        agent: AgentId::Litellm,
        model: Some("claude-opus-5.5".into()),
        timestamp: iso.into(),
        input_tokens: 100.0,
        output_tokens: 20.0,
        cache_read_tokens: 0.0,
        cache_write_tokens: 0.0,
        total_tokens: 120.0,
        estimated_cost: Some(0.01),
        currency: "USD".into(),
        pricing_status: PricingStatus::Priced,
        workspace: None,
        source_path: "test".into(),
        ..Default::default()
    }
}

fn ev_ms(ms: f64) -> UsageEvent {
    ev(&to_iso_string(ms).unwrap())
}

struct Bursty {
    start_iso: &'static str,
    target_span_hours: f64,
    burst_gap_seconds: f64,
    burst_size: u32,
    pause_seconds: f64,
}

/// Build a day with a requested span: bursts of sub-minute cadence separated by
/// longer pauses, with the cycle count solved so the last request lands close to
/// `target_span_hours` after the first.
fn bursty_day(o: Bursty) -> Vec<UsageEvent> {
    let cycle_seconds = (o.burst_size as f64 - 1.0) * o.burst_gap_seconds + o.pause_seconds;
    let target_seconds = o.target_span_hours * 3600.0;
    // JS Math.round: floor(x + 0.5)
    let cycles = (target_seconds / cycle_seconds + 0.5).floor().max(1.0) as u32;
    let mut out = Vec::new();
    let mut t = js_date_parse(o.start_iso);
    for _ in 0..cycles {
        for _ in 0..o.burst_size {
            out.push(ev_ms(t));
            t += o.burst_gap_seconds * 1000.0;
        }
        t += o.pause_seconds * 1000.0;
    }
    out
}

fn defaults() -> FlagThresholds {
    default_flag_thresholds()
}

fn days_of(events: &[UsageEvent]) -> Vec<DayActivity> {
    compute_day_activity(events, &defaults())
}

fn contains(list: &[String], day: &str) -> bool {
    list.iter().any(|d| d == day)
}

#[test]
fn a_single_request_has_zero_span_and_no_cadence() {
    let days = days_of(&[ev("2026-10-07T12:00:00.000Z")]);
    assert_eq!(days.len(), 1);
    let d = &days[0];
    assert_eq!(d.span_hours, 0.0);
    assert_eq!(d.active_minutes, 1.0);
    assert_eq!(d.hours_with_traffic, 1.0);
    assert_eq!(d.median_gap_seconds, None);
    assert_eq!(d.share_gaps_under60s, 0.0, "no gaps means no automated cadence");
}

#[test]
fn span_is_inflated_by_two_distant_requests_active_minutes_is_not() {
    let events = vec![ev("2026-10-07T00:00:00.000Z"), ev("2026-10-07T18:00:00.000Z")];
    let d = &days_of(&events)[0];
    assert_eq!(d.span_hours, 18.0);
    assert_eq!(d.active_minutes, 2.0);
    assert!((d.active_hours - 2.0 / 60.0).abs() < 1e-9);
    assert_eq!(d.request_count, 2.0);
    assert!(d.active_hours < 0.05, "active time is tiny despite an 18h span");
}

#[test]
fn idle_hours_between_the_first_and_last_request_are_reported() {
    let events = vec![ev("2026-10-07T00:10:00.000Z"), ev("2026-10-07T05:10:00.000Z")];
    let d = &days_of(&events)[0];
    assert_eq!(d.idle_hours, vec![1, 2, 3, 4]);
    assert_eq!(d.idle_hours_in_span, 4.0);
    assert_eq!(d.hours_with_traffic, 2.0);
}

#[test]
fn idle_hours_are_counted_only_between_the_first_and_last_request() {
    let trailing = days_of(&[
        ev("2026-10-08T00:30:00.000Z"),
        ev("2026-10-08T12:00:00.000Z"),
        ev("2026-10-08T17:00:00.000Z"),
    ])
    .remove(0);
    assert_eq!(trailing.hours_with_traffic, 3.0);
    // Trailing silence (hours 18..23) is not represented at all.
    assert!(!trailing.idle_hours.contains(&18));
    assert!(!trailing.idle_hours.contains(&23));
    // The interior gaps are the ones reported.
    assert_eq!(trailing.idle_hours, vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16]);

    // When the silence sits between two requests it IS reported.
    let interior = days_of(&[ev("2026-10-08T00:30:00.000Z"), ev("2026-10-08T23:00:00.000Z")]).remove(0);
    assert_eq!(interior.idle_hours, (1..=22).collect::<Vec<u32>>());
}

#[test]
fn regression_2026_10_07_shape_is_flagged_by_span_and_round_the_clock_not_by_active_hours() {
    let events = bursty_day(Bursty {
        start_iso: "2026-10-07T01:12:49.000Z",
        target_span_hours: 22.68,
        burst_gap_seconds: 5.0,
        burst_size: 40,
        pause_seconds: 240.0,
    });

    let report = compute_flag_report(&events, &defaults());
    let d = &report.days[0];

    assert_eq!(d.idle_hours_in_span, 0.0, "traffic in every hour inside the span");
    assert!(d.span_hours >= 18.0, "span {}h reaches the 18h threshold", d.span_hours);
    assert!(d.span_hours <= 24.0, "span {}h stays within the day", d.span_hours);
    assert!(
        d.active_hours < d.span_hours - 2.0,
        "active {}h must stay clearly below span {}h",
        d.active_hours,
        d.span_hours
    );
    assert!(d.share_gaps_under60s >= 0.9, "sub-minute cadence is the bot signature");
    assert!(d.median_gap_seconds.map_or(false, |m| m <= 60.0));

    assert!(contains(&report.days_over_span, "2026-10-07"), "span reading flags the day");
    assert!(contains(&report.days_round_the_clock, "2026-10-07"), "zero idle hours flags the day");

    let verdict = &report.verdicts[0];
    assert!(verdict.flagged);
    assert!(verdict.reasons.len() >= 2, "multiple independent reasons are reported");
    assert!(
        verdict.reasons.iter().any(|r| r.contains("span")),
        "the reason names the metric so the reading is auditable"
    );
}

#[test]
fn regression_2026_10_08_stays_under_the_18h_span_threshold() {
    let events = bursty_day(Bursty {
        start_iso: "2026-10-08T00:00:35.000Z",
        target_span_hours: 17.45,
        burst_gap_seconds: 7.0,
        burst_size: 40,
        pause_seconds: 240.0,
    });
    let report = compute_flag_report(&events, &defaults());
    let d = &report.days[0];
    assert!(d.span_hours < 18.0, "17.45h span stays under 18h, got {}", d.span_hours);
    assert!(!contains(&report.days_over_span, "2026-10-08"));
    assert!(d.active_hours < 18.0);
}

#[test]
fn estimated_daily_rollups_never_contribute_cadence_or_span() {
    let mut rollup = ev("2026-10-07T12:00:00.000Z");
    rollup.estimated = Some(true);
    rollup.request_count = Some(5000.0);
    let events = vec![ev("2026-10-07T00:00:00.000Z"), rollup, ev("2026-10-07T23:59:00.000Z")];
    let d = &days_of(&events)[0];
    assert_eq!(d.request_count, 2.0, "the rollup is excluded");
    assert_eq!(d.active_minutes, 2.0);
}

#[test]
fn days_are_bucketed_by_utc_calendar_date() {
    let events = vec![ev("2026-10-07T23:59:00.000Z"), ev("2026-10-08T00:01:00.000Z")];
    let days = days_of(&events);
    let keys: Vec<&str> = days.iter().map(|d| d.day.as_str()).collect();
    assert_eq!(keys, vec!["2026-10-07", "2026-10-08"]);
}

#[test]
fn longest_continuous_run_breaks_on_a_gap_above_the_threshold() {
    let thresholds = FlagThresholds { continuous_gap_seconds: 60.0, ..defaults() };
    let start = js_date_parse("2026-10-07T00:00:00.000Z");
    let mut events: Vec<UsageEvent> = Vec::new();
    for i in 0..10 {
        events.push(ev_ms(start + i as f64 * 30_000.0));
    }
    let after_gap = start + 9.0 * 30_000.0 + 600_000.0;
    for i in 0..10 {
        events.push(ev_ms(after_gap + i as f64 * 30_000.0));
    }
    let d = &compute_day_activity(&events, &thresholds)[0];
    // 9 gaps * 30s = 270s = 0.075h in each run.
    assert!((d.longest_continuous_run_hours - 270.0 / 3600.0).abs() < 1e-9);
}

#[test]
fn thresholds_are_configurable_and_drive_the_verdicts() {
    let day0 = js_date_parse("2026-10-07T00:00:00.000Z");
    // 10-minute cadence over 16h: a human-scale pause, never a continuous run.
    let slow: Vec<UsageEvent> = (0..100).map(|i| ev_ms(day0 + i as f64 * 600_000.0)).collect();
    let high = FlagThresholds { span_hours: 1000.0, active_hours: 1000.0, max_idle_hours: -1.0, ..defaults() };

    let relaxed = compute_flag_report(&slow, &FlagThresholds { automated_gap_share: 0.9, ..high });
    assert_eq!(relaxed.days[0].share_gaps_under60s, 0.0);
    assert!(!contains(&relaxed.days_automated_cadence, "2026-10-07"), "10-min cadence is not bot-like");
    assert!(relaxed.days_automated_cadence.is_empty());
    assert!(relaxed.days_round_the_clock.is_empty(), "maxIdleHours=-1 disables the round-the-clock check");

    // A fast cadence trips the same threshold.
    let fast: Vec<UsageEvent> = (0..100).map(|i| ev_ms(day0 + i as f64 * 30_000.0)).collect();
    let strict = compute_flag_report(&fast, &FlagThresholds { automated_gap_share: 0.9, ..high });
    assert!(strict.days[0].share_gaps_under60s > 0.9);
    assert!(contains(&strict.days_automated_cadence, "2026-10-07"));

    // Uniform 30s spacing gives a share of exactly 1.0, so only a threshold
    // above 1 can exclude it.
    let raised = compute_flag_report(&fast, &FlagThresholds { automated_gap_share: 1.0000001, ..high });
    assert!(raised.days_automated_cadence.is_empty());
}

#[test]
fn the_round_the_clock_check_is_driven_by_max_idle_hours() {
    let events = bursty_day(Bursty {
        start_iso: "2026-10-07T01:12:49.000Z",
        target_span_hours: 22.68,
        burst_gap_seconds: 5.0,
        burst_size: 40,
        pause_seconds: 240.0,
    });
    let zero = compute_flag_report(&events, &defaults());
    assert!(contains(&zero.days_round_the_clock, "2026-10-07"));
    let impossible = compute_flag_report(&events, &FlagThresholds { max_idle_hours: -1.0, ..defaults() });
    assert!(impossible.days_round_the_clock.is_empty());
}

#[test]
fn period_wide_cadence_aggregates_every_day() {
    let d7 = js_date_parse("2026-10-07T00:00:00.000Z");
    let d8 = js_date_parse("2026-10-08T00:00:00.000Z");
    let mut events: Vec<UsageEvent> = Vec::new();
    for i in 0..50 {
        events.push(ev_ms(d7 + i as f64 * 30_000.0));
        events.push(ev_ms(d8 + i as f64 * 30_000.0));
    }
    let report = compute_flag_report(&events, &defaults());
    assert_eq!(report.median_gap_seconds, Some(30.0), "median of the pooled 30s gaps");
    assert!(report.share_gaps_under60s > 0.9);
    assert!(report.longest_run_hours > 0.0);
}

#[test]
fn empty_input_yields_an_empty_report_rather_than_throwing() {
    let report = compute_flag_report(&[], &defaults());
    assert!(report.days.is_empty());
    assert!(report.verdicts.is_empty());
    assert_eq!(report.median_gap_seconds, None);
    assert_eq!(report.longest_run_hours, 0.0);
    assert_eq!(report.share_gaps_under60s, 0.0);
}

#[test]
fn events_with_unparseable_timestamps_are_skipped() {
    let events = vec![ev("not-a-date"), ev("2026-10-07T10:00:00.000Z")];
    let days = days_of(&events);
    assert_eq!(days.len(), 1);
    assert_eq!(days[0].request_count, 1.0);
}
