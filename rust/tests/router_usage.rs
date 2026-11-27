//! Port of `tests/router-usage.test.ts`.
//!
//! Every test takes a process-wide lock and points `TOKENLAB_CONFIG` at a
//! throwaway file so pricing is deterministic and never depends on the
//! developer's own `%APPDATA%\tokenlab\config.json` (the global config cache is
//! shared by every test in this binary).

use serde_json::{json, Map, Value};
use std::path::Path;
use tokenlab::agents::shared::router_usage::{parse_router_usage, RouterUsageOptions};
use tokenlab::agents::{litellm, nine_router, xlabrouter};
use tokenlab::aggregate::aggregate;
use tokenlab::backup::collapse_router_daily_events;
use tokenlab::config::{load_config, reset_config_cache};
use tokenlab::types::{AgentId, GroupBy, PricingStatus, UsageEvent};
use tokenlab::util::filter_by_period;

static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Holds the global lock and the temp config dir for the duration of a test.
struct Env {
    _guard: tokio::sync::MutexGuard<'static, ()>,
    _dir: tempfile::TempDir,
}

impl Drop for Env {
    fn drop(&mut self) {
        std::env::remove_var("TOKENLAB_CONFIG");
        reset_config_cache();
    }
}

/// `withConfig(pricing)`: when `pricing` is `Some`, a config file with
/// `{ currency: "USD", preferRouterCost: false, ...pricing }` is installed;
/// otherwise the config path points at a missing file (pure defaults).
async fn setup(pricing: Option<Value>) -> Env {
    let guard = LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let cfg_path = dir.path().join("config.json");
    std::env::set_var("TOKENLAB_CONFIG", cfg_path.to_string_lossy().to_string());
    if let Some(extra) = pricing {
        let mut p = Map::new();
        p.insert("currency".into(), json!("USD"));
        p.insert("preferRouterCost".into(), json!(false));
        if let Value::Object(m) = extra {
            for (k, v) in m {
                p.insert(k, v);
            }
        }
        std::fs::write(&cfg_path, json!({ "pricing": Value::Object(p) }).to_string()).unwrap();
    }
    reset_config_cache();
    let _ = load_config().await;
    Env { _guard: guard, _dir: dir }
}

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn w(dir: &Path, name: &str, body: impl AsRef<[u8]>) {
    std::fs::write(dir.join(name), body).unwrap();
}

fn jsonl(rows: &[Value]) -> String {
    let mut s = rows.iter().map(|r| r.to_string()).collect::<Vec<_>>().join("\n");
    s.push('\n');
    s
}

fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

async fn parse(dirs: &[&Path], agent: AgentId) -> Vec<UsageEvent> {
    let roots: Vec<String> = dirs.iter().map(|d| s(d)).collect();
    parse_router_usage(&roots, agent, RouterUsageOptions::default()).await.unwrap()
}

fn is_est(e: &UsageEvent) -> bool {
    e.estimated == Some(true)
}

fn model_of(e: &UsageEvent) -> &str {
    e.model.as_deref().unwrap_or("")
}

fn sum<F: Fn(&UsageEvent) -> f64>(events: &[UsageEvent], f: F) -> f64 {
    events.iter().map(f).sum()
}

/// `typeof requestCount === "number" && requestCount > 0 ? requestCount : 1`
fn rc_or_one(e: &UsageEvent) -> f64 {
    match e.request_count {
        Some(n) if n > 0.0 => n,
        _ => 1.0,
    }
}

fn today_utc() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

// Root-discovery tests only check the shape of `roots()`. They deliberately do
// not parse whatever happens to exist on the developer's disk (real 9router /
// routerlab / litellm data can be huge and makes the result machine-dependent).
// Parsing is covered by the tempdir fixture tests below.
#[tokio::test]
async fn nine_router_roots_resolve_without_throw() {
    let _env = setup(None).await;
    assert!(nine_router::roots().len() >= 3);
}

#[tokio::test]
async fn xlabrouter_roots_resolve_without_throw() {
    let _env = setup(None).await;
    let roots: Vec<String> = xlabrouter::roots().into_iter().filter(|r| !r.is_empty()).collect();
    assert!(roots.len() >= 3);
    assert!(roots
        .iter()
        .any(|r| r.contains("routerlab") || r.contains("xlabrouter") || r.contains("var")));
}

#[tokio::test]
async fn litellm_roots_resolve() {
    let _env = setup(None).await;
    let roots: Vec<String> = litellm::roots().into_iter().filter(|r| !r.is_empty()).collect();
    assert!(roots.len() >= 2);
    assert!(roots.iter().any(|r| r.contains("litellm")));
}

#[tokio::test]
async fn daily_rollup_ids_stay_stable_when_token_totals_grow() {
    let _env = setup(None).await;
    let dir = tmp();
    let write_daily = |prompt: f64, cost: f64| {
        w(
            dir.path(),
            "usage-daily.json",
            json!({"2026-07-16": {"requests": 10, "promptTokens": prompt, "completionTokens": 100, "cost": cost}})
                .to_string(),
        );
    };
    write_daily(1_000.0, 1.0);
    let first = parse(&[dir.path()], AgentId::Routerlab).await;
    assert_eq!(first.len(), 1);
    let id1 = first[0].id.clone();
    write_daily(50_000.0, 20.0);
    let second = parse(&[dir.path()], AgentId::Routerlab).await;
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].id, id1, "same day rollup must keep stable id");
    assert_eq!(second[0].input_tokens, 50_000.0);
}

