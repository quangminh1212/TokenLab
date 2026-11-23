//! Port of the Gist / full-backup half of `tests/backup.security.test.ts`
//! (period stats, hour/day restore rollups, multi-machine merging, builders).

use std::ffi::OsString;
use std::sync::Mutex;
use tokenlab::aggregate::{aggregate, SortBy};
use tokenlab::backup::*;
use tokenlab::config::reset_config_cache;
use tokenlab::types::{AgentId, GroupBy, PricingStatus, UsageEvent};
use tokenlab::util::{filter_by_period, js_date_parse, now_ms, to_iso_string};

/// The builders read the (process-global) config and data dir.
static ENV_LOCK: Mutex<()> = Mutex::new(());
const ENV_KEYS: [&str; 3] = ["XLAB_TOKEN_DATA_DIR", "TOKENLAB_DATA_DIR", "TOKENLAB_CONFIG"];

struct Fixture {
    _dir: tempfile::TempDir,
    saved: Vec<(&'static str, Option<OsString>)>,
    _guard: std::sync::MutexGuard<'static, ()>,
}

impl Fixture {
    fn new() -> Fixture {
        let guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let saved = ENV_KEYS.iter().map(|k| (*k, std::env::var_os(k))).collect();
        let dir = tempfile::Builder::new().prefix("tokenlab-gist-").tempdir().unwrap();
        std::env::remove_var("TOKENLAB_DATA_DIR");
        std::env::set_var("XLAB_TOKEN_DATA_DIR", dir.path());
        std::env::set_var("TOKENLAB_CONFIG", dir.path().join("config.json"));
        reset_config_cache();
        Fixture { _dir: dir, saved, _guard: guard }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        reset_config_cache();
        for (k, v) in &self.saved {
            match v {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
        reset_config_cache();
    }
}

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

fn iso(ms: f64) -> String {
    to_iso_string(ms).unwrap()
}

fn cost(rows: &[UsageEvent]) -> f64 {
    rows.iter().map(|e| e.estimated_cost.unwrap_or(0.0)).sum()
}

const DAY_MS: f64 = 86_400_000.0;

#[test]
fn is_backup_done_today_uses_local_calendar_day() {
    assert!(!is_backup_done_today(None, Some("UTC")));
    assert!(!is_backup_done_today(None, Some("local")));
    let now = iso(now_ms());
    assert!(is_backup_done_today(Some(&now), Some("local")));
    assert!(!is_backup_done_today(Some("2020-01-01T12:00:00.000Z"), Some("UTC")));
}

#[test]
fn build_period_stats_covers_by_model_and_by_agent_for_all_dashboard_periods() {
    let now = now_ms();
    let events = vec![
        evt("p1", |e| {
            e.agent = AgentId::Grok;
            e.model = Some("grok-4.5".into());
            e.timestamp = iso(now - 60_000.0);
            e.input_tokens = 1000.0;
            e.total_tokens = 1100.0;
            e.estimated_cost = Some(2.0);
        }),
        evt("p2", |e| {
            e.agent = AgentId::Windsurf;
            e.model = Some("swe-1-6".into());
            e.timestamp = iso(now - 2.0 * DAY_MS);
            e.input_tokens = 500.0;
            e.total_tokens = 550.0;
            e.estimated_cost = Some(1.0);
        }),
        evt("p3", |e| {
            e.agent = AgentId::Grok;
            e.model = Some("grok-4.5".into());
            e.timestamp = iso(now - 10.0 * DAY_MS);
            e.input_tokens = 200.0;
            e.total_tokens = 220.0;
            e.estimated_cost = Some(0.5);
        }),
    ];
    let stats = build_period_stats(&events, Some("UTC"));
    for key in ["today", "24h", "7d", "30d", "all"] {
        assert!(stats.contains_key(key), "missing period {key}");
    }
    let all = &stats["all"];
    assert!(all.by_model.iter().any(|r| r.key.contains("grok")));
    assert!(all.by_agent.iter().any(|r| r.key == "grok"));
    assert!(all.by_agent.iter().any(|r| r.key == "windsurf"));
    assert_eq!(all.totals.event_count, 3.0);
}

#[test]
fn build_gist_restore_rollups_uses_hour_buckets_for_recent_day_for_older() {
    // Pin `now` at HH:15 so the 30-minute-old and 20-minute-old events always
    // share the same hour bucket regardless of wall-clock minute drift.
    let today = iso(now_ms())[..10].to_string();
    let now = js_date_parse(&format!("{today}T12:15:00.000Z"));
    let events = vec![
        evt("r1", |e| {
            e.agent = AgentId::Grok;
            e.model = Some("grok-4.5 (xAI)".into());
            e.timestamp = iso(now - 30.0 * 60_000.0);
            e.input_tokens = 100.0;
            e.total_tokens = 110.0;
            e.estimated_cost = Some(1.0);
        }),
        evt("r2", |e| {
            e.agent = AgentId::Grok;
            e.model = Some("grok-4.5".into());
            e.timestamp = iso(now - 20.0 * 60_000.0);
            e.input_tokens = 50.0;
            e.total_tokens = 55.0;
            e.estimated_cost = Some(0.5);
        }),
        evt("r3", |e| {
            e.agent = AgentId::Windsurf;
            e.model = Some("swe-1-6".into());
            // older than 8d hour window -> daily bucket
            e.timestamp = iso(now - 12.0 * DAY_MS);
            e.input_tokens = 10.0;
            e.total_tokens = 11.0;
            e.estimated_cost = Some(0.1);
        }),
    ];
    let rollups = build_gist_restore_rollups(&events, now, Some("pc-a"));
    let recent: Vec<&UsageEvent> = rollups.iter().filter(|e| e.source_path.starts_with("backup:gist-hour")).collect();
    let older: Vec<&UsageEvent> = rollups.iter().filter(|e| e.source_path.starts_with("backup:gist-daily")).collect();
    assert!(!recent.is_empty());
    assert_eq!(older.len(), 1);
    let grok = recent.iter().find(|e| e.agent == AgentId::Grok).expect("grok hour rollup");
    assert_eq!(grok.input_tokens, 150.0);
    assert_eq!(grok.estimated_cost, Some(1.5));
    assert_eq!(machine_id_from_event(grok), "pc-a");
    assert_eq!(grok.source_path, "backup:gist-hour:pc-a");
    // alias still works
    assert_eq!(build_daily_agent_model_rollups(&events).len(), build_gist_restore_rollups(&events, now_ms(), None).len());
}

#[test]
fn merge_local_prefer_over_gist_rollups_drops_only_same_machine_gist_when_local_covers_key() {
    let local = vec![evt("local-1", |e| {
        e.agent = AgentId::Grok;
        e.model = Some("grok-4.5".into());
        e.timestamp = "2026-07-15T10:00:00.000Z".into();
        e.input_tokens = 100.0;
        e.total_tokens = 110.0;
        e.estimated_cost = Some(1.0);
        e.source_path = "/real/path".into();
    })];
    let imported = vec![
        evt("gist-same", |e| {
            e.agent = AgentId::Grok;
            e.model = Some("grok-4.5".into());
            e.timestamp = "2026-07-15T12:00:00.000Z".into();
            e.input_tokens = 9999.0;
            e.total_tokens = 9999.0;
            e.estimated_cost = Some(50.0);
            e.source_path = "backup:gist-daily:pc-a".into();
            e.workspace = Some("pc-a".into());
        }),
        evt("gist-other", |e| {
            e.agent = AgentId::Grok;
            e.model = Some("grok-4.5".into());
            e.timestamp = "2026-07-15T12:00:00.000Z".into();
            e.input_tokens = 500.0;
            e.total_tokens = 550.0;
            e.estimated_cost = Some(5.0);
            e.source_path = "backup:gist-daily:pc-b".into();
            e.workspace = Some("pc-b".into());
        }),
        evt("gist-2", |e| {
            e.agent = AgentId::Windsurf;
            e.model = Some("swe-1-6".into());
            e.timestamp = "2026-07-14T12:00:00.000Z".into();
            e.input_tokens = 10.0;
            e.total_tokens = 11.0;
            e.estimated_cost = Some(0.1);
            e.source_path = "backup:gist-hour:pc-a".into();
            e.workspace = Some("pc-a".into());
        }),
    ];
    let merged = merge_local_prefer_over_gist_rollups(&local, &imported, Some("pc-a"));
    let has = |id: &str| merged.iter().any(|e| e.id == id);
    assert!(has("local-1"));
    assert!(has("gist-other"), "other machine always kept");
    assert!(has("gist-2"), "uncovered agent kept");
    assert!(!has("gist-same"), "same-machine covered rollup dropped");
}

#[test]
fn foreign_imported_router_usage_remains_additive_through_reconciliation() {
    let local = vec![evt("local-router", |e| {
        e.agent = AgentId::Routerlab;
        e.model = Some("gpt-5.5".into());
        e.timestamp = "2026-07-15T12:00:00.000Z".into();
        e.input_tokens = 100.0;
        e.total_tokens = 110.0;
        e.estimated_cost = Some(10.0);
        e.source_path = "C:/local/router.json".into();
        e.estimated = Some(true);
    })];
    let imported = vec![evt("foreign-router", |e| {
        e.agent = AgentId::Xlabrouter;
        e.model = Some("gpt-5.5".into());
        e.timestamp = "2026-07-15T12:00:00.000Z".into();
        e.input_tokens = 200.0;
        e.total_tokens = 220.0;
        e.estimated_cost = Some(20.0);
        e.source_path = "C:/other-machine/router.json".into();
        e.estimated = Some(true);
    })];

    let merged = merge_local_prefer_over_gist_rollups(&local, &imported, Some("pc-local"));
    let high_water = enforce_monotonic_agent_days(&local, &merged);

    assert_eq!(cost(&high_water), 30.0, "local and foreign-machine usage must be summed");
    assert!(high_water.iter().any(|e| e.machine_scope.as_deref() == Some("foreign-import")));
}

#[test]
fn merge_multi_machine_gist_rollups_sums_two_hosts_and_replaces_same_host() {
    let ts = || iso(now_ms());
    let from_a = build_gist_restore_rollups(
        &[evt("a1", |e| {
            e.agent = AgentId::Grok;
            e.model = Some("grok-4.5".into());
            e.timestamp = ts();
            e.input_tokens = 100.0;
            e.total_tokens = 110.0;
            e.estimated_cost = Some(2.0);
        })],
        now_ms(),
        Some("pc-a"),
    );
    let from_b = build_gist_restore_rollups(
        &[evt("b1", |e| {
            e.agent = AgentId::Grok;
            e.model = Some("grok-4.5".into());
            e.timestamp = ts();
            e.input_tokens = 50.0;
            e.total_tokens = 55.0;
            e.estimated_cost = Some(1.0);
        })],
        now_ms(),
        Some("pc-b"),
    );
    // B uploads after A: remote has A, local is B
    let merged = merge_multi_machine_gist_rollups(&from_b, Some(&from_a), Some("pc-b"));
    assert_eq!(merged.len(), 2, "both machines kept");
    assert!(merged.iter().any(|e| machine_id_from_event(e) == "pc-a"));
    assert!(merged.iter().any(|e| machine_id_from_event(e) == "pc-b"));
    assert_eq!(cost(&merged), 3.0);

    // A re-uploads with higher cost: replaces A's old slice, keeps B
    let from_a2 = build_gist_restore_rollups(
        &[evt("a2", |e| {
            e.agent = AgentId::Grok;
            e.model = Some("grok-4.5".into());
            e.timestamp = ts();
            e.input_tokens = 200.0;
            e.total_tokens = 220.0;
            e.estimated_cost = Some(4.0);
        })],
        now_ms(),
        Some("pc-a"),
    );
    let merged2 = merge_multi_machine_gist_rollups(&from_a2, Some(&merged), Some("pc-a"));
    assert_eq!(merged2.len(), 2);
    let a_row = merged2.iter().find(|e| machine_id_from_event(e) == "pc-a").unwrap();
    assert_eq!(a_row.estimated_cost, Some(4.0));
    let b_row = merged2.iter().find(|e| machine_id_from_event(e) == "pc-b").unwrap();
    assert_eq!(b_row.estimated_cost, Some(1.0));
}

fn bulk(prefix: &str, n: usize) -> Vec<UsageEvent> {
    let now = now_ms();
    (0..n)
        .map(|i| {
            evt(&format!("{prefix}-{i}"), |e| {
                e.agent = if i % 2 == 0 { AgentId::Grok } else { AgentId::Windsurf };
                e.model = Some(if i % 3 == 0 { "grok-4.5" } else { "swe-1-6" }.into());
                e.timestamp = iso(now - (i % 40) as f64 * DAY_MS);
                e.input_tokens = 100.0 + i as f64;
                e.total_tokens = 110.0 + i as f64;
                e.estimated_cost = Some(0.01 * (i as f64 + 1.0));
            })
        })
        .collect()
}

#[tokio::test]
async fn build_gist_full_backup_is_period_stats_and_much_smaller_than_raw_events() {
    let _fx = Fixture::new();
    let events = bulk("bulk", 200);
    let backup = build_gist_full_backup(
        &events,
        GistBackupOpts { machine_id: Some("pc-a".into()), ..Default::default() },
    )
    .await;
    assert_eq!(backup.scope, "period-stats");
    assert_eq!(backup.format_version, 3.0);
    let all = &backup.period_stats.as_ref().expect("periodStats")["all"];
    assert!(!all.by_model.is_empty());
    assert!(!all.by_agent.is_empty());
    let rollups = backup.events.as_ref().map_or(0, |e| e.len());
    assert!(rollups < events.len());
    let meta = backup.meta.as_ref().expect("meta");
    assert_eq!(meta.source_event_count, Some(200.0));
    assert_eq!(meta.machine_id.as_deref(), Some("pc-a"));
    assert!(meta.machines.as_ref().map_or(false, |m| m.iter().any(|x| x == "pc-a")));
    let raw_size = serde_json::to_string(&events).unwrap().len();
    let gist_size = serde_json::to_string(&backup).unwrap().len();
    assert!(gist_size < raw_size, "gist {gist_size} should be < raw {raw_size}");
}

#[tokio::test]
async fn build_full_backup_uses_compact_gist_rollups_instead_of_raw_events() {
    let _fx = Fixture::new();
    let events = bulk("full-bulk", 2_000);
    let backup = build_full_backup(
        &events,
        FullBackupOpts { include_mirrors: Some(false), note: None },
    )
    .await;
    assert_eq!(backup.scope, "full");
    assert_eq!(backup.format_version, 3.0);
    let all = &backup.period_stats.as_ref().expect("periodStats")["all"];
    assert!(!all.by_model.is_empty());
    assert!(!all.by_agent.is_empty());
    let rollups = backup.events.as_ref().map_or(0, |e| e.len());
    assert!(rollups < events.len());
    let meta = backup.meta.as_ref().expect("meta");
    assert_eq!(meta.source_event_count, Some(events.len() as f64));
    assert_eq!(meta.rollup_event_count, Some(rollups as f64));
    assert!(
        meta.note.as_deref().unwrap_or("").contains("raw request rows omitted"),
        "note was {:?}",
        meta.note
    );
    let raw_size = serde_json::to_string(&events).unwrap().len();
    let export_size = serde_json::to_string(&backup).unwrap().len();
    assert!(export_size < raw_size, "export {export_size} should be < raw {raw_size}");
}

#[tokio::test]
async fn build_gist_full_backup_multi_machine_sums_period_stats_cost() {
    let _fx = Fixture::new();
    let now = iso(now_ms());
    let events_a = vec![evt("ma1", |e| {
        e.agent = AgentId::Grok;
        e.model = Some("grok-4.5".into());
        e.timestamp = now.clone();
        e.input_tokens = 1000.0;
        e.total_tokens = 1100.0;
        e.estimated_cost = Some(10.0);
    })];
    let events_b = vec![evt("mb1", |e| {
        e.agent = AgentId::Grok;
        e.model = Some("grok-4.5".into());
        e.timestamp = now.clone();
        e.input_tokens = 500.0;
        e.total_tokens = 550.0;
        e.estimated_cost = Some(5.0);
    })];
    let remote_a = build_gist_full_backup(
        &events_a,
        GistBackupOpts { machine_id: Some("pc-a".into()), ..Default::default() },
    )
    .await;
    let merged = build_gist_full_backup(
        &events_b,
        GistBackupOpts {
            machine_id: Some("pc-b".into()),
            remote_events: remote_a.events.clone(),
            ..Default::default()
        },
    )
    .await;
    let machines = merged.meta.as_ref().and_then(|m| m.machines.clone()).unwrap_or_default();
    assert!(machines.iter().any(|m| m == "pc-a"));
    assert!(machines.iter().any(|m| m == "pc-b"));
    assert_eq!(merged.events.as_ref().map(|e| e.len()), Some(2));
    let all_cost = merged.period_stats.as_ref().map_or(0.0, |s| s["all"].totals.estimated_cost);
    assert!((all_cost - 15.0).abs() < 0.0001, "expected 15 got {all_cost}");
}

#[test]
fn gist_restore_rollups_match_source_totals_for_dashboard_periods() {
    let now = now_ms();
    let events: Vec<UsageEvent> = (0..120)
        .map(|i| {
            evt(&format!("acc-{i}"), |e| {
                e.agent = if i % 2 == 0 { AgentId::Grok } else { AgentId::Devin };
                e.model = Some(if i % 3 == 0 { "grok-4.5" } else { "glm-5-2" }.into());
                e.timestamp = iso(now - i as f64 * 3_600_000.0); // last 120 hours
                e.input_tokens = 100.0 + i as f64;
                e.output_tokens = 10.0;
                e.total_tokens = 110.0 + i as f64;
                e.estimated_cost = Some(0.05 * (i as f64 + 1.0));
            })
        })
        .collect();
    let rollups = build_gist_restore_rollups(&events, now, None);
    for period in [Some("today"), Some("24h"), Some("7d"), Some("30d"), None] {
        let src = aggregate(&filter_by_period(&events, period, None, Some("UTC")), GroupBy::Model, SortBy::Cost, None, None, None, false).totals;
        let rol = aggregate(&filter_by_period(&rollups, period, None, Some("UTC")), GroupBy::Model, SortBy::Cost, None, None, None, false).totals;
        let cost_err = (rol.estimated_cost - src.estimated_cost).abs();
        let tok_err = (rol.total_tokens - src.total_tokens).abs();
        assert!(
            cost_err < 0.0001 && tok_err < 1.0,
            "period {} cost_delta={cost_err} tok_delta={tok_err} src={} rol={}",
            period.unwrap_or("all"),
            src.estimated_cost,
            rol.estimated_cost
        );
    }
}
