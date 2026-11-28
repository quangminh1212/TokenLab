//! Port of `tests/periodic-hermes-scan.test.ts`.
//!
//! These tests mutate process-wide environment variables, so they are
//! serialized through one async mutex.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use indexmap::IndexMap;
use serde_json::{json, Value};
use tokenlab::agents::dsh;
use tokenlab::agents::shared::router_light::parse_router_usage_light;
use tokenlab::agents::{all_agents, scan_all, ScanAllOptions};
use tokenlab::server::{apply_periodic_light_delta, periodic_light_scan_enabled};
use tokenlab::types::{AgentId, PricingStatus, UsageEvent};
use tokenlab::util::js_date_parse;

static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Saves env vars on creation, restores them on drop (like the TS `finally`).
struct EnvGuard {
    saved: Vec<(String, Option<String>)>,
}

impl EnvGuard {
    fn new(keys: &[&str]) -> EnvGuard {
        EnvGuard { saved: keys.iter().map(|k| (k.to_string(), std::env::var(k).ok())).collect() }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            match value {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
    }
}

const HERMES_ENV_KEYS: [&str; 9] = [
    "HERMES_HOME",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "TOKENLAB_DATA_DIR",
    "XLAB_TOKEN_DATA_DIR",
];

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn set_hermes_env(root: &Path, hermes_root: &Path) {
    std::env::set_var("HERMES_HOME", hermes_root);
    std::env::set_var("HOME", root);
    std::env::set_var("USERPROFILE", root);
    std::env::set_var("LOCALAPPDATA", root.join("local"));
    std::env::set_var("APPDATA", root.join("roaming"));
    std::env::set_var("XDG_DATA_HOME", root.join("share"));
    std::env::set_var("XDG_CONFIG_HOME", root.join("config"));
    std::env::set_var("TOKENLAB_DATA_DIR", root.join("data"));
    std::env::remove_var("XLAB_TOKEN_DATA_DIR");
}

fn write(path: &Path, content: &str) {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).unwrap();
    }
    std::fs::write(path, content).unwrap();
}

fn set_mtime(path: &Path, secs_since_epoch: u64) {
    let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    f.set_modified(UNIX_EPOCH + Duration::from_secs(secs_since_epoch)).unwrap();
}

fn light_event(id: &str, agent: AgentId, timestamp: &str, source_path: &str, input: f64, output: f64) -> UsageEvent {
    UsageEvent {
        id: id.to_string().into(),
        agent,
        model: Some(("m".to_string()).into()),
        timestamp: timestamp.to_string().into(),
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: 0.0,
        cache_write_tokens: 0.0,
        total_tokens: input + output,
        estimated_cost: Some(0.0),
        currency: ("USD".to_string()).into(),
        pricing_status: PricingStatus::Priced,
        workspace: None,
        source_path: source_path.to_string().into(),
        ..Default::default()
    }
}