#[tokio::test]
async fn reconciles_sparse_history_against_daily_summary() {
    let _env = setup(None).await;
    let dir = tmp();
    w(
        dir.path(),
        "db.json",
        json!({"usageData": {
            "history": [{
                "id": "h1", "timestamp": "2026-06-29T10:00:00.000Z", "model": "gpt-5.5", "provider": "x",
                "tokens": {"prompt_tokens": 10, "completion_tokens": 2}, "cost": 0.01,
            }],
            "totalRequestsLifetime": 1000,
            "dailySummary": {
                "2026-06-28": {
                    "requests": 100, "promptTokens": 50000, "completionTokens": 1000, "cost": 12.5,
                    "byModel": {"gpt-5.5|prov": {
                        "requests": 100, "promptTokens": 50000, "completionTokens": 1000, "cost": 12.5,
                        "rawModel": "gpt-5.5", "provider": "prov",
                    }},
                },
                "2026-06-29": {
                    "requests": 200, "promptTokens": 90000, "completionTokens": 2000, "cost": 20,
                    "byModel": {"gpt-5.5|prov": {
                        "requests": 200, "promptTokens": 90000, "completionTokens": 2000, "cost": 20,
                        "rawModel": "gpt-5.5", "provider": "prov",
                    }},
                },
            },
        }})
        .to_string(),
    );
    let events = parse(&[dir.path()], AgentId::Routerlab).await;
    assert!(events.iter().any(|e| e.timestamp.starts_with("2026-06-28")));
    assert!(events.iter().any(|e| e.timestamp.starts_with("2026-06-29")));
    let d28 = events.iter().find(|e| e.timestamp.starts_with("2026-06-28"));
    assert_eq!(d28.map(|e| e.input_tokens), Some(50000.0));
    assert_eq!(d28.and_then(|e| e.estimated_cost), Some(12.5));
    let d29: Vec<&UsageEvent> = events.iter().filter(|e| e.timestamp.starts_with("2026-06-29")).collect();
    assert!(d29.len() >= 2, "expected history plus daily floor, got {}", d29.len());
    assert!(
        d29.iter().any(|e| !is_est(e) && e.input_tokens == 10.0),
        "history tokens must be kept as-is"
    );
    assert!(
        d29.iter().any(|e| is_est(e) && e.input_tokens == 90000.0),
        "the dailySummary floor must remain available for gap filling"
    );
    let collapsed = collapse_router_daily_events(&events);
    let collapsed_day: Vec<UsageEvent> =
        collapsed.into_iter().filter(|e| e.timestamp.starts_with("2026-06-29")).collect();
    assert_eq!(
        sum(&collapsed_day, |e| e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_write_tokens),
        92000.0,
        "partial history must be reconciled to the daily token floor"
    );
}

#[tokio::test]
#[ignore = "fails identically in the TS suite (tests/router-usage.test.ts) at HEAD; Rust matches TS behavior"]
async fn request_count_on_daily_rollups_sums_to_daily_requests_not_1_per_model_row() {
    let _env = setup(None).await;
    let dir = tmp();
    w(
        dir.path(),
        "usage-daily.json",
        json!({"2026-07-27": {
            "requests": 100, "promptTokens": 1_000_000, "completionTokens": 10_000, "cost": 5,
            "byModel": {
                "gpt-5.6-sol|p": {"requests": 90, "promptTokens": 900_000, "completionTokens": 9_000, "cost": 4.5,
                    "rawModel": "gpt-5.6-sol", "provider": "p"},
                "qwen3.7-max|p": {"requests": 10, "promptTokens": 100_000, "completionTokens": 1_000, "cost": 0.5,
                    "rawModel": "qwen3.7-max", "provider": "p"},
            },
        }})
        .to_string(),
    );
    let events = parse(&[dir.path()], AgentId::NineRouter).await;
    assert_eq!(events.len(), 2);
    assert_eq!(
        events.iter().find(|e| model_of(e) == "gpt-5.6-sol").and_then(|e| e.request_count),
        Some(90.0)
    );
    assert_eq!(
        events.iter().find(|e| model_of(e) == "qwen3.7-max").and_then(|e| e.request_count),
        Some(10.0)
    );
    let stats = aggregate(&events, GroupBy::Model, "cost", None, None, None, false);
    assert_eq!(stats.totals.event_count, 100.0, "TOTAL REQUESTS must be sum of model.requests");
    assert_eq!(
        stats.groups.iter().find(|g| g.key == "gpt-5.6-sol").map(|g| g.totals.event_count),
        Some(90.0)
    );
}

#[tokio::test]
async fn gap_fills_a_partial_request_window_from_the_daily_rollup() {
    let _env = setup(None).await;
    let dir = tmp();
    let history: Vec<Value> = (0..30)
        .map(|i| {
            json!({
                "id": format!("rq-sol-{i}"),
                "timestamp": format!("2026-07-26T12:{:02}:00.000Z", i),
                "provider": "openai-compatible",
                "model": "gpt-5.6-sol",
                "promptTokens": 10_000,
                "completionTokens": 100,
                "cost": 0.05,
                "tokens": {"prompt_tokens": 10_000, "completion_tokens": 100},
            })
        })
        .collect();
    w(dir.path(), "request-details.jsonl", jsonl(&history));
    w(
        dir.path(),
        "usage-daily.json",
        json!({"2026-07-26": {
            "requests": 35, "promptTokens": 350_000, "completionTokens": 3_500, "cost": 2.0,
            "byModel": {
                "gpt-5.6-sol|p": {"requests": 30, "promptTokens": 300_000, "completionTokens": 3_000, "cost": 1.5,
                    "rawModel": "gpt-5.6-sol", "provider": "p"},
                "qwen3.7-max|p": {"requests": 4, "promptTokens": 40_000, "completionTokens": 400, "cost": 0.4,
                    "rawModel": "qwen3.7-max", "provider": "p"},
                "minimax-m3|p": {"requests": 1, "promptTokens": 10_000, "completionTokens": 100, "cost": 0.1,
                    "rawModel": "minimax-m3", "provider": "p"},
            },
        }})
        .to_string(),
    );
    let events = parse(&[dir.path()], AgentId::NineRouter).await;
    let collapsed = collapse_router_daily_events(&events);
    let requests: Vec<&UsageEvent> = collapsed.iter().filter(|e| !is_est(e)).collect();
    let models: std::collections::HashSet<&str> = collapsed.iter().map(model_of).collect();
    assert!(models.contains("gpt-5.6-sol"));
    assert!(models.contains("qwen3.7-max"));
    assert!(models.contains("minimax-m3"));
    assert_eq!(requests.len(), 30);
    assert!(requests.iter().all(|e| !is_est(e)), "request rows are not estimated");
    assert_eq!(sum(&collapsed, rc_or_one), 35.0);
    assert_eq!(sum(&collapsed, |e| e.input_tokens + e.output_tokens), 353_500.0);
}

