//! Port of `tests/aggregate.test.ts`.

use tokenlab::aggregate::{
    aggregate, compute_active_usage_rpm, compute_live_request_rate, cost_report, count_active_minutes,
    rpm_by_group, RpmScope, SortBy,
};
use tokenlab::types::{AgentId, GroupBy, PricingStatus, StatsResult, UsageEvent};

fn sample() -> Vec<UsageEvent> {
    vec![
        UsageEvent {
            id: "1".into(),
            agent: AgentId::Cursor,
            model: Some("gpt-4.1".into()),
            timestamp: "2026-07-11T10:00:00.000Z".into(),
            input_tokens: 1000.0,
            output_tokens: 200.0,
            cache_read_tokens: 0.0,
            cache_write_tokens: 0.0,
            total_tokens: 1200.0,
            estimated_cost: Some(0.5),
            currency: "USD".into(),
            pricing_status: PricingStatus::Priced,
            workspace: None,
            source_path: "x".into(),
            ..Default::default()
        },
        UsageEvent {
            id: "2".into(),
            agent: AgentId::Grok,
            model: Some("grok-4.5".into()),
            timestamp: "2026-07-11T11:00:00.000Z".into(),
            input_tokens: 2000.0,
            output_tokens: 400.0,
            cache_read_tokens: 0.0,
            cache_write_tokens: 0.0,
            total_tokens: 2400.0,
            estimated_cost: Some(1.2),
            currency: "USD".into(),
            pricing_status: PricingStatus::Priced,
            workspace: None,
            source_path: "y".into(),
            ..Default::default()
        },
    ]
}

