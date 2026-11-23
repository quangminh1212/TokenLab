//! Port of the pure-function half of `tests/backup.security.test.ts`
//! (router daily collapse, monotonic agent-day guards, high-water
//! reconciliation, prune/prefer-richer merging).

use tokenlab::backup::*;
use tokenlab::types::{AgentId, PricingStatus, UsageEvent};

/// Mirror of the TS `evt()` helper: default devin row, overridden by `f`.
fn evt(id: &str, f: impl FnOnce(&mut UsageEvent)) -> UsageEvent {
    let mut e = UsageEvent {
        id: id.to_string(),
        agent: AgentId::Devin,
        model: None,
        timestamp: "2026-07-15T00:00:00.000Z".into(),
        input_tokens: 100.0,
        output_tokens: 10.0,
        cache_read_tokens: 0.0,
        cache_write_tokens: 0.0,
        total_tokens: 110.0,
        estimated_cost: Some(1.0),
        currency: "USD".into(),
        pricing_status: PricingStatus::Priced,
        workspace: None,
        source_path: "/x".into(),
        ..Default::default()
    };
    f(&mut e);
    e
}

fn tok(rows: &[UsageEvent]) -> f64 {
    rows.iter().map(|e| e.total_tokens).sum()
}

fn is_est(e: &UsageEvent) -> bool {
    e.estimated == Some(true)
}

fn sorted_ids(rows: &[UsageEvent]) -> Vec<String> {
    let mut v: Vec<String> = rows.iter().map(|e| e.id.clone()).collect();
    v.sort();
    v
}

fn has(rows: &[UsageEvent], id: &str) -> bool {
    rows.iter().any(|e| e.id == id)
}

#[test]
fn drop_legacy_router_mirror_rows_replaces_old_local_single_root_cache() {
    let old_local = evt("legacy-router", |e| {
        e.agent = AgentId::Routerlab;
        e.source_path = "daily-rollup".into();
        e.input_tokens = 100.0;
        e.total_tokens = 100.0;
    });
    let foreign = evt("foreign-router", |e| {
        e.agent = AgentId::Routerlab;
        e.machine_scope = Some("foreign-import".into());
        e.source_path = "daily-rollup".into();
        e.input_tokens = 200.0;
        e.total_tokens = 200.0;
    });
    let other = evt("other-agent", |e| e.agent = AgentId::Hermes);
    let fresh = vec![
        evt("fresh-primary", |e| {
            e.agent = AgentId::Routerlab;
            e.source_path = "daily-rollup|primary".into();
        }),
        evt("fresh-mirror", |e| {
            e.agent = AgentId::Routerlab;
            e.source_path = "daily-rollup|mirror-a".into();
        }),
    ];
    let kept = drop_legacy_router_mirror_rows(&[old_local.clone(), foreign, other], &fresh);
    assert_eq!(sorted_ids(&kept), vec!["foreign-router", "other-agent"]);

    let current = evt("current-mirror", |e| {
        e.agent = AgentId::Routerlab;
        e.source_path = "request-details.jsonl#mirror-root=mirror-a".into();
        e.input_tokens = 300.0;
        e.total_tokens = 300.0;
    });
    let after_migration = drop_legacy_router_mirror_rows(&[old_local, current], &fresh);
    assert_eq!(
        sorted_ids(&after_migration),
        vec!["current-mirror", "legacy-router"],
        "an additive cache is not re-migrated on every rescan"
    );
}