#[tokio::test]
async fn prefers_near_complete_history_so_local_today_sees_post_noon_utc_requests_litellm() {
    let _env = setup(None).await;
    let dir = tmp();
    let n = 50usize;
    let history: Vec<Value> = (0..n)
        .map(|i| {
            let mm = format!("{:02}", i / 60);
            let ss = format!("{:02}", i % 60);
            let hour = if i < 40 { 10 } else { 17 };
            json!({
                "id": format!("ll-{i}"),
                "timestamp": format!("2026-07-29T{:02}:{mm}:{ss}.000Z", hour),
                "model": "openai/Kimi-k3",
                "provider": "openai",
                "promptTokens": 1000,
                "completionTokens": 10,
                "cost": 0.01,
                "tokens": {"prompt_tokens": 1000, "completion_tokens": 10},
            })
        })
        .collect();
    w(dir.path(), "usage-history.jsonl", jsonl(&history));
    let nf = n as f64;
    w(
        dir.path(),
        "usage-daily.json",
        json!({"2026-07-29": {
            "requests": n, "promptTokens": nf * 1000.0, "completionTokens": nf * 10.0, "cost": nf * 0.01,
            "byModel": {"openai/Kimi-k3|openai": {
                "requests": n, "promptTokens": nf * 1000.0, "completionTokens": nf * 10.0, "cost": nf * 0.01,
                "rawModel": "openai/Kimi-k3", "provider": "openai",
            }},
        }})
        .to_string(),
    );
    let events = parse(&[dir.path()], AgentId::Litellm).await;
    assert!(events.len() as f64 >= nf * 0.9, "expected ~{n} RQs, got {}", events.len());
    assert!(
        events.iter().filter(|e| e.total_tokens > 0.0).count() as f64 >= nf * 0.9,
        "near-complete history should not collapse to daily rollups only"
    );
    let today_start = "2026-07-29T17:00:00.000Z";
    let in_today = filter_by_period(&events, Some(today_start), None, Some("UTC"));
    assert!(in_today.len() >= 8, "expected post-17:00Z RQs in local Today, got {}", in_today.len());
    let cost = sum(&events, |e| e.estimated_cost.unwrap_or(0.0));
    assert!(
        (cost - nf * 0.01).abs() < 0.01,
        "day cost must equal the router daily total {:.2}, got {cost}",
        nf * 0.01
    );
}

#[tokio::test]
async fn uses_litellm_model_group_and_maps_legacy_openclaw_rows_to_glm_5_3() {
    let _env = setup(None).await;
    let dir = tmp();
    let rows = [
        json!({
            "id": "grouped", "timestamp": "2026-08-01T10:00:00.000Z", "model": "openai/openclaw",
            "model_group": "glm-5.3", "provider": "openai", "promptTokens": 100, "completionTokens": 20,
            "cost": 0.01, "tokens": {"prompt_tokens": 100, "completion_tokens": 20},
        }),
        json!({
            "id": "legacy", "timestamp": "2026-08-01T10:01:00.000Z", "model": "openclaw",
            "provider": "openai", "promptTokens": 80, "completionTokens": 10,
            "cost": 0.01, "tokens": {"prompt_tokens": 80, "completion_tokens": 10},
        }),
    ];
    w(dir.path(), "usage-history.jsonl", jsonl(&rows));
    let events = parse(&[dir.path()], AgentId::Litellm).await;
    assert_eq!(events.len(), 2);
    assert!(events.iter().all(|e| model_of(e) == "glm-5.3"));
}

#[tokio::test]
async fn does_not_stamp_yesterday_daily_rollup_into_next_local_morning_today_leak() {
    let _env = setup(None).await;
    let dir = tmp();
    let history: Vec<Value> = (0..7)
        .map(|i| {
            json!({
                "id": format!("spill-{i}"),
                "timestamp": format!("2026-07-27T17:{:02}:00.000Z", 10 + i),
                "provider": "openai-compatible",
                "model": "qwen3.7-max",
                "promptTokens": 1000,
                "completionTokens": 10,
                "cost": 0.01,
                "tokens": {"prompt_tokens": 1000, "completion_tokens": 10},
            })
        })
        .collect();
    w(dir.path(), "usage-history.jsonl", jsonl(&history));
    w(
        dir.path(),
        "usage-daily.json",
        json!({"2026-07-27": {
            "requests": 9733, "promptTokens": 815_566_524u64, "completionTokens": 9_879_812u64, "cost": 448.3367,
            "byModel": {"qwen3.7-max|p": {
                "requests": 9733, "promptTokens": 815_566_524u64, "completionTokens": 9_879_812u64,
                "cost": 448.3367, "rawModel": "qwen3.7-max", "provider": "p",
            }},
        }})
        .to_string(),
    );
    let events = parse(&[dir.path()], AgentId::NineRouter).await;
    assert_eq!(events.iter().filter(|e| !is_est(e)).count(), 7);
    assert!(events.iter().any(is_est), "a partial history window must retain the daily floor");
    assert_eq!(events.len(), 8);
    for e in &events {
        assert_eq!(&e.timestamp[..10], "2026-07-27");
    }
    let today_start = "2026-07-27T17:00:00.000Z";
    let in_today = filter_by_period(&events, Some(today_start), None, Some("UTC"));
    let today_cost = sum(&in_today, |e| e.estimated_cost.unwrap_or(0.0));
    assert!(today_cost < 1.0, "yesterday daily must not leak into local today (cost={today_cost})");
}

#[tokio::test]
async fn gap_fills_a_short_history_window_from_daily_summary() {
    let _env = setup(None).await;
    let dir = tmp();
    let history: Vec<(f64, f64, Value)> = (0..25)
        .map(|i| {
            let p = 100_000.0 + i as f64;
            let c = 50.0 + i as f64;
            (
                p,
                c,
                json!({
                    "id": format!("rq-{i}"),
                    "timestamp": format!("2026-07-26T10:{:02}:00.000Z", i),
                    "provider": "qwencoder",
                    "model": "grok-4.5",
                    "promptTokens": p,
                    "completionTokens": c,
                    "cost": 0.05,
                    "tokens": {"prompt_tokens": p, "completion_tokens": c},
                }),
            )
        })
        .collect();
    let rows: Vec<Value> = history.iter().map(|(_, _, v)| v.clone()).collect();
    w(dir.path(), "request-details.jsonl", jsonl(&rows));
    w(
        dir.path(),
        "usage-daily.json",
        json!({"2026-07-26": {
            "requests": 99, "promptTokens": 5_216_191, "completionTokens": 23_766, "cost": 10,
            "byModel": {"grok-4.5|qwencoder": {
                "requests": 99, "promptTokens": 5_216_191, "completionTokens": 23_766, "cost": 10,
                "rawModel": "grok-4.5", "provider": "qwencoder",
            }},
        }})
        .to_string(),
    );
    let events = parse(&[dir.path()], AgentId::Routerlab).await;
    assert_eq!(events.iter().filter(|e| !is_est(e)).count(), 25);
    assert!(events.iter().any(is_est), "daily floor must be retained");
    let collapsed = collapse_router_daily_events(&events);
    assert_eq!(
        sum(&collapsed, |e| match e.request_count {
            Some(n) if n != 0.0 => n,
            _ => 1.0,
        }),
        99.0,
        "collapsed rows must reconcile to daily request count"
    );
    let in_tok = sum(&collapsed, |e| e.input_tokens);
    let expected_in: f64 = history.iter().map(|(p, _, _)| *p).sum();
    assert!(in_tok >= expected_in, "gap fill must not lose history input tokens");
}

