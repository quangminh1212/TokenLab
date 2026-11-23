//! Port of the IO half of `tests/backup.security.test.ts`: scan-cache
//! persistence, restore path-traversal protection and the settings backup.
//!
//! The data dir (`XLAB_TOKEN_DATA_DIR` / `TOKENLAB_DATA_DIR`) and the config
//! path are process-global, so every test takes `ENV_LOCK`, points both at its
//! own temp dir and restores the environment on the way out.

use serde_json::json;
use std::ffi::OsString;
use std::sync::Mutex;
use tokenlab::backup::*;
use tokenlab::config::reset_config_cache;
use tokenlab::types::{AgentId, PricingStatus, UsageEvent};

static ENV_LOCK: Mutex<()> = Mutex::new(());

const ENV_KEYS: [&str; 3] = ["XLAB_TOKEN_DATA_DIR", "TOKENLAB_DATA_DIR", "TOKENLAB_CONFIG"];

struct Fixture {
    dir: tempfile::TempDir,
    saved: Vec<(&'static str, Option<OsString>)>,
    _guard: std::sync::MutexGuard<'static, ()>,
}

impl Fixture {
    fn new() -> Fixture {
        let guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let saved = ENV_KEYS.iter().map(|k| (*k, std::env::var_os(k))).collect();
        let dir = tempfile::Builder::new().prefix("tokenlab-backup-").tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        // Same switch the TS tests use; the newer name must not shadow it.
        std::env::remove_var("TOKENLAB_DATA_DIR");
        std::env::set_var("XLAB_TOKEN_DATA_DIR", &data);
        std::env::set_var("TOKENLAB_CONFIG", dir.path().join("config.json"));
        reset_config_cache();
        Fixture { dir, saved, _guard: guard }
    }

