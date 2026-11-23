//! Port of `src/server/http.ts` (axum HTTP/SSE server).
//!
//! The Node monolith kept all of its state in closure variables inside
//! `startServer`. Here the same state lives in an [`AppState`] (a
//! `parking_lot::Mutex<Inner>` shared through an `Arc`). Locks are never held
//! across `.await`, and CPU heavy work (merge, aggregate, backup builds) runs in
//! `spawn_blocking` so the runtime keeps serving SSE pings and small requests.
//!
//! Every route is dispatched from one `fallback` handler on `(method, path)`
//! exactly like the `if (req.method === ... && url.pathname === ...)` chain in
//! the TS server; unknown paths and wrong methods give the same JSON 404.

pub mod phanmemvip_usage;

use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use futures::future::{BoxFuture, FutureExt, Shared};
use indexmap::{IndexMap, IndexSet};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use regex::Regex;
use rust_embed::RustEmbed;
use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::agents::{self, AdditionalRoots, AgentDone, ScanAllOptions};
use crate::aggregate::{
    aggregate, compute_active_usage_rpm, compute_live_request_rate, cost_report, precompute_dashboard_periods,
    DashPeriodKey, PrecomputedPeriodStats, SortBy,
};
use crate::backup::{
    build_full_backup, build_settings_backup, collapse_exact_usage_duplicates, collapse_router_daily_events,
    collapse_source_path_rollups, drop_legacy_codex_proxy_attributions, drop_legacy_router_mirror_rows,
    drop_previous_agent_session_events, drop_previous_agent_source_events, drop_previous_litellm_daily_rollups,
    enforce_monotonic_agent_days, get_machine_id, gist_coverage_key, is_gist_rollup_event, load_imported_events,
    load_scan_cache, load_scan_cache_main_only, machine_id_from_event, merge_events_by_id_prefer_richer,
    merge_local_prefer_over_gist_rollups, migrate_legacy_data_dir, prefer_richer_event, prune_stale_source_events,
    reconcile_scan_cache_high_water, restore_backup, save_imported_events, save_scan_cache,
    try_auto_daily_gist_backup, upload_backup_to_gist, AutoDailyGistResult, FullBackupOpts, SaveMode,
    SaveScanCacheOpts, SettingsBackupOpts, UploadOpts,
};
use crate::config::{
    config_from_value, config_path, full_scan_interval_minutes, get_config_sync, load_config, save_config,
    scan_interval_minutes, scan_periodic_enabled, set_custom_rates, set_scan_cache_rates_version,
    to_map as config_to_map, XlabTokenConfig,
};
use crate::flag_report::{compute_flag_report, resolve_flag_thresholds, FlagThresholds};
use crate::live_rate::{build_recent_live_events, compute_dashboard_live_rate, RecentLiveOptions};
use crate::openrouter_models::{
    fetch_open_router_models, get_open_router_fetched_at, get_open_router_models_sync,
    load_open_router_cache_from_disk, locale_compare, OpenRouterModelEntry,
};
use crate::pricing::{
    get_rate_for_model, guess_provider, list_pricing_catalog, reprice_events, RateSource, BUNDLED_RATES,
    RATES_VERSION,
};
use crate::process_guard::write_heartbeat;
use crate::rate_guard::{resolve_rate_spec, RateConfigInput};
use crate::types::{AgentId, AgentStatus, GroupBy, ModelRate, UsageEvent};
use crate::util::{
    app_data_dir, build_timestamp_index, cwd_string, env_nonempty, filter_by_period,
    filter_by_period_sorted_detailed, host_platform, js_date_parse, js_num_to_string, js_number_from_str,
    js_to_fixed, js_trim, normalize_model_for_agent, normalize_model_name, now_ms, parse_since, pjoin,
    sort_events_by_time, start_of_day_in_time_zone, to_iso_string, utc_parts, PathFlavor,
};
use crate::version::VERSION;

use phanmemvip_usage::{js_number_of_value, resolve_phanmemvip_usage, PhanmemvipUsage};

// ---------------------------------------------------------------------------
// Embedded UI (Astro build output)
// ---------------------------------------------------------------------------

/// Built Astro site. `allow_missing` keeps the crate compiling (and the server
/// running API-only) when `web/dist` does not exist yet or is mid-build.
#[derive(RustEmbed)]
#[folder = "../web/dist/"]
#[allow_missing = true]
struct Assets;

// ---------------------------------------------------------------------------
// Small JS-compat helpers
// ---------------------------------------------------------------------------

/// JS number -> JSON value: integral doubles become integers, NaN/Infinity
/// become `null` (what `JSON.stringify` does).
pub(crate) fn jn(x: f64) -> Value {
    if !x.is_finite() {
        return Value::Null;
    }
    if x.fract() == 0.0 && x.abs() < 9.0e15 {
        return Value::from(x as i64);
    }
    serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
}