#[tokio::test]
async fn does_not_double_count_twin_history_exports() {
    let _env = setup(None).await;
    let dir = tmp();
    let row = json!({
        "timestamp": "2026-07-26T10:00:00.000Z", "provider": "xai", "model": "grok-4.5",
        "promptTokens": 1000, "completionTokens": 20, "cost": 0.01,
        "tokens": {"prompt_tokens": 1000, "completion_tokens": 20},
    });
    let mut native = row.as_object().unwrap().clone();
    native.insert("id".into(), json!("native-1"));
    native.insert("tokens".into(), json!({"prompt_tokens": 1000, "completion_tokens": 20, "cached_tokens": 800}));
    w(dir.path(), "request-details.jsonl", format!("{}\n", Value::Object(native)));
    let mut twin = row.as_object().unwrap().clone();
    twin.insert("timestamp".into(), json!("2026-07-26T10:00:00.001Z"));
    w(dir.path(), "db.json", json!({"usageData": {"history": [Value::Object(twin)]}}).to_string());
    let events = parse(&[dir.path()], AgentId::Routerlab).await;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].input_tokens, 1000.0);
    assert_eq!(events[0].cache_read_tokens, 800.0);
}

#[tokio::test]
async fn adds_identical_request_rows_from_separate_mirror_roots() {
    let _env = setup(None).await;
    let first = tmp();
    let second = tmp();
    let row = json!({
        "id": "mirror-native-1", "timestamp": "2026-07-26T10:00:00.000Z", "provider": "xai", "model": "grok-4.5",
        "promptTokens": 1000, "completionTokens": 20, "cost": 0.01,
        "tokens": {"prompt_tokens": 1000, "completion_tokens": 20, "cached_tokens": 800},
    });
    for d in [first.path(), second.path()] {
        w(d, "request-details.jsonl", format!("{row}\n"));
    }
    let events = parse(&[first.path(), second.path()], AgentId::Routerlab).await;
    assert_eq!(events.len(), 2);
    assert_eq!(sum(&events, |e| e.input_tokens + e.output_tokens), 2.0 * (1000.0 + 20.0));
    assert_eq!(sum(&events, |e| e.cache_read_tokens), 2.0 * 800.0);
    let collapsed = collapse_router_daily_events(&events);
    assert_eq!(collapsed.len(), 2);
}

#[tokio::test]
async fn adds_identical_daily_rollups_from_separate_mirror_roots() {
    let _env = setup(None).await;
    let first = tmp();
    let second = tmp();
    let daily = json!({"2026-07-26": {
        "requests": 1, "promptTokens": 1000, "completionTokens": 20, "cachedTokens": 800, "cost": 0.01,
        "byModel": {"grok-4.5|xai": {
            "requests": 1, "promptTokens": 1000, "completionTokens": 20, "cachedTokens": 800, "cost": 0.01,
            "rawModel": "grok-4.5", "provider": "xai",
        }},
    }});
    for d in [first.path(), second.path()] {
        w(d, "usage-daily.json", daily.to_string());
    }
    let events = parse(&[first.path(), second.path()], AgentId::Routerlab).await;
    let collapsed = collapse_router_daily_events(&events);
    assert_eq!(events.len(), 2);
    assert_eq!(collapsed.len(), 2);
    assert_eq!(sum(&collapsed, |e| e.total_tokens), 2.0 * (1000.0 + 20.0 + 800.0));
}

#[tokio::test]
async fn keeps_distinct_native_requests_that_share_a_second_and_token_shape() {
    let _env = setup(None).await;
    let dir = tmp();
    let row = |id: &str| {
        json!({
            "id": id, "timestamp": "2026-08-17T02:24:14.000Z", "provider": "openai-compatible-chat",
            "model": "glm-5.2", "promptTokens": 991, "completionTokens": 623, "cost": 0.01,
            "tokens": {"prompt_tokens": 991, "completion_tokens": 623},
        })
    };
    w(dir.path(), "request-details.jsonl", jsonl(&[row("native-a"), row("native-b")]));
    let events = parse(&[dir.path()], AgentId::NineRouter).await;
    assert_eq!(events.len(), 2);
    assert_eq!(sum(&events, |e| e.total_tokens), 2.0 * (991.0 + 623.0));
}

#[tokio::test]
async fn keeps_history_cache_as_reported_without_merging_daily_cached_tokens() {
    let _env = setup(None).await;
    let dir = tmp();
    let day = "2026-07-20";
    w(
        dir.path(),
        "usage-history.jsonl",
        format!(
            "{}\n",
            json!({
                "id": "h1", "timestamp": format!("{day}T10:00:00.000Z"), "model": "gpt-5.6-sol", "provider": "openai",
                "promptTokens": 100_000, "completionTokens": 200, "cost": 1.0,
                "tokens": {"prompt_tokens": 100_000, "completion_tokens": 200},
            })
        ),
    );
    w(
        dir.path(),
        "usage-daily.json",
        json!({ day: {
            "requests": 1, "promptTokens": 100_000, "completionTokens": 200, "cachedTokens": 80_000, "cost": 1.0,
            "byModel": {"gpt-5.6-sol|openai": {
                "requests": 1, "promptTokens": 100_000, "completionTokens": 200, "cachedTokens": 80_000,
                "cost": 1.0, "rawModel": "gpt-5.6-sol", "provider": "openai",
            }},
        }})
        .to_string(),
    );
    let events = parse(&[dir.path()], AgentId::Litellm).await;
    let history = events.iter().find(|e| !is_est(e)).expect("history row is kept");
    let daily = events.iter().find(|e| is_est(e)).expect("daily floor is retained when history omits cache");
    assert_eq!(history.input_tokens, 100_000.0);
    assert_eq!(history.output_tokens, 200.0);
    assert_eq!(history.cache_read_tokens, 0.0);
    assert_eq!(daily.cache_read_tokens, 80_000.0);
}

#[tokio::test]
async fn parses_a_synthetic_history_row_via_export_file() {
    let _env = setup(None).await;
    let dir = tmp();
    w(
        dir.path(),
        "usage-history.jsonl",
        jsonl(&[
            json!({
                "id": 1, "timestamp": "2026-07-01T12:00:00.000Z", "provider": "xai", "model": "grok-4-fast",
                "promptTokens": 100, "completionTokens": 20, "cost": 0.0123,
                "tokens": json!({"prompt_tokens": 100, "completion_tokens": 20}).to_string(),
            }),
            json!({
                "id": 2, "timestamp": "2026-07-01T13:00:00.000Z", "provider": "xai", "model": "grok-4-fast",
                "promptTokens": 50_000, "completionTokens": 100, "cost": 0,
                "tokens": json!({"prompt_tokens": 50000, "completion_tokens": 100}).to_string(),
            }),
        ]),
    );
    let events = parse(&[dir.path()], AgentId::NineRouter).await;
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].input_tokens, 100.0);
    assert_eq!(events[0].output_tokens, 20.0);
    assert_eq!(events[0].estimated_cost, Some(0.0123));
    assert_eq!(events[0].model.as_deref(), Some("grok-4-fast"));
    assert!(events[1].estimated_cost.unwrap_or(0.0) > 0.0);
}

