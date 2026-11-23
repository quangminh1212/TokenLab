//! Port of `tests/util.platform.test.ts`.

use tokenlab::agents::shared::env::{jetbrains_roots, path_env, unique, vscode_global_storage, vscode_user_data_roots};
use tokenlab::types::{AgentId, PricingStatus, UsageEvent};
use tokenlab::util::{
    app_data_dir, cache_dir, current_platform, filter_by_period, filter_by_period_sorted, home_dir,
    local_app_data_dir, normalize_model_name, sort_events_by_time,
};

const SEP: char = std::path::MAIN_SEPARATOR;

// --- platform path helpers ---------------------------------------------------

#[test]
fn home_dir_returns_a_non_empty_absolute_ish_path() {
    let h = home_dir();
    assert!(!h.is_empty());
    assert_eq!(h, path_env().home);
}

#[test]
fn app_data_local_app_data_cache_dir_are_platform_consistent() {
    let app = app_data_dir();
    let local = local_app_data_dir();
    let cache = cache_dir();
    assert!(!app.is_empty());
    assert!(!local.is_empty());
    assert!(!cache.is_empty());

    if cfg!(windows) {
        let (a, l) = (app.to_lowercase(), local.to_lowercase());
        assert!(a.contains("appdata") || a.contains("roaming"), "{a}");
        assert!(l.contains("appdata") || l.contains("local"), "{l}");
    } else if cfg!(target_os = "macos") {
        assert!(app.contains("Application Support") || app.contains("Library"));
        assert!(local.contains("Application Support") || local.contains("Library"));
        assert!(cache.contains("Caches") || cache.contains("Library"));
    } else {
        assert!(app.contains(".config") || std::env::var_os("XDG_CONFIG_HOME").is_some() || !app.is_empty());
        assert!(
            local.contains(".local") || local.contains("share") || std::env::var_os("XDG_DATA_HOME").is_some()
        );
    }
}

#[test]
fn path_env_exposes_cross_platform_fields() {
    let env = path_env();
    // Every field is a String in Rust; the TS `typeof === "string"` checks hold by construction.
    let _: &String = &env.home;
    let _: &String = &env.app_data;
    let _: &String = &env.local_app;
    let _: &String = &env.cache;
    let _: &String = &env.xdg_data;
    let _: &String = &env.xdg_config;
    let _: &String = &env.xdg_cache;
    assert_eq!(env.platform, current_platform());
    let expected = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    assert_eq!(env.platform, expected);
    // localApp must not collapse to bare home on Linux (old bug)
    if cfg!(target_os = "linux") {
        assert_ne!(env.local_app, env.home);
    }
}

#[test]
fn unique_filters_empties_and_dedupes() {
    assert_eq!(unique(["a", "", "a", "b"]), vec!["a".to_string(), "b".to_string()]);
}

#[test]
fn vscode_user_data_roots_includes_code_and_cursor() {
    let roots = vscode_user_data_roots(&[]);
    assert!(roots.iter().any(|r| r.contains("Code") || r.ends_with(&format!("{SEP}Code"))));
    assert!(roots.iter().any(|r| r.contains("Cursor")));
    assert!(roots.len() >= 4);
}

#[test]
fn vscode_global_storage_builds_extension_paths() {
    let paths = vscode_global_storage(&["saoudrizwan.claude-dev", "continue.continue"]);
    assert!(paths.len() >= 2);
    assert!(paths.iter().all(|p| p.contains("globalStorage")));
    assert!(paths.iter().any(|p| p.contains("saoudrizwan.claude-dev")));
    assert!(paths.iter().any(|p| p.contains("continue.continue")));
}

#[test]
fn jetbrains_roots_includes_jetbrains_base_and_optional_subpaths() {
    let bases = jetbrains_roots(&[]);
    assert!(bases.iter().any(|r| r.contains("JetBrains")));
    let junie = jetbrains_roots(&["Junie"]);
    assert!(junie.iter().any(|r| r.ends_with(&format!("{SEP}Junie")) || r.contains(&format!("{SEP}Junie"))));
}

// --- normalizeModelName ------------------------------------------------------

#[test]
fn normalize_model_name_strips_parenthetical_provider_suffixes() {
    assert_eq!(
        normalize_model_name(Some("gpt-5.5 (openai-compatible-responses-edd706dd-4c64-4148-ba97-f5bddf8c0cfc)")),
        Some("gpt-5.5".to_string())
    );
}

#[test]
fn normalize_model_name_strips_pipe_provider_keys_and_merges_path() {
    assert_eq!(normalize_model_name(Some("gpt-5.5|openai-compatible-chat-aa9b")), Some("gpt-5.5".to_string()));
    assert_eq!(normalize_model_name(Some("openai/gpt-4.1")), Some("gpt-4.1".to_string()));
}