/// `Math.min` (NaN propagates).
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// `Math.max` (NaN propagates).
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Number(x || fallback)` for an optional query string value.
fn number_or(value: Option<&str>, fallback: f64) -> f64 {
    match value {
        Some(s) if !s.is_empty() => js_number_from_str(s),
        _ => fallback,
    }
}

fn percent_decode(input: &str, plus_as_space: bool) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'+' && plus_as_space {
            out.push(b' ');
            i += 1;
        } else if b == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
            } else {
                out.push(b);
                i += 1;
            }
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `URLSearchParams` (first match wins for `get`).
#[derive(Debug, Default, Clone)]
struct Query {
    pairs: Vec<(String, String)>,
}

impl Query {
    fn parse(raw: Option<&str>) -> Query {
        let mut pairs = Vec::new();
        if let Some(raw) = raw {
            for part in raw.split('&') {
                if part.is_empty() {
                    continue;
                }
                let (k, v) = match part.find('=') {
                    Some(i) => (&part[..i], &part[i + 1..]),
                    None => (part, ""),
                };
                pairs.push((percent_decode(k, true), percent_decode(v, true)));
            }
        }
        Query { pairs }
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    /// `url.searchParams.get(key) || null` (empty string becomes `None`).
    fn get_nonempty(&self, key: &str) -> Option<String> {
        match self.get(key) {
            Some(s) if !s.is_empty() => Some(s.to_string()),
            _ => None,
        }
    }
}

fn configured_time_zone() -> String {
    let cfg = get_config_sync();
    match cfg.timezone.as_deref() {
        Some(tz) if !js_trim(tz).is_empty() => js_trim(tz).to_string(),
        _ => "local".to_string(),
    }
}

/// `Asia/Ho_Chi_Minh` is a fixed UTC+7 zone (no DST).
fn vietnam_date_key(now: f64) -> String {
    let (y, mo, d, ..) = utc_parts(now + 7.0 * 3_600_000.0);
    format!("{:04}-{:02}-{:02}", y, mo + 1, d)
}

async fn read_phanmemvip_usage(events: &[UsageEvent]) -> PhanmemvipUsage {
    let date = vietnam_date_key(now_ms());
    let mut mirror: Option<Map<String, Value>> = None;
    for root in agents::litellm::roots() {
        let file = pjoin(&[root.as_str(), "phanmemvip-minute-usage.json"]);
        let text = match tokio::fs::read_to_string(&file).await {
            Ok(t) => t,
            Err(_) => continue,
        };
        if let Ok(Value::Object(candidate)) = serde_json::from_str::<Value>(&text) {
            if candidate.get("date").and_then(|d| d.as_str()) == Some(date.as_str()) {
                mirror = Some(candidate);
                break;
            }
        }
    }
    resolve_phanmemvip_usage(mirror.as_ref(), events, &date)
}

/// Per-day activity audit: every candidate definition of "hours used" is
/// reported (the disagreement between them is the finding), plus `spreadHours`.
fn build_rate_audit_flag(events: &[UsageEvent], thresholds: &FlagThresholds) -> Value {
    let report = compute_flag_report(events, thresholds);
    let spread: Vec<Value> = report
        .days
        .iter()
        .map(|d| {
            json!({
                "day": d.day,
                "spanHours": jn(d.span_hours),
                "activeHours": jn(d.active_hours),
                "spread": jn(d.span_hours - d.active_hours),
            })
        })
        .collect();
    let mut value = serde_json::to_value(&report).unwrap_or(Value::Null);
    if let Value::Object(map) = &mut value {
        map.insert("spreadHours".to_string(), Value::Array(spread));
    }
    value
}

// ---------------------------------------------------------------------------
// Periodic light scan (pure helpers, exported for tests)
// ---------------------------------------------------------------------------

/// Agents refreshed by the periodic light scan. The cadence comes from
/// `config.scan.intervalMinutes` (Settings -> Scanning, default 60 min).
const PERIODIC_LIGHT_AGENTS: [&str; 7] = ["codex", "9router", "routerlab", "xlabrouter", "litellm", "hermes", "dsh"];

fn is_periodic_light_agent(agent: &str) -> bool {
    PERIODIC_LIGHT_AGENTS.contains(&agent)
}

pub fn periodic_light_scan_enabled() -> HashMap<AgentId, bool> {
    let mut enabled = HashMap::new();
    for module in agents::all_agents() {
        enabled.insert(module.id, is_periodic_light_agent(module.id.as_str()));
    }
    enabled
}

/// Codex and Hermes light parses return the complete rows of each file they
/// actually read. Replacing those source paths is enough.
fn is_light_source_replace_agent(agent: &str) -> bool {
    agent == "codex" || agent == "hermes"
}

/// `usageSourceKey`: source path up to the first " <- " marker, `\` -> `/`,
/// lowercase.
fn usage_source_key(source_path: &str) -> String {
    source_path
        .split(" \u{2190} ")
        .next()
        .unwrap_or("")
        .replace('\\', "/")
        .to_lowercase()
}

fn dedupe_fresh_by_id(fresh: &[UsageEvent]) -> Vec<UsageEvent> {
    let mut by_id: IndexMap<&str, &UsageEvent> = IndexMap::new();
    for event in fresh {
        if event.id.is_empty() {
            continue;
        }
        match by_id.get_mut(event.id.as_str()) {
            Some(slot) => *slot = prefer_richer_event(*slot, event),
            None => {
                by_id.insert(event.id.as_str(), event);
            }
        }
    }
    by_id.values().map(|e| (*e).clone()).collect()
}

fn merge_sorted_usage(
    left: Vec<UsageEvent>,
    left_ts: Vec<f64>,
    right: Vec<UsageEvent>,
    right_ts: Vec<f64>,
) -> (Vec<UsageEvent>, Vec<f64>) {
    let total = left.len() + right.len();
    let mut events = Vec::with_capacity(total);
    let mut timestamps = Vec::with_capacity(total);
    let mut left_iter = left.into_iter().zip(left_ts).peekable();
    let mut right_iter = right.into_iter().zip(right_ts).peekable();
    loop {
        let take_left = match (left_iter.peek(), right_iter.peek()) {
            (Some(l), Some(r)) => l.1 <= r.1,
            (Some(_), None) => true,
            (None, Some(_)) => false,
            (None, None) => break,
        };
        let (event, ts) = if take_left { left_iter.next() } else { right_iter.next() }.unwrap();
        events.push(event);
        timestamps.push(ts);
    }
    (events, timestamps)
}

fn drop_gist_rows_covered_by_fresh(
    sorted: (Vec<UsageEvent>, Vec<f64>),
    fresh: &[&UsageEvent],
) -> (Vec<UsageEvent>, Vec<f64>) {
    let mut covered: HashSet<String> = HashSet::new();
    for event in fresh {
        if is_gist_rollup_event(event) {
            continue;
        }
        covered.insert(gist_coverage_key(event));
    }
    if covered.is_empty() {
        return sorted;
    }
    let mid = get_machine_id();
    let is_covered = |event: &UsageEvent| -> bool {
        if !is_gist_rollup_event(event) {
            return false;
        }
        let event_mid = machine_id_from_event(event);
        (event_mid.is_empty() || event_mid == mid) && covered.contains(&gist_coverage_key(event))
    };
    if !sorted.0.iter().any(|e| is_covered(e)) {
        return sorted;
    }
    let mut events = Vec::with_capacity(sorted.0.len());
    let mut timestamps = Vec::with_capacity(sorted.0.len());
    for (event, ts) in sorted.0.into_iter().zip(sorted.1) {
        if is_covered(&event) {
            continue;
        }
        events.push(event);
        timestamps.push(ts);
    }
    (events, timestamps)
}

/// Apply one light scan onto an already sorted cache. Untouched rows stay in
/// order; only the fresh rows are sorted, then merged.
pub fn apply_periodic_light_delta(
    prev: &[UsageEvent],
    prev_ts: Option<&[f64]>,
    fresh_by_agent: &IndexMap<String, Vec<UsageEvent>>,
) -> (Vec<UsageEvent>, Vec<f64>) {
    let mut replace_paths: HashMap<&str, HashSet<String>> = HashMap::new();
    let mut replace_ids: HashMap<&str, HashSet<&str>> = HashMap::new();
    let mut small_agents: IndexSet<&str> = IndexSet::new();
    for (agent, fresh) in fresh_by_agent {
        if fresh.is_empty() {
            continue;
        }
        if is_light_source_replace_agent(agent) {
            let mut paths = HashSet::new();
            let mut ids = HashSet::new();
            for event in fresh {
                if !event.id.is_empty() {
                    ids.insert(event.id.as_str());
                }
                let source = usage_source_key(&event.source_path);
                if !source.is_empty() {
                    paths.insert(source);
                }
            }
            replace_paths.insert(agent.as_str(), paths);
            replace_ids.insert(agent.as_str(), ids);
        } else {
            small_agents.insert(agent.as_str());
        }
    }

    let mut kept: Vec<UsageEvent> = Vec::with_capacity(prev.len());
    let mut kept_ts: Vec<f64> = Vec::with_capacity(prev.len());
    let mut prev_small: HashMap<&str, Vec<UsageEvent>> = HashMap::new();
    // Same id on a file this light pass did not re-read. Richer row wins.
    let mut shadowed: HashMap<String, UsageEvent> = HashMap::new();
    let use_ts = prev_ts.map_or(false, |t| t.len() == prev.len());
    for (i, event) in prev.iter().enumerate() {
        let agent = event.agent.as_str();
        if let Some(paths) = replace_paths.get(agent) {
            let source = usage_source_key(&event.source_path);
            if !source.is_empty() && paths.contains(&source) {
                continue;
            }
            if !event.id.is_empty() && replace_ids.get(agent).map_or(false, |ids| ids.contains(event.id.as_str())) {
                let key = format!("{}|{}", agent, event.id);
                let richer = match shadowed.get(&key) {
                    Some(existing) => prefer_richer_event(existing, event).clone(),
                    None => event.clone(),
                };
                shadowed.insert(key, richer);
                continue;
            }
            kept.push(event.clone());
            if use_ts {
                kept_ts.push(prev_ts.unwrap()[i]);
            }
            continue;
        }
        if small_agents.contains(agent) {
            prev_small.entry(agent).or_default().push(event.clone());
            continue;
        }
        kept.push(event.clone());
        if use_ts {
            kept_ts.push(prev_ts.unwrap()[i]);
        }
    }
    if !use_ts {
        for event in &kept {
            let parsed = js_date_parse(&event.timestamp);
            kept_ts.push(if parsed.is_nan() { 0.0 } else { parsed });
        }
    }

    let mut additions: Vec<UsageEvent> = Vec::new();
    for (agent, fresh) in fresh_by_agent {
        if !replace_paths.contains_key(agent.as_str()) {
            continue;
        }
        for event in dedupe_fresh_by_id(fresh) {
            let key = format!("{}|{}", agent, event.id);
            match shadowed.get(&key) {
                Some(shadow) => additions.push(prefer_richer_event(shadow, &event).clone()),
                None => additions.push(event),
            }
        }
    }
    for agent in &small_agents {
        let fresh: &[UsageEvent] = fresh_by_agent.get(*agent).map(|v| v.as_slice()).unwrap_or(&[]);
        let previous: &[UsageEvent] = prev_small.get(agent).map(|v| v.as_slice()).unwrap_or(&[]);
        additions.extend(merge_events_by_id_prefer_richer(&[fresh, previous]));
    }
    let (sorted_add, sorted_add_ts) = sort_events_by_time(&additions);
    let merged = merge_sorted_usage(kept, kept_ts, sorted_add, sorted_add_ts);
    let fresh_rows: Vec<&UsageEvent> = fresh_by_agent.values().flat_map(|v| v.iter()).collect();
    drop_gist_rows_covered_by_fresh(merged, &fresh_rows)
}

// ---------------------------------------------------------------------------
// Logging (never panic on a closed stdout/stderr, like the TS `slog`)
// ---------------------------------------------------------------------------

fn slog(message: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stdout(), "{message}");
}

fn swarn(message: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "{message}");
}

/// Append `[ISO] message` to `<LOCALAPPDATA||APPDATA||cwd>/tokenlab/server.txt`.
fn light_log(message: &str) {
    use std::io::Write;
    let base = env_nonempty("LOCALAPPDATA")
        .or_else(|| env_nonempty("APPDATA"))
        .unwrap_or_else(cwd_string);
    let dir = pjoin(&[base.as_str(), "tokenlab"]);
    let file = pjoin(&[dir.as_str(), "server.txt"]);
    let line = format!("[{}] {}\r\n", to_iso_string(now_ms()).unwrap_or_default(), message);
    if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(&file) {
        let _ = f.write_all(line.as_bytes());
    }
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

type ScanFuture = Shared<BoxFuture<'static, Result<usize, String>>>;
type BoolFuture = Shared<BoxFuture<'static, bool>>;
type AgentsFuture = Shared<BoxFuture<'static, Arc<Vec<AgentStatus>>>>;

const LIVE_RATE_TTL_MS: f64 = 2_500.0;
const AGENTS_PATH_TTL_MS: f64 = 8_000.0;
const QUICK_SAVE_MIN_MS: f64 = 5.0 * 60_000.0;

/// Run `fut` on its own task (so it survives the caller going away, e.g. an
/// HTTP client disconnecting) and hand out a clonable handle on its result.
fn spawn_shared<T, F>(handle: &tokio::runtime::Handle, fut: F, on_panic: T) -> Shared<BoxFuture<'static, T>>
where
    T: Clone + Send + Sync + 'static,
    F: std::future::Future<Output = T> + Send + 'static,
{
    let join: JoinHandle<T> = handle.spawn(fut);
    async move { join.await.unwrap_or(on_panic) }.boxed().shared()
}

fn ready_scan(n: usize) -> ScanFuture {
    futures::future::ready(Ok::<usize, String>(n)).boxed().shared()
}

#[derive(Clone)]
struct LiveRateMemo {
    at: f64,
    scan_revision: u64,
    window_minutes: f64,
    value: Arc<Value>,
}

#[derive(Clone)]
struct AgentsStatusCache {
    at: f64,
    event_count: usize,
    agents: Arc<Vec<AgentStatus>>,
}

struct Inner {
    /// Write-side cache (may be replaced several times while a scan runs).
    cache: Arc<Vec<UsageEvent>>,
    /// Parallel ms timestamps for O(log n) period filters (None while unsorted).
    cache_ts: Option<Arc<Vec<f64>>>,
    /// Stable read snapshot published only as complete, indexed snapshots.
    read_cache: Arc<Vec<UsageEvent>>,
    read_cache_ts: Option<Arc<Vec<f64>>>,
    /// Period aggregate memo (serialized `{...stats, usageRpm}` minus `live`).
    period_stats_memo: HashMap<String, Arc<Map<String, Value>>>,
    /// Cost reports are stable between completed scan/pricing revisions.
    cost_report_memo: HashMap<String, Arc<Value>>,
    live_rate_memo: Option<LiveRateMemo>,
    /// Single-pass period stats for Today/24h/7D/30D/All.
    dash_period_stats: Option<Arc<IndexMap<DashPeriodKey, PrecomputedPeriodStats>>>,
    dash_period_stats_building: bool,
    /// Events from other machines / restore: survive local rescans.
    imported_events: Arc<Vec<UsageEvent>>,
    scanning: bool,
    scan_promise: Option<ScanFuture>,
    manual_full_scan_promise: Option<ScanFuture>,
    scan_cache_save_timer: Option<JoinHandle<()>>,
    pending_save_full: bool,
    last_quick_save_at: f64,
    last_recent_light_scan_at: f64,
    last_periodic_full_scan_at: f64,
    scan_revision: u64,
    scan_updated_at: f64,
    pricing_revision: u64,
    pricing_updated_at: f64,
    /// SSE clients (pricing + scan status).
    listeners: Vec<mpsc::UnboundedSender<String>>,
    agents_status_cache: Option<AgentsStatusCache>,
    agents_status_promise: Option<AgentsFuture>,
    /// agentId -> mirrored Ubuntu roots (local paths) + machine scope.
    ubuntu_additional_roots: HashMap<AgentId, AdditionalRoots>,
    last_mirror_sync_at: f64,
    last_pmv_mirror_sync_at: f64,
    last_ubuntu_mirror_sync_at: f64,
    vps_sync_promise: Option<BoolFuture>,
    pmv_sync_promise: Option<BoolFuture>,
    ubuntu_sync_promise: Option<BoolFuture>,
    /// Long-lived background timers (aborted on close).
    tasks: Vec<JoinHandle<()>>,
}

pub(crate) struct AppState {
    inner: Mutex<Inner>,
    #[allow(dead_code)]
    host: String,
    #[allow(dead_code)]
    port: u16,
    no_ui: bool,
    started_at: f64,
    handle: tokio::runtime::Handle,
    /// Flipped to `true` by `ServerHandle::close` so SSE pings stop and streams end.
    shutdown: tokio::sync::watch::Sender<bool>,
}

#[derive(Default)]
struct ScanLocal {
    by_agent: IndexMap<String, Vec<UsageEvent>>,
    /// Light tick: agents that returned rows. Empty means "file unchanged".
    fresh_by_agent: IndexMap<String, Vec<UsageEvent>>,
    agent_stats: Vec<AgentStat>,
    codex_replaced_paths: HashSet<String>,
    grok_replaced_sessions: HashSet<String>,
    agents_done: u64,
    rebuilt: bool,
}

struct AgentStat {
    agent: String,
    events: usize,
    duration_ms: f64,
    error: Option<String>,
}

#[derive(Default)]
struct Progress {
    last_payload: Option<Map<String, Value>>,
    timer: Option<JoinHandle<()>>,
}

/// `scanning = false; scanPromise = null` in the TS `finally`, even if the scan
/// task panics.
struct ScanGuard(Arc<AppState>);

impl Drop for ScanGuard {
    fn drop(&mut self) {
        let mut g = self.0.inner.lock();
        g.scanning = false;
        g.scan_promise = None;
    }
}

static RE_GROK_TAGGED: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)#([0-9a-f]{8}-[0-9a-f-]{27,})$").unwrap());
static RE_GROK_ON_DISK: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)[\\/]sessions[\\/][^\\/]+[\\/]([^\\/]+)[\\/](?:usage|updates|chat_history)\.jsonl?$").unwrap()
});

fn grok_session_key(source_path: &str) -> String {
    if let Some(m) = RE_GROK_TAGGED.captures(source_path).and_then(|c| c.get(1)) {
        return m.as_str().to_lowercase();
    }
    RE_GROK_ON_DISK
        .captures(source_path)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_lowercase())
        .unwrap_or_default()
}

/// Mid-scan merge: by-id prefer-richer. Never replace a richer previous agent
/// snapshot just because the fresh parse has more (often thinner) rows. Also
/// returns the Grok sessions replaced by usage snapshots in this pass.
fn merge_agent_scan_light(fresh: Vec<UsageEvent>, mut prev: Vec<UsageEvent>) -> (Vec<UsageEvent>, HashSet<String>) {
    let mut grok_sessions: HashSet<String> = HashSet::new();
    if fresh.is_empty() {
        return (prev, grok_sessions);
    }
    if prev.is_empty() {
        return (fresh, grok_sessions);
    }
    let agent = fresh[0].agent.as_str();
    // Antigravity: full re-parse is authoritative.
    if agent == "antigravity" && fresh.len() >= 5 {
        return (fresh, grok_sessions);
    }
    // Codex and Hermes: replace previous rows of re-read files before the union.
    if agent == "codex" || agent == "hermes" {
        let fresh_paths: HashSet<String> = fresh
            .iter()
            .map(|e| usage_source_key(&e.source_path))
            .filter(|p| !p.is_empty())
            .collect();
        if !fresh_paths.is_empty() {
            prev.retain(|e| !fresh_paths.contains(&usage_source_key(&e.source_path)));
        }
    }
    let mut prev_for_merge = prev;
    if agent == "grok" {
        let mut snapshot_sessions: HashSet<String> = HashSet::new();
        let mut fresh_paths: HashSet<String> = HashSet::new();
        for e in &fresh {
            if !e.source_path.is_empty() {
                let source = e.source_path.replace('\\', "/").to_lowercase();
                if source.ends_with("usage.json") || source.contains("session-meta.json#") {
                    let session = grok_session_key(&e.source_path);
                    if !session.is_empty() {
                        snapshot_sessions.insert(session);
                    }
                }
                fresh_paths.insert(source);
            }
        }
        grok_sessions = snapshot_sessions.clone();
        let filtered: Vec<UsageEvent> = prev_for_merge
            .into_iter()
            .filter(|e| {
                if e.agent.as_str() != "grok" {
                    return true;
                }
                let sp = e.source_path.replace('\\', "/").to_lowercase();
                let session = grok_session_key(&e.source_path);
                // A usage.json/session-meta snapshot replaces every older per-turn row.
                if !session.is_empty() && snapshot_sessions.contains(&session) {
                    return false;
                }
                if e.output_tokens > 0.0 {
                    return true;
                }
                if e.estimated != Some(true) {
                    return true;
                }
                if sp.is_empty() || !sp.ends_with("updates.jsonl") {
                    return true;
                }
                // Path re-scanned: fresh is authoritative for residuals on that file.
                if fresh_paths.contains(&sp) {
                    return false;
                }
                true
            })
            .collect();
        prev_for_merge = drop_previous_agent_session_events(&filtered, &fresh, "grok");
    }
    if agent == "claude-code" {
        prev_for_merge = drop_previous_agent_source_events(&prev_for_merge, &fresh, "claude-code");
    }
    if agent == "opencode" {
        prev_for_merge = drop_previous_agent_source_events(&prev_for_merge, &fresh, "opencode");
    }
    (merge_events_by_id_prefer_richer(&[&fresh, &prev_for_merge]), grok_sessions)
}

fn opt_num_sig(x: Option<f64>) -> String {
    x.map(js_num_to_string).unwrap_or_default()
}

/// Same tokens, cost, and model means the cached row is already complete.
fn usage_sig(e: &UsageEvent) -> String {
    [
        js_num_to_string(e.input_tokens),
        js_num_to_string(e.output_tokens),
        js_num_to_string(e.cache_read_tokens),
        js_num_to_string(e.cache_write_tokens),
        opt_num_sig(e.request_count),
        opt_num_sig(e.estimated_cost),
        e.model.clone().unwrap_or_default(),
        if e.cache_reported == Some(true) { "reported".to_string() } else { String::new() },
    ]
    .join(":")
}

/// True when every fresh row is already in the cache with the same totals.
fn light_fresh_already_cached(fresh_by_agent: &IndexMap<String, Vec<UsageEvent>>, prev: &[UsageEvent]) -> bool {
    let mut need: HashMap<&str, String> = HashMap::new();
    for events in fresh_by_agent.values() {
        for event in events {
            need.insert(event.id.as_str(), usage_sig(event));
        }
    }
    if need.is_empty() {
        return true;
    }
    let mut found = 0usize;
    for event in prev {
        let want = match need.get(event.id.as_str()) {
            Some(w) => w,
            None => continue,
        };
        if *want != usage_sig(event) {
            return false;
        }
        found += 1;
        if found == need.len() {
            return true;
        }
    }
    found == need.len()
}

fn dash_period_key(since: Option<&str>, until: Option<&str>) -> Option<DashPeriodKey> {
    if matches!(until, Some(u) if !u.is_empty()) {
        return None;
    }
    let since = match since {
        Some(s) if !s.is_empty() => s,
        _ => return Some(DashPeriodKey::All),
    };
    match js_trim(since).to_lowercase().as_str() {
        "today" => Some(DashPeriodKey::Today),
        "24h" => Some(DashPeriodKey::H24),
        "7d" => Some(DashPeriodKey::D7),
        "30d" => Some(DashPeriodKey::D30),
        _ => None,
    }
}

/// Pure body of `rebuild(finalize)`: union of unchanged and re-scanned rows,
/// collapse + high-water guards when finalizing, then the imported merge.
fn rebuild_merge(
    full: bool,
    finalize: bool,
    prev: &[UsageEvent],
    by_agent: IndexMap<String, Vec<UsageEvent>>,
    codex_replaced_paths: &HashSet<String>,
    grok_replaced_sessions: &HashSet<String>,
    imported: &[UsageEvent],
) -> (Vec<UsageEvent>, Option<Vec<f64>>) {
    let collapse = |events: &[UsageEvent]| -> Vec<UsageEvent> {
        collapse_exact_usage_duplicates(&collapse_source_path_rollups(&collapse_router_daily_events(events)))
    };
    let previous_for_monotonic = || -> Vec<UsageEvent> {
        let valid = drop_legacy_codex_proxy_attributions(prev);
        if codex_replaced_paths.is_empty() && grok_replaced_sessions.is_empty() {
            return valid;
        }
        valid
            .into_iter()
            .filter(|e| {
                if e.agent.as_str() == "codex" && codex_replaced_paths.contains(&usage_source_key(&e.source_path)) {
                    return false;
                }
                if e.agent.as_str() == "grok" && grok_replaced_sessions.contains(&grok_session_key(&e.source_path)) {
                    return false;
                }
                true
            })
            .collect()
    };
    // Baseline for the high-water guard: previous rows, minus anything the
    // current scan has just re-parsed.
    let monotonic_baseline = |scanned: &[UsageEvent]| -> Vec<UsageEvent> {
        prune_stale_source_events(
            &drop_legacy_router_mirror_rows(
                &drop_previous_litellm_daily_rollups(&previous_for_monotonic(), scanned),
                scanned,
            ),
            scanned,
        )
    };

    let mut scanned: Vec<UsageEvent> = Vec::new();
    if !full {
        scanned.extend(prev.iter().filter(|e| !is_periodic_light_agent(e.agent.as_str())).cloned());
    }
    for (_, list) in by_agent {
        scanned.extend(list);
    }
    if finalize {
        scanned = drop_legacy_codex_proxy_attributions(&scanned);
        scanned = collapse(&scanned);
        scanned = enforce_monotonic_agent_days(&monotonic_baseline(&scanned), &scanned);
        scanned = collapse(&scanned);
    }
    let mut merged = merge_local_prefer_over_gist_rollups(&scanned, imported, None);
    if finalize {
        merged = drop_legacy_codex_proxy_attributions(&merged);
        merged = enforce_monotonic_agent_days(&monotonic_baseline(&merged), &merged);
        merged = collapse(&merged);
        let (events, ts) = sort_events_by_time(&merged);
        (events, Some(ts))
    } else {
        (merged, None)
    }
}

fn refresh_agent_event_counts(base: &[AgentStatus], cache: &[UsageEvent]) -> Vec<AgentStatus> {
    let mut counts: HashMap<&str, f64> = HashMap::new();
    let mut last_at: HashMap<&str, &str> = HashMap::new();
    for e in cache {
        let agent = e.agent.as_str();
        *counts.entry(agent).or_insert(0.0) += 1.0;
        match last_at.get(agent) {
            Some(prev) if e.timestamp.as_str() <= *prev => {}
            _ => {
                last_at.insert(agent, e.timestamp.as_str());
            }
        }
    }
    base.iter()
        .map(|a| {
            let mut next = a.clone();
            next.event_count = counts.get(a.id.as_str()).copied().unwrap_or(0.0);
            next.last_event_at = last_at.get(a.id.as_str()).map(|s| s.to_string());
            next
        })
        .collect()
}

/// Filter a read snapshot by period; the parallel index is returned when the
/// snapshot was sorted.
fn filter_snapshot(
    events: &[UsageEvent],
    ts: Option<&[f64]>,
    since: Option<&str>,
    until: Option<&str>,
) -> (Vec<UsageEvent>, Option<Vec<f64>>) {
    let tz = configured_time_zone();
    match ts {
        Some(ts) if ts.len() == events.len() => {
            let (e, t) = filter_by_period_sorted_detailed(events, ts, since, until, Some(&tz));
            (e, Some(t))
        }
        _ => (filter_by_period(events, since, until, Some(&tz)), None),
    }
}

struct ReadSnapshot {
    events: Arc<Vec<UsageEvent>>,
    ts: Option<Arc<Vec<f64>>>,
}

impl ReadSnapshot {
    fn ts_slice(&self) -> Option<&[f64]> {
        self.ts.as_deref().map(|v| v.as_slice())
    }
}

fn stat_summary(stats: &[AgentStat]) -> String {
    stats
        .iter()
        .map(|s| format!("{}:{}/{}", s.agent, s.events, js_num_to_string(s.duration_ms)))
        .collect::<Vec<_>>()
        .join(" ")
}

impl AppState {
    fn new(host: String, port: u16, no_ui: bool, handle: tokio::runtime::Handle) -> AppState {
        let now = now_ms();
        AppState {
            inner: Mutex::new(Inner {
                cache: Arc::new(Vec::new()),
                cache_ts: None,
                read_cache: Arc::new(Vec::new()),
                read_cache_ts: None,
                period_stats_memo: HashMap::new(),
                cost_report_memo: HashMap::new(),
                live_rate_memo: None,
                dash_period_stats: None,
                dash_period_stats_building: false,
                imported_events: Arc::new(Vec::new()),
                scanning: false,
                scan_promise: None,
                manual_full_scan_promise: None,
                scan_cache_save_timer: None,
                pending_save_full: false,
                last_quick_save_at: 0.0,
                last_recent_light_scan_at: 0.0,
                last_periodic_full_scan_at: now,
                scan_revision: 0,
                scan_updated_at: 0.0,
                pricing_revision: 1,
                pricing_updated_at: now,
                listeners: Vec::new(),
                agents_status_cache: None,
                agents_status_promise: None,
                ubuntu_additional_roots: HashMap::new(),
                last_mirror_sync_at: 0.0,
                last_pmv_mirror_sync_at: 0.0,
                last_ubuntu_mirror_sync_at: 0.0,
                vps_sync_promise: None,
                pmv_sync_promise: None,
                ubuntu_sync_promise: None,
                tasks: Vec::new(),
            }),
            host,
            port,
            no_ui,
            started_at: now,
            handle,
            shutdown: tokio::sync::watch::channel(false).0,
        }
    }

    // ----- SSE -------------------------------------------------------------

    fn broadcast_stream(&self, payload: Value) {
        let data = format!("data: {}\n\n", serde_json::to_string(&payload).unwrap_or_else(|_| "null".into()));
        let mut g = self.inner.lock();
        g.listeners.retain(|tx| tx.send(data.clone()).is_ok());
    }

    fn bump_pricing(&self, reason: &str) {
        let payload = {
            let mut g = self.inner.lock();
            g.pricing_revision += 1;
            g.pricing_updated_at = now_ms();
            g.cost_report_memo.clear();
            json!({
                "type": "pricing",
                "revision": g.pricing_revision,
                "updatedAt": jn(g.pricing_updated_at),
                "reason": reason,
                "eventCount": g.cache.len(),
                "scanning": g.scanning,
                "scanRevision": g.scan_revision,
            })
        };
        self.broadcast_stream(payload);
    }

    fn bump_scan(&self, reason: &str) {
        let payload = {
            let mut g = self.inner.lock();
            g.scan_revision += 1;
            g.scan_updated_at = now_ms();
            g.cost_report_memo.clear();
            json!({
                "type": "scan",
                "revision": g.scan_revision,
                "updatedAt": jn(g.scan_updated_at),
                "reason": reason,
                "eventCount": g.cache.len(),
                "scanning": false,
                "pricingRevision": g.pricing_revision,
            })
        };
        self.broadcast_stream(payload);
    }

    /// Broadcast a `{type:"scan", ...}` frame announcing a scan phase.
    fn broadcast_scan_phase(&self, reason: &str) {
        let payload = {
            let g = self.inner.lock();
            json!({
                "type": "scan",
                "revision": g.scan_revision,
                "updatedAt": jn(now_ms()),
                "reason": reason,
                "eventCount": g.cache.len(),
                "scanning": true,
                "pricingRevision": g.pricing_revision,
            })
        };
        self.broadcast_stream(payload);
    }

    // ----- cache -----------------------------------------------------------

    /// Replace the in-memory event cache. When `sorted` is false the
    /// O(n log n) sort is deferred to the first period query.
    async fn set_cache(self: &Arc<Self>, events: Vec<UsageEvent>, sorted: bool, ts: Option<Vec<f64>>) {
        let (events, ts) = if sorted {
            match ts {
                Some(t) if t.len() == events.len() => (events, Some(t)),
                _ if events.is_empty() => (events, Some(Vec::new())),
                _ => {
                    if events.len() > 20_000 {
                        match tokio::task::spawn_blocking(move || {
                            let t = build_timestamp_index(&events);
                            (events, t)
                        })
                        .await
                        {
                            Ok((e, t)) => (e, Some(t)),
                            Err(_) => return,
                        }
                    } else {
                        let t = build_timestamp_index(&events);
                        (events, Some(t))
                    }
                }
            }
        } else {
            (events, None)
        };
        let want_index = sorted && !events.is_empty();
        {
            let mut g = self.inner.lock();
            g.cache = Arc::new(events);
            if sorted {
                g.cache_ts = ts.map(Arc::new);
                // Publish only complete, timestamp-indexed snapshots to readers.
                g.read_cache = g.cache.clone();
                g.read_cache_ts = g.cache_ts.clone();
            } else {
                g.cache_ts = None;
            }
            g.period_stats_memo.clear();
            g.live_rate_memo = None;
            g.dash_period_stats = None;
        }
        // After a full sorted set (boot / scan finalize): rebuild the period
        // index in the background so the next period switch is a map lookup.
        if want_index {
            let this = self.clone();
            self.handle.spawn(async move {
                this.rebuild_dash_period_stats().await;
            });
        }
    }

    /// Snapshot of the sorted cache, sorting (and publishing) it if needed.
    async fn ensure_cache_sorted(self: &Arc<Self>) -> (Arc<Vec<UsageEvent>>, Arc<Vec<f64>>) {
        let snapshot = {
            let g = self.inner.lock();
            if let Some(ts) = &g.cache_ts {
                if ts.len() == g.cache.len() {
                    return (g.cache.clone(), ts.clone());
                }
            }
            g.cache.clone()
        };
        let source = snapshot.clone();
        let (sorted, ts) = match tokio::task::spawn_blocking(move || sort_events_by_time(&source)).await {
            Ok(r) => r,
            Err(_) => return (snapshot, Arc::new(Vec::new())),
        };
        let sorted = Arc::new(sorted);
        let ts = Arc::new(ts);
        let mut g = self.inner.lock();
        if Arc::ptr_eq(&g.cache, &snapshot) {
            g.cache = sorted.clone();
            g.cache_ts = Some(ts.clone());
        }
        (sorted, ts)
    }

    /// The snapshot readers use: the last complete one while scanning.
    fn read_snapshot(&self) -> ReadSnapshot {
        let g = self.inner.lock();
        if g.scanning {
            ReadSnapshot { events: g.read_cache.clone(), ts: g.read_cache_ts.clone() }
        } else {
            ReadSnapshot { events: g.cache.clone(), ts: g.cache_ts.clone() }
        }
    }

    async fn events_in_period_detailed(
        self: &Arc<Self>,
        since: Option<String>,
        until: Option<String>,
    ) -> (Vec<UsageEvent>, Option<Vec<f64>>) {
        let snap = self.read_snapshot();
        tokio::task::spawn_blocking(move || {
            filter_snapshot(&snap.events, snap.ts_slice(), since.as_deref(), until.as_deref())
        })
        .await
        .unwrap_or_default()
    }

    async fn events_in_period(self: &Arc<Self>, since: Option<String>, until: Option<String>) -> Vec<UsageEvent> {
        self.events_in_period_detailed(since, until).await.0
    }

    /// Reprice keeps timestamps/order: retain the sort index, only invalidate
    /// the period memo.
    async fn reprice_cache(self: &Arc<Self>, force_table: bool) {
        for _ in 0..4 {
            let snapshot = self.inner.lock().cache.clone();
            let source = snapshot.clone();
            let repriced = match tokio::task::spawn_blocking(move || reprice_events(&source, force_table)).await {
                Ok(r) => Arc::new(r),
                Err(_) => return,
            };
            let mut g = self.inner.lock();
            if Arc::ptr_eq(&g.cache, &snapshot) {
                g.cache = repriced;
                g.read_cache = g.cache.clone();
                g.read_cache_ts = g.cache_ts.clone();
                g.period_stats_memo.clear();
                g.live_rate_memo = None;
                return;
            }
        }
        let mut g = self.inner.lock();
        g.cache = Arc::new(reprice_events(&g.cache, force_table));
        g.read_cache = g.cache.clone();
        g.read_cache_ts = g.cache_ts.clone();
        g.period_stats_memo.clear();
        g.live_rate_memo = None;
    }

    async fn rebuild_dash_period_stats(self: &Arc<Self>) {
        {
            let mut g = self.inner.lock();
            if g.cache.is_empty() {
                g.dash_period_stats = None;
                return;
            }
            if g.dash_period_stats_building {
                return;
            }
            g.dash_period_stats_building = true;
        }
        struct BuildGuard(Arc<AppState>);
        impl Drop for BuildGuard {
            fn drop(&mut self) {
                self.0.inner.lock().dash_period_stats_building = false;
            }
        }
        let _guard = BuildGuard(self.clone());
        write_heartbeat();
        let (events, ts) = self.ensure_cache_sorted().await;
        let tz = configured_time_zone();
        let now = now_ms();
        let source = events.clone();
        let computed = tokio::task::spawn_blocking(move || {
            let mut bounds: HashMap<DashPeriodKey, Option<f64>> = HashMap::new();
            bounds.insert(DashPeriodKey::Today, parse_since(Some("today"), Some(&tz)));
            bounds.insert(DashPeriodKey::H24, parse_since(Some("24h"), Some(&tz)));
            bounds.insert(DashPeriodKey::D7, parse_since(Some("7d"), Some(&tz)));
            bounds.insert(DashPeriodKey::D30, parse_since(Some("30d"), Some(&tz)));
            bounds.insert(DashPeriodKey::All, None);
            precompute_dashboard_periods(&source, &ts, &bounds, now)
        })
        .await;
        match computed {
            Ok(stats) => {
                write_heartbeat();
                slog(&format!(
                    "[tokenlab] period index ready: {} events \u{2192} {} periods",
                    events.len(),
                    stats.len()
                ));
                let mut g = self.inner.lock();
                if Arc::ptr_eq(&g.cache, &events) {
                    g.dash_period_stats = Some(Arc::new(stats));
                }
            }
            Err(err) => {
                swarn(&format!("[tokenlab] period index rebuild failed: {err}"));
                self.inner.lock().dash_period_stats = None;
            }
        }
    }

    async fn get_live_rate_cached(self: &Arc<Self>, window_minutes: f64) -> Arc<Value> {
        let floored = window_minutes.floor();
        let floored = if floored.is_nan() || floored == 0.0 { 3.0 } else { floored };
        let mins = floored.min(60.0).max(1.0);
        let now = now_ms();
        let (source, source_ts) = {
            let g = self.inner.lock();
            if let Some(m) = &g.live_rate_memo {
                if m.scan_revision == g.scan_revision && m.window_minutes == mins && now - m.at < LIVE_RATE_TTL_MS {
                    return m.value.clone();
                }
            }
            if g.scanning {
                (g.read_cache.clone(), g.read_cache_ts.clone())
            } else {
                (g.cache.clone(), g.cache_ts.clone())
            }
        };
        write_heartbeat();
        let rate = compute_dashboard_live_rate(
            &source,
            mins,
            now,
            source_ts.as_deref().map(|v| v.as_slice()),
            compute_live_request_rate,
        )
        .await;
        write_heartbeat();
        let value = Arc::new(serde_json::to_value(&rate).unwrap_or(Value::Null));
        let mut g = self.inner.lock();
        let scan_revision = g.scan_revision;
        g.live_rate_memo = Some(LiveRateMemo { at: now, scan_revision, window_minutes: mins, value: value.clone() });
        value
    }

    fn schedule_save_scan_cache(self: &Arc<Self>, full: bool) {
        let mut g = self.inner.lock();
        if full {
            g.pending_save_full = true;
        }
        // Do not reset an already-pending light save every tick.
        if g.scan_cache_save_timer.is_some() && !full {
            return;
        }
        if let Some(timer) = g.scan_cache_save_timer.take() {
            timer.abort();
        }
        let delay = if g.pending_save_full {
            800.0
        } else {
            f64::max(5_000.0, QUICK_SAVE_MIN_MS - (now_ms() - g.last_quick_save_at))
        };
        let this = self.clone();
        let timer = self.handle.spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay as u64)).await;
            let (events, mode) = {
                let mut g = this.inner.lock();
                g.scan_cache_save_timer = None;
                let full = g.pending_save_full;
                g.pending_save_full = false;
                g.last_quick_save_at = now_ms();
                (g.cache.clone(), if full { SaveMode::Full } else { SaveMode::Quick })
            };
            if let Err(err) = save_scan_cache(&events, SaveScanCacheOpts { mode }).await {
                swarn(&format!("[tokenlab] save scan cache failed: {err}"));
            }
        });
        g.scan_cache_save_timer = Some(timer);
    }

    // ----- agents status ---------------------------------------------------

    async fn get_agents_status(self: &Arc<Self>, force: bool) -> Arc<Vec<AgentStatus>> {
        enum Plan {
            Ready(Arc<Vec<AgentStatus>>),
            Refresh { base: Arc<Vec<AgentStatus>>, at: f64, cache: Arc<Vec<UsageEvent>> },
            Wait(AgentsFuture),
        }
        let now = now_ms();
        let plan = {
            let mut g = self.inner.lock();
            let mut plan: Option<Plan> = None;
            if !force {
                if let Some(c) = &g.agents_status_cache {
                    if now - c.at < AGENTS_PATH_TTL_MS {
                        // Paths still valid: refresh counts without disk I/O.
                        plan = Some(if c.event_count == g.cache.len() {
                            Plan::Ready(c.agents.clone())
                        } else {
                            Plan::Refresh { base: c.agents.clone(), at: c.at, cache: g.cache.clone() }
                        });
                    }
                }
                if plan.is_none() {
                    if let Some(p) = &g.agents_status_promise {
                        plan = Some(Plan::Wait(p.clone()));
                    }
                }
            }
            match plan {
                Some(p) => p,
                None => {
                    let events = g.cache.clone();
                    let this = self.clone();
                    let fut = spawn_shared(
                        &self.handle,
                        async move {
                            let agents = Arc::new(agents::detect_agents(&events).await);
                            let mut g = this.inner.lock();
                            let count = g.cache.len();
                            g.agents_status_cache =
                                Some(AgentsStatusCache { at: now_ms(), event_count: count, agents: agents.clone() });
                            g.agents_status_promise = None;
                            agents
                        },
                        Arc::new(Vec::new()),
                    );
                    g.agents_status_promise = Some(fut.clone());
                    Plan::Wait(fut)
                }
            }
        };
        match plan {
            Plan::Ready(a) => a,
            Plan::Wait(f) => f.await,
            Plan::Refresh { base, at, cache } => {
                let count = cache.len();
                let refreshed = tokio::task::spawn_blocking(move || refresh_agent_event_counts(&base, &cache))
                    .await
                    .unwrap_or_default();
                let agents = Arc::new(refreshed);
                self.inner.lock().agents_status_cache =
                    Some(AgentsStatusCache { at, event_count: count, agents: agents.clone() });
                agents
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Scan pipeline
// ---------------------------------------------------------------------------

impl AppState {
    /// Rescan local agent usage into memory.
    /// - `full`: historical full pass (all agents). Boot + manual Refresh.
    /// - `!full`: light periodic (hot agents only, soft timeout).
    ///
    /// Concurrent callers share one in-flight scan.
    fn rescan(self: &Arc<Self>, full: bool) -> ScanFuture {
        let mut g = self.inner.lock();
        // Coalesce concurrent rescans: never return a mid-scan empty cache.
        if let Some(p) = &g.scan_promise {
            return p.clone();
        }
        if !full {
            let now = now_ms();
            if now - g.last_recent_light_scan_at < scan_interval_minutes() * 60_000.0 {
                return ready_scan(g.cache.len());
            }
            g.last_recent_light_scan_at = now;
        }
        g.scanning = true;
        let prev = g.cache.clone();
        let this = self.clone();
        // The scan task blocks on this lock (in its `ScanGuard`) until the
        // promise below has been stored, so `scan_promise = None` always wins.
        let fut = spawn_shared(
            &self.handle,
            async move { this.run_scan(full, prev).await },
            Err("scan task panicked".to_string()),
        );
        g.scan_promise = Some(fut.clone());
        drop(g);
        // Light ticks stay quiet unless something actually changed.
        if full {
            self.broadcast_scan_phase("start-full");
            slog("[tokenlab] full historical scan started (all agent usage on disk)\u{2026}");
        }
        fut
    }

    async fn run_scan(self: Arc<Self>, full: bool, prev: Arc<Vec<UsageEvent>>) -> Result<usize, String> {
        let _guard = ScanGuard(self.clone());
        let local = Arc::new(Mutex::new(ScanLocal::default()));
        let progress = Arc::new(Mutex::new(Progress::default()));
        let result = self.scan_body(full, &prev, &local, &progress).await;
        match result {
            Ok(n) => Ok(n),
            Err(err) => {
                // Preserve parser batches completed before a scan-level failure.
                let (has_stats, rebuilt) = {
                    let l = local.lock();
                    (!l.agent_stats.is_empty(), l.rebuilt)
                };
                if has_stats && !rebuilt {
                    let _ = self.rebuild(full, full, &prev, &local).await;
                }
                self.bump_scan("error");
                Err(err)
            }
        }
    }

    async fn scan_body(
        self: &Arc<Self>,
        full: bool,
        prev: &Arc<Vec<UsageEvent>>,
        local: &Arc<Mutex<ScanLocal>>,
        progress: &Arc<Mutex<Progress>>,
    ) -> Result<usize, String> {
        // Full scans collect fresh rows per agent; final aggregation compares
        // them with prev so a thinner parser cannot erase history. Light scans
        // copy the cache only after a parser reports a real change.
        if full {
            let source = prev.clone();
            let seeded = tokio::task::spawn_blocking(move || {
                let mut by_agent: IndexMap<String, Vec<UsageEvent>> = IndexMap::new();
                for e in source.iter() {
                    by_agent.entry(e.agent.as_str().to_string()).or_default().push(e.clone());
                }
                by_agent
            })
            .await
            .map_err(|e| e.to_string())?;
            local.lock().by_agent = seeded;
        }

        // Light periodic: only hot agents (mirrors + common IDEs). Full: everyone.
        let enabled = if full { None } else { Some(periodic_light_scan_enabled()) };
        let light_tick_started = now_ms();
        let opts = ScanAllOptions {
            enabled,
            additional_roots: Some(self.snapshot_ubuntu_additional_roots()),
            light: !full,
            // One light parser at a time (a Codex session walk plus DSH
            // decompress on two workers stalled the disk for minutes).
            concurrency: Some(1),
            // Full: no timeout. Periodic: 90s soft cap (prev data kept on miss).
            timeout_ms: Some(if full { 0.0 } else { 90_000.0 }),
            on_agent_done: Some(self.make_on_agent_done(full, local.clone(), progress.clone())),
        };
        agents::scan_all(opts).await;

        if !full {
            Self::clear_progress_timer(progress);
            // Unchanged files, or a re-read that matches the cache: keep the
            // same array and the sort index. History already in memory stays.
            let fresh = std::mem::take(&mut local.lock().fresh_by_agent);
            let fresh_count = fresh.len();
            let source = prev.clone();
            let (cached, fresh) = tokio::task::spawn_blocking(move || {
                let cached = fresh.is_empty() || light_fresh_already_cached(&fresh, &source);
                (cached, fresh)
            })
            .await
            .map_err(|e| e.to_string())?;
            let stats = stat_summary(&local.lock().agent_stats);
            let tick_ms = js_num_to_string((now_ms() - light_tick_started).floor());
            if cached {
                let len = self.inner.lock().cache.len();
                light_log(&format!("[tokenlab] light tick {tick_ms}ms unchanged events={len} {stats}"));
                return Ok(len);
            }
            let cache_ts = self.inner.lock().cache_ts.clone();
            let source = prev.clone();
            let (events, ts) = tokio::task::spawn_blocking(move || {
                apply_periodic_light_delta(&source, cache_ts.as_deref().map(|v| v.as_slice()), &fresh)
            })
            .await
            .map_err(|e| e.to_string())?;
            let applied_len = events.len();
            self.set_cache(events, true, Some(ts)).await;
            self.bump_scan("complete");
            self.schedule_save_scan_cache(false);
            let tick_ms = js_num_to_string((now_ms() - light_tick_started).floor());
            light_log(&format!(
                "[tokenlab] light tick {tick_ms}ms fresh={fresh_count} events={applied_len} {stats}"
            ));
            return Ok(self.inner.lock().cache.len());
        }

        // LiteLLM is kept independent: its usage is added as-is and is never
        // reconciled against DSH.
        let openclaw = {
            let mut l = local.lock();
            let has = l.by_agent.get("openclaw").map_or(false, |v| !v.is_empty());
            if has {
                let hermes = l.by_agent.get("hermes").cloned().unwrap_or_default();
                l.by_agent.get_mut("openclaw").map(std::mem::take).map(|o| (o, hermes))
            } else {
                None
            }
        };
        if let Some((openclaw, hermes)) = openclaw {
            let deduped =
                tokio::task::spawn_blocking(move || agents::dedupe_mirrored_openclaw_events(&openclaw, &hermes))
                    .await
                    .map_err(|e| e.to_string())?;
            local.lock().by_agent.insert("openclaw".to_string(), deduped);
        }
        Self::clear_progress_timer(progress);
        // Full passes collapse/authoritatively replace once.
        self.rebuild(true, true, prev, local).await?;
        // saveScanCache applies the persisted high-water guard while writing.
        // Reconcile the same snapshot into RAM before publishing completion;
        // otherwise the disk has the fuller usage but /api/stats still serves
        // the thinner parser result until the next restart.
        let existing = load_scan_cache_main_only().await;
        if !existing.is_empty() {
            let current = self.inner.lock().cache.clone();
            let reconciled = tokio::task::spawn_blocking(move || {
                let merged = reconcile_scan_cache_high_water(&existing, &current);
                sort_events_by_time(&merged)
            })
            .await;
            match reconciled {
                Ok((events, ts)) => self.set_cache(events, true, Some(ts)).await,
                Err(err) => slog(&format!("[tokenlab] in-memory high-water reconciliation failed: {err}")),
            }
        }
        self.bump_scan("complete-full");
        self.schedule_save_scan_cache(true);
        let (agents_total, failed) = {
            let l = local.lock();
            let failed: Vec<String> =
                l.agent_stats.iter().filter(|s| s.error.is_some()).map(|s| s.agent.clone()).collect();
            (l.agent_stats.len(), failed)
        };
        let len = self.inner.lock().cache.len();
        let failed_note = if failed.is_empty() {
            String::new()
        } else {
            format!(" ({} failed: {})", failed.len(), failed.join(", "))
        };
        slog(&format!(
            "[tokenlab] full historical scan done: {len} events from {agents_total} agents{failed_note}"
        ));
        // Prefer auto Gist after a complete full scan (has freshest usage).
        let this = self.clone();
        self.handle.spawn(async move {
            tokio::time::sleep(Duration::from_millis(5_000)).await;
            let events = this.inner.lock().cache.clone();
            if events.is_empty() {
                return;
            }
            match try_auto_daily_gist_backup(&events).await {
                AutoDailyGistResult::Failed { error, .. } => {
                    swarn(&format!("[tokenlab] auto Gist (post-full): {error}"));
                }
                AutoDailyGistResult::Done { skipped: false, gist, .. } => {
                    slog(&format!("[tokenlab] auto daily Gist backup OK (post-full): {}", gist.html_url));
                }
                _ => {}
            }
        });
        Ok(len)
    }

    fn clear_progress_timer(progress: &Arc<Mutex<Progress>>) {
        if let Some(t) = progress.lock().timer.take() {
            t.abort();
        }
    }

    /// Debounced (1.2s) progress frame; `eventCount` is refreshed at fire time.
    fn schedule_progress_broadcast(self: &Arc<Self>, progress: &Arc<Mutex<Progress>>, payload: Map<String, Value>) {
        let mut p = progress.lock();
        p.last_payload = Some(payload);
        if p.timer.is_some() {
            return;
        }
        let this = self.clone();
        let prog = progress.clone();
        p.timer = Some(self.handle.spawn(async move {
            tokio::time::sleep(Duration::from_millis(1_200)).await;
            let payload = {
                let mut p = prog.lock();
                p.timer = None;
                p.last_payload.take()
            };
            if let Some(mut payload) = payload {
                payload.insert("eventCount".to_string(), Value::from(this.inner.lock().cache.len()));
                this.broadcast_stream(Value::Object(payload));
            }
        }));
    }

    fn make_on_agent_done(
        self: &Arc<Self>,
        full: bool,
        local: Arc<Mutex<ScanLocal>>,
        progress: Arc<Mutex<Progress>>,
    ) -> agents::OnAgentDone {
        let this = self.clone();
        Arc::new(move |done: AgentDone| {
            // Long agent parsers can block the event loop; refresh hang watchdog.
            write_heartbeat();
            let AgentDone { agent, events, duration_ms, error } = done;
            let agent_name = agent.as_str().to_string();
            // JS truthiness: an empty error string is "no error".
            let error = error.filter(|e| !e.is_empty());
            local.lock().agents_done += 1;
            let n_new = events.len();

            if !full {
                let mut l = local.lock();
                l.agent_stats.push(AgentStat {
                    agent: agent_name.clone(),
                    events: n_new,
                    duration_ms,
                    error: error.clone(),
                });
                if error.is_none() && n_new > 0 {
                    l.fresh_by_agent.insert(agent_name, events);
                }
                return;
            }

            // Take the previous list out (position preserved) so the merge runs
            // without holding the lock.
            let (prev_list, existed) = {
                let mut l = local.lock();
                match l.by_agent.get_mut(&agent_name) {
                    Some(v) => (std::mem::take(v), true),
                    None => (Vec::new(), false),
                }
            };
            let keep_prev = (error.is_some() && n_new == 0) || (n_new == 0 && !prev_list.is_empty());
            let mut codex_paths: Vec<String> = Vec::new();
            let mut grok_sessions: HashSet<String> = HashSet::new();
            let (store, kept) = if keep_prev {
                // Timeout/crash with nothing parsed, or an empty re-parse over
                // existing data: keep previous (never wipe).
                let kept = prev_list.len();
                (if existed { Some(prev_list) } else { None }, if existed { kept } else { n_new })
            } else {
                if agent_name == "codex" {
                    for e in &events {
                        let source = usage_source_key(&e.source_path);
                        if !source.is_empty() {
                            codex_paths.push(source);
                        }
                    }
                }
                let list = if error.is_none() && n_new > 0 {
                    events
                } else {
                    let (merged, sessions) = merge_agent_scan_light(events, prev_list);
                    grok_sessions = sessions;
                    merged
                };
                let kept = list.len();
                (Some(list), kept)
            };
            let now = now_ms();
            {
                let mut l = local.lock();
                if let Some(list) = store {
                    l.by_agent.insert(agent_name.clone(), list);
                }
                l.codex_replaced_paths.extend(codex_paths);
                l.grok_replaced_sessions.extend(grok_sessions);
                l.agent_stats.push(AgentStat {
                    agent: agent_name.clone(),
                    events: kept,
                    duration_ms,
                    error: error.clone(),
                });
            }
            let agents_done = local.lock().agents_done;
            let payload = {
                let mut g = this.inner.lock();
                g.scan_updated_at = now;
                let mut m = Map::new();
                m.insert("type".into(), json!("scan"));
                m.insert("revision".into(), json!(g.scan_revision));
                m.insert("updatedAt".into(), jn(now));
                m.insert("reason".into(), json!("progress"));
                m.insert("agent".into(), json!(agent_name));
                m.insert("durationMs".into(), jn(duration_ms));
                m.insert("error".into(), error.clone().map_or(Value::Null, Value::from));
                m.insert("eventCount".into(), json!(g.cache.len()));
                m.insert("scanning".into(), json!(true));
                m.insert("pricingRevision".into(), json!(g.pricing_revision));
                m.insert("agentsDone".into(), json!(agents_done));
                m
            };
            this.schedule_progress_broadcast(&progress, payload);
            if error.is_some() || duration_ms >= 2_000.0 {
                let status = match &error {
                    Some(e) => format!("error: {e} (kept {kept})"),
                    None => format!("{n_new} new \u{2192} {kept} total"),
                };
                slog(&format!(
                    "[tokenlab]   {agent_name}: {status} ({}ms)",
                    js_num_to_string(duration_ms)
                ));
            }
        })
    }

    /// Union of unchanged and re-scanned rows (`rebuild` in the TS source).
    async fn rebuild(
        self: &Arc<Self>,
        full: bool,
        finalize: bool,
        prev: &Arc<Vec<UsageEvent>>,
        local: &Arc<Mutex<ScanLocal>>,
    ) -> Result<(), String> {
        let (by_agent, codex, grok) = {
            let mut l = local.lock();
            l.rebuilt = true;
            (
                std::mem::take(&mut l.by_agent),
                l.codex_replaced_paths.clone(),
                l.grok_replaced_sessions.clone(),
            )
        };
        let imported = self.inner.lock().imported_events.clone();
        let source = prev.clone();
        let (events, ts) = tokio::task::spawn_blocking(move || {
            rebuild_merge(full, finalize, &source, by_agent, &codex, &grok, &imported)
        })
        .await
        .map_err(|e| e.to_string())?;
        self.set_cache(events, finalize, ts).await;
        Ok(())
    }

    /// Keep non-router Recent requests fresh without making the API caller wait
    /// for a parser pass. Coalesced with boot/manual/periodic scans and
    /// rate-limited so a polling dashboard cannot turn into a disk scan loop.
    fn schedule_recent_light_scan(self: &Arc<Self>) {
        let now = now_ms();
        {
            let g = self.inner.lock();
            if g.manual_full_scan_promise.is_some()
                || g.scan_promise.is_some()
                || now - g.last_recent_light_scan_at < scan_interval_minutes() * 60_000.0
            {
                return;
            }
        }
        let fut = self.rescan(false);
        self.handle.spawn(async move {
            if let Err(err) = fut.await {
                slog(&format!("[tokenlab] recent light scan failed: {err}"));
            }
        });
    }
}

// ---------------------------------------------------------------------------
// Ubuntu / VPS / PhanmemVIP mirrors and the manual full scan
// ---------------------------------------------------------------------------

use std::path::{Path, PathBuf};
use std::process::Stdio;

const UBUNTU_REMOTE_HOME: &str = "/home/ubuntu";
/// Must outlast the remote export (~175s) plus transfer time, or the sync is
/// killed mid-scan and the mirror is left stale while the run looks finished.
const MIRROR_SYNC_TIMEOUT_MS: u64 = 300_000;
const MIRROR_SYNC_INTERVAL_MS: f64 = 60.0 * 60_000.0;
const PMV_MIRROR_SYNC_INTERVAL_MS: f64 = 60_000.0;
const PMV_SYNC_TIMEOUT_MS: u64 = 15_000;

fn ubuntu_mirror_base() -> String {
    let data = app_data_dir();
    pjoin(&[data.as_str(), "tokenlab", "mirrors", "ubuntu"])
}

fn ubuntu_mirror_home() -> String {
    let base = ubuntu_mirror_base();
    pjoin(&[base.as_str(), "home", "ubuntu"])
}

/// specId -> remote Ubuntu roots (always under `/home/ubuntu`).
static UBUNTU_REMOTE_ROOTS: Lazy<IndexMap<String, Vec<String>>> = Lazy::new(|| {
    let mut out: IndexMap<String, Vec<String>> = IndexMap::new();
    for spec in agents::agent_path_specs_for_linux_home(UBUNTU_REMOTE_HOME) {
        for remote_root in &spec.roots {
            let relative = PathFlavor::Posix.relative(UBUNTU_REMOTE_HOME, remote_root);
            if relative.is_empty() || relative == "." || relative.starts_with("..") {
                continue;
            }
            let roots = out.entry(spec.id.as_str().to_string()).or_default();
            if !roots.contains(remote_root) {
                roots.push(remote_root.clone());
            }
        }
    }
    out
});

/// `setUbuntuAdditionalRoots` validation: `None` when `value` is not an object.
fn parse_ubuntu_additional_roots(value: &Value) -> Option<HashMap<AgentId, AdditionalRoots>> {
    let obj = value.as_object()?;
    let home = ubuntu_mirror_home();
    let mut next: HashMap<AgentId, AdditionalRoots> = HashMap::new();
    for (agent_id, roots) in obj {
        let agent = match AgentId::from_id(agent_id) {
            Some(a) => a,
            None => continue,
        };
        let roots = match roots.as_array() {
            Some(r) => r,
            None => continue,
        };
        let mut local_roots: Vec<String> = Vec::new();
        for candidate in roots {
            let candidate = match candidate.as_str() {
                Some(s) if PathFlavor::Posix.is_absolute(s) => s,
                _ => continue,
            };
            let normalized = PathFlavor::Posix.normalize(candidate);
            let relative = PathFlavor::Posix.relative(UBUNTU_REMOTE_HOME, &normalized);
            if relative.is_empty()
                || relative == "."
                || relative.starts_with("..")
                || PathFlavor::Posix.is_absolute(&relative)
            {
                continue;
            }
            let mut parts: Vec<&str> = vec![home.as_str()];
            parts.extend(relative.split('/'));
            let local_root = pjoin(&parts);
            if !local_roots.contains(&local_root) {
                local_roots.push(local_root);
            }
        }
        if !local_roots.is_empty() {
            next.insert(agent, AdditionalRoots { roots: local_roots, machine_scope: "ubuntu".to_string() });
        }
    }
    Some(next)
}

/// `scripts/<name>` next to the checkout / installer (see the TS
/// `resolveSyncScript`): `../../scripts`, `../../../scripts`, cwd.
fn resolve_script(name: &str) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("../../scripts").join(name));
            candidates.push(dir.join("../../../scripts").join(name));
            candidates.push(dir.join("scripts").join(name));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("scripts").join(name));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Run `python <script> [args]` detached from the console. `true` only on exit
/// code 0; a spawn error or a timeout (child killed) is `false`.
async fn run_python_script(script: &Path, args: &[String], timeout_ms: u64) -> bool {
    // python.exe creates a console host even when hidden, which flashes a CMD
    // window on every sync; pythonw.exe has no console subsystem.
    let python = if cfg!(windows) { "pythonw.exe" } else { "python" };
    let mut cmd = tokio::process::Command::new(python);
    cmd.arg(script)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return false,
    };
    match tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait()).await {
        Ok(Ok(status)) => status.code() == Some(0),
        Ok(Err(_)) => false,
        Err(_) => {
            let _ = child.kill().await;
            false
        }
    }
}

#[derive(Clone, Copy)]
enum SyncKind {
    Vps,
    Pmv,
    Ubuntu,
}

/// `finally { xxxSyncPromise = null }`, panic-safe.
struct SyncGuard {
    state: Arc<AppState>,
    kind: SyncKind,
}

impl Drop for SyncGuard {
    fn drop(&mut self) {
        let mut g = self.state.inner.lock();
        match self.kind {
            SyncKind::Vps => g.vps_sync_promise = None,
            SyncKind::Pmv => g.pmv_sync_promise = None,
            SyncKind::Ubuntu => g.ubuntu_sync_promise = None,
        }
    }
}

impl AppState {
    fn set_ubuntu_additional_roots(&self, value: &Value) {
        if let Some(next) = parse_ubuntu_additional_roots(value) {
            self.inner.lock().ubuntu_additional_roots = next;
        }
    }

    async fn restore_ubuntu_additional_roots(&self) {
        let base = ubuntu_mirror_base();
        let file = pjoin(&[base.as_str(), "remote-roots-active.json"]);
        let text = match tokio::fs::read_to_string(&file).await {
            Ok(t) => t,
            // No successful Ubuntu scan has completed yet.
            Err(_) => return,
        };
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            self.set_ubuntu_additional_roots(&value);
        }
    }

    fn snapshot_ubuntu_additional_roots(&self) -> HashMap<AgentId, AdditionalRoots> {
        self.inner.lock().ubuntu_additional_roots.clone()
    }

    /// Pull RouterLab + LiteLLM usage into local mirrors (coalesced: concurrent
    /// callers share one in-flight sync).
    fn sync_vps_mirrors(self: &Arc<Self>, reason: &str, timeout_ms: u64) -> BoolFuture {
        let mut g = self.inner.lock();
        if let Some(p) = &g.vps_sync_promise {
            return p.clone();
        }
        let this = self.clone();
        let reason = reason.to_string();
        // The task blocks on `inner` (in its guard / bookkeeping) until the
        // promise below is stored, so clearing it always wins.
        let fut = spawn_shared(
            &self.handle,
            async move {
                let _guard = SyncGuard { state: this.clone(), kind: SyncKind::Vps };
                let script = match resolve_script("sync-vps-mirrors.py") {
                    Some(s) => s,
                    None => return false,
                };
                let ok = run_python_script(&script, &[], timeout_ms).await;
                if ok {
                    this.inner.lock().last_mirror_sync_at = now_ms();
                    slog(&format!("[tokenlab] VPS router mirrors synced ({reason})"));
                }
                ok
            },
            false,
        );
        g.vps_sync_promise = Some(fut.clone());
        fut
    }

    /// The PMV counter is one small state file, so refresh it every minute
    /// without rerunning the expensive LiteLLM spend aggregation.
    fn sync_phanmemvip_usage_mirror(self: &Arc<Self>, reason: &str) -> BoolFuture {
        let mut g = self.inner.lock();
        if let Some(p) = &g.pmv_sync_promise {
            return p.clone();
        }
        let this = self.clone();
        let reason = reason.to_string();
        let fut = spawn_shared(
            &self.handle,
            async move {
                let _guard = SyncGuard { state: this.clone(), kind: SyncKind::Pmv };
                let script = match resolve_script("sync-vps-mirrors.py") {
                    Some(s) => s,
                    None => return false,
                };
                let ok = run_python_script(&script, &["--pmv-only".to_string()], PMV_SYNC_TIMEOUT_MS).await;
                if ok {
                    this.inner.lock().last_pmv_mirror_sync_at = now_ms();
                    slog(&format!("[tokenlab] PhanmemVIP usage mirror synced ({reason})"));
                }
                ok
            },
            false,
        );
        g.pmv_sync_promise = Some(fut.clone());
        fut
    }

    fn sync_ubuntu_usage(self: &Arc<Self>, reason: &str) -> BoolFuture {
        let mut g = self.inner.lock();
        if let Some(p) = &g.ubuntu_sync_promise {
            return p.clone();
        }
        let this = self.clone();
        let reason = reason.to_string();
        let fut = spawn_shared(
            &self.handle,
            async move {
                let _guard = SyncGuard { state: this.clone(), kind: SyncKind::Ubuntu };
                let script = match resolve_script("sync-ubuntu-usage.py") {
                    Some(s) => s,
                    None => return false,
                };
                let base = ubuntu_mirror_base();
                let manifest = pjoin(&[base.as_str(), "remote-roots.json"]);
                if tokio::fs::create_dir_all(&base).await.is_err() {
                    return false;
                }
                let body = serde_json::to_string(&*UBUNTU_REMOTE_ROOTS).unwrap_or_else(|_| "{}".to_string());
                if tokio::fs::write(&manifest, body).await.is_err() {
                    return false;
                }
                let ok = run_python_script(&script, &[manifest.clone()], MIRROR_SYNC_TIMEOUT_MS).await;
                if ok {
                    this.inner.lock().last_ubuntu_mirror_sync_at = now_ms();
                    this.restore_ubuntu_additional_roots().await;
                    slog(&format!("[tokenlab] Ubuntu usage mirror synced ({reason})"));
                }
                ok
            },
            false,
        );
        g.ubuntu_sync_promise = Some(fut.clone());
        fut
    }

    fn announce_vps_sync(&self) {
        let payload = {
            let mut g = self.inner.lock();
            g.scanning = true;
            json!({
                "type": "scan",
                "revision": g.scan_revision,
                "updatedAt": jn(now_ms()),
                "reason": "start-remote-sync",
                "eventCount": g.cache.len(),
                "scanning": true,
                "pricingRevision": g.pricing_revision,
            })
        };
        self.broadcast_stream(payload);
    }

    /// Manual Refresh: refresh the remote mirrors first, then always do a full
    /// historical pass. Coalesced; runs on its own task so it survives the HTTP
    /// client going away.
    fn scan_all_sources_manually(self: &Arc<Self>) -> ScanFuture {
        let mut g = self.inner.lock();
        if let Some(p) = &g.manual_full_scan_promise {
            return p.clone();
        }
        let this = self.clone();
        let fut = spawn_shared(
            &self.handle,
            async move { this.manual_scan_body().await },
            Err("manual scan task panicked".to_string()),
        );
        g.manual_full_scan_promise = Some(fut.clone());
        fut
    }

    async fn manual_scan_body(self: Arc<Self>) -> Result<usize, String> {
        struct ManualGuard(Arc<AppState>);
        impl Drop for ManualGuard {
            fn drop(&mut self) {
                self.0.inner.lock().manual_full_scan_promise = None;
            }
        }
        let _guard = ManualGuard(self.clone());

        let before = self.inner.lock().scan_promise.clone();
        if let Some(p) = before {
            // A prior scan failure should not block a fresh manual scan.
            let _ = p.await;
        }

        self.announce_vps_sync();
        slog("[tokenlab] manual full scan syncing VPS and Ubuntu mirrors first");

        let (vps, pmv, ubuntu) = futures::join!(
            self.sync_vps_mirrors("manual-scan", MIRROR_SYNC_TIMEOUT_MS),
            self.sync_phanmemvip_usage_mirror("manual-scan"),
            self.sync_ubuntu_usage("manual-scan"),
        );
        if !vps {
            swarn("[tokenlab] manual scan could not refresh VPS BNIX mirrors; continuing with existing mirror files");
        }
        if !pmv {
            swarn("[tokenlab] manual scan could not refresh PhanmemVIP usage; keeping the last mirrored value");
        }
        if !ubuntu {
            swarn("[tokenlab] manual scan could not refresh Ubuntu usage over SSH; keeping the last mirrored snapshot");
        }

        let during = self.inner.lock().scan_promise.clone();
        if let Some(p) = during {
            // Scan again below after the mirror refresh, even if this scan failed.
            let _ = p.await;
            self.announce_vps_sync();
        }

        let result = self.rescan(true).await;
        if result.is_err() {
            let reset = {
                let mut g = self.inner.lock();
                if g.scanning && g.scan_promise.is_none() {
                    g.scanning = false;
                    true
                } else {
                    false
                }
            };
            if reset {
                self.bump_scan("error");
            }
        }
        result
    }
}

// ---------------------------------------------------------------------------
// HTTP plumbing: JSON helpers, static files, dispatcher
// ---------------------------------------------------------------------------

use axum::body::Bytes;
use axum::extract::{Request, State};
use futures::StreamExt;
use std::cmp::Ordering;
use tokio_stream::wrappers::UnboundedReceiverStream;

/// The TS `json()` helper: compact body, `no-store`, explicit length.
fn json_res(status: u16, body: &Value) -> Response {
    let data = crate::util::to_vec_js(body).unwrap_or_else(|_| b"null".to_vec());
    bytes_json_res(status, data)
}

fn bytes_json_res(status: u16, data: Vec<u8>) -> Response {
    let len = data.len();
    let mut res = Response::new(Body::from(data));
    *res.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    res
}

/// Serialize on the blocking pool (large backups / event lists).
async fn json_ser<T: Serialize + Send + 'static>(status: u16, value: T) -> Result<Response, String> {
    let data = tokio::task::spawn_blocking(move || crate::util::to_vec_js(&value))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(bytes_json_res(status, data))
}

fn error_json(status: u16, code: &str, message: &str) -> Response {
    json_res(status, &json!({ "error": { "code": code, "message": message } }))
}

/// `readJsonBody`: trimmed UTF-8; empty / invalid / non-object gives `{}`.
async fn read_json_body(body: Body) -> Map<String, Value> {
    let bytes = match axum::body::to_bytes(body, usize::MAX).await {
        Ok(b) => b,
        Err(_) => return Map::new(),
    };
    let text = String::from_utf8_lossy(&bytes);
    let raw = js_trim(&text);
    if raw.is_empty() {
        return Map::new();
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

/// JS truthiness of a JSON value.
fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map_or(false, |f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `a || b || c`: the first truthy number (else the last one).
fn js_or_num(values: &[f64]) -> f64 {
    for v in values {
        if *v != 0.0 && !v.is_nan() {
            return *v;
        }
    }
    values.last().copied().unwrap_or(0.0)
}

/// Descending numeric comparator (`b - a`), total so `sort_by` never panics.
fn desc_cmp(a: f64, b: f64) -> Ordering {
    (b + 0.0).total_cmp(&(a + 0.0))
}

/// Index resolution of `Array.prototype.slice(start, end)`.
fn js_slice_bounds(len: usize, start: f64, end: Option<f64>) -> (usize, usize) {
    fn rel(v: f64, len: usize) -> usize {
        let n = if v.is_nan() { 0.0 } else { v.trunc() };
        if n < 0.0 {
            (len as f64 + n).max(0.0) as usize
        } else {
            n.min(len as f64) as usize
        }
    }
    let s = rel(start, len);
    let e = match end {
        Some(e) => rel(e, len),
        None => len,
    };
    if e < s {
        (s, s)
    } else {
        (s, e)
    }
}

fn panic_message(p: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = p.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = p.downcast_ref::<String>() {
        s.clone()
    } else {
        "internal panic".to_string()
    }
}

fn js_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

/// `decodeURIComponent` (a malformed sequence is a `URIError` -> 500 in TS).
fn decode_uri_component(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err("URI malformed".to_string());
            }
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            match (hi, lo) {
                (Some(h), Some(l)) => out.push((h * 16 + l) as u8),
                _ => return Err("URI malformed".to_string()),
            }
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "URI malformed".to_string())
}

fn content_type_for(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.ends_with(".svg") {
        "image/svg+xml; charset=utf-8"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".ico") {
        "image/x-icon"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if lower.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else {
        "application/octet-stream"
    }
}

/// `sendCachedText` / the asset branch: ETag + `If-None-Match` -> 304.
fn send_cached(
    headers: &HeaderMap,
    etag: &str,
    body: Vec<u8>,
    content_type: &str,
    cache_control: &str,
) -> Response {
    let (Ok(etag_v), Ok(cc_v)) = (HeaderValue::from_str(etag), HeaderValue::from_str(cache_control)) else {
        return error_json(500, "INTERNAL", "bad cache headers");
    };
    let matches = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .map_or(false, |v| v == etag);
    if matches {
        let mut res = Response::new(Body::empty());
        *res.status_mut() = StatusCode::NOT_MODIFIED;
        res.headers_mut().insert(header::ETAG, etag_v);
        res.headers_mut().insert(header::CACHE_CONTROL, cc_v);
        return res;
    }
    let len = body.len();
    let mut res = Response::new(Body::from(body));
    let h = res.headers_mut();
    if let Ok(ct) = HeaderValue::from_str(content_type) {
        h.insert(header::CONTENT_TYPE, ct);
    }
    h.insert(header::ETAG, etag_v);
    h.insert(header::CACHE_CONTROL, cc_v);
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    res
}

/// Serve `name` from the embedded Astro build, `None` when it is not there
/// (`web/dist` missing or mid-build).
fn embedded_response(headers: &HeaderMap, name: &str, content_type: &str, cache_control: &str) -> Option<Response> {
    let file = Assets::get(name)?;
    let hash = file.metadata.sha256_hash();
    let etag = format!("W/\"{}-{:x}\"", hex::encode(&hash[..8]), file.data.len());
    Some(send_cached(headers, &etag, file.data.into_owned(), content_type, cache_control))
}

const HTML_CACHE_CONTROL: &str = "private, max-age=15, must-revalidate";
const ASSET_CACHE_CONTROL: &str = "public, max-age=3600, must-revalidate";

fn serve_page(headers: &HeaderMap, name: &str) -> Response {
    match embedded_response(headers, name, "text/html; charset=utf-8", HTML_CACHE_CONTROL) {
        Some(res) => res,
        None => error_json(
            500,
            "INTERNAL",
            &format!("UI not built: {name} is missing from web/dist (run the Astro build, then rebuild the binary)"),
        ),
    }
}

static RE_ASSET_PATH: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-zA-Z0-9._/-]+$").unwrap());
static RE_9ROUTER: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^9router-").unwrap());

/// `/assets/*` and `/_astro/*`.
fn serve_asset(headers: &HeaderMap, prefix: &str, raw_rest: &str) -> Result<Response, String> {
    let rel = decode_uri_component(raw_rest)?.replace('\\', "/");
    if rel.is_empty() || rel.contains("..") || rel.starts_with('/') || !RE_ASSET_PATH.is_match(&rel) {
        return Ok(error_json(400, "BAD_PATH", "Invalid asset path"));
    }
    let segments: Vec<&str> = rel.split('/').filter(|s| !s.is_empty() && *s != ".").collect();
    if segments.is_empty() {
        return Ok(error_json(404, "NOT_FOUND", "Asset not found"));
    }
    let embed_path = format!("{prefix}/{}", segments.join("/"));
    let basename = segments[segments.len() - 1];
    match embedded_response(headers, &embed_path, content_type_for(basename), ASSET_CACHE_CONTROL) {
        Some(res) => Ok(res),
        None => Ok(error_json(404, "NOT_FOUND", "Asset not found")),
    }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

async fn fallback_handler(State(state): State<Arc<AppState>>, req: Request) -> Response {
    let fut = state.handle_request(req);
    match std::panic::AssertUnwindSafe(fut).catch_unwind().await {
        Ok(Ok(res)) => res,
        Ok(Err(msg)) => error_json(500, "INTERNAL", &msg),
        Err(panic) => error_json(500, "INTERNAL", &panic_message(&panic)),
    }
}

impl AppState {
    /// One `(method, pathname)` chain, exactly like the TS `handle()`.
    async fn handle_request(self: &Arc<Self>, req: Request) -> Result<Response, String> {
        let (parts, body) = req.into_parts();
        let path = parts.uri.path().to_string();
        let q = Query::parse(parts.uri.query());
        let no_ui = self.no_ui;

        match (parts.method.as_str(), path.as_str()) {
            ("GET", "/api/health") => self.route_health().await,
            ("GET", "/api/stats") => self.route_stats(&q).await,
            ("GET", "/api/rpm") => {
                let mins = js_min(30.0, js_max(1.0, number_or(q.get("minutes"), 3.0)));
                let rate = self.get_live_rate_cached(mins).await;
                Ok(json_res(200, &rate))
            }
            ("GET", "/api/phanmemvip-usage") => self.route_phanmemvip_usage().await,
            ("GET", "/api/rate-audit") => self.route_rate_audit(&q).await,
            ("GET", "/api/cost") => self.route_cost(&q).await,
            ("GET", "/api/events") => self.route_events(&q).await,
            ("GET", "/api/agents") => {
                let agents = self.get_agents_status(false).await;
                Ok(json_res(200, &json!({ "agents": serde_json::to_value(&*agents).map_err(|e| e.to_string())? })))
            }
            ("POST", "/api/scan") => self.route_scan(&q).await,
            ("GET", "/api/pricing") => self.route_pricing_get(&q).await,
            ("POST", "/api/models/refresh") => match fetch_open_router_models(true).await {
                Ok(models) => Ok(json_res(
                    200,
                    &json!({ "ok": true, "count": models.len(), "fetchedAt": jn(get_open_router_fetched_at()) }),
                )),
                Err(err) => Ok(error_json(502, "OPENROUTER_FETCH", &err.to_string())),
            },
            ("GET", "/api/pricing/stream") => Ok(self.route_pricing_stream()),
            ("PUT", "/api/pricing") => self.route_pricing_put(body).await,
            ("GET", "/api/config") => self.route_config_get().await,
            ("GET", "/api/backup") => self.route_backup_get(&q).await,
            ("POST", "/api/backup/gist") => self.route_backup_gist(body).await,
            ("POST", "/api/backup/restore") => self.route_backup_restore(body).await,
            ("PUT", "/api/config") => self.route_config_put(body).await,
            ("GET", "/" | "/index.html" | "/dashboard") if !no_ui => Ok(serve_page(&parts.headers, "index.html")),
            ("GET", "/agents" | "/agents.html") if !no_ui => Ok(serve_page(&parts.headers, "agents.html")),
            ("GET", "/settings" | "/settings.html") if !no_ui => Ok(serve_page(&parts.headers, "settings.html")),
            ("GET", "/model" | "/model.html" | "/pricing" | "/pricing.html") if !no_ui => {
                Ok(serve_page(&parts.headers, "pricing.html"))
            }
            ("GET", "/styles.css") if !no_ui => {
                // Revalidate each navigation (ETag -> 304). The Astro build emits the
                // stylesheet as `_astro/Base.<hash>.css`, so `/styles.css` falls back to
                // that bundle when no literal `styles.css` is embedded.
                let name = if Assets::get("styles.css").is_some() {
                    Some("styles.css".to_string())
                } else {
                    let mut css: Vec<String> = Assets::iter()
                        .filter(|n| n.starts_with("_astro/") && n.ends_with(".css"))
                        .map(|n| n.to_string())
                        .collect();
                    css.sort();
                    css.into_iter().next()
                };
                match name.and_then(|n| {
                    embedded_response(
                        &parts.headers,
                        &n,
                        "text/css; charset=utf-8",
                        "public, max-age=0, must-revalidate",
                    )
                }) {
                    Some(res) => Ok(res),
                    None => Ok(error_json(404, "NOT_FOUND", "styles.css not found")),
                }
            }
            ("GET", p) if !no_ui && p.starts_with("/assets/") => {
                serve_asset(&parts.headers, "assets", &p["/assets/".len()..])
            }
            ("GET", p) if !no_ui && p.starts_with("/_astro/") => {
                serve_asset(&parts.headers, "_astro", &p["/_astro/".len()..])
            }
            _ => Ok(error_json(404, "NOT_FOUND", "Not found")),
        }
    }

    // ----- /api/health -----------------------------------------------------

    async fn route_health(self: &Arc<Self>) -> Result<Response, String> {
        let agents = self.get_agents_status(false).await;
        let timezone = configured_time_zone();
        let now = now_ms();
        let today_start = to_iso_string(start_of_day_in_time_zone(Some(&timezone), now))
            .ok_or_else(|| "Invalid time value".to_string())?;
        let detected: Vec<&str> = agents.iter().filter(|a| a.detected).map(|a| a.id.as_str()).collect();
        let g = self.inner.lock();
        // Keep the dashboard's visible count stable while a progressive scan
        // is replacing the write-side cache.
        let event_count = if g.scanning { g.read_cache.len() } else { g.cache.len() };
        let last_scan = if g.last_recent_light_scan_at != 0.0 {
            to_iso_string(g.last_recent_light_scan_at).map(Value::from).unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        let body = json!({
            "ok": true,
            "version": VERSION,
            "platform": host_platform(),
            "arch": js_arch(),
            "node": "rust",
            "uptimeSec": jn(((now - self.started_at) / 1000.0).floor()),
            "agentsDetected": detected,
            "eventCount": event_count,
            "scanning": g.scanning,
            "scanRevision": g.scan_revision,
            "scanUpdatedAt": jn(g.scan_updated_at),
            "scanIntervalMinutes": jn(scan_interval_minutes()),
            "scanFullIntervalMinutes": jn(full_scan_interval_minutes()),
            "scanPeriodicEnabled": scan_periodic_enabled(),
            "lastScanAt": last_scan,
            "pricingRevision": g.pricing_revision,
            "pricingUpdatedAt": jn(g.pricing_updated_at),
            "timezone": timezone,
            "todayStartsAt": today_start,
        });
        drop(g);
        Ok(json_res(200, &body))
    }

    // ----- /api/stats ------------------------------------------------------

    async fn route_stats(self: &Arc<Self>, q: &Query) -> Result<Response, String> {
        let since: Option<String> = q.get("since").map(str::to_string);
        let until: Option<String> = q.get("until").map(str::to_string);
        let group_by_raw = q.get_nonempty("groupBy").unwrap_or_else(|| "agent".to_string());
        let sort = q.get_nonempty("sort").unwrap_or_else(|| "cost".to_string());
        // live=0: skip hot-mirror RPM (chart series second fetch).
        let want_live = q.get("live") != Some("0");
        let group_by = match GroupBy::parse(&group_by_raw) {
            Some(g) => g,
            None => {
                return Ok(error_json(400, "INVALID_QUERY", "groupBy must be one of: agent, model, day, hour"));
            }
        };
        write_heartbeat();

        // Memo period aggregates across the dashboard double-fetch.
        let (scan_revision, pricing_revision) = {
            let g = self.inner.lock();
            (g.scan_revision, g.pricing_revision)
        };
        let memo_key = format!(
            "{}|{}|{}|{}|{}|{}",
            scan_revision,
            pricing_revision,
            since.as_deref().unwrap_or(""),
            until.as_deref().unwrap_or(""),
            group_by.as_str(),
            sort
        );
        let memo_hit = self.inner.lock().period_stats_memo.get(&memo_key).cloned();
        let part: Arc<Map<String, Value>> = match memo_hit {
            Some(hit) => hit,
            None => {
                // Fast path: precomputed Today/24h/7D/30D/All index.
                let pk = dash_period_key(since.as_deref(), until.as_deref());
                if pk.is_some() {
                    let need_rebuild = {
                        let g = self.inner.lock();
                        g.dash_period_stats.is_none() && !g.scanning && !g.cache.is_empty()
                    };
                    if need_rebuild {
                        self.rebuild_dash_period_stats().await;
                    }
                }
                let pre_all = self.inner.lock().dash_period_stats.clone();
                let fast: Option<Map<String, Value>> = match (pk, pre_all.as_ref()) {
                    (Some(k), Some(all)) => match all.get(&k) {
                        Some(pre) => {
                            let base = pre.by_group.get(group_by);
                            let sort_cost = sort == "cost";
                            let mut groups: Vec<&crate::types::GroupRow> = base.groups.iter().collect();
                            groups.sort_by(|a, b| {
                                if sort_cost {
                                    desc_cmp(a.totals.estimated_cost, b.totals.estimated_cost)
                                } else {
                                    desc_cmp(a.totals.total_tokens, b.totals.total_tokens)
                                }
                            });
                            let mut map = match serde_json::to_value(base).map_err(|e| e.to_string())? {
                                Value::Object(m) => m,
                                _ => Map::new(),
                            };
                            map.insert("groups".to_string(), serde_json::to_value(&groups).map_err(|e| e.to_string())?);
                            map.insert("period".to_string(), json!({ "since": since, "until": until }));
                            map.insert(
                                "usageRpm".to_string(),
                                serde_json::to_value(&pre.usage_rpm).map_err(|e| e.to_string())?,
                            );
                            Some(map)
                        }
                        None => None,
                    },
                    _ => None,
                };
                let map = match fast {
                    Some(m) => m,
                    None => {
                        let scanning = self.inner.lock().scanning;
                        if !scanning {
                            self.ensure_cache_sorted().await;
                        }
                        let (events, ts) = self.events_in_period_detailed(since.clone(), until.clone()).await;
                        write_heartbeat();
                        let all_aliases = pk == Some(DashPeriodKey::All) && group_by == GroupBy::Model;
                        let sort_c = sort.clone();
                        let since_c = since.clone();
                        let until_c = until.clone();
                        let (stats_v, rpm_v) = tokio::task::spawn_blocking(move || {
                            let stats = aggregate(
                                &events,
                                group_by,
                                SortBy::from(sort_c.as_str()),
                                since_c.as_deref(),
                                until_c.as_deref(),
                                ts.as_deref(),
                                all_aliases,
                            );
                            // Period RPM: busiest single minute in the period.
                            let rpm = compute_active_usage_rpm(&events);
                            (serde_json::to_value(&stats), serde_json::to_value(&rpm))
                        })
                        .await
                        .map_err(|e| e.to_string())?;
                        let mut map = match stats_v.map_err(|e| e.to_string())? {
                            Value::Object(m) => m,
                            _ => Map::new(),
                        };
                        map.insert("usageRpm".to_string(), rpm_v.map_err(|e| e.to_string())?);
                        map
                    }
                };
                let arc = Arc::new(map);
                // Cap memo size (period x groupBy combos are small).
                let mut g = self.inner.lock();
                if g.period_stats_memo.len() > 64 {
                    g.period_stats_memo.clear();
                }
                g.period_stats_memo.insert(memo_key, arc.clone());
                arc
            }
        };
        write_heartbeat();
        let mut out = (*part).clone();
        if want_live {
            // Short-TTL memo + only recent cache rows (not the full history).
            let live = self.get_live_rate_cached(3.0).await;
            out.insert("live".to_string(), (*live).clone());
        }
        Ok(json_res(200, &Value::Object(out)))
    }

    // ----- /api/phanmemvip-usage ------------------------------------------

    async fn route_phanmemvip_usage(self: &Arc<Self>) -> Result<Response, String> {
        let date = vietnam_date_key(now_ms());
        let day_start = js_date_parse(&format!("{date}T00:00:00+07:00"));
        let today_events = if day_start.is_finite() {
            let a = to_iso_string(day_start);
            let b = to_iso_string(day_start + 24.0 * 60.0 * 60.0 * 1000.0 - 1.0);
            self.events_in_period(a, b).await
        } else {
            Vec::new()
        };
        let usage = read_phanmemvip_usage(&today_events).await;
        Ok(json_res(200, &serde_json::to_value(&usage).map_err(|e| e.to_string())?))
    }

    // ----- /api/rate-audit -------------------------------------------------

    async fn route_rate_audit(self: &Arc<Self>, q: &Query) -> Result<Response, String> {
        let since = q.get("since").map(str::to_string);
        let until = q.get("until").map(str::to_string);
        let tz = configured_time_zone();
        let since_ms: Option<f64> = parse_since(since.as_deref(), Some(&tz));
        let until_ms: Option<f64> = match until.as_deref() {
            Some(u) if !u.is_empty() => {
                let t = js_date_parse(u);
                if t.is_nan() {
                    None
                } else {
                    Some(t)
                }
            }
            _ => None,
        };
        // Scope the audit to ONE agent by default: a rate limit is enforced per
        // key/route, so pooling agents fabricates a cadence no key produced.
        let agent_filter: Option<String> = match q.get("agent") {
            Some("*") => None,
            Some(a) if !a.is_empty() => Some(a.to_string()),
            _ => Some("litellm".to_string()),
        };
        let source = {
            let g = self.inner.lock();
            if g.scanning {
                g.read_cache.clone()
            } else {
                g.cache.clone()
            }
        };
        let cfg = get_config_sync();
        let rate_cfg = cfg.rate_limit.clone();
        let flag_value: Option<Value> =
            rate_cfg.as_ref().and_then(|r| r.flag.as_ref()).and_then(|f| serde_json::to_value(f).ok());
        let config_windows = rate_cfg.as_ref().and_then(|r| r.windows.clone());
        let config_models = rate_cfg.as_ref().and_then(|r| r.models.clone());
        let period_since = match since_ms {
            Some(ms) => Value::from(to_iso_string(ms).ok_or_else(|| "Invalid time value".to_string())?),
            None => Value::Null,
        };
        let period_until = match until_ms {
            Some(ms) => Value::from(to_iso_string(ms).ok_or_else(|| "Invalid time value".to_string())?),
            None => Value::Null,
        };

        let agent_for_scope = agent_filter.clone();
        let body = tokio::task::spawn_blocking(move || -> Result<Value, String> {
            // Rate auditing needs real per-call rows only: estimated daily
            // rollups carry a whole day under one timestamp.
            let in_period = |e: &UsageEvent, agent: Option<&str>| -> bool {
                if e.estimated == Some(true) {
                    return false;
                }
                if let Some(a) = agent {
                    if e.agent.as_str() != a {
                        return false;
                    }
                }
                let t = js_date_parse(&e.timestamp);
                if !t.is_finite() {
                    return false;
                }
                if let Some(s) = since_ms {
                    if t < s {
                        return false;
                    }
                }
                if let Some(u) = until_ms {
                    if t > u {
                        return false;
                    }
                }
                true
            };
            let events: Vec<UsageEvent> =
                source.iter().filter(|e| in_period(e, agent_filter.as_deref())).cloned().collect();

            // Per-agent counts in the same window, so a pooled figure can never
            // be mistaken for a single key's traffic.
            let mut counts: IndexMap<String, u64> = IndexMap::new();
            for e in source.iter() {
                if !in_period(e, None) {
                    continue;
                }
                *counts.entry(e.agent.as_str().to_string()).or_insert(0) += 1;
            }
            let mut counted: Vec<(String, u64)> = counts.into_iter().collect();
            counted.sort_by(|a, b| b.1.cmp(&a.1));
            let agents_in_period: Vec<Value> =
                counted.into_iter().map(|(agent, n)| json!({ "agent": agent, "eventCount": n })).collect();

            let resolved = resolve_rate_spec(&RateConfigInput { config_windows, config_models, env: None });
            let thresholds = resolve_flag_thresholds(flag_value.as_ref());
            Ok(json!({
                "guard": {
                    "spec": serde_json::to_value(&resolved.spec).map_err(|e| e.to_string())?,
                    "windowsSource": serde_json::to_value(&resolved.windows_source).map_err(|e| e.to_string())?,
                    "modelsSource": serde_json::to_value(&resolved.models_source).map_err(|e| e.to_string())?,
                    "warnings": resolved.warnings,
                    "isUpstreamDefault": resolved.is_upstream_default,
                    // The algorithm the guard reproduces, named so a reader knows
                    // the numbers come from LiteLLM's own pre-call hook.
                    "algorithm": "litellm_pre_call_sliding_window",
                },
                "flag": build_rate_audit_flag(&events, &thresholds),
                "scope": {
                    // null when every agent is pooled via `agent=*`.
                    "agent": agent_for_scope,
                    "agentsInPeriod": agents_in_period,
                },
                "period": { "since": period_since, "until": period_until },
                "eventCount": events.len(),
            }))
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(json_res(200, &body))
    }

    // ----- /api/cost -------------------------------------------------------

    async fn route_cost(self: &Arc<Self>, q: &Query) -> Result<Response, String> {
        let since = q.get("since").map(str::to_string);
        let until = q.get("until").map(str::to_string);
        let (scanning, scan_revision, pricing_revision) = {
            let g = self.inner.lock();
            (g.scanning, g.scan_revision, g.pricing_revision)
        };
        let memo_key = format!(
            "{}|{}|{}|{}",
            scan_revision,
            pricing_revision,
            since.as_deref().unwrap_or(""),
            until.as_deref().unwrap_or("")
        );
        if !scanning {
            if let Some(hit) = self.inner.lock().cost_report_memo.get(&memo_key).cloned() {
                return Ok(json_res(200, &hit));
            }
            self.ensure_cache_sorted().await;
        }
        let events = self.events_in_period(since.clone(), until.clone()).await;
        let since_c = since.clone();
        let until_c = until.clone();
        let report = tokio::task::spawn_blocking(move || {
            let r = cost_report(&events, since_c.as_deref(), until_c.as_deref());
            serde_json::to_value(&r)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        let report = Arc::new(report);
        if !scanning {
            let mut g = self.inner.lock();
            if g.cost_report_memo.len() >= 64 {
                g.cost_report_memo.clear();
            }
            g.cost_report_memo.insert(memo_key, report.clone());
        }
        Ok(json_res(200, &report))
    }

    // ----- /api/events -----------------------------------------------------

    async fn route_events(self: &Arc<Self>, q: &Query) -> Result<Response, String> {
        let limit = js_min(1000.0, js_max(1.0, number_or(q.get("limit"), 100.0)));
        let agent = q.get_nonempty("agent");
        let since = q.get("since").map(str::to_string);
        let until = q.get("until").map(str::to_string);
        // live=0 -> raw cache (incl. daily rollups). Default live=1 for RECENT
        // EVENTS: only real per-call rows.
        let live_only = q.get("live") != Some("0");
        if live_only {
            self.schedule_recent_light_scan();
            write_heartbeat();
            let scanning = self.inner.lock().scanning;
            if !scanning {
                self.ensure_cache_sorted().await;
            }
            let snap = self.read_snapshot();
            let tz = configured_time_zone();
            let since_ms = parse_since(since.as_deref(), Some(&tz));
            let until_ms = match until.as_deref() {
                Some(u) if !u.is_empty() => {
                    let t = js_date_parse(u);
                    if t.is_nan() {
                        None
                    } else {
                        Some(t)
                    }
                }
                _ => None,
            };
            let opts = RecentLiveOptions {
                limit: Some(js_min(200.0, js_max(limit, 40.0))),
                since_ms,
                until_ms,
                agent: agent.clone(),
                now_ms: Some(now_ms()),
                timestamps_ms: snap.ts_slice(),
            };
            let mut list = build_recent_live_events(&snap.events, &opts).await;
            write_heartbeat();
            if let Some(a) = agent.as_deref() {
                list.retain(|e| e.agent.as_str() == a);
            }
            let (s, e) = js_slice_bounds(list.len(), 0.0, Some(limit));
            list = list[s..e].to_vec();
            let count = list.len();
            return json_ser(200, json!({ "events": list, "count": count, "liveOnly": true })).await;
        }
        let scanning = self.inner.lock().scanning;
        if !scanning {
            self.ensure_cache_sorted().await;
        }
        let mut list = self.events_in_period(since, until).await;
        if let Some(a) = agent.as_deref() {
            list.retain(|e| e.agent.as_str() == a);
        }
        // Cache is ascending; the recent page is the tail (no full re-sort when
        // there is no agent filter).
        let tail_ok = {
            let g = self.inner.lock();
            matches!(&g.cache_ts, Some(ts) if ts.len() == g.cache.len())
        };
        if agent.is_none() && tail_ok && (list.len() as f64) > limit {
            let (s, _) = js_slice_bounds(list.len(), list.len() as f64 - limit, None);
            list = list[s..].to_vec();
            list.reverse();
        } else {
            // Descending by timestamp; unparsable timestamps sort last.
            let mut keyed: Vec<(f64, UsageEvent)> = list
                .into_iter()
                .map(|e| {
                    let t = js_date_parse(&e.timestamp);
                    (if t.is_nan() { f64::NEG_INFINITY } else { t }, e)
                })
                .collect();
            keyed.sort_by(|a, b| b.0.total_cmp(&a.0));
            let (s, e) = js_slice_bounds(keyed.len(), 0.0, Some(limit));
            list = keyed.into_iter().skip(s).take(e - s).map(|(_, e)| e).collect();
        }
        let count = list.len();
        json_ser(200, json!({ "events": list, "count": count, "liveOnly": false })).await
    }

    // ----- POST /api/scan --------------------------------------------------

    async fn route_scan(self: &Arc<Self>, q: &Query) -> Result<Response, String> {
        let t0 = now_ms();
        // Manual refresh always does a full historical pass (no per-agent
        // timeout). async=1: start in the background and return immediately.
        let async_mode = q.get("async") == Some("1") || q.get("wait") == Some("0");
        let fut = self.scan_all_sources_manually();
        if async_mode {
            self.handle.spawn(async move {
                if let Err(err) = fut.await {
                    swarn(&format!("[tokenlab] async scan failed: {err}"));
                }
            });
            let (event_count, scan_revision) = {
                let g = self.inner.lock();
                (g.cache.len(), g.scan_revision)
            };
            return Ok(json_res(
                202,
                &json!({
                    "ok": true,
                    "accepted": true,
                    "full": true,
                    "scanning": true,
                    "eventCount": event_count,
                    "scanRevision": scan_revision,
                }),
            ));
        }
        let n = fut.await?;
        Ok(json_res(
            200,
            &json!({
                "ok": true,
                "full": true,
                "eventsIngested": n,
                "durationMs": jn(now_ms() - t0),
            }),
        ))
    }
}

// ---------------------------------------------------------------------------
// Pricing / config / backup routes
// ---------------------------------------------------------------------------

use tokio::time::Instant;

/// One row of the Model page catalog (`CatalogRow` in the TS handler). Optional
/// fields are omitted from the JSON exactly like `undefined` is.
struct CatRow {
    id: String,
    name: String,
    provider: String,
    slug: String,
    context_length: f64,
    modality: String,
    free: bool,
    source: &'static str,
    input_per_1m: f64,
    output_per_1m: f64,
    cache_read_per_1m: Option<f64>,
    cache_write_per_1m: Option<f64>,
    estimated: bool,
    created: Option<f64>,
}

impl CatRow {
    fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("id".to_string(), Value::from(self.id.as_str()));
        m.insert("name".to_string(), Value::from(self.name.as_str()));
        m.insert("provider".to_string(), Value::from(self.provider.as_str()));
        m.insert("slug".to_string(), Value::from(self.slug.as_str()));
        m.insert("contextLength".to_string(), jn(self.context_length));
        m.insert("modality".to_string(), Value::from(self.modality.as_str()));
        m.insert("free".to_string(), Value::Bool(self.free));
        m.insert("source".to_string(), Value::from(self.source));
        m.insert("inputPer1M".to_string(), jn(self.input_per_1m));
        m.insert("outputPer1M".to_string(), jn(self.output_per_1m));
        if let Some(v) = self.cache_read_per_1m {
            m.insert("cacheReadPer1M".to_string(), jn(v));
        }
        if let Some(v) = self.cache_write_per_1m {
            m.insert("cacheWritePer1M".to_string(), jn(v));
        }
        m.insert("estimated".to_string(), Value::Bool(self.estimated));
        if let Some(v) = self.created {
            m.insert("created".to_string(), jn(v));
        }
        Value::Object(m)
    }
}

/// Distinct model names seen in local usage, in first-seen order.
fn seen_models_of(cache: &[UsageEvent]) -> Vec<String> {
    // Most rows repeat the same (agent, model) pair: normalize each pair once.
    let mut pairs: HashSet<(AgentId, Option<&str>)> = HashSet::new();
    let mut out: IndexSet<String> = IndexSet::new();
    for e in cache {
        if !pairs.insert((e.agent, e.model.as_deref())) {
            continue;
        }
        let norm = normalize_model_for_agent(e.model.as_deref(), Some(e.agent.as_str())).filter(|s| !s.is_empty());
        let picked = norm.or_else(|| e.model.clone().filter(|s| !s.is_empty()));
        if let Some(m) = picked {
            out.insert(m);
        }
    }
    out.into_iter().collect()
}

/// OpenRouter catalog merged with effective rates, plus synthetic rows for
/// bundled / custom / locally seen models that OpenRouter does not list.
fn build_pricing_catalog(
    models: &[String],
    openrouter: &[OpenRouterModelEntry],
    custom: &IndexMap<String, ModelRate>,
) -> Vec<CatRow> {
    let mut rows: Vec<CatRow> = openrouter
        .iter()
        .map(|m| {
            let c_key = m.id.to_lowercase();
            let s_key = m.slug.to_lowercase();
            let cust = custom.get(&c_key).or_else(|| custom.get(&s_key));
            let reference = get_rate_for_model(Some(&m.id));
            let use_paid = cust.is_none()
                && m.free
                && reference.source == RateSource::Bundled
                && (reference.rate.input_per_1m > 0.0 || reference.rate.output_per_1m > 0.0);
            let input = cust
                .map(|c| c.input_per_1m)
                .unwrap_or(if use_paid { reference.rate.input_per_1m } else { m.input_per_1m });
            let output = cust
                .map(|c| c.output_per_1m)
                .unwrap_or(if use_paid { reference.rate.output_per_1m } else { m.output_per_1m });
            let free = if use_paid {
                false
            } else {
                cust.map(|c| c.input_per_1m).unwrap_or(m.input_per_1m) == 0.0
                    && cust.map(|c| c.output_per_1m).unwrap_or(m.output_per_1m) == 0.0
            };
            CatRow {
                id: m.id.clone(),
                name: m.name.clone(),
                provider: m.provider.clone(),
                slug: m.slug.clone(),
                context_length: m.context_length,
                modality: m.modality.clone(),
                free,
                source: if cust.is_some() {
                    "custom"
                } else if use_paid {
                    "bundled"
                } else {
                    "openrouter"
                },
                input_per_1m: input,
                output_per_1m: output,
                cache_read_per_1m: cust.and_then(|c| c.cache_read_per_1m).or(if use_paid {
                    reference.rate.cache_read_per_1m
                } else {
                    m.cache_read_per_1m
                }),
                cache_write_per_1m: cust.and_then(|c| c.cache_write_per_1m).or(if use_paid {
                    reference.rate.cache_write_per_1m
                } else {
                    m.cache_write_per_1m
                }),
                estimated: cust.is_none() && use_paid,
                created: m.created,
            }
        })
        .collect();

    let mut by_id: HashSet<String> = rows.iter().map(|r| r.id.to_lowercase()).collect();
    let mut by_slug: HashSet<String> = HashSet::new();
    for r in &rows {
        if !r.slug.is_empty() {
            by_slug.insert(r.slug.to_lowercase());
        }
    }

    let mut add_synthetic = |raw_name: &str, source: &'static str| {
        let name = js_trim(raw_name);
        if name.is_empty() || name == "default" {
            return;
        }
        // Skip router aggregate placeholders.
        if RE_9ROUTER.is_match(name) || name == "mixed" || name == "XLab" {
            return;
        }
        let norm: String = normalize_model_name(Some(name))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| name.to_string());
        let key = norm.to_lowercase();
        if by_id.contains(&key) || by_slug.contains(&key) {
            return;
        }
        // Also skip when any OpenRouter id ends with /slug.
        let suffix = format!("/{key}");
        if by_id.iter().any(|id| id.ends_with(&suffix) || *id == key) {
            return;
        }
        let looked_up = get_rate_for_model(Some(name));
        let rate = &looked_up.rate;
        let provider = guess_provider(&norm);
        let slug = match norm.find('/') {
            Some(i) => norm[i + 1..].to_string(),
            None => norm.clone(),
        };
        let id = if norm.contains('/') { norm.clone() } else { format!("{provider}/{slug}") };
        if by_id.contains(&id.to_lowercase()) {
            return;
        }
        let cust = custom
            .get(&key)
            .or_else(|| custom.get(&id.to_lowercase()))
            .or_else(|| custom.get(&slug.to_lowercase()));
        let entry = CatRow {
            id: id.clone(),
            name: norm.clone(),
            provider,
            slug: slug.clone(),
            context_length: 0.0,
            modality: "text->text".to_string(),
            free: cust.map(|c| c.input_per_1m).unwrap_or(rate.input_per_1m) == 0.0
                && cust.map(|c| c.output_per_1m).unwrap_or(rate.output_per_1m) == 0.0,
            source: if cust.is_some() {
                "custom"
            } else if looked_up.source == RateSource::Bundled {
                "bundled"
            } else if source == "custom" {
                "custom"
            } else {
                source
            },
            input_per_1m: cust.map(|c| c.input_per_1m).unwrap_or(rate.input_per_1m),
            output_per_1m: cust.map(|c| c.output_per_1m).unwrap_or(rate.output_per_1m),
            cache_read_per_1m: cust.and_then(|c| c.cache_read_per_1m).or(rate.cache_read_per_1m),
            cache_write_per_1m: cust.and_then(|c| c.cache_write_per_1m).or(rate.cache_write_per_1m),
            estimated: rate.estimated == Some(true),
            created: Some(0.0),
        };
        rows.push(entry);
        by_id.insert(id.to_lowercase());
        by_slug.insert(slug.to_lowercase());
    };

    // Bundled offline rates first, then custom, then models seen in local usage.
    for k in BUNDLED_RATES.keys() {
        add_synthetic(k, "bundled");
    }
    for k in custom.keys() {
        add_synthetic(k, "custom");
    }
    for m in models {
        add_synthetic(m, "seen");
    }

    // Newest OpenRouter first, then synthetic (created = 0) alphabetically.
    rows.sort_by(|a, b| {
        desc_cmp(a.created.unwrap_or(0.0), b.created.unwrap_or(0.0)).then_with(|| locale_compare(&a.name, &b.name))
    });
    rows
}

/// `PUT /api/pricing` body to normalized custom rates.
fn parse_rate_entries(rates_in: &Value) -> IndexMap<String, ModelRate> {
    let entries: Vec<(String, &Value)> = match rates_in {
        Value::Object(m) => m.iter().map(|(k, v)| (k.clone(), v)).collect(),
        Value::Array(a) => a.iter().enumerate().map(|(i, v)| (i.to_string(), v)).collect(),
        _ => Vec::new(),
    };
    let mut out: IndexMap<String, ModelRate> = IndexMap::new();
    for (raw_key, raw_val) in entries {
        let key_src = normalize_model_name(Some(&raw_key))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| raw_key.clone());
        let key = js_trim(&key_src).to_lowercase();
        if key.is_empty() {
            continue;
        }
        let Value::Object(o) = raw_val else { continue };
        let num = |k: &str| o.get(k).map(js_number_of_value).unwrap_or(f64::NAN);
        let input = num("inputPer1M");
        let output = num("outputPer1M");
        if !input.is_finite() || !output.is_finite() {
            continue;
        }
        let opt = |k: &str| -> Option<f64> {
            match o.get(k) {
                None | Some(Value::Null) => None,
                Some(v) => {
                    let n = js_number_of_value(v);
                    if n.is_finite() {
                        Some(n)
                    } else {
                        None
                    }
                }
            }
        };
        out.insert(
            key,
            ModelRate {
                input_per_1m: input,
                output_per_1m: output,
                cache_read_per_1m: opt("cacheReadPer1M"),
                cache_write_per_1m: opt("cacheWritePer1M"),
                ..Default::default()
            },
        );
    }
    out
}

fn json_obj_or_empty(v: Option<&Value>) -> Map<String, Value> {
    match v {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    }
}

/// The rate-limit block `PUT /api/config` stores (always a fresh object when
/// the body carries one; `prev` otherwise).
fn next_rate_limit(prev: Option<&Value>, body_rate: Option<&Value>) -> Option<Value> {
    let Some(Value::Object(br)) = body_rate else {
        return prev.cloned();
    };
    let prev_rl: Option<&Map<String, Value>> = prev.and_then(|v| v.as_object());
    let pick_string = |key: &str| -> Option<Value> {
        match br.get(key) {
            Some(Value::String(s)) => Some(Value::String(s.clone())),
            _ => prev_rl.and_then(|p| p.get(key)).filter(|v| v.is_string()).cloned(),
        }
    };
    let body_flag: Option<&Map<String, Value>> = match br.get("flag") {
        Some(Value::Object(m)) => Some(m),
        _ => None,
    };
    let prev_flag: Option<Map<String, Value>> = match prev_rl.and_then(|p| p.get("flag")) {
        Some(Value::Object(m)) => Some(m.clone()),
        _ => None,
    };
    let mut flag: Option<Map<String, Value>> = match body_flag {
        Some(_) => Some(prev_flag.unwrap_or_default()),
        None => prev_flag,
    };
    if let (Some(bf), Some(f)) = (body_flag, flag.as_mut()) {
        // Only finite numbers are adopted; a half-typed field must not save NaN.
        for key in ["spanHours", "activeHours", "continuousGapSeconds", "maxIdleHours", "automatedGapShare"] {
            if let Some(Value::Number(n)) = bf.get(key) {
                if let Some(x) = n.as_f64().filter(|x| x.is_finite()) {
                    f.insert(key.to_string(), jn(x));
                }
            }
        }
    }
    let mut out = Map::new();
    if let Some(w) = pick_string("windows") {
        out.insert("windows".to_string(), w);
    }
    if let Some(m) = pick_string("models") {
        out.insert("models".to_string(), m);
    }
    if let Some(f) = flag {
        if !f.is_empty() {
            out.insert("flag".to_string(), Value::Object(f));
        }
    }
    Some(Value::Object(out))
}

impl AppState {
    // ----- GET /api/pricing ------------------------------------------------

    async fn route_pricing_get(self: &Arc<Self>, q: &Query) -> Result<Response, String> {
        let cache = self.inner.lock().cache.clone();
        let mut models: Vec<String> = tokio::task::spawn_blocking(move || seen_models_of(&cache))
            .await
            .map_err(|e| e.to_string())?;
        let cfg = load_config().await;
        let force_or = q.get("refreshOpenRouter") == Some("1");
        // Auto-refresh a stale OpenRouter catalog (>6h) so the Model page stays complete.
        let fetched_at = get_open_router_fetched_at();
        let stale = fetched_at == 0.0 || now_ms() - fetched_at > 6.0 * 60.0 * 60.0 * 1000.0;
        if force_or || get_open_router_models_sync().is_empty() || stale {
            // Keep empty / stale on failure; the UI can show offline.
            let _ = fetch_open_router_models(force_or || stale).await;
        }
        let openrouter = get_open_router_models_sync();
        let custom: IndexMap<String, ModelRate> =
            cfg.pricing.as_ref().map(|p| p.custom_rates.clone()).unwrap_or_default();
        let currency = cfg
            .pricing
            .as_ref()
            .and_then(|p| p.currency.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "USD".to_string());
        let prefer_router_cost = cfg.pricing.as_ref().and_then(|p| p.prefer_router_cost) != Some(false);

        let (custom_json, catalog_json, openrouter_json, seen_sorted) = tokio::task::spawn_blocking(
            move || -> Result<(Value, Value, Vec<Value>, Vec<String>), String> {
                let rows = build_pricing_catalog(&models, &openrouter, &custom);
                let openrouter_json: Vec<Value> = rows.iter().map(CatRow::to_json).collect();
                // The pricing catalog is listed before `seenModels` is sorted.
                let catalog = list_pricing_catalog(&models);
                let catalog_json = serde_json::to_value(&catalog).map_err(|e| e.to_string())?;
                let custom_json = serde_json::to_value(&custom).map_err(|e| e.to_string())?;
                models.sort_by(|a, b| locale_compare(a, b));
                Ok((custom_json, catalog_json, openrouter_json, models))
            },
        )
        .await
        .map_err(|e| e.to_string())??;

        let (pricing_revision, pricing_updated_at) = {
            let g = self.inner.lock();
            (g.pricing_revision, g.pricing_updated_at)
        };
        let count = openrouter_json.len();
        let body = json!({
            "configPath": config_path(),
            "currency": currency,
            "preferRouterCost": prefer_router_cost,
            "customRates": custom_json,
            "catalog": catalog_json,
            "openrouter": openrouter_json,
            "openrouterCount": count,
            "openrouterFetchedAt": jn(get_open_router_fetched_at()),
            "seenModels": seen_sorted,
            "pricingRevision": pricing_revision,
            "pricingUpdatedAt": jn(pricing_updated_at),
        });
        json_ser(200, body).await
    }

    // ----- GET /api/pricing/stream (SSE) ----------------------------------

    fn route_pricing_stream(self: &Arc<Self>) -> Response {
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        {
            let mut g = self.inner.lock();
            let hello = json!({
                "type": "hello",
                "revision": g.pricing_revision,
                "pricingRevision": g.pricing_revision,
                "scanRevision": g.scan_revision,
                "scanning": g.scanning,
                "updatedAt": jn(g.pricing_updated_at),
                "eventCount": g.cache.len(),
            });
            let _ = tx.send(format!("data: {}\n\n", serde_json::to_string(&hello).unwrap_or_else(|_| "null".into())));
            g.listeners.push(tx.clone());
        }

        // Keep-alive ping every 15s; ends (and de-registers) when the client
        // goes away or the server is closing.
        let state = self.clone();
        let mut shutdown_rx = self.shutdown.subscribe();
        self.handle.spawn(async move {
            let mut interval = tokio::time::interval_at(Instant::now() + Duration::from_secs(15), Duration::from_secs(15));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            if !*shutdown_rx.borrow() {
                loop {
                    tokio::select! {
                        _ = tx.closed() => break,
                        changed = shutdown_rx.changed() => {
                            if changed.is_err() || *shutdown_rx.borrow() {
                                break;
                            }
                        }
                        _ = interval.tick() => {
                            if tx.send(format!(": ping {}\n\n", now_ms() as i64)).is_err() {
                                break;
                            }
                        }
                    }
                }
            }
            state.inner.lock().listeners.retain(|l| !l.same_channel(&tx));
        });

        let stream = UnboundedReceiverStream::new(rx).map(|s| Ok::<Bytes, Infallible>(Bytes::from(s)));
        let mut res = Response::new(Body::from_stream(stream));
        *res.status_mut() = StatusCode::OK;
        let h = res.headers_mut();
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream; charset=utf-8"));
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-transform"));
        h.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
        res
    }

    // ----- PUT /api/pricing ------------------------------------------------

    async fn route_pricing_put(self: &Arc<Self>, body: Body) -> Result<Response, String> {
        let body = read_json_body(body).await;
        let rates_in: Value = ["customRates", "rates"]
            .iter()
            .filter_map(|k| body.get(*k))
            .find(|v| js_truthy(v))
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));
        let replace = body.get("replace") == Some(&Value::Bool(true));
        let live = body.get("live") == Some(&Value::Bool(true));
        let normalized = parse_rate_entries(&rates_in);

        let cfg = set_custom_rates(normalized, replace).await.map_err(|e| e.to_string())?;
        // Force table reprice so new rates apply immediately to all events.
        self.reprice_cache(true).await;
        set_scan_cache_rates_version(RATES_VERSION).await.map_err(|e| e.to_string())?;
        self.bump_pricing(if live { "live" } else { "save" });

        let cache = self.inner.lock().cache.clone();
        let totals = {
            let c = cache.clone();
            tokio::task::spawn_blocking(move || {
                aggregate(&c, GroupBy::Agent, "cost", None, None, None, false).totals
            })
            .await
            .map_err(|e| e.to_string())?
        };
        let custom_json = match cfg.pricing.as_ref() {
            Some(p) => serde_json::to_value(&p.custom_rates).map_err(|e| e.to_string())?,
            None => Value::Object(Map::new()),
        };
        let (event_count, pricing_revision, pricing_updated_at) = {
            let g = self.inner.lock();
            (g.cache.len(), g.pricing_revision, g.pricing_updated_at)
        };
        Ok(json_res(
            200,
            &json!({
                "ok": true,
                "live": live,
                "customRates": custom_json,
                "eventCount": event_count,
                "pricingRevision": pricing_revision,
                "pricingUpdatedAt": jn(pricing_updated_at),
                "totals": {
                    "estimatedCost": jn(totals.estimated_cost),
                    "totalTokens": jn(totals.total_tokens),
                    "eventCount": jn(totals.event_count),
                },
            }),
        ))
    }

    // ----- GET /api/config -------------------------------------------------

    async fn route_config_get(self: &Arc<Self>) -> Result<Response, String> {
        let cfg = load_config().await;
        // Never echo the full GitHub token to the browser.
        let has_token = cfg
            .backup
            .as_ref()
            .and_then(|b| b.github_token.as_deref())
            .map_or(false, |t| !t.is_empty())
            || env_nonempty("XLAB_GITHUB_TOKEN").is_some()
            || env_nonempty("GITHUB_TOKEN").is_some();
        let str_or_null = |v: Option<&String>| -> Value {
            match v {
                Some(s) if !s.is_empty() => Value::from(s.as_str()),
                _ => Value::Null,
            }
        };
        let b = cfg.backup.as_ref();
        let backup = json!({
            "gistId": str_or_null(b.and_then(|b| b.gist_id.as_ref())),
            "gistUrl": str_or_null(b.and_then(|b| b.gist_url.as_ref())),
            "lastBackupAt": str_or_null(b.and_then(|b| b.last_backup_at.as_ref())),
            "hasGithubToken": has_token,
            // Default on when unset.
            "autoDaily": b.and_then(|b| b.auto_daily) != Some(false),
        });
        let mut map = config_to_map(&cfg);
        map.insert("configPath".to_string(), Value::from(config_path()));
        map.insert("backup".to_string(), backup);
        Ok(json_res(200, &Value::Object(map)))
    }

    // ----- GET /api/backup -------------------------------------------------

    async fn route_backup_get(self: &Arc<Self>, q: &Query) -> Result<Response, String> {
        let scope_settings = q.get("scope") == Some("settings");
        let cache = self.inner.lock().cache.clone();
        if scope_settings {
            let opts = SettingsBackupOpts { event_count_hint: Some(cache.len() as f64), note: None };
            let backup = build_settings_backup(Some(&opts));
            return json_ser(200, backup).await;
        }
        let include_mirrors = q.get("mirrors") != Some("0");
        let built = self
            .handle
            .spawn(async move {
                build_full_backup(&cache, FullBackupOpts { include_mirrors: Some(include_mirrors), note: None }).await
            })
            .await;
        let backup = match built {
            Ok(b) => b,
            Err(e) => {
                let msg = if e.is_panic() { panic_message(&e.into_panic()) } else { e.to_string() };
                return Ok(error_json(500, "BACKUP_FAILED", &msg));
            }
        };
        match json_ser(200, backup).await {
            Ok(res) => Ok(res),
            Err(msg) => Ok(error_json(500, "BACKUP_FAILED", &msg)),
        }
    }

    // ----- POST /api/backup/gist ------------------------------------------

    async fn route_backup_gist(self: &Arc<Self>, body: Body) -> Result<Response, String> {
        let body = read_json_body(body).await;
        let cache = self.inner.lock().cache.clone();
        let event_count = cache.len();
        let as_string = |k: &str| -> Option<String> {
            match body.get(k) {
                Some(Value::String(s)) => Some(s.clone()),
                _ => None,
            }
        };
        let is_true = |k: &str| body.get(k) == Some(&Value::Bool(true));
        let events: Vec<UsageEvent> = tokio::task::spawn_blocking(move || (*cache).clone())
            .await
            .map_err(|e| e.to_string())?;
        let opts = UploadOpts {
            token: as_string("token"),
            gist_id: as_string("gistId"),
            public: Some(is_true("public")),
            event_count_hint: Some(event_count as f64),
            save_token: is_true("saveToken"),
            // Period stats: by model + by agent for Today/24h/7D/30D/All.
            events: Some(events),
        };
        let result = match upload_backup_to_gist(opts).await {
            Ok(r) => r,
            Err(e) => return Ok(error_json(400, "GIST_BACKUP_FAILED", &e.to_string())),
        };
        let b = &result.backup;
        let meta = b.meta.as_ref();
        let custom_rate_count = b.config.pricing.as_ref().map_or(0, |p| p.custom_rates.len());
        let events_len = b.events.as_ref().map_or(0.0, |e| e.len() as f64);
        let or0 = |v: Option<f64>| v.unwrap_or(0.0);
        let event_count_out = js_or_num(&[
            or0(meta.and_then(|m| m.source_event_count)),
            or0(meta.and_then(|m| m.event_count)),
            events_len,
            0.0,
        ]);
        let rollup_out = js_or_num(&[or0(meta.and_then(|m| m.rollup_event_count)), events_len, 0.0]);
        let model_count = js_or_num(&[or0(meta.and_then(|m| m.model_count)), 0.0]);
        let agent_count = js_or_num(&[or0(meta.and_then(|m| m.agent_count)), 0.0]);
        let mirror_files = js_or_num(&[or0(meta.and_then(|m| m.mirror_file_count)), 0.0]);
        let machine_id = match meta.and_then(|m| m.machine_id.as_ref()) {
            Some(s) if !s.is_empty() => Value::from(s.as_str()),
            _ => Value::Null,
        };
        let machines: Vec<String> = meta.and_then(|m| m.machines.clone()).unwrap_or_default();
        let gist = serde_json::to_value(&result.gist).map_err(|e| e.to_string())?;
        Ok(json_res(
            200,
            &json!({
                "ok": true,
                "gist": gist,
                "scope": result.scope,
                "exportedAt": b.exported_at,
                "customRateCount": custom_rate_count,
                "eventCount": jn(event_count_out),
                "rollupEventCount": jn(rollup_out),
                "modelCount": jn(model_count),
                "agentCount": jn(agent_count),
                "machineId": machine_id,
                "machines": machines,
                "mirrorFileCount": jn(mirror_files),
            }),
        ))
    }

    // ----- POST /api/backup/restore ---------------------------------------

    async fn route_backup_restore(self: &Arc<Self>, body: Body) -> Result<Response, String> {
        let body = read_json_body(body).await;
        let payload: Value = match body.get("backup") {
            Some(v @ (Value::Object(_) | Value::Array(_))) => v.clone(),
            _ => Value::Object(body.clone()),
        };
        let outcome: Result<Value, String> = async {
            let result = restore_backup(&payload).await.map_err(|e| e.to_string())?;
            let prefer_table = result.config.pricing.as_ref().and_then(|p| p.prefer_router_cost) == Some(false);
            let restored_events: Vec<UsageEvent> = result.events.clone().unwrap_or_default();
            let events_restored = restored_events.len();
            // Restore usage: merge Gist rollups / full events into import + cache.
            if !restored_events.is_empty() {
                let current = self.inner.lock().imported_events.clone();
                let imported: Vec<UsageEvent> = tokio::task::spawn_blocking(move || {
                    let a: &[UsageEvent] = &current;
                    let b: &[UsageEvent] = &restored_events;
                    merge_events_by_id_prefer_richer(&[a, b])
                })
                .await
                .map_err(|e| e.to_string())?;
                let imported = Arc::new(imported);
                // Memory first (like TS), then persist so the next local rescan
                // does not drop other-machine events.
                self.inner.lock().imported_events = imported.clone();
                save_imported_events(&imported).await.map_err(|e| e.to_string())?;
                // Prefer real local rows over Gist rollups for the same day x agent x model.
                let cache = self.inner.lock().cache.clone();
                let imported_c = imported.clone();
                let (sorted, ts) = tokio::task::spawn_blocking(move || {
                    let merged = merge_local_prefer_over_gist_rollups(&cache, &imported_c, None);
                    let restored = reprice_events(&merged, prefer_table);
                    sort_events_by_time(&restored)
                })
                .await
                .map_err(|e| e.to_string())?;
                self.set_cache(sorted, true, Some(ts)).await;
                self.bump_scan("restore");
            } else {
                self.reprice_cache(prefer_table).await;
            }
            set_scan_cache_rates_version(RATES_VERSION).await.map_err(|e| e.to_string())?;
            self.bump_pricing("restore");
            let event_count = self.inner.lock().cache.len();
            let timezone = result
                .config
                .timezone
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "local".to_string());
            Ok(json!({
                "ok": true,
                "scope": result.scope,
                "customRateCount": jn(result.custom_rate_count),
                "eventCount": event_count,
                "eventsRestored": events_restored,
                "openrouterRestored": result.openrouter_restored,
                "mirrorsRestored": jn(result.mirrors_restored),
                "timezone": timezone,
            }))
        }
        .await;
        match outcome {
            Ok(v) => Ok(json_res(200, &v)),
            Err(msg) => Ok(error_json(400, "RESTORE_FAILED", &msg)),
        }
    }

    // ----- PUT /api/config -------------------------------------------------

    async fn route_config_put(self: &Arc<Self>, body: Body) -> Result<Response, String> {
        let body = read_json_body(body).await;
        let prev = load_config().await;
        let prev_map = config_to_map(&prev);

        let body_pricing = json_obj_or_empty(body.get("pricing"));
        let body_tz = match body.get("timezone") {
            Some(Value::String(s)) if !js_trim(s).is_empty() => Some(js_trim(s).to_string()),
            _ => prev.timezone.clone(),
        };
        let timezone = body_tz.filter(|s| !s.is_empty()).unwrap_or_else(|| "local".to_string());

        // pricing = {...prev.pricing, ...bodyPricing, customRates: <body or prev>}
        let mut pricing = json_obj_or_empty(prev_map.get("pricing"));
        let prev_custom = pricing.get("customRates").cloned();
        for (k, v) in &body_pricing {
            pricing.insert(k.clone(), v.clone());
        }
        match body_pricing.get("customRates") {
            // Never wipe custom rates via this endpoint unless explicitly provided.
            Some(Value::Object(m)) => {
                pricing.insert("customRates".to_string(), Value::Object(m.clone()));
            }
            _ => match prev_custom {
                Some(v) => {
                    pricing.insert("customRates".to_string(), v);
                }
                None => {
                    pricing.shift_remove("customRates");
                }
            },
        }

        // scan = bodyScan ? {...prev.scan, ...bodyScan} : prev.scan
        let scan: Option<Value> = match body.get("scan") {
            Some(Value::Object(bs)) => {
                let mut m = json_obj_or_empty(prev_map.get("scan"));
                for (k, v) in bs {
                    m.insert(k.clone(), v.clone());
                }
                Some(Value::Object(m))
            }
            _ => prev_map.get("scan").cloned(),
        };

        let rate_limit = next_rate_limit(prev_map.get("rateLimit"), body.get("rateLimit"));

        // backup = {...prev.backup, autoDaily only when the body gives a boolean}
        let mut backup = json_obj_or_empty(prev_map.get("backup"));
        if let Some(Value::Object(bb)) = body.get("backup") {
            if let Some(Value::Bool(b)) = bb.get("autoDaily") {
                backup.insert("autoDaily".to_string(), Value::Bool(*b));
            }
        }

        let mut cfg_map = prev_map.clone();
        cfg_map.insert("timezone".to_string(), Value::from(timezone));
        cfg_map.insert("pricing".to_string(), Value::Object(pricing));
        if let Some(s) = scan {
            cfg_map.insert("scan".to_string(), s);
        }
        if let Some(r) = rate_limit {
            cfg_map.insert("rateLimit".to_string(), r);
        }
        cfg_map.insert("backup".to_string(), Value::Object(backup));
        let next_cfg: XlabTokenConfig = config_from_value(Value::Object(cfg_map)).map_err(|e| e.to_string())?;
        let next = save_config(&next_cfg).await.map_err(|e| e.to_string())?;

        // A cadence change must take effect now, not after the old window expires:
        // either clear the rate-limit so the next tick can scan, or mark the
        // window as just-used so a longer interval is not waited out twice.
        let periodic = scan_periodic_enabled();
        {
            let mut g = self.inner.lock();
            g.last_recent_light_scan_at = 0.0;
            if periodic {
                g.last_periodic_full_scan_at = now_ms();
            }
        }
        // Reprice when preferRouterCost flips.
        self.reprice_cache(next.pricing.as_ref().and_then(|p| p.prefer_router_cost) == Some(false)).await;
        set_scan_cache_rates_version(RATES_VERSION).await.map_err(|e| e.to_string())?;
        self.bump_pricing("config");

        let today_tz = next.timezone.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "local".to_string());
        let today_starts_at = to_iso_string(start_of_day_in_time_zone(Some(&today_tz), now_ms()))
            .ok_or_else(|| "Invalid time value".to_string())?;
        // Echoes `next.backup` as stored (the TS handler does the same).
        let mut out = Map::new();
        out.insert("ok".to_string(), Value::Bool(true));
        for (k, v) in config_to_map(&next) {
            out.insert(k, v);
        }
        out.insert("configPath".to_string(), Value::from(config_path()));
        out.insert("scanIntervalMinutes".to_string(), jn(scan_interval_minutes()));
        out.insert("scanFullIntervalMinutes".to_string(), jn(full_scan_interval_minutes()));
        out.insert("scanPeriodicEnabled".to_string(), Value::Bool(scan_periodic_enabled()));
        out.insert("todayStartsAt".to_string(), Value::from(today_starts_at));
        Ok(json_res(200, &Value::Object(out)))
    }
}

// ---------------------------------------------------------------------------
// Lifecycle: periodic tick, auto Gist, listen, start / close
// ---------------------------------------------------------------------------

impl AppState {
    /// One 60s bookkeeping tick. The tick fires every minute, but the remote
    /// mirror pulls and the scans are all throttled by config: mirrors every
    /// 60 min, scans every `scan.intervalMinutes` and full all-agent scans every
    /// `scan.fullIntervalMinutes`.
    async fn periodic_tick(self: &Arc<Self>) -> Result<(), String> {
        let now = now_ms();
        let (last_pmv, last_full, last_mirror, last_ubuntu) = {
            let g = self.inner.lock();
            if g.manual_full_scan_promise.is_some() {
                return Ok(());
            }
            (
                g.last_pmv_mirror_sync_at,
                g.last_periodic_full_scan_at,
                g.last_mirror_sync_at,
                g.last_ubuntu_mirror_sync_at,
            )
        };
        if now - last_pmv >= PMV_MIRROR_SYNC_INTERVAL_MS {
            // Runs on its own task; nothing waits for it.
            let _ = self.sync_phanmemvip_usage_mirror("periodic");
        }
        let periodic_on = scan_periodic_enabled();
        let full_due = periodic_on && now - last_full >= full_scan_interval_minutes() * 60_000.0;
        // Remote usage is cheap to download but expensive to produce, so pull it
        // on its own 60-minute cadence rather than on every tick. Always pull
        // regardless of `periodic_on`: the dashboard reads mirrors directly, and
        // skipping this when scanning is off would freeze multi-machine totals.
        let mirror_due = now - last_mirror >= MIRROR_SYNC_INTERVAL_MS;
        let ubuntu_mirror_due = now - last_ubuntu >= MIRROR_SYNC_INTERVAL_MS;
        if mirror_due || ubuntu_mirror_due {
            let reason = if full_due { "periodic-full" } else { "periodic" };
            let vps = async {
                if mirror_due {
                    self.sync_vps_mirrors(reason, MIRROR_SYNC_TIMEOUT_MS).await
                } else {
                    true
                }
            };
            let ubuntu = async {
                if ubuntu_mirror_due {
                    self.sync_ubuntu_usage(reason).await
                } else {
                    true
                }
            };
            let _ = futures::join!(vps, ubuntu);
        }
        if !periodic_on {
            return Ok(());
        }
        // Skip starting another scan if one is already running (rescan coalesces
        // too). A dashboard recent-scan inside the window counts as this tick.
        if self.inner.lock().scan_promise.is_some() {
            return Ok(());
        }
        if full_due {
            self.inner.lock().last_periodic_full_scan_at = now;
            self.rescan(true).await?;
            return Ok(());
        }
        let last_light = self.inner.lock().last_recent_light_scan_at;
        if now - last_light < scan_interval_minutes() * 60_000.0 {
            return Ok(());
        }
        self.rescan(false).await?;
        Ok(())
    }

    /// Once per local day when gistId + token exist (`autoDaily` default on).
    fn schedule_auto_gist(self: &Arc<Self>, reason: &'static str) {
        let events = {
            let g = self.inner.lock();
            if g.scanning || g.cache.is_empty() {
                return;
            }
            g.cache.clone()
        };
        self.handle.spawn(async move {
            match try_auto_daily_gist_backup(&events).await {
                AutoDailyGistResult::Failed { error, .. } => {
                    swarn(&format!("[tokenlab] auto Gist ({reason}): {error}"));
                }
                AutoDailyGistResult::Done { skipped: false, gist, .. } => {
                    slog(&format!("[tokenlab] auto daily Gist backup OK ({reason}): {}", gist.html_url));
                }
                _ => {}
            }
        });
    }

    /// Stop everything `start_server` scheduled: SSE pings and streams, the
    /// periodic timers and a pending scan cache save.
    fn stop_background(&self) {
        let (timer, tasks) = {
            let mut g = self.inner.lock();
            g.listeners.clear();
            (g.scan_cache_save_timer.take(), std::mem::take(&mut g.tasks))
        };
        self.shutdown.send_replace(true);
        for t in tasks {
            t.abort();
        }
        if let Some(t) = timer {
            t.abort();
        }
    }
}

/// Bind `host:port`, retrying while the port is busy (a restarting dev server
/// on Windows keeps the old socket for a moment).
async fn listen_with_retry(
    host: &str,
    port: f64,
    attempts: usize,
    delay_ms: u64,
) -> Result<tokio::net::TcpListener, String> {
    let mut last_err = String::new();
    for i in 0..attempts {
        let bound: std::io::Result<tokio::net::TcpListener> =
            if port.is_finite() && port.fract() == 0.0 && (0.0..=65535.0).contains(&port) {
                tokio::net::TcpListener::bind((host, port as u16)).await
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("options.port should be >= 0 and < 65536. Received {}", js_num_to_string(port)),
                ))
            };
        match bound {
            Ok(listener) => return Ok(listener),
            Err(err) => {
                last_err = err.to_string();
                if err.kind() != std::io::ErrorKind::AddrInUse || i + 1 == attempts {
                    break;
                }
                if i == 0 || (i + 1) % 5 == 0 {
                    swarn(&format!(
                        "[tokenlab] port {host}:{} busy (EADDRINUSE), retry {}/{attempts}\u{2026}",
                        js_num_to_string(port),
                        i + 1
                    ));
                }
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
        }
    }
    Err(format!(
        "Cannot bind {host}:{} \u{2014} {last_err}. Port is in use; stop only the TokenLab server that owns it, then retry.",
        js_num_to_string(port)
    ))
}

/// Options for [`start_server`] (the TS `ServerOptions`).
#[derive(Debug, Clone, Default)]
pub struct ServerOptions {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub no_ui: bool,
}

/// A running server. Dropping it leaves the server running; call
/// [`ServerHandle::close`] for an orderly shutdown (final scan cache flush).
pub struct ServerHandle {
    pub host: String,
    pub port: u16,
    state: Arc<AppState>,
    stop_tx: Option<tokio::sync::oneshot::Sender<()>>,
    server_task: Option<JoinHandle<()>>,
}

impl ServerHandle {
    pub async fn close(mut self) {
        // Timers first, then flush the scan cache in full mode (collapse + archive).
        self.state.stop_background();
        let events = self.state.inner.lock().cache.clone();
        if let Err(err) = save_scan_cache(&events, SaveScanCacheOpts { mode: SaveMode::Full }).await {
            swarn(&format!("[tokenlab] final scan cache save failed: {err}"));
        }
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(mut task) = self.server_task.take() {
            // Hard-stop if peers keep sockets open.
            if tokio::time::timeout(Duration::from_millis(800), &mut task).await.is_err() {
                task.abort();
            }
        }
    }
}

/// Port of `startServer`: load the warm cache, bind, kick off the background
/// scans and timers, and return a handle.
pub async fn start_server(opts: ServerOptions) -> anyhow::Result<ServerHandle> {
    let _ = load_config().await;
    // Migrate pre-rename data dir before loading caches so usage totals never
    // silently drop after the XLab Token -> TokenLab rename.
    migrate_legacy_data_dir().await;
    let host = opts
        .host
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| env_nonempty("TOKENLAB_HOST"))
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port: f64 = match opts.port.filter(|p| *p != 0) {
        Some(p) => f64::from(p),
        None => match env_nonempty("TOKENLAB_PORT") {
            Some(s) => js_number_from_str(&s),
            None => 3737.0,
        },
    };
    let no_ui = opts.no_ui || std::env::var("TOKENLAB_NO_UI").map_or(false, |v| v == "1");

    let state = Arc::new(AppState::new(host.clone(), port as u16, no_ui, tokio::runtime::Handle::current()));

    // Events from other machines / restore, and the last local scan snapshot.
    let imported = load_imported_events().await;
    let disk = load_scan_cache().await;
    let imported_len = imported.len();
    let disk_len = disk.len();
    // Union import + disk, then collapse within machine scope: local clones
    // collapse while foreign-machine usage remains additive and day totals never
    // shrink.
    let imported = Arc::new(imported);
    let imported_for_merge = imported.clone();
    let (events, ts) = tokio::task::spawn_blocking(move || {
        let merged = merge_local_prefer_over_gist_rollups(&disk, &imported_for_merge, None);
        let mono = enforce_monotonic_agent_days(&disk, &merged);
        let c1 = collapse_router_daily_events(&mono);
        let c2 = collapse_source_path_rollups(&c1);
        let c3 = collapse_exact_usage_duplicates(&c2);
        // Disk saves write timestamp-sorted; sort once more for safety then index.
        sort_events_by_time(&c3)
    })
    .await?;
    state.inner.lock().imported_events = imported;
    state.set_cache(events, true, Some(ts)).await;
    if disk_len > 0 {
        slog(&format!("[tokenlab] loaded {disk_len} cached scan events"));
    }
    if imported_len > 0 {
        slog(&format!("[tokenlab] loaded {imported_len} imported events"));
    }
    let cached = state.inner.lock().cache.len();
    if cached > 0 {
        slog(&format!("[tokenlab] warm cache ready: {cached} events (scan + import)"));
    }

    // Bundled rates changed since the cache was last priced? Reprice once so
    // agents without a real router cost do not keep an estimatedCost computed
    // from an older rate table. Real router-reported costs are preserved by
    // `reprice_events` itself.
    let stored = get_config_sync().scan_cache_rates_version.unwrap_or(0.0);
    if stored != RATES_VERSION {
        let sum_cost = |state: &Arc<AppState>| -> f64 {
            state.inner.lock().cache.iter().fold(0.0, |sum, e| sum + e.estimated_cost.unwrap_or(0.0))
        };
        let before = sum_cost(&state);
        state.reprice_cache(true).await;
        let after = sum_cost(&state);
        let n = state.inner.lock().cache.len();
        slog(&format!(
            "[tokenlab] rates v{} -> v{}: repriced {n} events (${} -> ${})",
            js_num_to_string(stored),
            js_num_to_string(RATES_VERSION),
            js_to_fixed(before, 2),
            js_to_fixed(after, 2)
        ));
        state.schedule_save_scan_cache(true);
        if let Err(err) = set_scan_cache_rates_version(RATES_VERSION).await {
            swarn(&format!("[tokenlab] rates reprice skipped: {err}"));
        }
    }

    // Bind immediately (retry while the port is busy).
    let listener = match listen_with_retry(&host, port, 40, 150).await {
        Ok(l) => l,
        Err(msg) => {
            state.stop_background();
            return Err(anyhow::anyhow!(msg));
        }
    };
    let bound_port = listener.local_addr().map(|a| a.port()).unwrap_or(port as u16);

    let app = axum::Router::new().fallback(fallback_handler).with_state(state.clone());
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let served = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                // A dropped handle must not stop the server: only an explicit close does.
                if stop_rx.await.is_err() {
                    std::future::pending::<()>().await;
                }
            })
            .await;
        if let Err(err) = served {
            swarn(&format!("[tokenlab] server stopped: {err}"));
        }
    });

    // Warm OpenRouter model catalog (disk then network) so the Model page is
    // never empty.
    state.handle.spawn(async move {
        let _ = load_open_router_cache_from_disk().await;
        match fetch_open_router_models(false).await {
            Ok(list) => slog(&format!("[tokenlab] OpenRouter models ready: {}", list.len())),
            Err(err) => swarn(&format!("[tokenlab] OpenRouter models fetch failed: {err}")),
        }
    });

    // Boot: serve the warm cache first. A full local scan can take minutes on a
    // machine with large Codex/Claude/Grok histories, so do not compete with the
    // first dashboard paint when a valid scan cache already exists.
    state.restore_ubuntu_additional_roots().await;
    {
        let this = state.clone();
        state.handle.spawn(async move {
            let _ = futures::join!(
                this.sync_vps_mirrors("boot", MIRROR_SYNC_TIMEOUT_MS),
                this.sync_ubuntu_usage("boot")
            );
            if this.inner.lock().cache.is_empty() {
                if let Err(err) = this.rescan(true).await {
                    swarn(&format!("[tokenlab] initial full scan failed: {err}"));
                }
                return;
            }
            // Give the browser a short quiet window to render the warm snapshot,
            // then refresh only hot remote mirrors. Manual Refresh remains the
            // explicit full historical scan for local agents.
            let light = this.clone();
            this.handle.spawn(async move {
                tokio::time::sleep(Duration::from_millis(2_500)).await;
                if !scan_periodic_enabled() {
                    return;
                }
                if let Err(err) = light.rescan(false).await {
                    swarn(&format!("[tokenlab] initial light scan failed: {err}"));
                }
            });
            slog("[tokenlab] warm cache served; deferred full local scan (use Refresh for a full scan)");
        });
    }
    {
        let this = state.clone();
        state.handle.spawn(async move {
            let _ = this.sync_phanmemvip_usage_mirror("boot").await;
        });
    }

    // 60s tick (each tick's work runs on its own task, like the un-awaited async
    // closure in the TS `setInterval`).
    let tick_state = state.clone();
    let tick = state.handle.spawn(async move {
        let mut interval =
            tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(60), Duration::from_secs(60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let s = tick_state.clone();
            tick_state.handle.spawn(async move {
                if let Err(err) = s.periodic_tick().await {
                    swarn(&format!("[tokenlab] periodic sync/scan failed: {err}"));
                }
            });
        }
    });

    // After the first full scan settles, try the daily Gist (non-blocking), then
    // hourly to catch midnight rollover without busy work.
    let boot_state = state.clone();
    let auto_boot = state.handle.spawn(async move {
        tokio::time::sleep(Duration::from_secs(90)).await;
        boot_state.schedule_auto_gist("boot");
    });
    let hourly_state = state.clone();
    let auto_hourly = state.handle.spawn(async move {
        let mut interval = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(3_600),
            Duration::from_secs(3_600),
        );
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            hourly_state.schedule_auto_gist("hourly");
        }
    });
    state.inner.lock().tasks.extend([tick, auto_boot, auto_hourly]);

    Ok(ServerHandle { host, port: bound_port, state, stop_tx: Some(stop_tx), server_task: Some(server_task) })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_parses_and_decodes() {
        let q = Query::parse(Some("a=1&b=hello%20world&c=&d=x+y"));
        assert_eq!(q.get("a"), Some("1"));
        assert_eq!(q.get("b"), Some("hello world"));
        assert_eq!(q.get("c"), Some(""));
        assert_eq!(q.get_nonempty("c"), None);
        assert_eq!(q.get("missing"), None);
        assert_eq!(Query::parse(None).get("a"), None);
    }

    #[test]
    fn jn_matches_json_stringify() {
        assert_eq!(jn(3.0), json!(3));
        assert_eq!(jn(0.5), json!(0.5));
        assert_eq!(jn(f64::NAN), Value::Null);
        assert_eq!(jn(f64::INFINITY), Value::Null);
        assert_eq!(jn(-0.0), json!(0));
    }

    #[test]
    fn js_min_max_propagate_nan() {
        assert!(js_min(1.0, f64::NAN).is_nan());
        assert!(js_max(f64::NAN, 1.0).is_nan());
        assert_eq!(js_min(1.0, 2.0), 1.0);
        assert_eq!(js_max(1.0, 2.0), 2.0);
    }

    #[test]
    fn slice_bounds_follow_array_slice() {
        assert_eq!(js_slice_bounds(10, 0.0, Some(3.0)), (0, 3));
        assert_eq!(js_slice_bounds(10, -3.0, None), (7, 10));
        assert_eq!(js_slice_bounds(10, 5.0, Some(2.0)), (5, 5));
        assert_eq!(js_slice_bounds(10, f64::NAN, Some(100.0)), (0, 10));
    }

    #[test]
    fn decode_uri_component_handles_escapes() {
        assert_eq!(decode_uri_component("a%20b").unwrap(), "a b");
        assert_eq!(decode_uri_component("caf%C3%A9").unwrap(), "caf\u{e9}");
        assert!(decode_uri_component("bad%2").is_err());
        assert!(decode_uri_component("bad%zz").is_err());
        assert!(decode_uri_component("%FF").is_err());
    }

    #[test]
    fn content_types() {
        assert_eq!(content_type_for("a.SVG"), "image/svg+xml; charset=utf-8");
        assert_eq!(content_type_for("a.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type_for("a.css"), "text/css; charset=utf-8");
        assert_eq!(content_type_for("a.bin"), "application/octet-stream");
    }

    #[test]
    fn desc_cmp_sorts_descending_without_panicking() {
        let mut v = vec![1.0, f64::NAN, 3.0, 2.0];
        v.sort_by(|a, b| desc_cmp(*a, *b));
        assert_eq!(v.len(), 4);
        let mut w = vec![1.0, 3.0, 2.0];
        w.sort_by(|a, b| desc_cmp(*a, *b));
        assert_eq!(w, vec![3.0, 2.0, 1.0]);
    }

    #[test]
    fn truthiness_matches_js() {
        assert!(!js_truthy(&json!(null)));
        assert!(!js_truthy(&json!(0)));
        assert!(!js_truthy(&json!("")));
        assert!(!js_truthy(&json!(false)));
        assert!(js_truthy(&json!({})));
        assert!(js_truthy(&json!([])));
        assert!(js_truthy(&json!("x")));
        assert_eq!(js_or_num(&[0.0, f64::NAN, 5.0, 0.0]), 5.0);
        assert_eq!(js_or_num(&[0.0, 0.0]), 0.0);
    }

    #[test]
    fn parse_rate_entries_normalizes_keys_and_filters() {
        let body = json!({
            "  Foo-Model  ": { "inputPer1M": 1, "outputPer1M": "2", "cacheReadPer1M": 0.5 },
            "bad": { "inputPer1M": "x", "outputPer1M": 1 },
            "skip": 5,
            "": { "inputPer1M": 1, "outputPer1M": 1 },
        });
        let rates = parse_rate_entries(&body);
        assert_eq!(rates.len(), 1);
        let (_, r) = rates.iter().next().unwrap();
        assert_eq!(r.input_per_1m, 1.0);
        assert_eq!(r.output_per_1m, 2.0);
        assert_eq!(r.cache_read_per_1m, Some(0.5));
        assert_eq!(r.cache_write_per_1m, None);
        assert!(parse_rate_entries(&json!(null)).is_empty());
    }

    #[test]
    fn rate_limit_merge_keeps_prev_when_body_missing() {
        let prev = json!({ "windows": "1/1s", "models": "*", "flag": { "spanHours": 20 } });
        assert_eq!(next_rate_limit(Some(&prev), None), Some(prev.clone()));
        assert_eq!(next_rate_limit(Some(&prev), Some(&json!("nope"))), Some(prev.clone()));
        let body = json!({ "windows": "2/1s", "flag": { "activeHours": 5, "spanHours": "bad" } });
        let next = next_rate_limit(Some(&prev), Some(&body)).unwrap();
        assert_eq!(next["windows"], json!("2/1s"));
        assert_eq!(next["models"], json!("*"));
        assert_eq!(next["flag"]["activeHours"], json!(5));
        assert_eq!(next["flag"]["spanHours"], json!(20));
    }

    #[test]
    fn json_obj_or_empty_only_accepts_objects() {
        assert!(json_obj_or_empty(Some(&json!([1]))).is_empty());
        assert_eq!(json_obj_or_empty(Some(&json!({"a": 1}))).len(), 1);
        assert!(json_obj_or_empty(None).is_empty());
    }

    #[tokio::test]
    async fn listen_with_retry_rejects_bad_ports() {
        let err = listen_with_retry("127.0.0.1", 70000.0, 1, 1).await.unwrap_err();
        assert!(err.starts_with("Cannot bind 127.0.0.1:70000"));
        assert!(err.contains("options.port should be >= 0 and < 65536"));
    }

    #[tokio::test]
    async fn listen_with_retry_binds_an_ephemeral_port() {
        let l = listen_with_retry("127.0.0.1", 0.0, 1, 1).await.unwrap();
        assert!(l.local_addr().unwrap().port() > 0);
    }
}