#[test]
fn collapse_router_daily_events_keeps_richest_estimated_row_per_day_model_workspace() {
    let low = evt("old-daily-low", |e| {
        e.agent = AgentId::Routerlab;
        e.model = Some("mixed".into());
        e.estimated = Some(true);
        e.input_tokens = 1_000.0;
        e.total_tokens = 1_100.0;
        e.estimated_cost = Some(1.0);
        e.timestamp = "2026-07-16T12:00:00.000Z".into();
        e.workspace = Some("provider:test".into());
    });
    let high = evt("old-daily-high", |e| {
        e.agent = AgentId::Routerlab;
        e.model = Some("mixed".into());
        e.estimated = Some(true);
        e.input_tokens = 50_000.0;
        e.total_tokens = 55_000.0;
        e.estimated_cost = Some(20.0);
        e.timestamp = "2026-07-16T15:00:00.000Z".into();
        e.workspace = Some("provider:test".into());
    });
    // Same model, different provider -> kept (not collapsed)
    let other_provider = evt("other-provider", |e| {
        e.agent = AgentId::Routerlab;
        e.model = Some("mixed".into());
        e.estimated = Some(true);
        e.input_tokens = 5_000.0;
        e.total_tokens = 5_500.0;
        e.estimated_cost = Some(2.0);
        e.timestamp = "2026-07-16T12:00:00.000Z".into();
        e.workspace = Some("provider:other".into());
    });
    // Requests smaller than daily -> keep daily (not double)
    let request_same_day = evt("req-same", |e| {
        e.agent = AgentId::Routerlab;
        e.model = Some("gpt-5".into());
        e.estimated = Some(false);
        e.input_tokens = 10.0;
        e.total_tokens = 12.0;
        e.estimated_cost = Some(0.01);
        e.timestamp = "2026-07-16T10:00:00.000Z".into();
    });
    // Day without daily rollup -> kept
    let request_other_day = evt("req-other", |e| {
        e.agent = AgentId::Routerlab;
        e.model = Some("gpt-5".into());
        e.estimated = Some(false);
        e.input_tokens = 10.0;
        e.total_tokens = 12.0;
        e.estimated_cost = Some(0.01);
        e.timestamp = "2026-07-10T10:00:00.000Z".into();
    });
    let merged = collapse_router_daily_events(&[low, high, other_provider, request_same_day, request_other_day]);
    // low+high collapse (same workspace) -> 1 daily; otherProvider kept (diff ws); req-other kept
    assert_eq!(merged.len(), 3);
    let dailies: Vec<&UsageEvent> = merged.iter().filter(|e| is_est(e)).collect();
    assert_eq!(dailies.len(), 2);
    let main_daily = dailies.iter().find(|e| e.workspace.as_deref() == Some("provider:test"));
    assert_eq!(main_daily.map(|e| e.total_tokens), Some(55_000.0));
    assert!(dailies.iter().any(|e| e.id == "other-provider"));
    assert!(!has(&merged, "req-same"));
    assert!(has(&merged, "req-other"));
}

#[test]
fn collapse_router_daily_events_prefers_requests_when_they_exceed_stale_daily() {
    let stale_daily = evt("daily-stale", |e| {
        e.agent = AgentId::NineRouter;
        e.model = Some("mixed".into());
        e.estimated = Some(true);
        e.input_tokens = 1_000.0;
        e.total_tokens = 1_100.0;
        e.estimated_cost = Some(1.0);
        e.timestamp = "2026-07-16T12:00:00.000Z".into();
    });
    let r1 = evt("r1", |e| {
        e.agent = AgentId::NineRouter;
        e.model = Some("gpt-5".into());
        e.estimated = Some(false);
        e.input_tokens = 40_000.0;
        e.total_tokens = 42_000.0;
        e.estimated_cost = Some(10.0);
        e.timestamp = "2026-07-16T08:00:00.000Z".into();
    });
    let r2 = evt("r2", |e| {
        e.agent = AgentId::NineRouter;
        e.model = Some("gpt-5".into());
        e.estimated = Some(false);
        e.input_tokens = 30_000.0;
        e.total_tokens = 31_000.0;
        e.estimated_cost = Some(8.0);
        e.timestamp = "2026-07-16T09:00:00.000Z".into();
    });
    let merged = collapse_router_daily_events(&[stale_daily, r1, r2]);
    assert!(!has(&merged, "daily-stale"));
    assert!(has(&merged, "r1"));
    assert!(has(&merged, "r2"));
    assert_eq!(tok(&merged), 73_000.0);
}