    fn base(&self) -> &std::path::Path {
        self.dir.path()
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

fn full() -> SaveScanCacheOpts {
    SaveScanCacheOpts { mode: SaveMode::Full }
}

#[tokio::test]
async fn restore_mirrors_blocks_path_traversal() {
    let fx = Fixture::new();
    let root = std::path::PathBuf::from(mirrors_root());
    // mirrors root is <base>/data/mirrors, so ../.. is <base>.
    let evil = fx.base().join("evil-xlab-traversal-test.txt");
    let evil2 = fx.base().join("evil-xlab-traversal-test2.txt");
    let _ = std::fs::remove_file(&evil);

    let result = restore_backup(&json!({
        "format": "xlab-token-backup",
        "formatVersion": 2,
        "appVersion": "1.0.1",
        "exportedAt": "2026-07-15T00:00:00.000Z",
        "scope": "full",
        "config": {
            "timezone": "Asia/Ho_Chi_Minh",
            "pricing": { "currency": "USD", "preferRouterCost": true, "customRates": {} }
        },
        "mirrors": {
            "../../evil-xlab-traversal-test.txt": "pwned",
            "..\\..\\evil-xlab-traversal-test2.txt": "pwned",
            "safe-test/nested.json": "{\"ok\":true}"
        }
    }))
    .await
    .unwrap();

    assert!(!evil.exists(), "must not write outside mirrors root");
    assert!(!evil2.exists(), "backslash traversal must not write outside mirrors root");
    assert!(result.mirrors_restored >= 1.0, "safe file should restore");
    let safe = root.join("safe-test").join("nested.json");
    assert!(safe.exists());
    assert_eq!(std::fs::read_to_string(&safe).unwrap(), "{\"ok\":true}");
}

#[tokio::test]
async fn scan_cache_drops_legacy_codex_proxy_rows_on_read_and_full_save_high_water_merge() {
    let _fx = Fixture::new();
    let native_codex = evt("native-codex-cache", |e| {
        e.agent = AgentId::Codex;
        e.source_path = "C:/Users/GHC/.codex/sessions/rollout.jsonl".into();
        e.workspace = Some("C--Dev-Demo".into());
    });
    let legacy_proxy = evt("legacy-codex-proxy-cache", |e| {
        e.agent = AgentId::Codex;
        e.source_path = "C:/Users/GHC/.codex/sessions/rollout.jsonl <- C:/data/litellm/usage-history.jsonl".into();
        e.workspace = Some("C--Dev-Demo via:tokenrouter".into());
        e.estimated_cost = Some(999.0);
    });
    let lite_llm = evt("litellm-source-cache", |e| {
        e.agent = AgentId::Litellm;
        e.source_path = "C:/data/litellm/usage-history.jsonl".into();
        e.workspace = Some("litellm".into());
    });
    std::fs::write(
        scan_cache_path(),
        serde_json::to_string(&vec![&native_codex, &legacy_proxy, &lite_llm]).unwrap(),
    )
    .unwrap();

    let loaded = load_scan_cache().await;
    let mut ids: Vec<String> = loaded.iter().map(|e| e.id.clone()).collect();
    ids.sort();
    assert_eq!(
        ids,
        vec!["litellm-source-cache", "native-codex-cache"],
        "legacy proxy rows must be filtered from the existing cache"
    );

    let fresh_codex = evt("fresh-codex-cache", |e| {
        e.agent = AgentId::Codex;
        e.source_path = "C:/Users/GHC/.codex/sessions/rollout-new.jsonl".into();
        e.workspace = Some("C--Dev-Demo".into());
        e.timestamp = "2026-07-16T01:00:00.000Z".into();
    });
    save_scan_cache(&[fresh_codex, legacy_proxy], full()).await.unwrap();

    let saved = load_scan_cache().await;
    assert!(saved.iter().any(|e| e.id == "native-codex-cache"));
    assert!(saved.iter().any(|e| e.id == "fresh-codex-cache"));
    assert!(saved.iter().any(|e| e.id == "litellm-source-cache"));
    assert!(!saved.iter().any(|e| e.id == "legacy-codex-proxy-cache"));
}

#[tokio::test]
async fn save_scan_cache_round_trips_and_load_recovers_from_bak_when_main_is_corrupt() {
    let _fx = Fixture::new();
    let events = vec![
        evt("persist-a", |e| {
            e.agent = AgentId::Grok;
            e.input_tokens = 1000.0;
            e.total_tokens = 1100.0;
            e.estimated_cost = Some(2.0);
        }),
        evt("persist-b", |e| {
            e.agent = AgentId::Windsurf;
            e.input_tokens = 500.0;
            e.total_tokens = 550.0;
            e.estimated_cost = Some(1.0);
        }),
    ];
    save_scan_cache(&events, SaveScanCacheOpts::default()).await.unwrap();
    let loaded = load_scan_cache().await;
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded.iter().find(|e| e.id == "persist-a").map(|e| e.input_tokens), Some(1000.0));
    // First write must seed .bak for recovery
    assert!(std::path::Path::new(&scan_cache_backup_path()).exists());
    // Main-only path matches full load when main is healthy
    let main_only = load_scan_cache_main_only().await;
    assert_eq!(main_only.len(), 2);

    // Simulate interrupted write leaving invalid JSON in the main file.
    std::fs::write(scan_cache_path(), "{\"id\":\"broken\"").unwrap();
    let recovered = load_scan_cache().await;
    assert_eq!(recovered.len(), 2, "must fall back to .bak after corrupt main");
    assert!(std::path::Path::new(&scan_cache_backup_path()).exists());
}

#[tokio::test]
async fn save_scan_cache_keeps_the_prior_agent_day_high_water_during_a_full_scan_save() {
    let _fx = Fixture::new();
    let previous = evt("full-scan-prior-high-water", |e| {
        e.agent = AgentId::Routerlab;
        e.model = Some("mixed".into());
        e.estimated = Some(true);
        e.input_tokens = 5_000_000.0;
        e.total_tokens = 5_100_000.0;
        e.estimated_cost = Some(100.0);
        e.timestamp = "2026-05-25T12:00:00.000Z".into();
    });
    let rescanned = evt("full-scan-thinner-result", |e| {
        e.agent = AgentId::Routerlab;
        e.model = Some("mixed".into());
        e.estimated = Some(true);
        e.input_tokens = 100_000.0;
        e.total_tokens = 110_000.0;
        e.estimated_cost = Some(2.0);
        e.timestamp = "2026-05-25T12:00:00.000Z".into();
    });

    save_scan_cache(&[previous], full()).await.unwrap();
    // The TS test also passes a legacy `replaceAgents: ["routerlab"]` hint that
    // must be ignored; the Rust options carry no such field, so a plain full
    // save is the equivalent call.
    save_scan_cache(&[rescanned], full()).await.unwrap();

    let loaded = load_scan_cache().await;
    let same_day: Vec<&UsageEvent> = loaded
        .iter()
        .filter(|e| e.agent == AgentId::Routerlab && &e.timestamp[..10] == "2026-05-25")
        .collect();
    assert!(
        same_day.iter().map(|e| e.total_tokens).sum::<f64>() >= 5_100_000.0,
        "full scan must retain the previous daily token high-water"
    );
    assert!(
        same_day.iter().map(|e| e.estimated_cost.unwrap_or(0.0)).sum::<f64>() >= 100.0,
        "full scan must retain the previous daily cost high-water"
    );
}

#[tokio::test]
async fn save_scan_cache_skips_identical_rewrite_and_persists_timestamp_sorted() {
    let _fx = Fixture::new();
    let events = vec![
        evt("late", |e| {
            e.agent = AgentId::Grok;
            e.timestamp = "2026-08-03T00:00:00.000Z".into();
            e.input_tokens = 100.0;
            e.total_tokens = 110.0;
            e.estimated_cost = Some(1.0);
        }),
        evt("early", |e| {
            e.agent = AgentId::Grok;
            e.timestamp = "2026-08-01T00:00:00.000Z".into();
            e.input_tokens = 200.0;
            e.total_tokens = 220.0;
            e.estimated_cost = Some(2.0);
        }),
    ];
    save_scan_cache(&events, full()).await.unwrap();
    let raw1 = std::fs::read_to_string(scan_cache_path()).unwrap();
    let parsed1: Vec<UsageEvent> = serde_json::from_str(&raw1).unwrap();
    assert_eq!(parsed1[0].id, "early", "full save must sort by timestamp ascending");
    assert_eq!(parsed1[1].id, "late");

    let before = std::fs::metadata(scan_cache_path()).unwrap().modified().unwrap();
    // Identical content -> no-op write (fingerprint short-circuit)
    save_scan_cache(&events, full()).await.unwrap();
    let after = std::fs::metadata(scan_cache_path()).unwrap().modified().unwrap();
    assert_eq!(after, before, "unchanged save must not rewrite main file");
    assert_eq!(
        scan_cache_fingerprint(&parsed1),
        scan_cache_fingerprint(&load_scan_cache_main_only().await)
    );
}

#[test]
fn salvage_scan_cache_json_recovers_objects_from_truncated_json_array() {
    let good = evt("salv-a", |e| {
        e.agent = AgentId::Grok;
        e.input_tokens = 900.0;
        e.total_tokens = 1000.0;
        e.estimated_cost = Some(3.0);
    });
    let prefix = format!("[{},{{\"id\":\"broken\"", serde_json::to_string(&good).unwrap());
    let salvaged = salvage_scan_cache_json(&prefix);
    assert_eq!(salvaged.len(), 1);
    assert_eq!(salvaged[0].id, "salv-a");
}

#[tokio::test]
async fn concurrent_save_scan_cache_calls_do_not_corrupt_output() {
    let _fx = Fixture::new();
    let batches: Vec<Vec<UsageEvent>> = (0..8)
        .map(|i| {
            vec![evt(&format!("c-{i}"), |e| {
                e.agent = AgentId::Grok;
                e.input_tokens = 100.0 + i as f64;
                e.total_tokens = 110.0 + i as f64;
                e.estimated_cost = Some(0.1 * i as f64);
            })]
        })
        .collect();
    let results = futures::future::join_all(batches.iter().map(|b| save_scan_cache(b, SaveScanCacheOpts::default()))).await;
    for r in results {
        r.unwrap();
    }
    let loaded = load_scan_cache().await;
    assert!(!loaded.is_empty());
    let raw = std::fs::read_to_string(scan_cache_path()).unwrap();
    let _: serde_json::Value = serde_json::from_str(&raw).expect("main cache file must stay valid JSON");
}

#[tokio::test]
async fn cache_reported_survives_the_scan_cache_round_trip() {
    // Regression: the sanitizer rebuilt every row from a field allowlist and
    // dropped `cacheReported`, so the dashboard rendered CACHE $ as "-" for
    // every agent after the first save/load.
    let _fx = Fixture::new();
    save_scan_cache(
        &[
            evt("litellm-reported", |e| {
                e.agent = AgentId::Litellm;
                e.model = Some("claude-opus-5.5".into());
                e.cache_read_tokens = 95_872.0;
                e.timestamp = "2026-10-08T01:00:00.000Z".into();
                e.cache_reported = Some(true);
            }),
            evt("litellm-silent", |e| {
                e.agent = AgentId::Litellm;
                e.model = Some("claude-opus-5.5".into());
                e.cache_read_tokens = 0.0;
                e.timestamp = "2026-10-08T02:00:00.000Z".into();
            }),
            evt("devin-legacy-cache", |e| {
                e.agent = AgentId::Devin;
                e.model = Some("adaptive".into());
                e.cache_read_tokens = 547.0;
                e.timestamp = "2026-10-08T03:00:00.000Z".into();
            }),
        ],
        full(),
    )
    .await
    .unwrap();

    let loaded = load_scan_cache().await;
    let reported = loaded.iter().find(|e| e.id == "litellm-reported").unwrap();
    let silent = loaded.iter().find(|e| e.id == "litellm-silent").unwrap();
    assert_eq!(reported.cache_reported, Some(true), "reported flag must persist");
    assert_eq!(silent.cache_reported, None, "a row that said nothing about cache must stay unset");
    assert_eq!(
        loaded.iter().find(|e| e.id == "devin-legacy-cache").and_then(|e| e.cache_reported),
        Some(true),
        "legacy Devin cache tokens carry measured provenance"
    );
}

#[tokio::test]
async fn restore_accepts_v1_settings_only_backup() {
    let _fx = Fixture::new();
    let r = restore_backup(&json!({
        "format": "xlab-token-backup",
        "formatVersion": 1,
        "appVersion": "1.0.1",
        "exportedAt": "2026-07-15T00:00:00.000Z",
        "config": {
            "timezone": "UTC",
            "pricing": {
                "currency": "USD",
                "preferRouterCost": false,
                "customRates": { "test-model-xlab": { "inputPer1M": 1, "outputPer1M": 2 } }
            }
        }
    }))
    .await
    .unwrap();
    assert!(r.ok);
    assert!(r.custom_rate_count >= 1.0);
    assert!(r.events.is_none());
}

#[tokio::test]
async fn unified_backup_file_includes_portable_project_settings_no_token() {
    let _fx = Fixture::new();
    // Make sure the sync config view is loaded from the isolated path.
    let _ = tokenlab::config::load_config().await;
    let s = build_settings_backup(None);
    assert_eq!(s.format, "tokenlab");
    assert!(s.config.timezone.as_deref().map_or(false, |t| !t.is_empty()));
    let pricing = s.config.pricing.as_ref().expect("pricing block");
    assert!(pricing.currency.as_deref().map_or(false, |c| !c.is_empty()));
    assert!(pricing.prefer_router_cost.is_some(), "preferRouterCost must be a boolean");
    // PAT must never be serialized into the shared backup file
    let wire = serde_json::to_string(&s).unwrap();
    assert!(!wire.contains("githubToken"));
    let portable = build_portable_config();
    assert_eq!(
        portable.pricing.as_ref().and_then(|p| p.currency.clone()),
        pricing.currency
    );
}