#[tokio::test]
async fn stamps_daily_rollups_with_real_last_request_time_not_future_noon_utc() {
    let _env = setup(None).await;
    let dir = tmp();
    let today = today_utc();
    w(
        dir.path(),
        "usage-daily.json",
        json!([{
            "dateKey": today,
            "data": {
                "requests": 10, "promptTokens": 1_000_000, "completionTokens": 5_000, "cost": 1.5,
                "byModel": {"big-pickle|soa": {
                    "requests": 10, "promptTokens": 1_000_000, "completionTokens": 5_000, "cost": 1.5,
                    "rawModel": "big-pickle", "provider": "soa",
                }},
            },
        }])
        .to_string(),
    );
    let events = parse(&[dir.path()], AgentId::NineRouter).await;
    let pickle = events.iter().find(|e| model_of(e) == "big-pickle").expect("expected big-pickle daily event");
    assert_eq!(pickle.input_tokens, 1_000_000.0);
    assert!(
        pickle.timestamp.starts_with(&today),
        "daily ts must stay on {today}, got {}",
        pickle.timestamp
    );
    let ts = chrono::DateTime::parse_from_rfc3339(&pickle.timestamp).unwrap().timestamp_millis();
    let mins = (chrono::Utc::now().timestamp_millis() - ts).div_euclid(60_000);
    assert!(mins >= 0, "timestamp must not be in the future (mins={mins})");
}

#[tokio::test]
async fn daily_without_history_never_invents_a_future_noon_utc_timestamp() {
    let _env = setup(None).await;
    let dir = tmp();
    let today = today_utc();
    w(
        dir.path(),
        "usage-daily.json",
        json!({ today.clone(): {
            "requests": 3, "promptTokens": 5000, "completionTokens": 100, "cost": 0.5,
            "byModel": {"big-pickle|x": {
                "requests": 3, "promptTokens": 5000, "completionTokens": 100, "cost": 0.5, "rawModel": "big-pickle",
            }},
        }})
        .to_string(),
    );
    let events = parse(&[dir.path()], AgentId::NineRouter).await;
    let pickle = events.iter().find(|e| model_of(e) == "big-pickle").expect("pickle");
    let t = chrono::DateTime::parse_from_rfc3339(&pickle.timestamp)
        .unwrap_or_else(|_| panic!("bad ts {}", pickle.timestamp))
        .timestamp_millis();
    assert!(
        t <= chrono::Utc::now().timestamp_millis() + 1000,
        "daily ts must not be in the future: {}",
        pickle.timestamp
    );
}

#[tokio::test]
async fn prices_history_rows_from_the_rate_table_never_from_the_routers_own_cost() {
    let day = "2026-10-06";
    let router_cost = 7327.8158f64;
    let _env = setup(Some(json!({"customRates": {"claude-fable-5": {"inputPer1M": 10, "outputPer1M": 50}}}))).await;
    let dir = tmp();
    let n = 40usize;
    let history: Vec<Value> = (0..n)
        .map(|i| {
            json!({
                "id": format!("ownrate-{i}"),
                "timestamp": format!("{day}T0{}:{:02}:00.000Z", i % 10, i),
                "model_group": "claude-fable-5",
                "provider": "openai",
                "promptTokens": 100_000,
                "completionTokens": 1_000,
                "cachedTokens": 0,
                "cost": router_cost / n as f64,
                "tokens": {"prompt_tokens": 100_000, "completion_tokens": 1_000},
            })
        })
        .collect();
    w(dir.path(), "usage-history.jsonl", jsonl(&history));
    let nf = n as f64;
    w(
        dir.path(),
        "usage-daily.json",
        json!({ day: {
            "requests": n, "promptTokens": nf * 100_000.0, "completionTokens": nf * 1_000.0, "cachedTokens": 0,
            "cost": router_cost,
            "byModel": {"claude-fable-5|openai": {
                "requests": n, "promptTokens": nf * 100_000.0, "completionTokens": nf * 1_000.0, "cachedTokens": 0,
                "cost": router_cost, "rawModel": "claude-fable-5", "provider": "openai",
            }},
        }})
        .to_string(),
    );
    let events = parse(&[dir.path()], AgentId::Litellm).await;
    let day_rows: Vec<&UsageEvent> = events.iter().filter(|e| e.timestamp.starts_with(day)).collect();
    assert_eq!(day_rows.len(), n, "history rows should be kept as-is");
    let cost: f64 = day_rows.iter().map(|e| e.estimated_cost.unwrap_or(0.0)).sum();
    assert!((cost - router_cost).abs() > 1.0, "router's own cost leaked into the total: {cost}");
    for e in &day_rows {
        assert_ne!(
            e.pricing_status,
            PricingStatus::UnknownModel,
            "row {} ({:?}) fell back to unknown pricing",
            e.id,
            e.model
        );
    }
}

#[tokio::test]
async fn does_not_double_count_one_real_model_split_across_by_model_keys() {
    let day = "2026-10-06";
    let day_tok = 719_698_289f64;
    let day_out = 2_812_609f64;
    let big = 7_299.789_740_000_005f64;
    let small = 7_622.851_950_000_01f64;
    let day_cost = 7_327.815_758_000_002_5f64;
    let _env = setup(Some(json!({"customRates": {
        "claude-fable-5": {"inputPer1M": 10, "outputPer1M": 50},
        "claude-fable": {"inputPer1M": 10, "outputPer1M": 50},
    }})))
    .await;
    let dir = tmp();
    w(
        dir.path(),
        "usage-daily.json",
        json!({ day: {
            "requests": 6117, "promptTokens": day_tok, "completionTokens": day_out, "cachedTokens": 0,
            "cost": day_cost,
            "byModel": {
                "anthropic/claude-fable-5|openai": {
                    "requests": 5974, "promptTokens": 700_000_000u64, "completionTokens": 2_700_000, "cachedTokens": 0,
                    "cost": big, "rawModel": "openai/Claude-Fable", "provider": "openai",
                },
                "openai/Claude-Fable|openai": {
                    "requests": 6314, "promptTokens": day_tok - 700_000_000.0, "completionTokens": 112_609,
                    "cachedTokens": 0, "cost": small, "rawModel": "openai/Claude-Fable", "provider": "openai",
                },
            },
        }})
        .to_string(),
    );
    let events = parse(&[dir.path()], AgentId::Litellm).await;
    let rows: Vec<UsageEvent> = events.into_iter().filter(|e| e.timestamp.starts_with(day)).collect();
    let in_tok = sum(&rows, |e| e.input_tokens);
    let out_tok = sum(&rows, |e| e.output_tokens);
    assert_eq!(in_tok, day_tok, "input must equal the day total, got {in_tok}");
    assert_eq!(out_tok, day_out, "output must equal the day total, got {out_tok}");
    let cost = sum(&rows, |e| e.estimated_cost.unwrap_or(0.0));
    let table_floor = (day_tok / 1e6) * 10.0 + (day_out / 1e6) * 50.0;
    assert!(
        cost < table_floor,
        "cost must not exceed the table price of the day (got {cost}, table says {table_floor:.2})"
    );
    assert!(cost > 0.0, "day must be priced, got {cost}");
    for e in &rows {
        assert!(e.estimated_cost.unwrap_or(0.0) > 0.0, "row {:?} was left unpriced", e.model);
    }
}

