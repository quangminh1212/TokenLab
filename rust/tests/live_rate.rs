//! Port of `tests/live-rate.test.ts`.

use serde_json::json;
use std::sync::Mutex;
use tokenlab::live_rate::*;
use tokenlab::types::{AgentId, PricingStatus, UsageEvent};
use tokenlab::util::js_date_parse;

/// Tests that touch TOKENLAB_DATA_DIR (process-global) serialise on this.
static ENV_LOCK: Mutex<()> = Mutex::new(());

fn base() -> UsageEvent {
    UsageEvent {
        id: "t".into(),
        agent: AgentId::Antigravity,
        model: Some("gemini-3.6-flash-high".into()),
        timestamp: "2026-07-31T05:00:00.000Z".into(),
        input_tokens: 1000.0,
        output_tokens: 50.0,
        cache_read_tokens: 0.0,
        cache_write_tokens: 0.0,
        total_tokens: 1050.0,
        estimated_cost: Some(0.01),
        currency: "USD".into(),
        pricing_status: PricingStatus::Priced,
        workspace: None,
        source_path: "/tmp/x".into(),
        request_count: Some(1.0),
        ..Default::default()
    }
}

#[test]
fn is_live_request_event_keeps_real_per_call_rows() {
    let e = UsageEvent { estimated: Some(false), ..base() };
    assert!(is_live_request_event(&e));
}

#[test]
fn is_live_request_event_keeps_estimated_single_turn_antigravity_transcript() {
    let e = UsageEvent {
        estimated: Some(true),
        request_count: Some(1.0),
        input_tokens: 12_000.0,
        output_tokens: 200.0,
        total_tokens: 12_200.0,
        ..base()
    };
    assert!(is_live_request_event(&e));
}

#[test]
fn is_live_request_event_drops_estimated_multi_rq_rollups() {
    let e = UsageEvent {
        estimated: Some(true),
        request_count: Some(500.0),
        input_tokens: 1e6,
        total_tokens: 1e6,
        ..base()
    };
    assert!(!is_live_request_event(&e));
}

#[test]
fn is_live_request_event_drops_multi_million_token_estimated_blobs() {
    let e = UsageEvent {
        estimated: Some(true),
        request_count: Some(1.0),
        input_tokens: 50_000_000.0,
        output_tokens: 1_000_000.0,
        total_tokens: 51_000_000.0,
        ..base()
    };
    assert!(!is_live_request_event(&e));
}

#[tokio::test]
async fn build_recent_live_events_keeps_same_second_requests_and_newest_duplicate() {
    let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // The TS test reads whatever mirrors exist; isolate from the real data dir.
    let empty = tempfile::tempdir().unwrap();
    let previous = std::env::var_os("TOKENLAB_DATA_DIR");
    std::env::set_var("TOKENLAB_DATA_DIR", empty.path());
    clear_hot_mirror_cache();

    let old = UsageEvent { id: "old".into(), timestamp: "2026-07-31T05:00:00.100Z".into(), ..base() };
    let newest = UsageEvent { id: "newest".into(), timestamp: "2026-07-31T05:00:00.900Z".into(), ..base() };
    let sibling = UsageEvent {
        id: "sibling".into(),
        timestamp: "2026-07-31T05:00:00.901Z".into(),
        input_tokens: 1001.0,
        total_tokens: 1051.0,
        ..base()
    };
    let future = UsageEvent { id: "future-rollup".into(), timestamp: "2026-07-31T05:02:00.000Z".into(), ..base() };
    let stamps: Vec<f64> = [&old, &newest, &sibling, &future].iter().map(|e| js_date_parse(&e.timestamp)).collect();
    let cache = vec![old, newest, sibling, future];

    let events = build_recent_live_events(
        &cache,
        &RecentLiveOptions {
            limit: Some(3.0),
            since_ms: Some(js_date_parse("2026-07-31T04:59:00.000Z")),
            until_ms: Some(js_date_parse("2026-07-31T05:01:00.000Z")),
            now_ms: Some(js_date_parse("2026-07-31T05:01:00.000Z")),
            timestamps_ms: Some(&stamps),
            ..Default::default()
        },
    )
    .await;

    match previous {
        Some(v) => std::env::set_var("TOKENLAB_DATA_DIR", v),
        None => std::env::remove_var("TOKENLAB_DATA_DIR"),
    }
    clear_hot_mirror_cache();

    let ids: Vec<&str> = events.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["sibling", "newest", "old"],
        "millisecond-distinct bursts must not collapse or let an older duplicate win"
    );
}

