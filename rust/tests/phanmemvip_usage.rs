//! Port of `tests/phanmemvip-usage.test.ts`.

use serde_json::json;
use tokenlab::server::phanmemvip_usage::{resolve_phanmemvip_usage, PhanmemvipUsage};
use tokenlab::types::{AgentId, PricingStatus, UsageEvent};

fn usage_event(id: &str, agent: AgentId, model: &str, timestamp: &str) -> UsageEvent {
    UsageEvent {
        id: id.into(),
        agent,
        model: Some(model.into()),
        timestamp: timestamp.into(),
        input_tokens: 1.0,
        output_tokens: 1.0,
        cache_read_tokens: 0.0,
        cache_write_tokens: 0.0,
        total_tokens: 2.0,
        estimated_cost: Some(0.0),
        currency: "USD".into(),
        pricing_status: PricingStatus::Priced,
        workspace: None,
        source_path: "test".into(),
        ..Default::default()
    }
}

#[test]
fn stale_zero_mirror_falls_back_to_todays_phanmemvip_litellm_minutes() {
    let mirror = json!({
        "date": "2026-10-13",
        "usedMinutes": 0,
        "limitMinutes": 1070,
        "updatedAt": null
    });
    let mut rollup = usage_event("daily-rollup", AgentId::Litellm, "claude-fable-5", "2026-10-12T17:07:00.000Z");
    rollup.estimated = Some(true);
    rollup.request_count = Some(500.0);

    let events = vec![
        usage_event("fable-1", AgentId::Litellm, "claude-fable-5", "2026-10-12T17:03:05.000Z"),
        usage_event("sonnet-same-minute", AgentId::Litellm, "pmv-sonnet-5", "2026-10-12T17:03:58.000Z"),
        usage_event("opus-next-minute", AgentId::Litellm, "claude-opus-4.7", "2026-10-12T17:04:00.000Z"),
        usage_event("other-provider", AgentId::Litellm, "mintrouter-big-pickle", "2026-10-12T17:05:00.000Z"),
        usage_event("other-agent", AgentId::Codex, "claude-fable-5", "2026-10-12T17:06:00.000Z"),
        rollup,
        usage_event("previous-vietnam-day", AgentId::Litellm, "claude-fable-5", "2026-10-12T16:59:59.000Z"),
    ];

    let result = resolve_phanmemvip_usage(mirror.as_object(), &events, "2026-10-13");
    assert_eq!(
        result,
        PhanmemvipUsage {
            date: "2026-10-13".into(),
            used_minutes: Some(2.0),
            limit_minutes: 1070.0,
            updated_at: Some("2026-10-12T17:04:00.000Z".into()),
        }
    );
    // Wire shape matches the TS object.
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        json!({
            "date": "2026-10-13",
            "usedMinutes": 2,
            "limitMinutes": 1070,
            "updatedAt": "2026-10-12T17:04:00.000Z"
        })
    );
}

#[test]
fn current_mirror_and_request_history_use_the_greater_active_minute_count() {
    let mirror = json!({
        "date": "2026-10-13",
        "minutes": ["07:00", "07:01", "07:02", "07:03"],
        "usedMinutes": 4,
        "updatedAt": "2026-10-13T04:10:00.000Z"
    });
    let events = vec![usage_event("fable-1", AgentId::Litellm, "claude-fable-5", "2026-10-12T17:03:05.000Z")];
    let result = resolve_phanmemvip_usage(mirror.as_object(), &events, "2026-10-13");
    assert_eq!(result.used_minutes, Some(4.0));
    assert_eq!(result.updated_at.as_deref(), Some("2026-10-13T04:10:00.000Z"));
}

#[test]
fn no_current_mirror_evidence_or_matching_events_does_not_fabricate_zero() {
    let mirror = json!({ "date": "2026-10-13", "usedMinutes": 0, "updatedAt": null });
    let result = resolve_phanmemvip_usage(mirror.as_object(), &[], "2026-10-13");
    assert_eq!(result.used_minutes, None);
    assert_eq!(result.updated_at, None);
}