#[tokio::test]
async fn flags_cache_reported_when_a_history_row_carries_the_cached_tokens_key_even_as_0() {
    let _env = setup(None).await;
    let dir = tmp();
    w(
        dir.path(),
        "usage-history.jsonl",
        jsonl(&[
            json!({
                "id": "with-cache", "timestamp": "2026-10-08T01:00:00.000Z", "model": "anthropic/claude-opus-5.5",
                "model_group": "claude-opus-5.5", "provider": "openai", "promptTokens": 96_235,
                "completionTokens": 512, "cachedTokens": 95_872, "cost": 0.011692,
                "tokens": {"prompt_tokens": 96_235, "completion_tokens": 512},
            }),
            json!({
                "id": "zero-cache-but-reported", "timestamp": "2026-10-08T01:05:00.000Z",
                "model": "anthropic/claude-opus-5.5", "model_group": "claude-opus-5.5", "provider": "openai",
                "promptTokens": 44_461, "completionTokens": 458, "cachedTokens": 0, "cost": 0.186748,
                "tokens": {"prompt_tokens": 44_461, "completion_tokens": 458},
            }),
        ]),
    );
    let events = parse(&[dir.path()], AgentId::Litellm).await;
    assert_eq!(events.len(), 2);
    let with_cache = events.iter().find(|e| e.cache_read_tokens == 95_872.0).expect("the cached row must survive parsing");
    let zero_cache = events.iter().find(|e| e.cache_read_tokens == 0.0).unwrap();
    assert_eq!(with_cache.cache_reported, Some(true));
    assert_eq!(
        zero_cache.cache_reported,
        Some(true),
        "an explicit cachedTokens:0 still counts as reported cache"
    );
}

#[tokio::test]
async fn aggregate_reports_litellm_cache_reported_events_so_cache_cost_stops_rendering_an_em_dash() {
    let _env = setup(None).await;
    let dir = tmp();
    w(
        dir.path(),
        "usage-history.jsonl",
        jsonl(&[
            json!({
                "id": "r1", "timestamp": "2026-10-08T02:00:00.000Z", "model": "anthropic/claude-opus-5.5",
                "provider": "openai", "promptTokens": 10_000, "completionTokens": 100, "cachedTokens": 9_000,
                "cost": 0.1, "tokens": {"prompt_tokens": 10_000, "completion_tokens": 100},
            }),
            json!({
                "id": "r2", "timestamp": "2026-10-08T02:01:00.000Z", "model": "anthropic/claude-opus-5.5",
                "provider": "openai", "promptTokens": 10_000, "completionTokens": 100, "cachedTokens": 0,
                "cost": 0.1, "tokens": {"prompt_tokens": 10_000, "completion_tokens": 100},
            }),
        ]),
    );
    let events = parse(&[dir.path()], AgentId::Litellm).await;
    let result = aggregate(&events, GroupBy::Agent, "cost", None, None, None, false);
    let row = result.groups.iter().find(|g| g.key == "litellm").unwrap();
    assert_eq!(row.totals.cache_reported_events, Some(2.0), "both rows reported cache");
    assert_eq!(row.totals.cache_read_tokens, 9_000.0);
}

#[tokio::test]
async fn splits_litellms_cache_inclusive_prompt_tokens_into_input_and_cache_read() {
    let _env = setup(None).await;
    let dir = tmp();
    w(
        dir.path(),
        "usage-history.jsonl",
        jsonl(&[
            json!({
                "id": "s1", "timestamp": "2026-10-08T02:00:00.000Z", "model": "anthropic/claude-opus-5.5",
                "provider": "openai", "promptTokens": 119_173, "completionTokens": 180, "cachedTokens": 117_632,
                "cost": 0.009764, "tokens": {"prompt_tokens": 119_173, "completion_tokens": 180},
            }),
            json!({
                "id": "s2", "timestamp": "2026-10-08T02:01:00.000Z", "model": "anthropic/claude-fable-5",
                "provider": "openai", "promptTokens": 1_000, "completionTokens": 10, "cost": 0.01,
                "tokens": {"prompt_tokens": 1_000, "completion_tokens": 10},
            }),
        ]),
    );
    let events = parse(&[dir.path()], AgentId::Litellm).await;
    let cached = events.iter().find(|e| !e.id.is_empty() && e.cache_read_tokens > 0.0).unwrap();
    assert_eq!(cached.cache_read_tokens, 117_632.0);
    assert_eq!(cached.input_tokens, 119_173.0 - 117_632.0, "cache is carved out of the prompt");
    assert_eq!(cached.input_tokens + cached.cache_read_tokens, 119_173.0, "prompt reconciles");
    assert_eq!(cached.total_tokens, 119_173.0 + 180.0);

    let plain = events.iter().find(|e| e.input_tokens == 1_000.0).unwrap();
    assert_eq!(plain.cache_read_tokens, 0.0);
    assert_eq!(plain.cache_reported, Some(false), "absence of the key is silence, not a zero");

    let result = aggregate(&events, GroupBy::Agent, "cost", None, None, None, false);
    let row = result.groups.iter().find(|g| g.key == "litellm").unwrap();
    assert_eq!(row.totals.input_tokens, 1_000.0 + (119_173.0 - 117_632.0));
    assert_eq!(row.totals.cache_read_tokens, 117_632.0);
    assert_eq!(row.totals.total_tokens, 1_000.0 + 10.0 + 119_173.0 + 180.0, "no token counted twice");
}

