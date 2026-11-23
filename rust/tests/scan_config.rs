//! Port of `tests/scan-config.test.ts`.
//!
//! The config cache and the TOKENLAB_* env vars are process-global, so every
//! test takes `ENV_LOCK`, points the config at its own temp dir, and restores the
//! environment (and drops the cache) on the way out.

use serde_json::json;
use std::sync::Mutex;
use tokenlab::config::*;

static ENV_LOCK: Mutex<()> = Mutex::new(());

const ENV_KEYS: [&str; 2] = ["TOKENLAB_CONFIG", "TOKENLAB_DATA_DIR"];

struct Fixture {
    dir: tempfile::TempDir,
    saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    _guard: std::sync::MutexGuard<'static, ()>,
}

impl Fixture {
    fn new() -> Fixture {
        let guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let saved = ENV_KEYS.iter().map(|k| (*k, std::env::var_os(k))).collect();
        let dir = tempfile::Builder::new().prefix("tokenlab-scan-").tempdir().unwrap();
        std::env::set_var("TOKENLAB_CONFIG", dir.path().join("config.json"));
        std::env::set_var("TOKENLAB_DATA_DIR", dir.path());
        reset_config_cache();
        Fixture { dir, saved, _guard: guard }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Order matters: flush the cache, restore env, flush again so the next
        // suite re-reads whatever it expects instead of our deleted file.
        reset_config_cache();
        for (k, v) in &self.saved {
            match v {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
        reset_config_cache();
        let _ = &self.dir;
    }
}

fn scan(interval: Option<f64>, full: Option<f64>, periodic: Option<bool>) -> Option<ScanConfig> {
    Some(ScanConfig {
        interval_minutes: interval,
        full_interval_minutes: full,
        periodic_enabled: periodic,
        ..Default::default()
    })
}

#[tokio::test]
async fn defaults_to_a_1_hour_light_cadence_and_a_1_hour_full_cadence() {
    let _fx = Fixture::new();
    let cfg = load_config().await;
    let s = cfg.scan.as_ref().unwrap();
    assert_eq!(s.interval_minutes, Some(DEFAULT_SCAN_INTERVAL_MINUTES));
    assert_eq!(s.full_interval_minutes, Some(DEFAULT_FULL_SCAN_INTERVAL_MINUTES));
    assert_eq!(s.periodic_enabled, Some(true));
    assert_eq!(scan_interval_minutes(), 60.0);
    assert_eq!(full_scan_interval_minutes(), 60.0);
    assert!(scan_periodic_enabled());
}

#[tokio::test]
async fn persists_a_saved_cadence_and_applies_it_without_a_restart() {
    let _fx = Fixture::new();
    let prev = load_config().await;
    save_config(&XlabTokenConfig { scan: scan(Some(10.0), Some(720.0), None), ..prev }).await.unwrap();
    assert_eq!(scan_interval_minutes(), 10.0);
    assert_eq!(full_scan_interval_minutes(), 720.0);

    let on_disk: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(config_path()).unwrap()).unwrap();
    assert_eq!(on_disk["scan"]["intervalMinutes"], json!(10));
    assert_eq!(on_disk["scan"]["fullIntervalMinutes"], json!(720));
}

#[tokio::test]
async fn keeps_periodic_enabled_true_unless_explicitly_turned_off() {
    let _fx = Fixture::new();
    let prev = load_config().await;
    // Merge drops the key when a partial PUT omits it: default must stay on.
    save_config(&XlabTokenConfig { scan: scan(Some(7.0), None, None), ..prev.clone() }).await.unwrap();
    assert!(scan_periodic_enabled());
    assert_eq!(scan_interval_minutes(), 7.0);

    save_config(&XlabTokenConfig { scan: scan(None, None, Some(false)), ..prev }).await.unwrap();
    assert!(!scan_periodic_enabled());
}

#[tokio::test]
async fn clamps_out_of_range_values_so_config_json_cannot_force_a_scan_loop() {
    let _fx = Fixture::new();
    let prev = load_config().await;
    save_config(&XlabTokenConfig { scan: scan(Some(0.0), Some(99999.0), None), ..prev.clone() }).await.unwrap();
    assert_eq!(scan_interval_minutes(), 1.0);
    assert_eq!(full_scan_interval_minutes(), 1440.0);

    save_config(&XlabTokenConfig { scan: scan(Some(999.0), None, None), ..prev }).await.unwrap();
    assert_eq!(scan_interval_minutes(), 60.0);
}

#[tokio::test]
async fn falls_back_to_defaults_for_non_numeric_junk() {
    let _fx = Fixture::new();
    let prev = load_config().await;
    // Hand-edited config.json with strings instead of numbers (typed Rust config
    // cannot hold a string here, so build it from the raw JSON like a load would).
    let junk: XlabTokenConfig = serde_json::from_value(json!({ "scan": { "intervalMinutes": "abc" } })).unwrap();
    save_config(&XlabTokenConfig { scan: junk.scan, ..prev }).await.unwrap();
    assert_eq!(scan_interval_minutes(), DEFAULT_SCAN_INTERVAL_MINUTES);

    std::fs::write(
        config_path(),
        serde_json::to_string(&json!({ "scan": { "intervalMinutes": "abc", "periodicEnabled": true } })).unwrap(),
    )
    .unwrap();
    reset_config_cache();
    let cfg = load_config().await;
    assert_eq!(cfg.scan.as_ref().and_then(|s| s.interval_minutes), Some(DEFAULT_SCAN_INTERVAL_MINUTES));
    assert_eq!(scan_interval_minutes(), DEFAULT_SCAN_INTERVAL_MINUTES);
}

#[tokio::test]
async fn never_drops_a_sibling_scan_field_on_a_partial_update() {
    let _fx = Fixture::new();
    reset_config_cache();
    save_config(&XlabTokenConfig {
        timezone: Some("local".into()),
        scan: scan(Some(15.0), Some(180.0), Some(true)),
        ..Default::default()
    })
    .await
    .unwrap();
    let prev = load_config().await;
    let mut next_scan = prev.scan.clone().unwrap();
    next_scan.interval_minutes = Some(30.0);
    save_config(&XlabTokenConfig { scan: Some(next_scan), ..prev }).await.unwrap();
    assert_eq!(scan_interval_minutes(), 30.0);
    assert_eq!(full_scan_interval_minutes(), 180.0);
}