#[test]
fn collapse_router_daily_events_uses_daily_when_request_rows_overshoot_remote_daily() {
    // Remote dashboard dailySummary is authoritative; inflated request history must not win.
    let daily = evt("daily-auth", |e| {
        e.agent = AgentId::Routerlab;
        e.model = Some("mixed".into());
        e.estimated = Some(true);
        e.input_tokens = 130_000_000.0;
        e.total_tokens = 131_000_000.0;
        e.estimated_cost = Some(146.0);
        e.request_count = Some(2805.0);
        e.timestamp = "2026-07-26T12:00:00.000Z".into();
    });
    let mut all = vec![daily];
    for i in 0..50 {
        all.push(evt(&format!("rq-over-{i}"), |e| {
            e.agent = AgentId::Routerlab;
            e.model = Some("gpt-5.6-sol".into());
            e.estimated = Some(false);
            e.input_tokens = 4_000_000.0;
            e.total_tokens = 4_010_000.0;
            e.estimated_cost = Some(10.0);
            e.timestamp = format!("2026-07-26T10:{:02}:00.000Z", i);
        }));
    }
    // 50 * 4.01M = 200.5M > 131M daily -> prefer daily (match VPS dashboard)
    let merged = collapse_router_daily_events(&all);
    assert!(has(&merged, "daily-auth"));
    assert!(!merged.iter().any(|e| e.id.starts_with("rq-over-")));
    assert_eq!(tok(&merged), 131_000_000.0);
}

#[test]
fn collapse_router_daily_events_uses_daily_when_rq_count_inflated_by_zero_token_probes() {
    // RouterLab remote Today: 1 billed RQ; RD has ~35 empty stream successes.
    let daily = evt("daily-tiny", |e| {
        e.agent = AgentId::Routerlab;
        e.model = Some("qwen3.7-max".into());
        e.estimated = Some(true);
        e.input_tokens = 3155.0;
        e.output_tokens = 69.0;
        e.total_tokens = 3224.0;
        e.estimated_cost = Some(0.0017155);
        e.request_count = Some(1.0);
        e.timestamp = "2026-07-27T12:00:00.000Z".into();
    });
    let real = evt("rq-real", |e| {
        e.agent = AgentId::Routerlab;
        e.model = Some("qwen3.7-max".into());
        e.estimated = Some(false);
        e.input_tokens = 3155.0;
        e.output_tokens = 69.0;
        e.total_tokens = 3224.0;
        e.estimated_cost = Some(0.0017155);
        e.timestamp = "2026-07-27T04:28:07.000Z".into();
    });
    let mut all = vec![daily, real];
    for i in 0..34 {
        all.push(evt(&format!("probe-{i}"), |e| {
            e.agent = AgentId::Routerlab;
            e.model = Some("grok-4.5".into());
            e.estimated = Some(false);
            e.input_tokens = 0.0;
            e.output_tokens = 0.0;
            e.total_tokens = 0.0;
            e.estimated_cost = Some(0.0);
            e.timestamp = format!("2026-07-27T04:30:{:02}.000Z", i);
        }));
    }
    let merged = collapse_router_daily_events(&all);
    assert!(has(&merged, "daily-tiny"));
    assert!(!merged.iter().any(|e| e.id.starts_with("probe-")));
    let reqs: f64 = merged
        .iter()
        .map(|e| match e.request_count {
            Some(rc) if rc > 0.0 => rc.floor(),
            _ => 1.0,
        })
        .sum();
    assert_eq!(reqs, 1.0);
}