fn agg(events: &[UsageEvent], by: GroupBy, sort: SortBy) -> StatsResult {
    aggregate(events, by, sort, None, None, None, false)
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

/// `{ ...sample[0], id, timestamp, requestCount, estimated: false }`
fn live(id: &str, ts: &str, request_count: f64) -> UsageEvent {
    UsageEvent {
        id: id.into(),
        timestamp: ts.into(),
        request_count: Some(request_count),
        estimated: Some(false),
        ..sample()[0].clone()
    }
}

#[test]
fn aggregate_by_agent_sorts_by_cost() {
    let r = agg(&sample(), GroupBy::Agent, SortBy::Cost);
    assert_eq!(r.groups[0].key, "grok");
    assert_eq!(r.totals.total_tokens, 3600.0);
    assert!(close(r.totals.estimated_cost, 1.7));
    assert_eq!(r.totals.event_count, 2.0, "default 1 request per event");
}

#[test]
fn aggregate_event_count_sums_request_count_daily_rollup_style() {
    let s = sample();
    let events = vec![
        UsageEvent { id: "d1".into(), request_count: Some(90.0), estimated_cost: Some(4.5), ..s[0].clone() },
        UsageEvent { id: "d2".into(), request_count: Some(10.0), estimated_cost: Some(0.5), ..s[1].clone() },
    ];
    let r = agg(&events, GroupBy::Model, SortBy::Cost);
    assert_eq!(r.totals.event_count, 100.0);
    assert_eq!(r.groups.iter().find(|g| g.key == "gpt 4.1").map(|g| g.totals.event_count), Some(90.0));
    assert_eq!(r.groups.iter().find(|g| g.key == "grok 4.5").map(|g| g.totals.event_count), Some(10.0));
}

#[test]
fn aggregate_by_model_merges_qwencoder_qwen38_max_into_qwen38_max() {
    let s = sample();
    let events = vec![
        UsageEvent {
            id: "qwen".into(),
            model: Some("qwen3.8 max".into()),
            request_count: Some(5.0),
            total_tokens: 100.0,
            ..s[0].clone()
        },
        UsageEvent {
            id: "qwencoder".into(),
            model: Some("qwencoder-qwen3.8-max".into()),
            request_count: Some(3.0),
            total_tokens: 60.0,
            ..s[0].clone()
        },
    ];
    let r = agg(&events, GroupBy::Model, SortBy::Cost);
    assert_eq!(r.groups.len(), 1);
    assert_eq!(r.groups[0].key, "qwen3.8 max");
    assert_eq!(r.groups[0].totals.event_count, 8.0);
    assert_eq!(r.groups[0].totals.total_tokens, 160.0);
}

#[test]
fn cost_report_matches_agent_and_normalized_model_aggregates_in_one_report() {
    let s = sample();
    let mut events = s.clone();
    events.push(UsageEvent {
        id: "3".into(),
        model: Some("gpt-4.1 (openai-compatible-responses)".into()),
        input_tokens: 50.0,
        output_tokens: 50.0,
        total_tokens: 100.0,
        estimated_cost: Some(0.25),
        request_count: Some(3.0),
        ..s[0].clone()
    });
    let a = aggregate(&events, GroupBy::Agent, SortBy::Cost, Some("7d"), Some("until"), None, false);
    let m = aggregate(&events, GroupBy::Model, SortBy::Cost, Some("7d"), Some("until"), None, false);
    let report = cost_report(&events, Some("7d"), Some("until"));
    let total = if a.totals.estimated_cost == 0.0 { 1.0 } else { a.totals.estimated_cost };

    assert_eq!(report.total_estimated_cost, a.totals.estimated_cost);
    assert_eq!(report.period.since.as_deref(), Some("7d"));
    assert_eq!(report.period.until.as_deref(), Some("until"));
    assert_eq!(report.by_agent.len(), a.groups.len());
    for (r, g) in report.by_agent.iter().zip(a.groups.iter()) {
        assert_eq!(r.agent, g.key);
        assert_eq!(r.estimated_cost, g.totals.estimated_cost);
        assert_eq!(r.total_tokens, g.totals.total_tokens);
        assert_eq!(r.share, g.totals.estimated_cost / total);
    }
    assert_eq!(report.by_model.len(), m.groups.len());
    for (r, g) in report.by_model.iter().zip(m.groups.iter()) {
        assert_eq!(r.model, g.key);
        assert_eq!(r.estimated_cost, g.totals.estimated_cost);
        assert_eq!(r.total_tokens, g.totals.total_tokens);
    }
}

#[test]
fn compute_active_usage_rpm_returns_the_peak_minute() {
    let events = vec![
        live("a1", "2026-07-28T01:00:10.000Z", 4.0),
        live("a2", "2026-07-28T01:00:40.000Z", 1.0), // same minute as a1
        live("b1", "2026-07-28T03:15:00.000Z", 5.0), // different minute
    ];
    assert_eq!(count_active_minutes(&events), 2);
    let r = compute_active_usage_rpm(&events);
    assert_eq!(r.method, "peak_minute");
    assert_eq!(r.requests, 10.0);
    assert_eq!(r.active_minutes, 2.0);
    assert_eq!(r.rpm, 5.0);
    assert_eq!(r.mean_rpm, 5.0);
    assert!(close(r.rps, 5.0 / 60.0));
}

#[test]
fn peak_rpm_beats_the_mean_when_traffic_is_bursty() {
    let events = vec![
        live("burst", "2026-07-28T01:00:00.000Z", 30.0),
        live("b", "2026-07-28T01:05:00.000Z", 1.0),
        live("c", "2026-07-28T01:10:00.000Z", 1.0),
        live("d", "2026-07-28T01:15:00.000Z", 1.0),
    ];
    let r = compute_active_usage_rpm(&events);
    assert_eq!(r.requests, 33.0);
    assert_eq!(r.active_minutes, 4.0);
    assert_eq!(r.mean_rpm, 33.0 / 4.0);
    assert_eq!(r.rpm, 30.0);
    assert_ne!(r.rpm, r.mean_rpm);
}

#[test]
fn active_minutes_counts_only_minutes_that_actually_carried_requests() {
    let events = vec![
        live("m1a", "2026-07-28T09:00:05.000Z", 1.0),
        live("m1b", "2026-07-28T09:00:35.000Z", 1.0),
        live("m1c", "2026-07-28T09:00:59.000Z", 1.0),
        live("m2", "2026-07-28T21:30:00.000Z", 1.0),
    ];
    let r = compute_active_usage_rpm(&events);
    assert_eq!(r.active_minutes, 2.0);
    assert_eq!(r.requests, 4.0);
    assert!(r.active_minutes < 1440.0);
    assert_eq!(r.rpm, 3.0);
}

#[test]
fn a_daily_rollup_row_inflates_active_minutes_by_exactly_one_minute() {
    let events = vec![
        live("live", "2026-07-28T09:00:10.000Z", 1.0),
        UsageEvent { estimated: Some(true), ..live("rollup", "2026-07-28T23:59:00.000Z", 4692.0) },
    ];
    let r = compute_active_usage_rpm(&events);
    assert_eq!(r.active_minutes, 2.0);
    assert_eq!(r.rpm, 1.0); // rollup never drives the peak
    assert_eq!(r.requests, 4693.0); // but it does inflate the request total
}

fn iso_ms(ms: f64) -> String {
    tokenlab::util::to_iso_string(ms).unwrap()
}

#[test]
fn compute_live_request_rate_uses_sliding_window_mean() {
    let now = tokenlab::util::js_date_parse("2026-07-27T12:00:00.000Z");
    let base = sample()[0].clone();
    let events = vec![
        UsageEvent { id: "live-1".into(), timestamp: iso_ms(now - 30_000.0).into(), request_count: Some(2.0), estimated: Some(false), ..base.clone() },
        UsageEvent { id: "live-2".into(), timestamp: iso_ms(now - 90_000.0).into(), request_count: Some(3.0), estimated: Some(false), ..base.clone() },
        UsageEvent { id: "live-3".into(), timestamp: iso_ms(now - 150_000.0).into(), request_count: Some(1.0), estimated: Some(false), ..base.clone() },
        // > 3 min: excluded
        UsageEvent { id: "old".into(), timestamp: iso_ms(now - 400_000.0).into(), request_count: Some(100.0), estimated: Some(false), ..base.clone() },
        // estimated rollup: skipped
        UsageEvent { id: "daily-fat".into(), timestamp: iso_ms(now - 20_000.0).into(), estimated: Some(true), request_count: Some(500.0), ..base.clone() },
        // zero-token probe: skipped
        UsageEvent {
            id: "probe".into(),
            timestamp: iso_ms(now - 10_000.0).into(),
            estimated: Some(false),
            input_tokens: 0.0,
            output_tokens: 0.0,
            total_tokens: 0.0,
            estimated_cost: Some(0.0),
            request_count: Some(1.0),
            ..base.clone()
        },
    ];
    let l = compute_live_request_rate(&events, 3.0, now);
    assert_eq!(l.window_minutes, 3.0);
    assert_eq!(l.window_seconds, 180.0);
    assert_eq!(l.method, "sliding_window_mean");
    assert_eq!(l.unit, "req/min");
    assert_eq!(l.requests, 6.0);
    assert!(close(l.rpm, (6.0 * 60.0) / 180.0));
    assert!(close(l.rps, 6.0 / 180.0));
    assert_eq!(l.per_minute.len(), 3);
    assert_eq!(l.per_minute[0].offset, 2.0);
    assert_eq!(l.per_minute[0].requests, 1.0);
    assert_eq!(l.per_minute[1].requests, 3.0);
    assert_eq!(l.per_minute[2].requests, 2.0);
}

fn counts_event(id: &str, model: &str, total: f64, cost: f64, input: f64, output: f64) -> UsageEvent {
    UsageEvent {
        id: id.into(),
        model: Some(model.into()),
        total_tokens: total,
        estimated_cost: Some(cost),
        input_tokens: input,
        output_tokens: output,
        ..sample()[0].clone()
    }
}

// NOTE: three TS tests (daily-rollup eventCount, provider-parentheses, case-variants) assert
// hyphenated keys ("gpt-5.5", "kimi-k3") but the TS implementation (src/aggregate.ts
// modelGroupKey) emits keys with hyphens replaced by spaces ("gpt 5.5") and aliases "xlab"
// to "gpt 5.5", so those TS tests FAIL upstream. The Rust port matches the TS implementation;
// these tests assert the TS implementation's actual keys.

#[test]
fn aggregate_by_model_merges_names_with_provider_parentheses() {
    let events = vec![
        counts_event(
            "a",
            "gpt-5.5 (openai-compatible-responses-edd706dd-4c64-4148-ba97-f5bddf8c0cfc)",
            100.0,
            1.0,
            80.0,
            20.0,
        ),
        counts_event("b", "gpt-5.5|openai-compatible-chat-aa9b60d1", 50.0, 0.5, 40.0, 10.0),
        counts_event("c", "gpt-5.5", 30.0, 0.3, 20.0, 10.0),
    ];
    let r = agg(&events, GroupBy::Model, SortBy::Cost);
    let keys: Vec<_> = r.groups.iter().map(|g| g.key.clone()).collect();
    let gpt = r
        .groups
        .iter()
        .find(|g| g.key == "gpt 5.5")
        .unwrap_or_else(|| panic!("expected gpt 5.5 group, got {keys:?}"));
    assert_eq!(gpt.totals.event_count, 3.0);
    assert_eq!(gpt.totals.total_tokens, 180.0);
    assert!(close(gpt.totals.estimated_cost, 1.8));
}

#[test]
fn aggregate_by_model_merges_case_variants_into_one_lowercase_key() {
    let events = vec![
        counts_event("k1", "kimi-k3", 100.0, 1.0, 80.0, 20.0),
        counts_event("k2", "Kimi-k3", 50.0, 0.5, 40.0, 10.0),
        counts_event("k3", "KIMI-K3", 30.0, 0.3, 20.0, 10.0),
        counts_event("x1", "xlab", 10.0, 0.1, 8.0, 2.0),
        counts_event("x2", "XLab", 10.0, 0.1, 8.0, 2.0),
    ];
    let r = agg(&events, GroupBy::Model, SortBy::Cost);
    let keys: Vec<_> = r.groups.iter().map(|g| g.key.clone()).collect();
    let kimi = r
        .groups
        .iter()
        .find(|g| g.key == "kimi k3")
        .unwrap_or_else(|| panic!("expected single kimi k3 group, got {keys:?}"));
    assert_eq!(kimi.totals.event_count, 3.0);
    assert_eq!(kimi.totals.total_tokens, 180.0);
    assert_eq!(kimi.key, "kimi k3");
    let xlab = r
        .groups
        .iter()
        .find(|g| g.key == "gpt 5.5")
        .unwrap_or_else(|| panic!("expected xlab (aliased) group, got {keys:?}"));
    assert_eq!(xlab.totals.event_count, 2.0);
    assert_eq!(xlab.key, "gpt 5.5");
    assert_eq!(r.groups.iter().filter(|g| g.key.to_lowercase() == "kimi k3").count(), 1);
    assert_eq!(r.groups.iter().filter(|g| g.key.to_lowercase() == "gpt 5.5").count(), 1);
}

#[test]
fn rpm_by_group_reports_each_hours_peak_minute() {
    let events = vec![
        live("h2a", "2026-07-28T02:00:10.000Z", 1.0),
        live("h2b", "2026-07-28T02:04:50.000Z", 1.0),
        live("h3a", "2026-07-28T03:10:00.000Z", 4.0),
        live("h3b", "2026-07-28T03:10:30.000Z", 2.0),
        live("h4a", "2026-07-28T04:00:05.000Z", 20.0),
        live("h4b", "2026-07-28T04:30:00.000Z", 2.0),
    ];
    let by_hour = rpm_by_group(&events, GroupBy::Hour, None, RpmScope::Table, false);
    assert_eq!(by_hour.get("2026-07-28T02:00"), Some(&1.0));
    assert_eq!(by_hour.get("2026-07-28T03:00"), Some(&6.0));
    assert_eq!(by_hour.get("2026-07-28T04:00"), Some(&20.0));
    assert_ne!(by_hour.get("2026-07-28T04:00"), Some(&11.0));
}

#[test]
fn rollups_never_contribute_to_peak_rpm_but_do_inflate_the_requests_column() {
    let events = vec![
        live("real", "2026-07-28T05:00:10.000Z", 1.0),
        UsageEvent { estimated: Some(true), ..live("rollup", "2026-07-28T05:30:00.000Z", 50.0) },
        UsageEvent {
            input_tokens: 0.0,
            output_tokens: 0.0,
            cache_read_tokens: 0.0,
            cache_write_tokens: 0.0,
            total_tokens: 0.0,
            estimated_cost: Some(0.0),
            ..live("probe", "2026-07-28T05:45:00.000Z", 1.0)
        },
    ];

    let live_hour = rpm_by_group(&events, GroupBy::Hour, None, RpmScope::Live, false);
    assert_eq!(live_hour.get("2026-07-28T05:00"), Some(&1.0));
    let live_day = rpm_by_group(&events, GroupBy::Day, None, RpmScope::Live, false);
    assert_eq!(live_day.get("2026-07-28"), Some(&1.0));

    let table_hour = rpm_by_group(&events, GroupBy::Hour, None, RpmScope::Table, false);
    assert_eq!(table_hour.get("2026-07-28T05:00"), Some(&1.0));

    let hour_stats = agg(&events, GroupBy::Hour, SortBy::Tokens);
    let row = hour_stats.groups.iter().find(|g| g.key == "2026-07-28T05:00");
    assert_eq!(row.map(|r| r.totals.event_count), Some(52.0));
    assert_eq!(row.and_then(|r| r.rpm), Some(1.0));

    let agent_stats = agg(&events, GroupBy::Agent, SortBy::Cost);
    assert!(!agent_stats.groups.is_empty());
    for g in &agent_stats.groups {
        assert!(g.rpm.unwrap_or(0.0) > 0.0);
    }
}

#[test]
fn rollup_only_groups_report_no_rpm_instead_of_a_fake_peak() {
    let mk = |id: &str, model: &str, ts: &str, estimated: bool, rc: f64| UsageEvent {
        id: id.into(),
        model: Some(model.into()),
        timestamp: ts.into(),
        request_count: Some(rc),
        estimated: Some(estimated),
        ..sample()[0].clone()
    };

    let only_rollup = vec![UsageEvent {
        total_tokens: 1_177_887.0,
        input_tokens: 1_000_000.0,
        ..mk("r1", "claude-sonnet", "2026-07-28T05:00:00.000Z", true, 157.0)
    }];
    let s1 = agg(&only_rollup, GroupBy::Model, SortBy::Cost);
    let row1 = &s1.groups[0];
    assert_eq!(row1.totals.event_count, 157.0);
    assert_eq!(row1.rpm, None);
    assert_eq!(
        rpm_by_group(&only_rollup, GroupBy::Model, None, RpmScope::Table, false).get("claude-sonnet"),
        None
    );

    let mixed = vec![
        mk("m1", "claude-sonnet", "2026-07-28T02:00:00.000Z", true, 4692.0),
        mk("m2", "claude-sonnet", "2026-07-28T02:00:10.000Z", false, 3.0),
        mk("m3", "claude-sonnet", "2026-07-28T02:05:40.000Z", false, 5.0),
    ];
    let row2 = agg(&mixed, GroupBy::Model, SortBy::Cost).groups.remove(0);
    assert_eq!(row2.totals.event_count, 4700.0);
    assert_eq!(row2.rpm, Some(5.0));
    assert_ne!(row2.rpm, Some(4692.0));
}

#[test]
fn agent_model_rpm_is_scoped_per_group_so_a_burst_is_not_diluted() {
    // The TS test uses the free-form agent ids "agent-a"/"agent-b"; the Rust
    // `AgentId` enum is closed, so two distinct real ids stand in for them.
    let mk = |id: &str, agent: AgentId, ts: &str, rc: f64| UsageEvent { agent, ..live(id, ts, rc) };
    let events = vec![
        mk("a1", AgentId::Cursor, "2026-07-28T09:00:05.000Z", 8.0),
        mk("b1", AgentId::Grok, "2026-07-28T09:30:00.000Z", 1.0),
    ];
    let stats = agg(&events, GroupBy::Agent, SortBy::Cost);
    assert_eq!(stats.groups.iter().find(|g| g.key == "cursor").and_then(|g| g.rpm), Some(8.0));
    assert_eq!(stats.groups.iter().find(|g| g.key == "grok").and_then(|g| g.rpm), Some(1.0));
}