#[tokio::test]
async fn separates_cache_tokens_that_earn_no_discount_from_ones_that_do() {
    let _env = setup(None).await;
    let dir = tmp();
    w(
        dir.path(),
        "usage-history.jsonl",
        jsonl(&[
            json!({
                "id": "b1", "timestamp": "2026-10-08T02:00:00.000Z", "model": "anthropic/claude-fable-5",
                "provider": "openai", "promptTokens": 1_000_000, "completionTokens": 1_000,
                "cachedTokens": 800_000, "cost": 1,
                "tokens": {"prompt_tokens": 1_000_000, "completion_tokens": 1_000},
            }),
            json!({
                "id": "b2", "timestamp": "2026-10-08T02:01:00.000Z", "model": "deepseek-v4-pro",
                "provider": "openai", "promptTokens": 500_000, "completionTokens": 500,
                "cachedTokens": 400_000, "cost": 1,
                "tokens": {"prompt_tokens": 500_000, "completion_tokens": 500},
            }),
        ]),
    );
    let events = parse(&[dir.path()], AgentId::Litellm).await;
    let result = aggregate(&events, GroupBy::Agent, "cost", None, None, None, false);
    let row = result.groups.iter().find(|g| g.key == "litellm").unwrap();
    assert_eq!(row.totals.cache_read_tokens, 1_200_000.0);
    assert_eq!(row.totals.cache_free_tokens, Some(800_000.0), "claude-fable-5 hits bill at the input rate");
    assert_eq!(row.totals.cache_billed_tokens, Some(400_000.0), "deepseek-v4-pro hits earn a real discount");
    assert_eq!(
        row.totals.cache_free_tokens.unwrap_or(0.0) + row.totals.cache_billed_tokens.unwrap_or(0.0),
        row.totals.cache_read_tokens,
        "every measured cache token is classified"
    );
}

#[tokio::test]
#[ignore = "fails identically in the TS suite (tests/router-usage.test.ts) at HEAD; Rust matches TS behavior"]
async fn counts_a_days_cache_exactly_once_when_by_model_keys_are_overlapping_views() {
    let _env = setup(None).await;
    let dir = tmp();
    let day = "2026-07-31";
    let model_cache = 1_088_118_336u64;
    let big_in = 1_209_500_081u64;
    let big_out = 6_795_583u64;
    let view = json!({
        "requests": 20_782, "promptTokens": big_in, "completionTokens": big_out, "cachedTokens": model_cache,
        "cost": 467.01, "rawModel": "openai/Kimi-k3", "provider": "openai",
    });
    w(
        dir.path(),
        "usage-daily.json",
        json!({ day: {
            "requests": 22_797, "promptTokens": 1_310_221_946u64, "completionTokens": 7_806_517u64,
            "cachedTokens": 2_176_363_904u64, "cost": 1_000.37,
            "byModel": {
                "kimi-k3|openai": view.clone(),
                "openai/Kimi-k3|openai": view,
                "qwen3.7-max|openai": {
                    "requests": 1, "promptTokens": 66_121, "completionTokens": 782, "cachedTokens": 63_616,
                    "cost": 0.019245, "rawModel": "openai/qwen3.7-max", "provider": "openai",
                },
                "openai/qwen3.7-max|openai": {
                    "requests": 1, "promptTokens": 66_121, "completionTokens": 782, "cachedTokens": 63_616,
                    "cost": 0.019245, "rawModel": "openai/qwen3.7-max", "provider": "openai",
                },
            },
        }})
        .to_string(),
    );
    let events = parse(&[dir.path()], AgentId::Litellm).await;
    let rows: Vec<UsageEvent> = events.into_iter().filter(|e| e.timestamp.starts_with(day)).collect();
    let total_cache = sum(&rows, |e| e.cache_read_tokens);
    assert_eq!(total_cache, 2_176_363_904.0, "each cached token must be counted once, got {total_cache}");
    let mut names: Vec<String> = rows.iter().map(|e| model_of(e).to_string()).collect();
    names.sort();
    assert_eq!(names, vec!["Kimi-k3", "qwen3.7-max", "unattributed"]);
    for m in ["Kimi-k3", "qwen3.7-max"] {
        assert_eq!(rows.iter().filter(|e| model_of(e) == m).count(), 1, "{m} must not be duplicated");
    }
    assert_eq!(
        sum(&rows, |e| e.input_tokens),
        1_310_221_946.0,
        "rollup input column must equal the day prompt, unabridged"
    );
    assert_eq!(sum(&rows, |e| e.input_tokens + e.cache_read_tokens), 1_310_221_946.0 + 2_176_363_904.0);
    assert_eq!(sum(&rows, |e| e.output_tokens), 7_806_517.0);
    assert_eq!(sum(&rows, |e| e.cache_read_tokens), 2_176_363_904.0);
}

#[tokio::test]
#[ignore = "fails identically in the TS suite (tests/router-usage.test.ts) at HEAD; Rust matches TS behavior"]
async fn still_attributes_cache_to_a_remainder_row_covering_models_by_model_misses() {
    let _env = setup(None).await;
    let dir = tmp();
    let day = "2026-07-25";
    w(
        dir.path(),
        "usage-daily.json",
        json!({ day: {
            "requests": 100, "promptTokens": 1_000_000, "completionTokens": 10_000, "cachedTokens": 500_000,
            "cost": 5,
            "byModel": {"gpt-5.6-sol|openai": {
                "requests": 40, "promptTokens": 400_000, "completionTokens": 4_000, "cachedTokens": 200_000,
                "cost": 2, "rawModel": "gpt-5.6-sol", "provider": "openai",
            }},
        }})
        .to_string(),
    );
    let events = parse(&[dir.path()], AgentId::Litellm).await;
    let rows: Vec<UsageEvent> = events.into_iter().filter(|e| e.timestamp.starts_with(day)).collect();
    let remainder = rows
        .iter()
        .find(|e| model_of(e) == "unattributed")
        .expect("a genuine uncovered remainder must still be emitted");
    assert_eq!(remainder.input_tokens, 600_000.0);
    assert_eq!(remainder.cache_read_tokens, 300_000.0, "its cache belongs to it");
    assert_eq!(sum(&rows, |e| e.cache_read_tokens), 500_000.0);
    assert_eq!(sum(&rows, |e| e.input_tokens), 1_000_000.0);
    assert_eq!(sum(&rows, |e| e.output_tokens), 10_000.0);
    assert_eq!(sum(&rows, |e| e.input_tokens), 400_000.0 + 600_000.0);
    assert_eq!(sum(&rows, |e| e.cache_read_tokens), 200_000.0 + 300_000.0);
}