#[test]
fn collapse_router_daily_events_keeps_multi_rq_detail_and_daily_floor() {
    let daily = evt("daily-fat", |e| {
        e.agent = AgentId::Routerlab;
        e.model = Some("grok-4.5".into());
        e.estimated = Some(true);
        e.input_tokens = 5_000_000.0;
        e.total_tokens = 5_020_000.0;
        e.estimated_cost = Some(50.0);
        e.request_count = Some(99.0);
        e.timestamp = "2026-07-26T12:00:00.000Z".into();
    });
    let mut all = vec![daily];
    for i in 0..25 {
        all.push(evt(&format!("rq-{i}"), |e| {
            e.agent = AgentId::Routerlab;
            e.model = Some("grok-4.5".into());
            e.estimated = Some(false);
            e.input_tokens = 100_000.0;
            e.total_tokens = 100_050.0;
            e.estimated_cost = Some(1.0);
            e.timestamp = format!("2026-07-26T10:{:02}:00.000Z", i);
        }));
    }
    let merged = collapse_router_daily_events(&all);
    // Original giant daily blob replaced by gap-fill remainder
    assert!(!has(&merged, "daily-fat"));
    let live: Vec<&UsageEvent> = merged.iter().filter(|e| !is_est(e)).collect();
    let gap: Vec<&UsageEvent> = merged.iter().filter(|e| is_est(e)).collect();
    assert_eq!(live.len(), 25, "keep individual RQs for RECENT EVENTS");
    assert!(!gap.is_empty(), "gap-fill remainder from daily floor");
    assert!(live.iter().all(|e| e.input_tokens == 100_000.0));
    assert!(tok(&merged) >= 5_020_000.0, "day total must stay at/above daily floor 5.02M");
}

#[test]
fn collapse_router_daily_events_is_idempotent_after_gap_filling() {
    let daily = evt("daily-idempotent", |e| {
        e.agent = AgentId::NineRouter;
        e.model = Some("grok-4.5".into());
        e.estimated = Some(true);
        e.input_tokens = 5_000_000.0;
        e.output_tokens = 20_000.0;
        e.total_tokens = 5_020_000.0;
        e.request_count = Some(99.0);
        e.timestamp = "2026-07-26T12:00:00.000Z".into();
    });
    let mut all = vec![daily];
    for i in 0..25 {
        all.push(evt(&format!("idempotent-rq-{i}"), |e| {
            e.agent = AgentId::NineRouter;
            e.model = Some("grok-4.5".into());
            e.estimated = Some(false);
            e.input_tokens = 100_000.0;
            e.output_tokens = 800.0;
            e.total_tokens = 100_800.0;
            e.timestamp = format!("2026-07-26T10:{:02}:00.000Z", i);
        }));
    }
    let first = collapse_router_daily_events(&all);
    let second = collapse_router_daily_events(&first);
    assert_eq!(tok(&second), tok(&first));
    assert_eq!(second.iter().filter(|e| !is_est(e)).count(), 25);
}

#[test]
fn collapse_router_daily_events_never_shrinks_when_partial_history_reappears() {
    let daily = evt("daily-9r", |e| {
        e.agent = AgentId::NineRouter;
        e.model = Some("Kimi-k3".into());
        e.estimated = Some(true);
        e.input_tokens = 1_000_000.0;
        e.total_tokens = 1_010_000.0;
        e.estimated_cost = Some(20.0);
        e.request_count = Some(50.0);
        e.timestamp = "2026-07-27T12:00:00.000Z".into();
        e.workspace = Some("provider:vip".into());
    });
    // First scan: daily only
    let full = collapse_router_daily_events(&[daily.clone()]);
    let full_tok = tok(&full);
    assert_eq!(full_tok, 1_010_000.0);

    // Later scan: 20 thin RQs (~2% of day) must not replace daily with 20k tokens
    let mut all = vec![daily];
    for i in 0..20 {
        all.push(evt(&format!("thin-{i}"), |e| {
            e.agent = AgentId::NineRouter;
            e.model = Some("Kimi-k3".into());
            e.estimated = Some(false);
            e.input_tokens = 1_000.0;
            e.total_tokens = 1_010.0;
            e.estimated_cost = Some(0.01);
            e.timestamp = format!("2026-07-27T08:{:02}:00.000Z", i);
            e.workspace = Some("provider:vip".into());
        }));
    }
    let mixed = collapse_router_daily_events(&all);
    assert!(tok(&mixed) >= full_tok, "rescan must not drop totals below prior daily floor");
}