fn fresh_map(entries: Vec<(&str, Vec<UsageEvent>)>) -> IndexMap<String, Vec<UsageEvent>> {
    entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

fn ids(events: &[UsageEvent]) -> Vec<String> {
    events.iter().map(|e| e.id.to_string()).collect()
}

fn scan_opts(concurrency: usize) -> ScanAllOptions {
    ScanAllOptions {
        enabled: Some(periodic_light_scan_enabled()),
        light: true,
        concurrency: Some(concurrency),
        timeout_ms: Some(5_000.0),
        ..Default::default()
    }
}

#[tokio::test]
async fn periodic_light_scans_pick_up_newly_written_hermes_usage() {
    let _lock = ENV_LOCK.lock().await;
    let _env = EnvGuard::new(&HERMES_ENV_KEYS);
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let hermes_root = root.join("hermes");
    let file = hermes_root.join("sessions").join("session.jsonl");
    write(
        &file,
        &format!(
            "{}\n",
            json!({"timestamp": "2026-10-03T00:30:00.000Z", "model": "test-model", "input_tokens": 7, "output_tokens": 3})
        ),
    );
    set_hermes_env(root, &hermes_root);

    // Fallback in TS: every agent disabled when the helper is missing; here it exists.
    let enabled = periodic_light_scan_enabled();
    assert_eq!(enabled.len(), all_agents().len());
    let events = scan_all(scan_opts(2)).await;

    let hermes = events.iter().find(|e| e.agent == AgentId::Hermes && e.source_path == s(&file)).expect("hermes event");
    assert_eq!(hermes.agent, AgentId::Hermes);
    assert_eq!(hermes.model.as_deref(), Some("test-model"));
    assert_eq!(hermes.input_tokens, 7.0);
    assert_eq!(hermes.output_tokens, 3.0);
    assert_eq!(hermes.total_tokens, 10.0);
}

#[tokio::test]
async fn periodic_light_scan_skips_unchanged_hermes_files_and_keeps_the_first_read() {
    let _lock = ENV_LOCK.lock().await;
    let _env = EnvGuard::new(&HERMES_ENV_KEYS);
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let hermes_root = root.join("hermes");
    let file = hermes_root.join("sessions").join("session.jsonl");
    let row1 = json!({"timestamp": "2026-10-03T01:00:00.000Z", "model": "test-model", "input_tokens": 11, "output_tokens": 4});
    let row2 = json!({"timestamp": "2026-10-03T02:00:00.000Z", "model": "test-model", "input_tokens": 6, "output_tokens": 1});
    write(&file, &format!("{row1}\n"));
    set_hermes_env(root, &hermes_root);

    let first = scan_all(scan_opts(1)).await;
    let second = scan_all(scan_opts(1)).await;
    let picked = first.iter().find(|e| e.agent == AgentId::Hermes && e.source_path == s(&file)).expect("first read");
    assert_eq!(picked.input_tokens, 11.0);
    assert_eq!(picked.output_tokens, 4.0);
    assert_eq!(second.iter().filter(|e| e.agent == AgentId::Hermes).count(), 0);

    write(&file, &format!("{row1}\n{row2}\n"));
    let third = scan_all(scan_opts(1)).await;
    let mut inputs: Vec<f64> = third
        .iter()
        .filter(|e| e.agent == AgentId::Hermes && e.source_path == s(&file))
        .map(|e| e.input_tokens)
        .collect();
    inputs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert_eq!(inputs, vec![6.0, 11.0]);
}

#[test]
fn light_delta_replaces_only_the_codex_file_that_was_reread() {
    let prev = vec![
        light_event("b", AgentId::Codex, "2026-10-08T00:00:01.000Z", "C:\\sessions\\b.jsonl", 2.0, 2.0),
        light_event("a-old", AgentId::Codex, "2026-10-08T00:00:02.000Z", "C:\\sessions\\a.jsonl", 3.0, 1.0),
        light_event("h", AgentId::Hermes, "2026-10-08T00:00:03.000Z", "C:\\hermes\\s.jsonl", 4.0, 4.0),
    ];
    let fresh = fresh_map(vec![(
        "codex",
        vec![
            light_event(
                "a-mid",
                AgentId::Codex,
                "2026-10-08T00:00:01.500Z",
                "C:/sessions/a.jsonl \u{2190} mirror",
                5.0,
                5.0,
            ),
            light_event("a-new", AgentId::Codex, "2026-10-08T00:00:04.000Z", "C:/sessions/a.jsonl", 6.0, 1.0),
        ],
    )]);
    let (events, timestamps) = apply_periodic_light_delta(&prev, None, &fresh);
    assert_eq!(ids(&events), vec!["b", "a-mid", "h", "a-new"]);
    assert_eq!(timestamps.len(), events.len());
    assert_eq!(events[1].input_tokens, 5.0);
}

#[test]
fn light_delta_keeps_a_richer_codex_row_that_lives_outside_the_reread_file() {
    let prev =
        vec![light_event("same", AgentId::Codex, "2026-10-08T00:00:01.000Z", "C:\\other\\keep.jsonl", 50.0, 50.0)];
    let fresh = fresh_map(vec![(
        "codex",
        vec![light_event("same", AgentId::Codex, "2026-10-08T00:00:02.000Z", "C:\\sessions\\hot.jsonl", 1.0, 1.0)],
    )]);
    let prev_ts = vec![js_date_parse(&prev[0].timestamp.to_str())];
    let (events, _) = apply_periodic_light_delta(&prev, Some(&prev_ts), &fresh);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].input_tokens, 50.0);
    assert_eq!(events[0].source_path, "C:\\other\\keep.jsonl");
}

#[test]
fn light_delta_keeps_router_history_and_prefers_the_richer_same_id() {
    let prev = vec![
        light_event("old", AgentId::NineRouter, "2026-10-07T00:00:01.000Z", "db", 2.0, 2.0),
        light_event("same", AgentId::NineRouter, "2026-10-08T00:00:01.000Z", "db", 1.0, 1.0),
        light_event("codex-stay", AgentId::Codex, "2026-10-08T00:00:03.000Z", "rollout.jsonl", 9.0, 9.0),
    ];
    let fresh = fresh_map(vec![(
        "9router",
        vec![
            light_event("same", AgentId::NineRouter, "2026-10-08T00:00:01.000Z", "db", 8.0, 8.0),
            light_event("new", AgentId::NineRouter, "2026-10-08T00:00:02.000Z", "db", 3.0, 3.0),
        ],
    )]);
    let (events, _) = apply_periodic_light_delta(&prev, None, &fresh);
    assert_eq!(ids(&events), vec!["old", "same", "new", "codex-stay"]);
    assert_eq!(events.iter().find(|e| e.id == "same").unwrap().input_tokens, 8.0);
}

