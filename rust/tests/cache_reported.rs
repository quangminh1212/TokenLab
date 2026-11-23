//! Port of `tests/cache-reported.test.ts`.

use tokenlab::aggregate::{aggregate, SortBy};
use tokenlab::types::{AgentId, GroupBy, PricingStatus, StatsResult, UsageEvent};

fn ev(id: &str, agent: AgentId, cache_read: f64, cache_reported: Option<bool>) -> UsageEvent {
    UsageEvent {
        id: id.into(),
        agent,
        model: Some("claude-fable-5".into()),
        timestamp: "2026-10-09T01:00:00.000Z".into(),
        input_tokens: 100.0,
        output_tokens: 10.0,
        cache_read_tokens: cache_read,
        cache_write_tokens: 0.0,
        total_tokens: 100.0 + 10.0 + cache_read,
        estimated_cost: Some(0.01),
        currency: "USD".into(),
        pricing_status: PricingStatus::Priced,
        workspace: None,
        source_path: "x".into(),
        cache_reported,
        ..Default::default()
    }
}

fn by_agent(events: &[UsageEvent]) -> StatsResult {
    aggregate(events, GroupBy::Agent, SortBy::Cost, None, None, None, false)
}

#[test]
fn cache_reported_events_counts_only_rows_that_actually_reported_cache() {
    let r = by_agent(&[
        ev("a", AgentId::Dsh, 500.0, Some(true)), // measured
        ev("b", AgentId::Dsh, 0.0, Some(true)),   // measured zero
        ev("c", AgentId::Dsh, 300.0, None),       // untouched -> never reported
    ]);
    let row = r.groups.iter().find(|g| g.key == "dsh").unwrap();
    assert_eq!(row.totals.cache_reported_events, Some(2.0), "only the two flagged rows count");
    assert_eq!(row.totals.cache_read_tokens, 800.0);

    // A group whose rows never mentioned caching stays unset, so the UI keeps the em dash.
    let r2 = by_agent(&[ev("d", AgentId::Litellm, 0.0, None), ev("e", AgentId::Litellm, 0.0, None)]);
    assert_eq!(
        r2.groups.iter().find(|g| g.key == "litellm").unwrap().totals.cache_reported_events,
        None
    );
}

#[test]
fn cache_reported_events_is_absent_not_zero_when_nothing_reported_cache() {
    let r = by_agent(&[ev("f", AgentId::Grok, 0.0, None)]);
    let row = r.groups.iter().find(|g| g.key == "grok").unwrap();
    let n = row.totals.cache_reported_events;
    assert!(n.is_none() || n == Some(0.0), "must stay unset so the dashboard renders an em dash");
    // JS `!row.cacheReportedEvents` is also true for undefined; the serialised row must omit it.
    let json = serde_json::to_value(row).unwrap();
    assert!(json.get("cacheReportedEvents").is_none());
}