#[test]
fn enforce_monotonic_agent_days_keeps_richer_previous_day() {
    let prev = vec![evt("day-rich", |e| {
        e.agent = AgentId::Routerlab;
        e.model = Some("mixed".into());
        e.estimated = Some(true);
        e.input_tokens = 5_000_000.0;
        e.total_tokens = 5_100_000.0;
        e.estimated_cost = Some(100.0);
        e.timestamp = "2026-05-25T12:00:00.000Z".into();
    })];
    let next = vec![
        evt("day-thin", |e| {
            e.agent = AgentId::Routerlab;
            e.model = Some("mixed".into());
            e.estimated = Some(true);
            e.input_tokens = 100_000.0;
            e.total_tokens = 110_000.0;
            e.estimated_cost = Some(2.0);
            e.timestamp = "2026-05-25T12:00:00.000Z".into();
        }),
        evt("day-new", |e| {
            e.agent = AgentId::Routerlab;
            e.model = Some("gpt-5".into());
            e.estimated = Some(true);
            e.input_tokens = 50_000.0;
            e.total_tokens = 55_000.0;
            e.estimated_cost = Some(1.0);
            e.timestamp = "2026-07-27T12:00:00.000Z".into();
        }),
    ];
    let merged = enforce_monotonic_agent_days(&prev, &next);
    assert!(tok(&merged) >= 5_100_000.0, "must keep previous rich day");
    assert!(has(&merged, "day-new"), "must still add new days");
    assert!(merged.iter().any(|e| e.total_tokens >= 5_000_000.0), "rich day row present");
}

#[test]
fn reconcile_scan_cache_high_water_keeps_the_persisted_richer_day_in_ram() {
    let persisted = evt("persisted-high-water", |e| {
        e.agent = AgentId::Codex;
        e.model = Some("gpt-5".into());
        e.timestamp = "2026-10-09T01:00:00.000Z".into();
        e.input_tokens = 500.0;
        e.output_tokens = 50.0;
        e.total_tokens = 550.0;
    });
    let thinner = evt("fresh-thinner", |e| {
        e.agent = AgentId::Codex;
        e.model = Some("gpt-5".into());
        e.timestamp = "2026-10-09T02:00:00.000Z".into();
        e.input_tokens = 100.0;
        e.output_tokens = 10.0;
        e.total_tokens = 110.0;
    });
    let reconciled = reconcile_scan_cache_high_water(&[persisted], &[thinner]);
    assert_eq!(tok(&reconciled), 550.0, "a thinner parser pass must not lower the persisted daily high-water");
    assert!(has(&reconciled, "persisted-high-water"));
}

#[test]
fn enforce_monotonic_agent_days_keeps_a_fuller_router_daily_floor_over_a_short_history_tail() {
    let day = "2026-07-26T12:00:00.000Z";
    let tail: Vec<UsageEvent> = (0..5)
        .map(|i| {
            evt(&format!("router-tail-{i}"), |e| {
                e.agent = AgentId::Routerlab;
                e.model = Some("gpt-5.6-sol".into());
                e.timestamp = day.into();
                e.input_tokens = 80_000.0;
                e.output_tokens = 1_000.0;
                e.total_tokens = 81_000.0;
                e.estimated = Some(false);
            })
        })
        .collect();
    let daily = evt("router-daily-full", |e| {
        e.agent = AgentId::Routerlab;
        e.model = Some("gpt-5.6-sol".into());
        e.timestamp = day.into();
        e.input_tokens = 130_830_102.0;
        e.output_tokens = 844_310.0;
        e.total_tokens = 131_674_412.0;
        e.estimated = Some(true);
        e.request_count = Some(2_805.0);
    });
    let merged = enforce_monotonic_agent_days(&tail, &[daily]);
    assert_eq!(tok(&merged), 131_674_412.0, "a full daily envelope must replace a short persisted request tail");
    assert!(has(&merged, "router-daily-full"));
}