#[test]
fn light_delta_upgrades_an_unchanged_cache_row_to_the_measured_variant() {
    let mut prev = light_event("same-cache", AgentId::NineRouter, "2026-10-08T00:00:01.000Z", "db", 100.0, 10.0);
    prev.cache_read_tokens = 900.0;
    let mut fresh_row = light_event("same-cache", AgentId::NineRouter, "2026-10-08T00:00:01.000Z", "db", 100.0, 10.0);
    fresh_row.cache_read_tokens = 900.0;
    fresh_row.cache_reported = Some(true);
    let fresh = fresh_map(vec![("9router", vec![fresh_row])]);
    let (events, _) = apply_periodic_light_delta(&[prev], None, &fresh);
    assert_eq!(events[0].cache_reported, Some(true));
}

#[test]
fn light_delta_drops_a_same_machine_gist_rollup_covered_by_the_fresh_row() {
    let mut gist = light_event("gist", AgentId::Codex, "2026-10-08T00:00:01.000Z", "backup:gist-daily", 100.0, 0.0);
    gist.model = Some("m".into());
    let mut foreign =
        light_event("foreign", AgentId::Codex, "2026-10-08T00:00:01.000Z", "backup:gist-daily:other-host", 40.0, 0.0);
    foreign.model = Some("m".into());
    let prev = vec![gist, foreign];
    let fresh = fresh_map(vec![(
        "codex",
        vec![light_event("live", AgentId::Codex, "2026-10-08T00:00:02.000Z", "C:\\sessions\\a.jsonl", 4.0, 1.0)],
    )]);
    let (events, _) = apply_periodic_light_delta(&prev, None, &fresh);
    assert_eq!(ids(&events), vec!["foreign", "live"]);
}

#[test]
fn light_delta_applies_a_large_codex_cache_without_collapsing_it() {
    let mut prev: Vec<UsageEvent> = Vec::with_capacity(40_000);
    let mut prev_ts: Vec<f64> = Vec::with_capacity(40_000);
    let base = js_date_parse("2026-01-01T00:00:00.000Z");
    for i in 0..40_000usize {
        let ms = base + (i as f64) * 1000.0;
        let timestamp = tokenlab::util::to_iso_string(ms).unwrap();
        prev.push(light_event(
            &format!("c{i}"),
            AgentId::Codex,
            &timestamp,
            &format!("C:\\sessions\\file-{}.jsonl", i % 100),
            1.0,
            1.0,
        ));
        prev_ts.push(ms);
    }
    let day2 = js_date_parse("2026-01-02T00:00:00.000Z");
    let fresh_rows: Vec<UsageEvent> = (0..10usize)
        .map(|i| {
            light_event(
                &format!("fresh{i}"),
                AgentId::Codex,
                &tokenlab::util::to_iso_string(day2 + (i as f64) * 1000.0).unwrap(),
                "C:\\sessions\\file-0.jsonl",
                2.0,
                2.0,
            )
        })
        .collect();
    let fresh = fresh_map(vec![("codex", fresh_rows)]);
    let started = Instant::now();
    let (events, _) = apply_periodic_light_delta(&prev, Some(&prev_ts), &fresh);
    let elapsed = started.elapsed().as_millis();
    assert_eq!(events.len(), 40_000 - 400 + 10);
    assert!(events.iter().any(|e| e.id == "c1"));
    assert!(!events.iter().any(|e| e.id == "c0"));
    assert_eq!(events.last().map(|e| e.id.to_string()), Some("fresh9".to_string()));
    assert!(elapsed < 30_000, "delta took {elapsed}ms");
}