#[test]
fn normalize_model_name_merges_the_qwencoder_prefixed_qwen38_max_alias() {
    assert_eq!(normalize_model_name(Some("QwenCoder Qwen3.8 Max")), Some("qwen3.8 max".to_string()));
    assert_eq!(normalize_model_name(Some("Qwencoder-Qwen3.8-Max")), Some("qwen3.8 max".to_string()));
}

#[test]
fn normalize_model_name_returns_none_for_empty() {
    assert_eq!(normalize_model_name(Some("")), None);
    assert_eq!(normalize_model_name(None), None);
}

#[test]
fn normalize_model_name_keeps_a_5_2_version_decimal_including_fable() {
    let n = |s: &str| normalize_model_name(Some(s));
    assert_eq!(n("claude-fable-5-2"), Some("claude-fable-5.2".to_string()));
    assert_eq!(n("fable-5-2"), Some("fable-5.2".to_string()));
    assert_eq!(n("anthropic/claude-fable-5-2"), Some("claude-fable-5.2".to_string()));
    assert_eq!(n("gpt-5-2"), Some("gpt-5.2".to_string()));
    assert_eq!(n("glm-5-2"), Some("glm-5.2".to_string()));
    assert_eq!(n("claude-fable-5.2"), Some("claude-fable-5.2".to_string()));
    assert_eq!(n("claude-fable-5"), Some("claude-fable-5".to_string()));
    assert_eq!(n("model-5-20"), Some("model-5-20".to_string()));
    assert_eq!(n("grok-4-fast"), Some("grok-4-fast".to_string()));
    assert_eq!(n("grok-4-5"), Some("grok-4-5".to_string()));
}

// --- period filter index -----------------------------------------------------

fn sample_evt(id: &str, ts: &str) -> UsageEvent {
    UsageEvent {
        id: id.into(),
        agent: AgentId::Grok,
        model: Some("grok-3".into()),
        timestamp: ts.into(),
        input_tokens: 10.0,
        output_tokens: 2.0,
        cache_read_tokens: 0.0,
        cache_write_tokens: 0.0,
        total_tokens: 12.0,
        estimated_cost: Some(0.001),
        currency: "USD".into(),
        pricing_status: PricingStatus::Priced,
        workspace: None,
        source_path: "/x".into(),
        ..Default::default()
    }
}

fn ids(events: &[UsageEvent]) -> Vec<&str> {
    events.iter().map(|e| e.id.as_str()).collect()
}

#[test]
fn sort_events_by_time_orders_ascending_and_builds_parallel_ms_index() {
    let events = vec![
        sample_evt("c", "2026-08-03T12:00:00.000Z"),
        sample_evt("a", "2026-08-01T12:00:00.000Z"),
        sample_evt("b", "2026-08-02T12:00:00.000Z"),
    ];
    let (sorted, timestamps_ms) = sort_events_by_time(&events);
    assert_eq!(ids(&sorted), vec!["a", "b", "c"]);
    assert_eq!(timestamps_ms.len(), 3);
    assert!(timestamps_ms[0] < timestamps_ms[1]);
    assert!(timestamps_ms[1] < timestamps_ms[2]);
}

#[test]
fn filter_by_period_sorted_matches_linear_filter_by_period() {
    let raw = vec![
        sample_evt("old", "2026-07-01T00:00:00.000Z"),
        sample_evt("mid", "2026-08-01T12:00:00.000Z"),
        sample_evt("new", "2026-08-06T18:00:00.000Z"),
        sample_evt("newer", "2026-08-06T20:00:00.000Z"),
    ];
    let (events, timestamps_ms) = sort_events_by_time(&raw);
    let since = Some("2026-08-01T00:00:00.000Z");
    let until = Some("2026-08-06T19:00:00.000Z");
    let linear = filter_by_period(&events, since, until, None);
    let indexed = filter_by_period_sorted(&events, &timestamps_ms, since, until, None);
    assert_eq!(ids(&indexed), ids(&linear));
    assert_eq!(ids(&indexed), vec!["mid", "new"]);
}

#[test]
fn filter_by_period_sorted_empty_range_returns_empty() {
    let (events, timestamps_ms) = sort_events_by_time(&[sample_evt("a", "2026-08-01T00:00:00.000Z")]);
    let out = filter_by_period_sorted(&events, &timestamps_ms, Some("2026-09-01T00:00:00.000Z"), None, None);
    assert_eq!(out.len(), 0);
}