#[test]
fn enforce_monotonic_agent_days_keeps_a_router_cache_recovery_instead_of_reverting_it() {
    const DAY: &str = "2026-07-31T12:00:00.000Z";
    let stale = evt("litellm-daily-stale", |e| {
        e.agent = AgentId::Litellm;
        e.model = Some("kimi-k3".into());
        e.estimated = Some(true);
        e.input_tokens = 1_209_500_081.0;
        e.output_tokens = 6_795_583.0;
        e.cache_read_tokens = 1_088_118_336.0;
        e.total_tokens = 1_209_500_081.0 + 6_795_583.0 + 1_088_118_336.0;
        e.estimated_cost = Some(467.01);
        e.timestamp = DAY.into();
    });
    let recovered = evt("litellm-daily-recovered", |e| {
        e.agent = AgentId::Litellm;
        e.model = Some("kimi-k3".into());
        e.estimated = Some(true);
        e.input_tokens = 121_381_745.0;
        e.output_tokens = 6_795_583.0;
        e.cache_read_tokens = 1_088_118_336.0;
        e.total_tokens = 121_381_745.0 + 6_795_583.0 + 1_088_118_336.0;
        e.estimated_cost = Some(467.01);
        e.timestamp = DAY.into();
    });
    let remainder = evt("litellm-daily-remainder", |e| {
        e.agent = AgentId::Litellm;
        e.model = Some("unattributed".into());
        e.estimated = Some(true);
        e.input_tokens = 0.0;
        e.output_tokens = 0.0;
        e.cache_read_tokens = 1_088_181_952.0;
        e.total_tokens = 1_088_181_952.0;
        e.estimated_cost = Some(0.0);
        e.timestamp = DAY.into();
    });

    // prev = stale half-cache snapshot, next = corrected parser output.
    let merged = enforce_monotonic_agent_days(&[stale], &[recovered.clone(), remainder]);
    let cache: f64 = merged.iter().map(|e| e.cache_read_tokens).sum();
    assert_eq!(
        cache,
        1_088_118_336.0 + 1_088_181_952.0,
        "the recovered cache must not be reverted by the high-water guard"
    );
    assert!(has(&merged, "litellm-daily-recovered"), "the recovered row must be present");

    // Guard still protects genuinely richer history (billed tokens differ).
    let richer = evt("litellm-daily-richer", |e| {
        e.agent = AgentId::Litellm;
        e.model = Some("kimi-k3".into());
        e.estimated = Some(true);
        e.input_tokens = 2_419_000_162.0;
        e.output_tokens = 6_795_583.0;
        e.cache_read_tokens = 0.0;
        e.total_tokens = 2_419_000_162.0 + 6_795_583.0;
        e.estimated_cost = Some(900.0);
        e.timestamp = DAY.into();
    });
    let kept = enforce_monotonic_agent_days(&[recovered], &[richer]);
    assert!(has(&kept, "litellm-daily-richer"), "a genuinely richer billed day must still win");
}