#[tokio::test]
async fn dsh_light_scan_reads_a_changed_session_once_and_skips_the_next_identical_pass() {
    let _lock = ENV_LOCK.lock().await;
    let _env = EnvGuard::new(&["DSH_HOME"]);
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let session_dir = root.join("sessions").join("s1");
    let file = session_dir.join("session.jsonl");
    // The TS test hardcodes 2026-10-08, which falls outside dsh's 30 day light
    // window once that date is old enough (the TS test then fails identically),
    // so stamp rows relative to now instead.
    let time = tokenlab::util::to_iso_string(tokenlab::util::now_ms() - 60_000.0).unwrap();
    let line = |seq: u32, input: u32| -> String {
        json!({
            "type": "assistant/message",
            "seq": seq,
            "time": time,
            "data": {"usage": {"input_tokens": input, "output_tokens": 2}},
        })
        .to_string()
    };
    write(&file, &format!("{}\n", line(1, 3)));
    std::env::set_var("DSH_HOME", root);
    let agent = dsh::agent();
    let parse_light = agent.parse_light.clone().expect("dsh parseLight");
    let roots = (agent.roots)();
    let first = parse_light(roots.clone()).await.unwrap();
    let second = parse_light(roots.clone()).await.unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].input_tokens, 3.0);
    assert_eq!(second.len(), 0);

    write(&file, &format!("{}\n{}\n", line(1, 3), line(2, 9)));
    let third = parse_light(roots.clone()).await.unwrap();
    // Both turns are legacy shape: total == input + output, with no cache key
    // anywhere in the stream. The cache split is therefore unknown, and unknown
    // is reported as zero.
    let mut inputs: Vec<f64> = third.iter().map(|e| e.input_tokens).collect();
    inputs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert_eq!(inputs, vec![3.0, 9.0]);
    assert_eq!(third.iter().map(|e| e.cache_read_tokens).collect::<Vec<_>>(), vec![0.0, 0.0]);
    assert_eq!(third.iter().map(|e| e.cache_reported.unwrap_or(false)).collect::<Vec<_>>(), vec![false, false]);

    let session_dir2 = root.join("sessions").join("s2");
    write(&session_dir2.join("session.jsonl"), &format!("{}\n", line(1, 4)));
    let fourth = parse_light(roots.clone()).await.unwrap();
    // A brand-new session's first turn is all input.
    assert_eq!(fourth.iter().map(|e| e.input_tokens).collect::<Vec<_>>(), vec![4.0]);
    assert_eq!(fourth.iter().map(|e| e.cache_read_tokens).collect::<Vec<_>>(), vec![0.0]);
}

fn codex_light_parse() -> tokenlab::agents::ParseFn {
    tokenlab::agents::codex::agent().parse_light.clone().expect("codex parseLight")
}

fn record(input: u32, stamp: &str) -> String {
    json!({
        "timestamp": stamp,
        "type": "token_usage_record",
        "payload": {"type": "token_usage_record", "usage": {"input_tokens": input, "output_tokens": 2}},
    })
    .to_string()
}

fn day_dir(root: &Path, date: chrono::DateTime<chrono::Local>) -> PathBuf {
    root.join("sessions").join(date.format("%Y").to_string()).join(date.format("%m").to_string()).join(
        date.format("%d").to_string(),
    )
}

fn root_key(root: &Path) -> String {
    let r = s(root);
    if cfg!(windows) {
        r.to_lowercase()
    } else {
        r
    }
}

#[tokio::test]
async fn codex_light_scan_does_not_walk_an_old_session_tree_again() {
    let _lock = ENV_LOCK.lock().await;
    let _env = EnvGuard::new(&["TOKENLAB_DATA_DIR", "XLAB_TOKEN_DATA_DIR"]);
    let root_tmp = tempfile::tempdir().unwrap();
    let data_tmp = tempfile::tempdir().unwrap();
    let root = root_tmp.path().to_path_buf();
    std::env::set_var("TOKENLAB_DATA_DIR", data_tmp.path());
    let day = day_dir(&root, chrono::Local::now());
    let old_dir = root.join("sessions").join("2020").join("01").join("01");

    let current = day.join("rollout-2026-10-08T10-00-00-current.jsonl");
    write(&current, &format!("{}\n", record(5, "2026-10-08T10:00:00.000Z")));
    for name in ["11-00-00-b", "12-00-00-c", "13-00-00-d"] {
        write(&day.join(format!("rollout-2026-10-08T{name}.jsonl")), "");
    }
    let old_file = old_dir.join("rollout-2020-01-01T00-00-00-old.jsonl");
    write(&old_file, &format!("{}\n", record(99, "2020-01-01T00:00:00.000Z")));
    set_mtime(&old_file, 1_577_836_800);

    let parse = codex_light_parse();
    let first = parse(vec![s(&root)]).await.unwrap();
    assert_eq!(first.iter().map(|e| e.input_tokens).collect::<Vec<_>>(), vec![5.0]);

    write(&old_file, &format!("{}\n", record(99, "2026-10-08T12:00:00.000Z")));
    let second = parse(vec![s(&root)]).await.unwrap();
    assert_eq!(second.len(), 0);

    write(
        &current,
        &format!("{}\n{}\n", record(5, "2026-10-08T10:00:00.000Z"), record(8, "2026-10-08T10:00:02.000Z")),
    );
    let third = parse(vec![s(&root)]).await.unwrap();
    let mut inputs: Vec<f64> = third.iter().map(|e| e.input_tokens).collect();
    inputs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert_eq!(inputs, vec![5.0, 8.0]);
}