#[tokio::test]
async fn load_hot_mirror_live_events_reads_json_snapshots_and_invalidates_on_file_changes() {
    let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let data_dir = tempfile::Builder::new().prefix("tokenlab-live-rate-").tempdir().unwrap();
    let mirror = data_dir.path().join("mirrors").join("litellm");
    let file = mirror.join("db.json");
    let sqlite_file = mirror.join("data.sqlite");
    let previous = std::env::var_os("TOKENLAB_DATA_DIR");
    let now_ms = js_date_parse("2026-01-01T00:10:00.000Z");
    let row = |id: &str, timestamp: &str| {
        json!({
            "id": id,
            "timestamp": timestamp,
            "model": "test-model",
            "promptTokens": 100,
            "completionTokens": 10,
            "cost": 0.01
        })
    };

    std::fs::create_dir_all(&mirror).unwrap();
    std::env::set_var("TOKENLAB_DATA_DIR", data_dir.path());
    clear_hot_mirror_cache();

    {
        let sqlite = rusqlite::Connection::open(&sqlite_file).unwrap();
        sqlite
            .execute_batch(
                "CREATE TABLE usageHistory (
                    id INTEGER PRIMARY KEY,
                    timestamp TEXT,
                    provider TEXT,
                    model TEXT,
                    connectionId TEXT,
                    apiKey TEXT,
                    endpoint TEXT,
                    promptTokens INTEGER,
                    completionTokens INTEGER,
                    cost REAL,
                    status TEXT,
                    tokens TEXT,
                    meta TEXT
                )",
            )
            .unwrap();
        sqlite
            .execute(
                "INSERT INTO usageHistory
                   (id, timestamp, model, promptTokens, completionTokens, cost, tokens)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    7,
                    "2026-01-01T00:08:30.000Z",
                    "sqlite-model",
                    200,
                    20,
                    0.02,
                    json!({ "prompt_tokens_details": { "cached_tokens": 50 } }).to_string()
                ],
            )
            .unwrap();
    }
    std::fs::write(
        &file,
        json!({ "usageData": { "history": [row("one", "2026-01-01T00:09:00.000Z")] } }).to_string(),
    )
    .unwrap();

    let first = load_hot_mirror_live_events(now_ms, 60.0, 64.0 * 1024.0).await;

    // Rewrite the JSON snapshot (size changes, so the file signature changes).
    std::fs::write(
        &file,
        json!({
            "usageData": {
                "history": [
                    row("one", "2026-01-01T00:09:00.000Z"),
                    row("two", "2026-01-01T00:09:30.000Z")
                ]
            }
        })
        .to_string(),
    )
    .unwrap();
    let second = load_hot_mirror_live_events(now_ms, 60.0, 64.0 * 1024.0).await;

    match previous {
        Some(v) => std::env::set_var("TOKENLAB_DATA_DIR", v),
        None => std::env::remove_var("TOKENLAB_DATA_DIR"),
    }
    clear_hot_mirror_cache();

    assert!(first.iter().any(|e| e.id.ends_with(":one")), "JSON db history should be visible");
    assert!(first.iter().any(|e| e.id.ends_with(":7")), "SQLite history should be visible");
    assert!(
        second.iter().any(|e| e.id.ends_with(":two")),
        "changed snapshot should be re-read immediately"
    );
}