#[test]
fn prune_stale_source_events_drops_prev_rows_a_fresh_scan_re_parsed() {
    let previous = vec![
        evt("stale-aggregate", |e| {
            e.agent = AgentId::Hermes;
            e.source_path = "C:/hermes/state.db".into();
            e.request_count = Some(3135.0);
            e.total_tokens = 872_000_000.0;
        }),
        evt("other-source", |e| {
            e.agent = AgentId::Hermes;
            e.source_path = "C:/hermes/profiles/other/state.db".into();
            e.request_count = Some(7.0);
        }),
        evt("gist-backup", |e| {
            e.agent = AgentId::Hermes;
            e.source_path = "backup:gist-daily:quang".into();
            e.request_count = Some(2.0);
        }),
    ];
    let fresh = vec![
        evt("split-0", |e| {
            e.agent = AgentId::Hermes;
            e.source_path = "C:/hermes/state.db".into();
            e.request_count = Some(3.0);
        }),
        evt("split-1", |e| {
            e.agent = AgentId::Hermes;
            e.source_path = "C:/hermes/state.db".into();
            e.request_count = Some(4.0);
        }),
    ];

    let pruned = prune_stale_source_events(&previous, &fresh);
    assert!(!has(&pruned, "stale-aggregate"), "rows whose source was re-parsed must be dropped, not kept by id");
    assert!(has(&pruned, "other-source"), "sources the scan did not cover must survive untouched");
    assert!(has(&pruned, "gist-backup"), "backup/gist rows have synthetic sources and must never be pruned");

    // A row the fresh scan still produces is kept (same id), and an empty fresh
    // list is a no-op so a failed scan can never wipe history.
    assert_eq!(prune_stale_source_events(&previous, &[]).len(), previous.len());
    let same_id = vec![evt("stale-aggregate", |e| {
        e.agent = AgentId::Hermes;
        e.source_path = "C:/hermes/state.db".into();
    })];
    assert!(has(&prune_stale_source_events(&previous, &same_id), "stale-aggregate"), "same-id rows are preserved");
}

#[test]
fn collapse_router_daily_events_drops_mixed_when_model_rows_cover_the_day() {
    let ts = "2026-05-25T12:00:00.000Z";
    let mixed = evt("mixed-blob", |e| {
        e.agent = AgentId::Routerlab;
        e.model = Some("mixed".into());
        e.estimated = Some(true);
        e.input_tokens = 1_000_000.0;
        e.total_tokens = 1_000_000.0;
        e.estimated_cost = Some(10.0);
        e.timestamp = ts.into();
    });
    let m1 = evt("m1", |e| {
        e.agent = AgentId::Routerlab;
        e.model = Some("gpt-5.5".into());
        e.estimated = Some(true);
        e.input_tokens = 600_000.0;
        e.total_tokens = 600_000.0;
        e.estimated_cost = Some(6.0);
        e.timestamp = ts.into();
    });
    let m2 = evt("m2", |e| {
        e.agent = AgentId::Routerlab;
        e.model = Some("claude-opus-4.7".into());
        e.estimated = Some(true);
        e.input_tokens = 400_000.0;
        e.total_tokens = 400_000.0;
        e.estimated_cost = Some(4.0);
        e.timestamp = ts.into();
    });
    let merged = collapse_router_daily_events(&[mixed, m1, m2]);
    assert!(!has(&merged, "mixed-blob"));
    assert_eq!(merged.len(), 2);
    assert_eq!(tok(&merged), 1_000_000.0);
}

#[test]
fn prefer_richer_event_fills_null_model_even_when_default_cost_is_higher() {
    let stale = evt("same", |e| {
        e.model = None;
        e.estimated_cost = Some(5.0);
        e.total_tokens = 110.0;
    });
    let fresh = evt("same", |e| {
        e.model = Some("glm-5-2".into());
        e.estimated_cost = Some(0.2);
        e.total_tokens = 110.0;
    });
    let kept = prefer_richer_event(&stale, &fresh);
    assert_eq!(kept.model.as_deref(), Some("glm-5-2"));
    assert_eq!(kept.estimated_cost, Some(0.2));
}

#[test]
fn prefer_richer_event_keeps_cache_provenance_when_token_totals_are_unchanged() {
    let stale = evt("same-cache", |e| {
        e.agent = AgentId::Codex;
        e.input_tokens = 100.0;
        e.output_tokens = 10.0;
        e.cache_read_tokens = 900.0;
        e.total_tokens = 1_010.0;
        e.cache_reported = None;
    });
    let fresh = evt("same-cache", |e| {
        e.agent = AgentId::Codex;
        e.input_tokens = 100.0;
        e.output_tokens = 10.0;
        e.cache_read_tokens = 900.0;
        e.total_tokens = 1_010.0;
        e.cache_reported = Some(true);
    });
    assert!(std::ptr::eq(prefer_richer_event(&stale, &fresh), &fresh));
    assert!(std::ptr::eq(prefer_richer_event(&fresh, &stale), &fresh));
}