#[tokio::test]
async fn cold_codex_light_scan_skips_history_outside_the_two_day_window() {
    let _lock = ENV_LOCK.lock().await;
    let _env = EnvGuard::new(&["TOKENLAB_DATA_DIR", "XLAB_TOKEN_DATA_DIR"]);
    let root_tmp = tempfile::tempdir().unwrap();
    let data_tmp = tempfile::tempdir().unwrap();
    let root = root_tmp.path().to_path_buf();
    let old_day = chrono::Local::now() - chrono::Duration::days(10);
    let old_file = day_dir(&root, old_day).join("rollout-older-session.jsonl");
    let current_file = day_dir(&root, chrono::Local::now()).join("rollout-current-session.jsonl");
    let now_iso = || tokenlab::util::to_iso_string(tokenlab::util::now_ms()).unwrap();
    write(&old_file, &format!("{}\n", record(99, &now_iso())));
    write(&current_file, &format!("{}\n", record(5, &now_iso())));
    std::env::set_var("TOKENLAB_DATA_DIR", data_tmp.path());

    let events = codex_light_parse()(vec![s(&root)]).await.unwrap();
    let index: Value =
        serde_json::from_str(&std::fs::read_to_string(data_tmp.path().join("codex-light-index.json")).unwrap()).unwrap();

    assert_eq!(events.iter().map(|e| e.input_tokens).collect::<Vec<_>>(), vec![5.0]);
    assert_eq!(index["roots"][root_key(&root)], json!([s(&current_file)]));
}

#[tokio::test]
async fn codex_light_scan_reloads_hot_rollout_paths_across_process_restarts() {
    let _lock = ENV_LOCK.lock().await;
    let _env = EnvGuard::new(&["TOKENLAB_DATA_DIR", "XLAB_TOKEN_DATA_DIR"]);
    let root_tmp = tempfile::tempdir().unwrap();
    let data_tmp = tempfile::tempdir().unwrap();
    let root = root_tmp.path().to_path_buf();
    let session_dir = root.join("sessions").join("2020").join("01").join("01");
    let now_iso = tokenlab::util::to_iso_string(tokenlab::util::now_ms()).unwrap();
    let active = session_dir.join("rollout-2020-01-01T00-00-00-active.jsonl");
    write(&active, &format!("{}\n", record(99, &now_iso)));
    for name in ["01-extra", "02-extra", "03-extra", "04-extra"] {
        write(&session_dir.join(format!("rollout-2020-01-01T{name}.jsonl")), "");
    }
    set_mtime(&active, 1_577_836_800);
    write(
        &data_tmp.path().join("codex-light-index.json"),
        &json!({"version": 1, "roots": {root_key(&root): [s(&active)]}}).to_string(),
    );
    std::env::set_var("TOKENLAB_DATA_DIR", data_tmp.path());

    let events = codex_light_parse()(vec![s(&root)]).await.unwrap();
    assert_eq!(events.iter().map(|e| e.input_tokens).collect::<Vec<_>>(), vec![99.0]);
}

#[tokio::test]
async fn router_light_scan_reads_a_usage_file_once_until_it_changes() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let usage = root.join("usage.json");
    let body = |input: u32| -> String {
        json!({"history": [{
            "timestamp": "2026-10-08T00:00:00.000Z",
            "model": "test-model",
            "input_tokens": input,
            "output_tokens": 2,
        }]})
        .to_string()
    };
    write(&usage, &body(3));
    let roots = vec![s(root)];
    let first = parse_router_usage_light(&roots, AgentId::NineRouter).await.unwrap();
    let second = parse_router_usage_light(&roots, AgentId::NineRouter).await.unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].input_tokens, 3.0);
    assert_eq!(second.len(), 0);
    // Make sure the changed file differs in size or mtime from the first write.
    std::thread::sleep(Duration::from_millis(20));
    write(&usage, &body(30));
    let third = parse_router_usage_light(&roots, AgentId::NineRouter).await.unwrap();
    assert_eq!(third.len(), 1);
    assert_eq!(third[0].input_tokens, 30.0);
}