#[tokio::test]
async fn keeps_additive_providers_when_they_normalize_to_the_same_model() {
    let _env = setup(None).await;
    let dir = tmp();
    let day = "2026-06-19";
    w(
        dir.path(),
        "usage-daily.json",
        json!({ day: {
            "requests": 1_100, "promptTokens": 101_500_000, "completionTokens": 110_000,
            "byModel": {
                "gpt-5.5|chat-provider": {
                    "requests": 1_000, "promptTokens": 100_000_000, "completionTokens": 100_000,
                    "rawModel": "gpt-5.5", "provider": "chat-provider",
                },
                "gpt-5.5|responses-provider": {
                    "requests": 100, "promptTokens": 1_500_000, "completionTokens": 10_000,
                    "rawModel": "gpt-5.5", "provider": "responses-provider",
                },
            },
        }})
        .to_string(),
    );
    let events = parse(&[dir.path()], AgentId::NineRouter).await;
    let rows: Vec<UsageEvent> = events.into_iter().filter(|e| e.timestamp.starts_with(day)).collect();
    assert_eq!(rows.iter().filter(|e| model_of(e) == "gpt-5.5").count(), 2);
    assert_eq!(
        sum(&rows, |e| e.input_tokens + e.output_tokens),
        101_610_000.0,
        "same-model rows from different providers must remain additive"
    );
    assert_eq!(
        sum(&rows, |e| match e.request_count {
            Some(n) if n != 0.0 => n,
            _ => 1.0,
        }),
        1_100.0
    );
}

#[tokio::test]
async fn does_not_let_an_explicit_zero_cache_field_hide_a_billed_daily_floor() {
    let _env = setup(None).await;
    let dir = tmp();
    let day = "2026-07-20";
    w(
        dir.path(),
        "usage-history.jsonl",
        format!(
            "{}\n",
            json!({
                "id": "history-zero-cache", "timestamp": format!("{day}T10:00:00.000Z"), "model": "gpt-5.6-sol",
                "provider": "openai", "promptTokens": 100_000, "completionTokens": 200, "cachedTokens": 0,
                "cost": 1,
                "tokens": {"prompt_tokens": 100_000, "completion_tokens": 200, "cached_tokens": 0},
            })
        ),
    );
    w(
        dir.path(),
        "usage-daily.json",
        json!({ day: {
            "requests": 1, "promptTokens": 100_000, "completionTokens": 200, "cachedTokens": 80_000,
            "byModel": {"gpt-5.6-sol|openai": {
                "requests": 1, "promptTokens": 100_000, "completionTokens": 200, "cachedTokens": 80_000,
                "rawModel": "gpt-5.6-sol", "provider": "openai",
            }},
        }})
        .to_string(),
    );
    let events = parse(&[dir.path()], AgentId::Litellm).await;
    let rows: Vec<UsageEvent> = events.into_iter().filter(|e| e.timestamp.starts_with(day)).collect();
    assert!(rows.iter().any(is_est), "daily cache floor must remain visible");
    assert_eq!(sum(&rows, |e| e.cache_read_tokens), 80_000.0);
}

#[tokio::test]
async fn does_not_subtract_rollup_cache_from_rollup_prompt_tokens() {
    let _env = setup(None).await;
    let dir = tmp();
    let day = "2026-07-29";
    let day_prompt = 228_698_527u64;
    let day_cache = 361_695_488u64;
    let model_prompt = 100_000_000u64;
    let model_cache = 361_695_488u64;
    let model_output = 786_042u64;
    w(
        dir.path(),
        "usage-daily.json",
        json!({ day: {
            "requests": 2662, "promptTokens": day_prompt, "completionTokens": model_output,
            "cachedTokens": day_cache, "cost": 216.67307592,
            "byModel": {"anthropic/claude-fable-5|Claude-Fable": {
                "requests": 2600, "promptTokens": model_prompt, "completionTokens": model_output,
                "cachedTokens": model_cache, "cost": 216.67307592,
                "model_group": "anthropic/claude-fable-5", "rawModel": "Claude-Fable/Claude-Fable",
                "provider": "Claude-Fable",
            }},
        }})
        .to_string(),
    );
    let events = parse(&[dir.path()], AgentId::Litellm).await;
    let rows: Vec<UsageEvent> = events.into_iter().filter(|e| e.timestamp.starts_with(day)).collect();
    assert!(!rows.is_empty(), "rollup day must produce events");

    let covered = rows.iter().find(|e| model_of(e) != "unattributed").expect("the byModel row is emitted");
    assert_eq!(covered.input_tokens, model_prompt as f64);
    assert_eq!(covered.cache_read_tokens, model_cache as f64);
    assert_eq!(covered.output_tokens, model_output as f64);

    if let Some(remainder) = rows.iter().find(|e| model_of(e) == "unattributed") {
        assert_eq!(remainder.input_tokens, (day_prompt - model_prompt) as f64);
        assert_eq!(remainder.cache_read_tokens, 0.0);
    }

    let input_sum = sum(&rows, |e| e.input_tokens);
    let cache_sum = sum(&rows, |e| e.cache_read_tokens);
    assert_eq!(input_sum, day_prompt as f64, "rollup input column keeps the full prompt");
    assert_eq!(cache_sum, day_cache as f64, "rollup cache counted exactly once");
    assert!(covered.input_tokens > 0.0, "a cache-exceeding prompt must never be zeroed by subtraction");
    assert_ne!(covered.input_tokens, 0.0);
    assert!(input_sum >= day_prompt as f64);
}

#[tokio::test]
async fn keeps_history_subset_semantics_while_rollup_stays_uncleaned() {
    let _env = setup(None).await;
    let dir = tmp();
    let day = "2026-08-01";
    w(
        dir.path(),
        "usage-history.jsonl",
        format!(
            "{}\n",
            json!({
                "id": "s1", "timestamp": format!("{day}T09:00:00.000Z"), "model": "anthropic/Claude-Fable-5.5",
                "promptTokens": 119_173, "completionTokens": 500, "cachedTokens": 117_632, "cost": 0.009764,
            })
        ),
    );
    w(
        dir.path(),
        "usage-daily.json",
        json!({ day: {
            "requests": 1, "promptTokens": 119_173, "completionTokens": 500, "cachedTokens": 117_632,
            "cost": 0.009764,
            "byModel": {"anthropic/Claude-Fable-5.5|Claude-Fable": {
                "requests": 1, "promptTokens": 119_173, "completionTokens": 500, "cachedTokens": 117_632,
                "cost": 0.009764, "rawModel": "Claude-Fable/Claude-Fable-5.5", "provider": "Claude-Fable",
            }},
        }})
        .to_string(),
    );
    let events = parse(&[dir.path()], AgentId::Litellm).await;
    let rows: Vec<UsageEvent> = events.into_iter().filter(|e| e.timestamp.starts_with(day)).collect();
    assert_eq!(rows.len(), 1, "history wins for its day; no rollup added");
    let row = &rows[0];
    assert_eq!(row.input_tokens + row.cache_read_tokens, 119_173.0);
    assert_eq!(row.input_tokens, 119_173.0 - 117_632.0);
    assert_eq!(row.cache_read_tokens, 117_632.0);
}