#[test]
fn enforce_monotonic_agent_days_keeps_cache_provenance_on_an_equal_envelope() {
    let stale = evt("stale-cache-day", |e| {
        e.agent = AgentId::Opencode;
        e.model = Some("XLab".into());
        e.timestamp = "2026-10-09T01:00:00.000Z".into();
        e.input_tokens = 100.0;
        e.output_tokens = 10.0;
        e.cache_read_tokens = 900.0;
        e.total_tokens = 1_010.0;
        e.cache_reported = None;
    });
    let fresh = evt("fresh-cache-day", |e| {
        e.agent = AgentId::Opencode;
        e.model = Some("XLab".into());
        e.timestamp = "2026-10-09T02:00:00.000Z".into();
        e.input_tokens = 100.0;
        e.output_tokens = 10.0;
        e.cache_read_tokens = 900.0;
        e.total_tokens = 1_010.0;
        e.cache_reported = Some(true);
    });
    let merged = enforce_monotonic_agent_days(&[stale], &[fresh.clone()]);
    assert_eq!(merged, vec![fresh]);
}

#[test]
fn enforce_monotonic_agent_days_upgrades_same_id_cache_markers_on_a_richer_day() {
    let stale = evt("same-cache-richer-day", |e| {
        e.agent = AgentId::Windsurf;
        e.model = Some("swe-1-6".into());
        e.timestamp = "2026-10-09T01:00:00.000Z".into();
        e.input_tokens = 2_000.0;
        e.output_tokens = 100.0;
        e.cache_read_tokens = 900.0;
        e.total_tokens = 3_000.0;
        e.cache_reported = None;
    });
    let fresh = evt("same-cache-richer-day", |e| {
        e.agent = AgentId::Windsurf;
        e.model = Some("swe-1-6".into());
        e.timestamp = "2026-10-09T01:00:00.000Z".into();
        e.input_tokens = 1_000.0;
        e.output_tokens = 100.0;
        e.cache_read_tokens = 900.0;
        e.total_tokens = 2_000.0;
        e.cache_reported = Some(true);
    });
    let merged = enforce_monotonic_agent_days(&[stale], &[fresh]);
    assert_eq!(merged[0].total_tokens, 3_000.0);
    assert_eq!(merged[0].cache_reported, Some(true));
}

#[test]
fn merge_events_by_id_prefer_richer_upgrades_null_model_cache_rows() {
    let cached = vec![
        evt("a", |e| {
            e.model = None;
            e.estimated_cost = Some(9.0);
            e.input_tokens = 50.0;
            e.total_tokens = 60.0;
        }),
        evt("b", |e| {
            e.model = Some("swe-1-6".into());
            e.estimated_cost = Some(1.0);
            e.input_tokens = 50.0;
            e.total_tokens = 60.0;
        }),
    ];
    let scanned = vec![
        evt("a", |e| {
            e.model = Some("kimi-k2-7".into());
            e.estimated_cost = Some(0.5);
            e.input_tokens = 50.0;
            e.total_tokens = 60.0;
        }),
        evt("b", |e| {
            e.model = Some("swe-1-6".into());
            e.estimated_cost = Some(1.0);
            e.input_tokens = 50.0;
            e.total_tokens = 60.0;
        }),
    ];
    let merged = merge_events_by_id_prefer_richer(&[&scanned, &cached]);
    let a = merged.iter().find(|e| e.id == "a").unwrap();
    let b = merged.iter().find(|e| e.id == "b").unwrap();
    assert_eq!(a.model.as_deref(), Some("kimi-k2-7"));
    assert_eq!(b.model.as_deref(), Some("swe-1-6"));
}
