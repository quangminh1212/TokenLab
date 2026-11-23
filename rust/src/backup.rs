//! Port of `src/backup.ts`.
//!
//! Gist multi-machine backup / restore, the persisted scan cache (with `.bak`
//! rotation + archive), the high-water monotonic merge of daily events, router
//! daily collapse, legacy `xlab-token` migration and mirror export / restore
//! with path-traversal protection.
//!
//! Behaviour (JSON names, numbers, rounding, file formats and on-disk
//! locations) mirrors the TypeScript implementation exactly so backup files
//! are byte-compatible in both directions.

#![allow(clippy::too_many_arguments)]
#![allow(clippy::type_complexity)]

use crate::config::{
    get_config_sync, load_config, save_config, PricingConfig, XlabTokenConfig,
};
use crate::openrouter_models::{
    get_open_router_fetched_at, get_open_router_models_sync, openrouter_cache_path,
    replace_open_router_cache, OpenRouterModelEntry,
};
use crate::types::{jsnum, AgentId, GroupBy, PricingStatus, TokenTotals, UsageEvent};
use crate::util::{
    app_data_dir, env_nonempty, filter_by_period, js_date_parse, js_num_to_string, js_number_from_str,
    js_round, js_to_fixed, js_trim, normalize_agent_id, normalize_model_name, now_ms, path_exists,
    path_flavor, pjoin, sort_events_by_time, stable_id, start_of_day_in_time_zone, to_iso_string,
};
use crate::version::VERSION;
use indexmap::{IndexMap, IndexSet};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::io::Write as _;

// ---------------------------------------------------------------------------
// Logging: %LOCALAPPDATA%\tokenlab\backup.txt
// ---------------------------------------------------------------------------

fn log_dir() -> String {
    let base = env_nonempty("LOCALAPPDATA")
        .or_else(|| env_nonempty("APPDATA"))
        .unwrap_or_else(crate::util::cwd_string);
    pjoin(&[base.as_str(), "tokenlab"])
}

fn log(msg: &str) {
    let message = format!("[{}] {}", to_iso_string(now_ms()).unwrap_or_default(), msg);
    let dir = log_dir();
    let file = pjoin(&[dir.as_str(), "backup.txt"]);
    let _ = (|| -> std::io::Result<()> {
        if !std::path::Path::new(&dir).exists() {
            std::fs::create_dir_all(&dir)?;
        }
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&file)?;
        f.write_all(format!("{}\r\n", message).as_bytes())?;
        Ok(())
    })();
}

fn log_error(msg: &str) {
    log(&format!("[ERROR] {}", msg));
}

pub const BACKUP_FORMAT: &str = "tokenlab";
/// Legacy format names accepted on import for backward compatibility.
const BACKUP_FORMAT_LEGACY: &str = "tokenlab-backup";
const BACKUP_FORMAT_LEGACY_XLAB: &str = "xlab-token-backup";
/// v1 = settings only, v2 = full events, v3 = period stats (by model + agent)
pub const BACKUP_FORMAT_VERSION: u32 = 3;

const LOCAL_MACHINE_SCOPE: &str = "local";
const FOREIGN_IMPORTED_SCOPE: &str = "foreign-import";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// `BackupScope` = "settings" | "full" | "period-stats"
pub type BackupScope = &'static str;
pub const SCOPE_SETTINGS: &str = "settings";
pub const SCOPE_FULL: &str = "full";
pub const SCOPE_PERIOD_STATS: &str = "period-stats";

/// Dashboard periods mirrored into Gist backups.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GistPeriodKey {
    Today,
    H24,
    D7,
    D30,
    All,
}

impl GistPeriodKey {
    pub fn as_str(&self) -> &'static str {
        match self {
            GistPeriodKey::Today => "today",
            GistPeriodKey::H24 => "24h",
            GistPeriodKey::D7 => "7d",
            GistPeriodKey::D30 => "30d",
            GistPeriodKey::All => "all",
        }
    }
}

impl Serialize for GistPeriodKey {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for GistPeriodKey {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Ok(match s.as_str() {
            "today" => GistPeriodKey::Today,
            "24h" => GistPeriodKey::H24,
            "7d" => GistPeriodKey::D7,
            "30d" => GistPeriodKey::D30,
            _ => GistPeriodKey::All,
        })
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompactTokenRow {
    #[serde(default, with = "jsnum")]
    pub input_tokens: f64,
    #[serde(default, with = "jsnum")]
    pub output_tokens: f64,
    #[serde(default, with = "jsnum")]
    pub cache_read_tokens: f64,
    #[serde(default, with = "jsnum")]
    pub cache_write_tokens: f64,
    #[serde(default, with = "jsnum")]
    pub total_tokens: f64,
    #[serde(default, with = "jsnum")]
    pub estimated_cost: f64,
    #[serde(default, with = "jsnum")]
    pub event_count: f64,
}

/// `PeriodGroupRow extends CompactTokenRow { key }` (key first, as in TS
/// `{ key, ...toCompactRow(totals) }`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PeriodGroupRow {
    pub key: String,
    #[serde(flatten)]
    pub row: CompactTokenRow,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PeriodSnapshot {
    pub period: GistPeriodKey,
    #[serde(default)]
    pub since: Option<String>,
    pub totals: CompactTokenRow,
    #[serde(default)]
    pub by_model: Vec<PeriodGroupRow>,
    #[serde(default)]
    pub by_agent: Vec<PeriodGroupRow>,
}

/// Gist destination metadata only (no token).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortableBackupBlock {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gist_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gist_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_backup_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_daily: Option<bool>,
}

/// Portable project settings embedded in every backup file. Never includes the
/// GitHub PAT.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortableBackupConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing: Option<PricingConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub port: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup: Option<PortableBackupBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupOpenrouter {
    #[serde(default, with = "jsnum")]
    pub fetched_at: f64,
    /// Kept as raw JSON so a restore round-trips the catalog byte-for-byte.
    #[serde(default)]
    pub models: Vec<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub event_count: Option<f64>,
    /// Hostname(s) contributing to this Gist (multi-machine sync).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machines: Option<Vec<String>>,
    /// Original raw events before period aggregation (Gist v3).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub source_event_count: Option<f64>,
    /// Daily agent x model rollup rows in `events` (Gist v3).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub rollup_event_count: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub model_count: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub agent_count: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub openrouter_model_count: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub mirror_file_count: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub mirror_bytes: Option<f64>,
}

/// Single on-disk / Gist file format for all backup features.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct XlabBackup {
    pub format: String,
    #[serde(default, with = "jsnum")]
    pub format_version: f64,
    #[serde(default)]
    pub app_version: String,
    #[serde(default)]
    pub exported_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    pub scope: String,
    /// Project settings (timezone, pricing, host/port, gist id/url).
    #[serde(default)]
    pub config: PortableBackupConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<BackupMeta>,
    /// Usage by model & agent for Today / 24h / 7D / 30D / All (insertion
    /// ordered; keys are the period names).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period_stats: Option<IndexMap<String, PeriodSnapshot>>,
    /// Compact hour/day rollups for full and period-stats backups.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<UsageEvent>>,
    /// Cached OpenRouter model catalog (full scope).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openrouter: Option<BackupOpenrouter>,
    /// Mirror files under the data dir `mirrors/` (full scope); keys are
    /// relative paths like `9router/usage-daily.json`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mirrors: Option<IndexMap<String, String>>,
}

// ---------------------------------------------------------------------------
// Small JS-semantics helpers
// ---------------------------------------------------------------------------

/// `s.slice(0, n)` on UTF-16 code units, approximated on chars (ASCII data).
fn slice_prefix(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// `s.slice(start)` on chars.
#[allow(dead_code)]
fn slice_from(s: &str, start: usize) -> String {
    s.chars().skip(start).collect()
}

/// `Number(x) || 0` for an `f64` that may be NaN.
fn n0(x: f64) -> f64 {
    if x.is_nan() {
        0.0
    } else {
        x
    }
}

/// `Number(e.estimatedCost) || 0`
fn cost_of(e: &UsageEvent) -> f64 {
    n0(e.estimated_cost.unwrap_or(0.0))
}

fn is_est(e: &UsageEvent) -> bool {
    e.estimated == Some(true)
}

fn norm_path(sp: &str) -> String {
    sp.replace('\\', "/").to_lowercase()
}

/// `typeof rc === "number" && rc > 0 ? Math.floor(rc) : 1`
fn req_floor_or_1(e: &UsageEvent) -> f64 {
    match e.request_count {
        Some(rc) if rc > 0.0 => rc.floor(),
        _ => 1.0,
    }
}

/// `(typeof e.model === "string" && e.model.trim()) || fallback`
fn model_or(e: &UsageEvent, fallback: &str) -> String {
    match &e.model {
        Some(m) => {
            let t = js_trim(m);
            if t.is_empty() {
                fallback.to_string()
            } else {
                t.to_string()
            }
        }
        None => fallback.to_string(),
    }
}

/// `(typeof e.workspace === "string" && e.workspace.trim()) || ""`
fn ws_trimmed(e: &UsageEvent) -> String {
    match &e.workspace {
        Some(w) => js_trim(w).to_string(),
        None => String::new(),
    }
}

/// `String(v)` for a JSON value (JS coercion).
fn js_string_of(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_num_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|x| match x {
                Value::Null => String::new(),
                other => js_string_of(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// JS truthiness of a JSON value.
fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            f != 0.0 && !f.is_nan()
        }
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `Number(v)` for a JSON value (`None` = undefined).
fn js_number_of(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js_number_from_str(s),
        Some(Value::Array(a)) => match a.len() {
            0 => 0.0,
            1 => js_number_of(a.first()),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// Set or remove (JS `undefined`) a key, preserving insertion order.
fn set_or_remove(map: &mut Map<String, Value>, key: &str, val: Option<Value>) {
    match val {
        Some(v) => {
            map.insert(key.to_string(), v);
        }
        None => {
            map.shift_remove(key);
        }
    }
}

fn err_msg<E: std::fmt::Display>(e: &E) -> String {
    e.to_string()
}

// ---------------------------------------------------------------------------
// Portable config + data paths
// ---------------------------------------------------------------------------

/// Snapshot of current project settings for any backup file (never the PAT).
pub fn build_portable_config() -> PortableBackupConfig {
    let cfg = get_config_sync();
    let pricing = cfg.pricing.clone().unwrap_or_default();
    let currency = match pricing.currency.as_deref() {
        Some(c) if !c.is_empty() => c.to_string(),
        _ => "USD".to_string(),
    };
    let mut out = PortableBackupConfig {
        timezone: Some(match cfg.timezone.as_deref() {
            Some(t) if !t.is_empty() => t.to_string(),
            _ => "local".to_string(),
        }),
        pricing: Some(PricingConfig {
            currency: Some(currency),
            prefer_router_cost: Some(pricing.prefer_router_cost != Some(false)),
            custom_rates: pricing.custom_rates.clone(),
            extra: Map::new(),
        }),
        host: None,
        port: None,
        backup: None,
    };
    if let Some(h) = cfg.host.as_deref() {
        if !h.is_empty() {
            out.host = Some(h.to_string());
        }
    }
    if let Some(p) = cfg.port {
        if p.is_finite() {
            out.port = Some(p);
        }
    }
    if let Some(b) = cfg.backup.as_ref() {
        let has_id = b.gist_id.as_deref().map_or(false, |s| !s.is_empty());
        let has_url = b.gist_url.as_deref().map_or(false, |s| !s.is_empty());
        let has_last = b.last_backup_at.as_deref().map_or(false, |s| !s.is_empty());
        if has_id || has_url || has_last || b.auto_daily.is_some() {
            out.backup = Some(PortableBackupBlock {
                gist_id: if has_id { b.gist_id.clone() } else { None },
                gist_url: if has_url { b.gist_url.clone() } else { None },
                last_backup_at: if has_last { b.last_backup_at.clone() } else { None },
                auto_daily: b.auto_daily.map(|a| a != false),
            });
        }
    }
    out
}

pub fn data_root() -> String {
    // Backward compat: pre-rename env var still wins.
    if let Some(d) = env_nonempty("TOKENLAB_DATA_DIR") {
        return d;
    }
    if let Some(d) = env_nonempty("XLAB_TOKEN_DATA_DIR") {
        return d;
    }
    pjoin(&[app_data_dir().as_str(), "tokenlab"])
}

/// Return the provenance scope used by cache reconciliation.
fn usage_machine_scope(e: &UsageEvent) -> String {
    if let Some(ms) = &e.machine_scope {
        let t = js_trim(ms);
        if !t.is_empty() {
            return t.to_string();
        }
    }
    if is_gist_rollup_event(e) {
        let machine_id = machine_id_from_event(e);
        if !machine_id.is_empty() {
            return format!("machine:{}", machine_id);
        }
    }
    LOCAL_MACHINE_SCOPE.to_string()
}

/// Mark events loaded from imported/restore storage as foreign-machine usage.
pub fn mark_imported_events(events: &[UsageEvent]) -> Vec<UsageEvent> {
    events
        .iter()
        .map(|e| {
            let machine_id = machine_id_from_event(e);
            let existing = e
                .machine_scope
                .as_deref()
                .map(|s| js_trim(s).to_string())
                .unwrap_or_default();
            let scope = if !existing.is_empty() && existing != LOCAL_MACHINE_SCOPE {
                existing
            } else if !machine_id.is_empty() {
                format!("machine:{}", machine_id)
            } else {
                FOREIGN_IMPORTED_SCOPE.to_string()
            };
            if e.machine_scope.as_deref() == Some(scope.as_str()) {
                e.clone()
            } else {
                let mut c = e.clone();
                c.machine_scope = Some(scope);
                c
            }
        })
        .collect()
}

/// Legacy data root before the XLab Token -> TokenLab rename. `""` when an env
/// override is set.
pub fn legacy_data_root() -> String {
    if env_nonempty("TOKENLAB_DATA_DIR").is_some() || env_nonempty("XLAB_TOKEN_DATA_DIR").is_some() {
        return String::new();
    }
    pjoin(&[app_data_dir().as_str(), "xlab-token"])
}

pub fn mirrors_root() -> String {
    pjoin(&[data_root().as_str(), "mirrors"])
}

/// Persisted events from other machines / restores.
pub fn imported_events_path() -> String {
    pjoin(&[data_root().as_str(), "imported-events.json"])
}

pub fn legacy_imported_events_path() -> String {
    pjoin(&[legacy_data_root().as_str(), "imported-events.json"])
}

pub fn legacy_scan_cache_path() -> String {
    pjoin(&[legacy_data_root().as_str(), "scan-cache.json"])
}

pub fn legacy_mirrors_root() -> String {
    pjoin(&[legacy_data_root().as_str(), "mirrors"])
}

pub fn scan_cache_path() -> String {
    pjoin(&[data_root().as_str(), "scan-cache.json"])
}

pub fn scan_cache_backup_path() -> String {
    format!("{}.bak", scan_cache_path())
}

pub fn scan_cache_archive_path() -> String {
    pjoin(&[data_root().as_str(), "scan-cache.archive.json"])
}

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

/// One-time migration from the pre-rename `xlab-token` data dir to `tokenlab`.
/// Idempotent: only copies files that are missing or smaller in the new dir.
pub async fn migrate_legacy_data_dir() {
    let legacy = legacy_data_root();
    let target = data_root();
    if legacy.is_empty() || target.is_empty() {
        return;
    }
    let pf = path_flavor();
    if pf.resolve(&[legacy.as_str()]) == pf.resolve(&[target.as_str()]) {
        return; // env override points at legacy
    }
    if !path_exists(&legacy).await {
        return;
    }

    let _ = tokio::fs::create_dir_all(&target).await;

    // Sentinel so we only run the heavy copy once per machine.
    let sentinel = pjoin(&[target.as_str(), ".migrated-from-xlab-token"]);
    if !path_exists(&sentinel).await {
        // Copy mirrors/ (VPS data) - only files missing in target.
        let r: std::io::Result<()> = async {
            if path_exists(&legacy_mirrors_root()).await {
                copy_dir_missing(&legacy_mirrors_root(), &mirrors_root()).await?;
            }
            Ok(())
        }
        .await;
        if let Err(e) = r {
            log_error(&format!("migrateLegacyDataDir: mirrors copy failed: {}", err_msg(&e)));
        }
        let _ = tokio::fs::write(&sentinel, to_iso_string(now_ms()).unwrap_or_default()).await;
    }

    // Per-file fallbacks - always run so a partial earlier migration heals.
    let legacy_root = legacy_data_root();
    let pairs: Vec<(&str, String, String)> = vec![
        ("imported-events.json", legacy_imported_events_path(), imported_events_path()),
        ("scan-cache.json", legacy_scan_cache_path(), scan_cache_path()),
        (
            "scan-cache.json.bak",
            format!("{}.bak", legacy_scan_cache_path()),
            format!("{}.bak", scan_cache_path()),
        ),
        (
            "scan-cache.archive.json",
            pjoin(&[legacy_root.as_str(), "scan-cache.archive.json"]),
            scan_cache_archive_path(),
        ),
    ];
    for (rel, lp, tp) in pairs {
        let r: std::io::Result<()> = async {
            if !path_exists(&lp).await {
                return Ok(());
            }
            let legacy_size = tokio::fs::metadata(&lp).await?.len();
            let mut target_size = 0u64;
            if path_exists(&tp).await {
                target_size = tokio::fs::metadata(&tp).await?.len();
            }
            // Never overwrite a richer current cache with an older smaller one.
            if target_size > 0 && target_size >= legacy_size {
                return Ok(());
            }
            let dir = pf.dirname(&tp);
            tokio::fs::create_dir_all(&dir).await?;
            tokio::fs::copy(&lp, &tp).await?;
            log(&format!(
                "migrateLegacyDataDir: copied {} ({} bytes) \u{2192} {}",
                rel, legacy_size, tp
            ));
            Ok(())
        }
        .await;
        if let Err(e) = r {
            log_error(&format!("migrateLegacyDataDir: copy {} failed: {}", rel, err_msg(&e)));
        }
    }

    // Merge legacy config.json into the new one - fill missing keys only.
    let r: Result<(), String> = async {
        let legacy_config_path = pjoin(&[legacy_data_root().as_str(), "config.json"]);
        if !path_exists(&legacy_config_path).await {
            return Ok(());
        }
        let text = tokio::fs::read_to_string(&legacy_config_path)
            .await
            .map_err(|e| err_msg(&e))?;
        let legacy_cfg: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| err_msg(&e))?;
        let legacy_obj = match &legacy_cfg {
            Value::Object(m) => m.clone(),
            // `{ ...null, ...cur }` style spreads tolerate non-objects; mirror that.
            _ => Map::new(),
        };
        let cur = load_config().await;
        let cur_val = serde_json::to_value(&cur).map_err(|e| err_msg(&e))?;
        let cur_obj = match &cur_val {
            Value::Object(m) => m.clone(),
            _ => Map::new(),
        };
        let mut merged: Map<String, Value> = legacy_obj.clone();
        for (k, v) in &cur_obj {
            merged.insert(k.clone(), v.clone());
        }
        // Deep-merge customRates (legacy rates fill gaps; current wins).
        let legacy_rates = legacy_obj
            .get("pricing")
            .and_then(|p| p.get("customRates"))
            .and_then(|r| r.as_object())
            .cloned();
        let cur_rates: Map<String, Value> = cur_obj
            .get("pricing")
            .and_then(|p| p.get("customRates"))
            .and_then(|r| r.as_object())
            .cloned()
            .unwrap_or_default();
        if let Some(lr) = legacy_rates {
            let mut pricing: Map<String, Value> = match cur_obj.get("pricing") {
                Some(Value::Object(m)) if js_truthy(&Value::Object(m.clone())) => m.clone(),
                _ => {
                    let mut m = Map::new();
                    m.insert("currency".into(), Value::String("USD".into()));
                    m
                }
            };
            let mut rates = lr;
            for (k, v) in cur_rates {
                rates.insert(k, v);
            }
            pricing.insert("customRates".into(), Value::Object(rates));
            merged.insert("pricing".into(), Value::Object(pricing));
        }
        // Gist link: current always wins when set.
        if let Some(Value::Object(lb)) = legacy_obj.get("backup") {
            let cb: Map<String, Value> = match cur_obj.get("backup") {
                Some(Value::Object(m)) => m.clone(),
                _ => Map::new(),
            };
            let str_of = |m: &Map<String, Value>, k: &str| -> String {
                match m.get(k) {
                    Some(v) if js_truthy(v) => js_trim(&js_string_of(v)).to_string(),
                    _ => String::new(),
                }
            };
            let raw_of = |m: &Map<String, Value>, k: &str| -> String {
                match m.get(k) {
                    Some(v) if js_truthy(v) => js_string_of(v),
                    _ => String::new(),
                }
            };
            let cur_id = str_of(&cb, "gistId");
            let leg_id = str_of(lb, "gistId");
            let cur_url = str_of(&cb, "gistUrl");
            let leg_url = str_of(lb, "gistUrl");
            let cur_last = raw_of(&cb, "lastBackupAt");
            let leg_last = raw_of(lb, "lastBackupAt");
            let newer_last: Option<String> = if !cur_last.is_empty() && !leg_last.is_empty() {
                if js_date_parse(&cur_last) >= js_date_parse(&leg_last) {
                    Some(cur_last.clone())
                } else {
                    Some(leg_last.clone())
                }
            } else if !cur_last.is_empty() {
                Some(cur_last.clone())
            } else if !leg_last.is_empty() {
                Some(leg_last.clone())
            } else {
                None
            };
            let mut nb: Map<String, Value> = lb.clone();
            for (k, v) in &cb {
                nb.insert(k.clone(), v.clone());
            }
            // githubToken: cb.githubToken || lb.githubToken
            let token = match cb.get("githubToken") {
                Some(v) if js_truthy(v) => Some(v.clone()),
                _ => lb.get("githubToken").cloned(),
            };
            set_or_remove(&mut nb, "githubToken", token);
            let gist_id = if !cur_id.is_empty() {
                Some(cur_id.clone())
            } else if !leg_id.is_empty() {
                Some(leg_id.clone())
            } else {
                None
            };
            set_or_remove(&mut nb, "gistId", gist_id.map(Value::String));
            let gist_url = {
                let first = if !cur_id.is_empty() { cur_url.clone() } else { String::new() };
                if !first.is_empty() {
                    Some(first)
                } else if !cur_url.is_empty() {
                    Some(cur_url.clone())
                } else if !leg_url.is_empty() {
                    Some(leg_url.clone())
                } else {
                    None
                }
            };
            set_or_remove(&mut nb, "gistUrl", gist_url.map(Value::String));
            set_or_remove(&mut nb, "lastBackupAt", newer_last.map(Value::String));
            let auto_daily = match cb.get("autoDaily") {
                Some(v) => Some(v.clone()),
                None => lb.get("autoDaily").cloned(),
            };
            set_or_remove(&mut nb, "autoDaily", auto_daily);
            merged.insert("backup".into(), Value::Object(nb));
        }
        let merged_cfg: XlabTokenConfig =
            serde_json::from_value(Value::Object(merged.clone())).map_err(|e| err_msg(&e))?;
        save_config(&merged_cfg).await.map_err(|e| err_msg(&e))?;
        // Keep legacy file in sync so a future merge cannot resurrect a dead id.
        let mb = merged.get("backup").and_then(|b| b.as_object());
        let get_s = |k: &str| -> Option<String> {
            mb.and_then(|b| b.get(k)).and_then(|v| v.as_str()).map(|s| s.to_string())
        };
        sync_legacy_gist_meta(get_s("gistId"), get_s("gistUrl"), get_s("lastBackupAt")).await;
        log("migrateLegacyDataDir: merged legacy config.json into current");
        Ok(())
    }
    .await;
    if let Err(e) = r {
        log_error(&format!("migrateLegacyDataDir: config merge failed: {}", e));
    }
}

/// Write gistId/url/lastBackupAt into the legacy xlab-token config so migrate
/// cannot resurrect a dead id.
async fn sync_legacy_gist_meta(
    gist_id: Option<String>,
    gist_url: Option<String>,
    last_backup_at: Option<String>,
) {
    let r: Result<(), String> = async {
        let legacy_config_path = pjoin(&[legacy_data_root().as_str(), "config.json"]);
        if !path_exists(&legacy_config_path).await {
            return Ok(());
        }
        let text = tokio::fs::read_to_string(&legacy_config_path)
            .await
            .map_err(|e| err_msg(&e))?;
        let mut raw: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| err_msg(&e))?;
        let raw_obj = match raw.as_object_mut() {
            Some(o) => o,
            None => return Ok(()),
        };
        let prev: Map<String, Value> = match raw_obj.get("backup") {
            Some(Value::Object(m)) => m.clone(),
            _ => Map::new(),
        };
        let next_id = js_trim(gist_id.as_deref().unwrap_or("")).to_string();
        if next_id.is_empty() {
            return Ok(());
        }
        let url_nonempty = gist_url.as_deref().filter(|s| !s.is_empty());
        let last_nonempty = last_backup_at.as_deref().filter(|s| !s.is_empty());
        let same_id = prev.get("gistId").and_then(|v| v.as_str()) == Some(next_id.as_str());
        // prev.gistUrl === (meta.gistUrl || prev.gistUrl)
        let same_url = match url_nonempty {
            Some(u) => prev.get("gistUrl").and_then(|v| v.as_str()) == Some(u),
            None => true,
        };
        let same_last = match last_nonempty {
            Some(l) => prev.get("lastBackupAt").and_then(|v| v.as_str()) == Some(l),
            None => true,
        };
        if same_id && same_url && same_last {
            return Ok(());
        }
        let mut nb = prev;
        nb.insert("gistId".into(), Value::String(next_id.clone()));
        if let Some(u) = url_nonempty {
            nb.insert("gistUrl".into(), Value::String(u.to_string()));
        }
        if let Some(l) = last_nonempty {
            nb.insert("lastBackupAt".into(), Value::String(l.to_string()));
        }
        raw_obj.insert("backup".into(), Value::Object(nb));
        let out = serde_json::to_string_pretty(&raw).map_err(|e| err_msg(&e))?;
        tokio::fs::write(&legacy_config_path, out).await.map_err(|e| err_msg(&e))?;
        log(&format!("syncLegacyGistMeta: legacy config gistId \u{2192} {}", next_id));
        Ok(())
    }
    .await;
    if let Err(e) = r {
        log_error(&format!("syncLegacyGistMeta failed: {}", e));
    }
}

/// Recursively copy files from src to dest, skipping files that already exist.
fn copy_dir_missing<'a>(
    src: &'a str,
    dest: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = std::io::Result<()>> + Send + 'a>> {
    Box::pin(async move {
        if !path_exists(src).await {
            return Ok(());
        }
        tokio::fs::create_dir_all(dest).await?;
        let mut rd = tokio::fs::read_dir(src).await?;
        while let Some(ent) = rd.next_entry().await? {
            let name = ent.file_name().to_string_lossy().to_string();
            let s = pjoin(&[src, name.as_str()]);
            let d = pjoin(&[dest, name.as_str()]);
            let ft = ent.file_type().await?;
            if ft.is_dir() {
                copy_dir_missing(&s, &d).await?;
            } else if ft.is_file() {
                if path_exists(&d).await {
                    continue; // never overwrite - usage only grows
                }
                tokio::fs::copy(&s, &d).await?;
            }
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Event merge primitives
// ---------------------------------------------------------------------------

fn event_token_weight(e: &UsageEvent) -> f64 {
    if e.total_tokens.is_finite() {
        return e.total_tokens;
    }
    n0(e.input_tokens) + n0(e.output_tokens) + n0(e.cache_read_tokens) + n0(e.cache_write_tokens)
}

fn has_model_name(e: &UsageEvent) -> bool {
    matches!(&e.model, Some(m) if !js_trim(m).is_empty())
}

/// Prefer the richer of two same-id rows.
/// Order: non-estimated, more tokens, known model over null, more cache,
/// cacheReported, higher cost.
pub fn prefer_richer_event<'a>(prev: &'a UsageEvent, next: &'a UsageEvent) -> &'a UsageEvent {
    // Real (non-estimated) always wins over estimated.
    if !is_est(next) && is_est(prev) {
        return next;
    }
    if is_est(next) && !is_est(prev) {
        return prev;
    }

    let pt = event_token_weight(prev);
    let et = event_token_weight(next);
    if et > pt {
        return next;
    }
    if et < pt {
        return prev;
    }

    let prev_model = has_model_name(prev);
    let next_model = has_model_name(next);
    if next_model && !prev_model {
        return next;
    }
    if prev_model && !next_model {
        return prev;
    }

    let prev_cache = n0(prev.cache_read_tokens) + n0(prev.cache_write_tokens);
    let next_cache = n0(next.cache_read_tokens) + n0(next.cache_write_tokens);
    if next_cache > prev_cache {
        return next;
    }
    if prev_cache > next_cache {
        return prev;
    }

    let next_cr = next.cache_reported == Some(true);
    let prev_cr = prev.cache_reported == Some(true);
    if next_cr && !prev_cr {
        return next;
    }
    if prev_cr && !next_cr {
        return prev;
    }

    if cost_of(next) > cost_of(prev) {
        return next;
    }
    prev
}

fn scoped_key(e: &UsageEvent) -> String {
    format!("{}|{}", usage_machine_scope(e), e.id)
}

/// Union events by `id` (first wins for duplicates).
pub fn merge_events_by_id(lists: &[&[UsageEvent]]) -> Vec<UsageEvent> {
    let mut by_id: IndexMap<String, &UsageEvent> = IndexMap::new();
    for list in lists {
        for e in list.iter() {
            if e.id.is_empty() {
                continue;
            }
            let key = scoped_key(e);
            by_id.entry(key).or_insert(e);
        }
    }
    by_id.into_values().cloned().collect()
}

/// Union by id, keeping the richer row when the same id appears in several
/// lists. Never lets a partial re-scan shrink all-time totals.
pub fn merge_events_by_id_prefer_richer(lists: &[&[UsageEvent]]) -> Vec<UsageEvent> {
    let mut by_id: IndexMap<String, &UsageEvent> = IndexMap::new();
    for list in lists {
        for e in list.iter() {
            if e.id.is_empty() {
                continue;
            }
            let key = scoped_key(e);
            match by_id.get(&key).copied() {
                None => {
                    by_id.insert(key, e);
                }
                Some(prev) => {
                    let winner = prefer_richer_event(prev, e);
                    by_id.insert(key, winner);
                }
            }
        }
    }
    // Policy: over-count rather than miss usage; usage only grows.
    let merged: Vec<UsageEvent> = by_id.into_values().cloned().collect();
    collapse_exact_usage_duplicates(&collapse_source_path_rollups(&collapse_router_daily_events(&merged)))
}

fn normalized_source_path(source_path: &str) -> String {
    norm_path(source_path)
}

const SESSION_SOURCE_NAMES: [&str; 4] = ["summary.json", "usage.json", "updates.jsonl", "chat_history.jsonl"];

/// Remove previous local rows for source files that were freshly parsed.
pub fn drop_previous_agent_source_events(
    previous: &[UsageEvent],
    fresh: &[UsageEvent],
    agent: &str,
) -> Vec<UsageEvent> {
    let wanted = normalize_agent_id(Some(agent));
    let mut fresh_paths: HashSet<String> = HashSet::new();
    for e in fresh {
        if normalize_agent_id(Some(e.agent.as_str())) != wanted {
            continue;
        }
        let source = normalized_source_path(&e.source_path);
        if !source.is_empty() {
            fresh_paths.insert(source);
        }
    }
    if fresh_paths.is_empty() {
        return previous.to_vec();
    }
    previous
        .iter()
        .filter(|e| {
            normalize_agent_id(Some(e.agent.as_str())) != wanted
                || !fresh_paths.contains(&normalized_source_path(&e.source_path))
        })
        .cloned()
        .collect()
}

/// Fresh-source replacement followed by the normal richer-row merge.
pub fn replace_fresh_agent_source_events(
    fresh: &[UsageEvent],
    previous: &[UsageEvent],
    agent: &str,
) -> Vec<UsageEvent> {
    let kept = drop_previous_agent_source_events(previous, fresh, agent);
    merge_events_by_id_prefer_richer(&[fresh, &kept])
}

/// Drop every previous row whose (agent, source) the fresh scan re-parsed.
pub fn prune_stale_source_events(previous: &[UsageEvent], fresh: &[UsageEvent]) -> Vec<UsageEvent> {
    if fresh.is_empty() {
        return previous.to_vec();
    }
    let mut fresh_keys: HashSet<String> = HashSet::new();
    let mut fresh_ids: HashSet<&str> = HashSet::new();
    for e in fresh {
        fresh_ids.insert(e.id.as_str());
        let source = normalized_source_path(&e.source_path);
        if source.is_empty() {
            continue;
        }
        fresh_keys.insert(format!("{}|{}", normalize_agent_id(Some(e.agent.as_str())).as_str(), source));
    }
    if fresh_keys.is_empty() {
        return previous.to_vec();
    }
    previous
        .iter()
        .filter(|e| {
            if fresh_ids.contains(e.id.as_str()) {
                return true;
            }
            let source = normalized_source_path(&e.source_path);
            if source.is_empty() {
                return true;
            }
            !fresh_keys.contains(&format!(
                "{}|{}",
                normalize_agent_id(Some(e.agent.as_str())).as_str(),
                source
            ))
        })
        .cloned()
        .collect()
}

/// Remove Codex rows created by the old time/model-only LiteLLM proxy join.
pub fn drop_legacy_codex_proxy_attributions(events: &[UsageEvent]) -> Vec<UsageEvent> {
    events
        .iter()
        .filter(|e| {
            e.agent != AgentId::Codex
                || !e.workspace.as_deref().unwrap_or("").contains("via:tokenrouter")
        })
        .cloned()
        .collect()
}

fn source_session_path(source_path: &str) -> String {
    let source = normalized_source_path(source_path);
    let meta_marker = "/session-meta.json#";
    if let Some(idx) = source.rfind(meta_marker) {
        return source[idx + meta_marker.len()..].to_string();
    }
    let slash = match source.rfind('/') {
        Some(s) => s,
        None => return String::new(),
    };
    let name = &source[slash + 1..];
    if !SESSION_SOURCE_NAMES.contains(&name) {
        return String::new();
    }
    let session_path = &source[..slash];
    match session_path.rfind('/') {
        Some(ss) => session_path[ss + 1..].to_string(),
        None => session_path.to_string(),
    }
}

/// Remove previous rows from sessions that were freshly parsed for an agent.
pub fn drop_previous_agent_session_events(
    previous: &[UsageEvent],
    fresh: &[UsageEvent],
    agent: &str,
) -> Vec<UsageEvent> {
    let wanted = normalize_agent_id(Some(agent));
    let mut fresh_sessions: HashSet<String> = HashSet::new();
    for e in fresh {
        if normalize_agent_id(Some(e.agent.as_str())) != wanted || is_est(e) {
            continue;
        }
        let session = source_session_path(&e.source_path);
        if !session.is_empty() {
            fresh_sessions.insert(session);
        }
    }
    if fresh_sessions.is_empty() {
        return previous.to_vec();
    }
    previous
        .iter()
        .filter(|e| {
            normalize_agent_id(Some(e.agent.as_str())) != wanted
                || !fresh_sessions.contains(&source_session_path(&e.source_path))
        })
        .cloned()
        .collect()
}

/// Fresh-session replacement followed by the normal richer-row merge.
pub fn replace_fresh_agent_session_events(
    fresh: &[UsageEvent],
    previous: &[UsageEvent],
    agent: &str,
) -> Vec<UsageEvent> {
    let kept = drop_previous_agent_session_events(previous, fresh, agent);
    merge_events_by_id_prefer_richer(&[fresh, &kept])
}

/// Windsurf progressive rescans mint new ids for the same .pb when tokens
/// grow; keep the richest row per file. Also drops stale Grok residuals.
pub fn collapse_source_path_rollups(events: &[UsageEvent]) -> Vec<UsageEvent> {
    if events.is_empty() {
        return Vec::new();
    }
    let mut best: IndexMap<String, UsageEvent> = IndexMap::new();
    let mut out: Vec<UsageEvent> = Vec::new();

    for e in events {
        if e.source_path.is_empty() {
            out.push(e.clone());
            continue;
        }
        let sp = norm_path(&e.source_path);
        // Only Windsurf cascade files: one logical session per .pb.
        if e.agent == AgentId::Windsurf && sp.ends_with(".pb") {
            let key = format!("ws|{}|{}", usage_machine_scope(e), sp);
            let next = match best.get(&key) {
                Some(prev) => prefer_richer_event(prev, e).clone(),
                None => e.clone(),
            };
            best.insert(key, next);
            continue;
        }
        out.push(e.clone());
    }
    out.extend(best.into_values());
    drop_grok_stale_residuals(&out)
}

/// Router mirror roots are additive; every router collapse key carries this
/// scope so a second mirror is never treated as a richer replacement.
fn router_mirror_scope(event: &UsageEvent) -> String {
    let source = event.source_path.replace('\\', "/");
    if let Some(marker) = source.find("#mirror-root=") {
        return source[marker + "#mirror-root=".len()..].to_string();
    }
    let daily_prefix = "daily-rollup|";
    if let Some(rest) = source.strip_prefix(daily_prefix) {
        return if rest.is_empty() { "primary".to_string() } else { rest.to_string() };
    }
    "primary".to_string()
}

fn is_router_usage_agent_id(a: AgentId) -> bool {
    matches!(
        a,
        AgentId::NineRouter | AgentId::Xlabrouter | AgentId::Routerlab | AgentId::Litellm
    )
}

/// Migrate a pre-additive local scan cache once the parser starts returning
/// scoped mirror rows.
pub fn drop_legacy_router_mirror_rows(previous: &[UsageEvent], fresh: &[UsageEvent]) -> Vec<UsageEvent> {
    // Once one additive scan has persisted scoped rows, the migration is done.
    let already_additive = previous.iter().any(|event| {
        let agent = normalize_agent_id(Some(event.agent.as_str()));
        if !is_router_usage_agent_id(agent) {
            return false;
        }
        event.source_path.contains("#mirror-root=") || event.source_path.starts_with("daily-rollup|")
    });
    if already_additive {
        return previous.to_vec();
    }
    let mut additive_agents: HashSet<AgentId> = HashSet::new();
    for event in fresh {
        let agent = normalize_agent_id(Some(event.agent.as_str()));
        if is_router_usage_agent_id(agent) && router_mirror_scope(event) != "primary" {
            additive_agents.insert(agent);
        }
    }
    if additive_agents.is_empty() {
        return previous.to_vec();
    }
    previous
        .iter()
        .filter(|event| {
            let agent = normalize_agent_id(Some(event.agent.as_str()));
            if !additive_agents.contains(&agent) {
                return true;
            }
            usage_machine_scope(event) != LOCAL_MACHINE_SCOPE
        })
        .cloned()
        .collect()
}

#[derive(Default, Clone, Copy)]
struct HistAcc {
    n: f64,
    tok: f64,
    cost: f64,
}

/// When keeping individual request rows for RECENT EVENTS but the history
/// window is incomplete vs daily rollups, emit estimated remainder rows so day
/// totals never fall below the daily floor.
fn gap_fill_router_day_from_dailies(dailies: &[UsageEvent], requests: &[UsageEvent]) -> Vec<UsageEvent> {
    if dailies.is_empty() {
        return Vec::new();
    }

    let mut hist: HashMap<String, HistAcc> = HashMap::new();
    for e in requests {
        let model = model_or(e, "mixed");
        let ws = ws_trimmed(e);
        let key = format!("{}|{}", model, ws);
        let prev = hist.entry(key).or_default();
        prev.n += req_floor_or_1(e);
        prev.tok += event_token_weight(e);
        prev.cost += cost_of(e);
    }

    // Also aggregate history without workspace so "mixed"/empty-ws dailies match
    let mut hist_by_model: HashMap<String, HistAcc> = HashMap::new();
    for e in requests {
        let model = model_or(e, "mixed");
        let prev = hist_by_model.entry(model).or_default();
        prev.n += req_floor_or_1(e);
        prev.tok += event_token_weight(e);
        prev.cost += cost_of(e);
    }

    let mut out: Vec<UsageEvent> = Vec::new();
    for d in dailies {
        let model = model_or(d, "mixed");
        let ws = ws_trimmed(d);
        let key = format!("{}|{}", model, ws);
        let h: HistAcc = hist
            .get(&key)
            .copied()
            .or_else(|| if ws.is_empty() { hist_by_model.get(&model).copied() } else { None })
            .or_else(|| hist_by_model.get(&model).copied())
            .unwrap_or_default();

        let daily_tok = event_token_weight(d);
        let daily_cost = cost_of(d);
        let daily_req = req_floor_or_1(d);

        let rem_tok = (daily_tok - h.tok).max(0.0);
        let rem_cost = (daily_cost - h.cost).max(0.0);
        let rem_req = (daily_req - h.n).max(0.0);

        // History already covers this daily row
        if rem_tok <= 0.0 && rem_cost <= 0.0 && rem_req <= 0.0 {
            continue;
        }
        if h.tok >= daily_tok && h.n >= daily_req && daily_tok > 0.0 {
            continue;
        }

        let ratio = if daily_tok > 0.0 { rem_tok / daily_tok } else { 0.0 };
        let mut rem_in = (n0(d.input_tokens) * ratio).floor().max(0.0);
        let mut rem_out = (n0(d.output_tokens) * ratio).floor().max(0.0);
        let mut rem_cache_r = (n0(d.cache_read_tokens) * ratio).floor().max(0.0);
        let mut rem_cache_w = (n0(d.cache_write_tokens) * ratio).floor().max(0.0);
        let mut parts = rem_in + rem_out + rem_cache_r + rem_cache_w;
        if rem_tok > 0.0 && parts == 0.0 {
            rem_in = rem_tok;
            parts = rem_tok;
        } else if rem_tok > parts {
            rem_in += rem_tok - parts;
            parts = rem_tok;
        } else if parts > rem_tok && rem_tok > 0.0 {
            rem_in = rem_tok;
            rem_out = 0.0;
            rem_cache_r = 0.0;
            rem_cache_w = 0.0;
            parts = rem_tok;
        }

        if parts <= 0.0 && rem_cost <= 0.0 && rem_req <= 0.0 {
            continue;
        }

        let day = slice_prefix(&d.timestamp, 10);
        let gap_id = format!(
            "gapfill:{}:{}:{}:{}",
            d.agent.as_str(),
            day,
            model,
            if ws.is_empty() { "nows" } else { ws.as_str() }
        );
        let mut ne = d.clone();
        ne.id = gap_id;
        ne.estimated = Some(true);
        ne.input_tokens = rem_in;
        ne.output_tokens = rem_out;
        ne.cache_read_tokens = rem_cache_r;
        ne.cache_write_tokens = rem_cache_w;
        ne.total_tokens = if parts > 0.0 { parts } else { rem_tok };
        ne.estimated_cost = Some(rem_cost);
        ne.request_count = Some(if rem_req > 0.0 {
            rem_req
        } else if parts > 0.0 {
            1.0
        } else {
            0.0
        });
        ne.timestamp = d.timestamp.clone();
        ne.source_path = if d.source_path.is_empty() {
            "gapfill-daily".to_string()
        } else {
            d.source_path.clone()
        };
        out.push(ne);
    }
    out
}

/// `/^\d{4}-\d{2}-\d{2}$/`
fn is_ymd(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 {
        return false;
    }
    for (i, c) in b.iter().enumerate() {
        if i == 4 || i == 7 {
            if *c != b'-' {
                return false;
            }
        } else if !c.is_ascii_digit() {
            return false;
        }
    }
    true
}

struct DayBucket {
    dailies: Vec<UsageEvent>,
    requests: Vec<UsageEvent>,
}

/// Router days: collapse multi-version estimated rollups to the richest per
/// model, then keep max(daily totals, request totals) for that day.
pub fn collapse_router_daily_events(events: &[UsageEvent]) -> Vec<UsageEvent> {
    if events.is_empty() {
        return Vec::new();
    }

    let mut non_router: Vec<UsageEvent> = Vec::new();
    let mut by_agent_day: IndexMap<String, DayBucket> = IndexMap::new();

    for e in events {
        if !is_router_usage_agent_id(e.agent) {
            non_router.push(e.clone());
            continue;
        }
        let day = slice_prefix(&e.timestamp, 10);
        if !is_ymd(&day) {
            non_router.push(e.clone());
            continue;
        }
        let key = format!(
            "{}|{}|{}|{}",
            usage_machine_scope(e),
            e.agent.as_str(),
            router_mirror_scope(e),
            day
        );
        let bucket = by_agent_day.entry(key).or_insert_with(|| DayBucket {
            dailies: Vec::new(),
            requests: Vec::new(),
        });
        if is_est(e) {
            bucket.dailies.push(e.clone());
        } else {
            bucket.requests.push(e.clone());
        }
    }

    let mut out: Vec<UsageEvent> = non_router;
    for bucket in by_agent_day.values() {
        // Same logical daily rollup rewritten many times: keep richest per
        // day+model+workspace (see TS comments for why not by model / id).
        let mut daily_by_key: IndexMap<String, UsageEvent> = IndexMap::new();
        for e in &bucket.dailies {
            let model = model_or(e, "mixed");
            let ws = ws_trimmed(e);
            let key = if !ws.is_empty() {
                format!("{}|{}", model, ws)
            } else {
                format!("__id__|{}", e.id)
            };
            let next = match daily_by_key.get(&key) {
                Some(prev) => prefer_richer_event(prev, e).clone(),
                None => e.clone(),
            };
            daily_by_key.insert(key, next);
        }
        let dailies: Vec<UsageEvent> = daily_by_key.into_values().collect();
        let requests = &bucket.requests;

        if dailies.is_empty() {
            out.extend(requests.iter().cloned());
            continue;
        }
        // Gap-fill rows are already the exact remainder of the daily floor.
        if dailies.iter().all(|e| e.id.starts_with("gapfill:")) {
            out.extend(requests.iter().cloned());
            out.extend(dailies.iter().cloned());
            continue;
        }
        if requests.is_empty() {
            out.extend(dedupe_mixed_daily_rollups(&dailies));
            continue;
        }

        let dailies_clean = dedupe_mixed_daily_rollups(&dailies);
        let daily_tok: f64 = dailies_clean.iter().fold(0.0, |a, e| a + event_token_weight(e));
        let req_tok: f64 = requests.iter().fold(0.0, |a, e| a + event_token_weight(e));
        let daily_cost: f64 = dailies_clean.iter().fold(0.0, |a, e| a + cost_of(e));
        let req_cost: f64 = requests.iter().fold(0.0, |a, e| a + cost_of(e));
        let daily_req: f64 = dailies_clean.iter().fold(0.0, |a, e| a + req_floor_or_1(e));
        let req_req: f64 = requests.iter().fold(0.0, |a, e| a + req_floor_or_1(e));

        let daily_looks_authoritative =
            daily_req >= 10.0 || daily_tok >= 100_000.0 || (daily_cost > 0.0 && daily_tok >= 10_000.0);
        let dailies_are_residual_only = requests.len() >= 20
            && daily_tok > 0.0
            && req_tok >= (daily_tok * 2.0).max(daily_tok + 50_000.0);
        if dailies_are_residual_only {
            out.extend(requests.iter().cloned());
            out.extend(dailies_clean.iter().cloned());
            continue;
        }
        if requests.len() >= 20
            && daily_tok > 0.0
            && req_tok >= daily_tok * 0.9
            && req_tok <= daily_tok * 1.35
            && (daily_req <= 0.0
                || (req_req >= daily_req * 0.75 && req_req <= (daily_req * 1.25).max(daily_req + 10.0)))
        {
            out.extend(requests.iter().cloned());
            if req_tok < daily_tok * 0.98 {
                out.extend(gap_fill_router_day_from_dailies(&dailies_clean, requests));
            }
            continue;
        }
        let requests_overshoot_daily = daily_looks_authoritative
            && ((daily_tok > 0.0 && req_tok > daily_tok * 1.05)
                || (daily_cost > 0.0 && req_cost > daily_cost * 1.15 && req_tok >= daily_tok * 0.9));
        let request_count_inflated = daily_req > 0.0
            && daily_tok > 0.0
            && req_req > (daily_req * 1.5).max(daily_req + 5.0)
            && req_tok <= daily_tok * 1.05
            && req_tok >= daily_tok * 0.5;

        if request_count_inflated || requests_overshoot_daily {
            out.extend(dailies_clean.iter().cloned());
            continue;
        }

        // Stale/tiny daily but rich request history: keep requests.
        if !daily_looks_authoritative && req_tok > daily_tok {
            out.extend(requests.iter().cloned());
            continue;
        }

        let requests_match_daily = !requests_overshoot_daily
            && !request_count_inflated
            && daily_tok > 0.0
            && req_tok >= daily_tok * 0.95
            && req_tok <= daily_tok * 1.05
            && (daily_req <= 0.0 || req_req <= (daily_req * 1.25).max(daily_req + 3.0));

        let want_request_detail = !requests_overshoot_daily
            && !request_count_inflated
            && requests.len() >= 2
            && (requests.len() >= 20
                || req_tok >= daily_tok * 0.15
                || (daily_req > 0.0 && req_req >= daily_req * 0.15)
                || requests.len() > dailies_clean.len());

        if requests_match_daily {
            out.extend(requests.iter().cloned());
            continue;
        }

        if want_request_detail && req_tok < daily_tok * 0.98 {
            out.extend(requests.iter().cloned());
            out.extend(gap_fill_router_day_from_dailies(&dailies_clean, requests));
            continue;
        }

        // Default / overshoot: authoritative daily.
        out.extend(dailies_clean.iter().cloned());
    }
    out
}

/// When a day has both model-specific daily rollups AND a "mixed" whole-day
/// blob, keep model rows and drop mixed if they already cover >= 95% of it.
fn dedupe_mixed_daily_rollups(dailies: &[UsageEvent]) -> Vec<UsageEvent> {
    if dailies.len() < 2 {
        return dailies.to_vec();
    }
    let model_str = |e: &UsageEvent| model_or(e, "");
    let mixed: Vec<&UsageEvent> = dailies
        .iter()
        .filter(|e| {
            let m = model_str(e);
            m.is_empty() || m == "mixed" || m == "unknown"
        })
        .collect();
    let models: Vec<&UsageEvent> = dailies
        .iter()
        .filter(|e| {
            let m = model_str(e);
            !m.is_empty() && m != "mixed" && m != "unknown"
        })
        .collect();
    if mixed.is_empty() || models.is_empty() {
        return dailies.to_vec();
    }

    let model_tok: f64 = models.iter().fold(0.0, |a, e| a + event_token_weight(e));
    let model_cost: f64 = models.iter().fold(0.0, |a, e| a + cost_of(e));
    let mut kept_mixed: Vec<&UsageEvent> = Vec::new();
    for m in &mixed {
        let mt = event_token_weight(m);
        let mc = cost_of(m);
        if mt > 0.0 && model_tok >= mt * 0.95 {
            continue;
        }
        if mc > 0.0 && model_cost >= mc * 0.95 && model_tok >= mt * 0.9 {
            continue;
        }
        kept_mixed.push(m);
    }
    models.into_iter().chain(kept_mixed).cloned().collect()
}

// ---------------------------------------------------------------------------
// Grok residuals, monotonic high-water, exact-duplicate collapse
// ---------------------------------------------------------------------------

#[derive(Default)]
struct GrokPathInfo {
    has_real: bool,
    has_est_out_pos: bool,
    out_zero_est: Vec<usize>,
}

/// Grok stream residuals used unstable ids (peak in hash) -> N out=0 rows per
/// session file. Drop those ghosts when a better row exists for the path, and
/// collapse pure out=0 stacks to a single richest residual.
pub fn drop_grok_stale_residuals(events: &[UsageEvent]) -> Vec<UsageEvent> {
    if events.is_empty() {
        return Vec::new();
    }

    let mut by_path: IndexMap<String, GrokPathInfo> = IndexMap::new();
    for (idx, e) in events.iter().enumerate() {
        if e.agent != AgentId::Grok {
            continue;
        }
        if e.source_path.is_empty() {
            continue;
        }
        let sp = norm_path(&e.source_path);
        if !sp.ends_with("updates.jsonl") {
            continue;
        }
        let key = format!("{}|{}", usage_machine_scope(e), sp);
        let info = by_path.entry(key).or_default();
        if !is_est(e) {
            info.has_real = true;
        } else if n0(e.output_tokens) > 0.0 {
            info.has_est_out_pos = true;
        } else {
            info.out_zero_est.push(idx);
        }
    }

    let mut drop_keys: HashSet<String> = HashSet::new();
    for info in by_path.values() {
        if info.out_zero_est.is_empty() {
            continue;
        }
        if info.has_real || info.has_est_out_pos {
            // Better row exists for this session file - drop all out=0 residuals
            for &gi in &info.out_zero_est {
                let g = &events[gi];
                drop_keys.insert(format!("{}|{}", usage_machine_scope(g), g.id));
            }
            continue;
        }
        // Pure out=0 stack: keep single richest
        if info.out_zero_est.len() > 1 {
            let mut best = &events[info.out_zero_est[0]];
            let mut best_w = event_token_weight(best);
            for &gi in info.out_zero_est.iter().skip(1) {
                let g = &events[gi];
                let w = event_token_weight(g);
                if w > best_w {
                    best = g;
                    best_w = w;
                }
            }
            for &gi in &info.out_zero_est {
                let g = &events[gi];
                if g.id != best.id {
                    drop_keys.insert(format!("{}|{}", usage_machine_scope(g), g.id));
                }
            }
        }
    }

    if drop_keys.is_empty() {
        return events.to_vec();
    }
    events
        .iter()
        .filter(|e| !drop_keys.contains(&format!("{}|{}", usage_machine_scope(e), e.id)))
        .cloned()
        .collect()
}

fn is_router_rollup(e: &UsageEvent) -> bool {
    is_est(e) && matches!(e.agent, AgentId::Litellm | AgentId::NineRouter | AgentId::Routerlab)
}

/// Envelope weight: ignore Grok estimated out=0 stream residuals.
fn mono_token_weight(e: &UsageEvent) -> f64 {
    if e.agent == AgentId::Grok
        && is_est(e)
        && n0(e.output_tokens) == 0.0
        && norm_path(&e.source_path).ends_with("updates.jsonl")
    {
        return 0.0;
    }
    if is_router_rollup(e) {
        // The whole prompt ACCOUNT, not just its uncached part.
        return n0(e.input_tokens) + n0(e.cache_read_tokens) + n0(e.output_tokens);
    }
    event_token_weight(e)
}

/// Cost of a row's non-cache tokens, so cache inflation is not a tiebreaker.
fn billed_cost_of(e: &UsageEvent) -> f64 {
    if is_router_rollup(e) {
        return 0.0;
    }
    let total = cost_of(e);
    if total <= 0.0 {
        return 0.0;
    }
    let cache = n0(e.cache_read_tokens) + n0(e.cache_write_tokens);
    let billed = n0(e.input_tokens) + n0(e.output_tokens);
    if cache <= 0.0 || billed <= 0.0 {
        return total;
    }
    total * (billed / (billed + cache))
}

#[derive(Default)]
struct MonoBucket {
    events: Vec<UsageEvent>,
    tok: f64,
    cost: f64,
    billed_cost: f64,
    req: f64,
    live: f64,
    est_out_pos: f64,
    cache_read: f64,
    cache_reported: f64,
}

fn bucketize(list: &[UsageEvent]) -> IndexMap<String, MonoBucket> {
    let mut map: IndexMap<String, MonoBucket> = IndexMap::new();
    for e in list {
        let agent = normalize_agent_id(Some(e.agent.as_str()));
        let day = slice_prefix(&e.timestamp, 10);
        let scope = usage_machine_scope(e);
        let key = if is_ymd(&day) {
            format!("{}|{}|{}", scope, agent.as_str(), day)
        } else {
            format!("{}|{}|__noday__|{}", scope, agent.as_str(), e.id)
        };
        let b = map.entry(key).or_default();
        let mut ne = e.clone();
        ne.agent = agent;
        b.events.push(ne);
        b.tok += mono_token_weight(e);
        b.cost += cost_of(e);
        b.billed_cost += billed_cost_of(e);
        b.cache_read += n0(e.cache_read_tokens);
        if e.cache_reported == Some(true) {
            b.cache_reported += 1.0;
        }
        b.req += req_floor_or_1(e);
        if !is_est(e) {
            b.live += 1.0;
        } else if n0(e.output_tokens) > 0.0 {
            b.est_out_pos += 1.0;
        }
    }
    map
}

fn is_router_agent_ev(e: &UsageEvent) -> bool {
    matches!(
        e.agent,
        AgentId::Litellm | AgentId::NineRouter | AgentId::Routerlab | AgentId::Xlabrouter
    )
}

/// Pick the winning snapshot for one agent x day (`a` = previous, `b` = fresh).
fn better<'a>(a: &'a MonoBucket, b: &'a MonoBucket) -> &'a MonoBucket {
    let a_live = a.live;
    let b_live = b.live;
    let a_est = a.events.len() as f64 - a_live;
    let b_est = b.events.len() as f64 - b_live;

    let both_router_days = a.events.iter().any(is_router_agent_ev) && b.events.iter().any(is_router_agent_ev);
    if both_router_days {
        if a.tok > b.tok * 1.001 {
            return a;
        }
        if b.tok > a.tok * 1.001 {
            return b;
        }
    }

    if a_live != b_live {
        return if a_live > b_live { a } else { b };
    }
    if a.est_out_pos != b.est_out_pos {
        return if a.est_out_pos > b.est_out_pos { a } else { b };
    }

    if a.tok > b.tok * 1.001 {
        return a;
    }
    if b.tok > a.tok * 1.001 {
        return b;
    }
    if a.billed_cost > b.billed_cost * 1.001 {
        return a;
    }
    if b.billed_cost > a.billed_cost * 1.001 {
        return b;
    }
    let both_router_rollups = a.events.iter().all(is_router_rollup) && b.events.iter().all(is_router_rollup);
    if !both_router_rollups {
        if a.cost > b.cost * 1.001 {
            return a;
        }
        if b.cost > a.cost * 1.001 {
            return b;
        }
    }

    if a_est > 0.0 && a_live == 0.0 && b_live > 0.0 && a.req > 0.0 && b.req > a.req * 1.5 {
        return a;
    }
    if b_est > 0.0 && b_live == 0.0 && a_live > 0.0 && b.req > 0.0 && a.req > b.req * 1.5 {
        return b;
    }

    if a.cache_read != b.cache_read {
        return if a.cache_read > b.cache_read { a } else { b };
    }
    if a.cache_reported != b.cache_reported {
        return if a.cache_reported > b.cache_reported { a } else { b };
    }

    if b_live >= 20.0 && a_est > 0.0 && a_live == 0.0 && b.req >= a.req * 0.75 {
        return b;
    }
    if a_live >= 20.0 && b_est > 0.0 && b_live == 0.0 && a.req >= b.req * 0.75 {
        return a;
    }

    if !both_router_rollups {
        if a.req > b.req {
            return a;
        }
        if b.req > a.req {
            return b;
        }
    }
    if both_router_rollups {
        return b;
    }
    if a.events.len() >= b.events.len() {
        a
    } else {
        b
    }
}

/// Per agent x day high-water mark: never replace a richer previous day
/// snapshot with a thinner rescan. Usage totals can only grow across rescans.
pub fn enforce_monotonic_agent_days(prev: &[UsageEvent], next: &[UsageEvent]) -> Vec<UsageEvent> {
    if prev.is_empty() {
        return next.to_vec();
    }
    if next.is_empty() {
        return drop_grok_stale_residuals(prev);
    }

    let prev = drop_grok_stale_residuals(prev);
    let next = drop_grok_stale_residuals(next);

    let prev_map = bucketize(&prev);
    let next_map = bucketize(&next);
    let mut keys: IndexSet<&String> = IndexSet::new();
    for k in prev_map.keys() {
        keys.insert(k);
    }
    for k in next_map.keys() {
        keys.insert(k);
    }
    let mut out: Vec<UsageEvent> = Vec::new();

    for key in keys {
        let p = prev_map.get(key);
        let n = next_map.get(key);
        match (p, n) {
            (Some(p), Some(n)) => {
                let winner = better(p, n);
                let loser = if std::ptr::eq(winner, p) { n } else { p };
                // Carry cacheReported provenance onto the retained rows.
                let reported_by_id: HashSet<&str> = loser
                    .events
                    .iter()
                    .filter(|ev| ev.cache_reported == Some(true))
                    .map(|ev| ev.id.as_str())
                    .collect();
                for event in &winner.events {
                    if event.cache_reported != Some(true) && reported_by_id.contains(event.id.as_str()) {
                        let mut c = event.clone();
                        c.cache_reported = Some(true);
                        out.push(c);
                    } else {
                        out.push(event.clone());
                    }
                }
            }
            (None, Some(n)) => out.extend(n.events.iter().cloned()),
            (Some(p), None) => out.extend(p.events.iter().cloned()),
            (None, None) => {}
        }
    }
    // Final strip: whichever side won must not reintroduce Grok residual stacks
    drop_grok_stale_residuals(&out)
}

/// Remove prior local LiteLLM daily rows when a fresh scan rebuilds the same
/// mirror root and day.
pub fn drop_previous_litellm_daily_rollups(previous: &[UsageEvent], fresh: &[UsageEvent]) -> Vec<UsageEvent> {
    let coverage_key = |event: &UsageEvent| -> Option<String> {
        if normalize_agent_id(Some(event.agent.as_str())) != AgentId::Litellm {
            return None;
        }
        let source = norm_path(&event.source_path);
        let day = slice_prefix(&event.timestamp, 10);
        if source.is_empty() || !is_ymd(&day) {
            return None;
        }
        let mirror = js_trim(&router_mirror_scope(event)).to_lowercase();
        if mirror.is_empty() {
            None
        } else {
            Some(format!("{}|{}", mirror, day))
        }
    };
    let previous_daily_key = |event: &UsageEvent| -> Option<String> {
        if !is_est(event) || usage_machine_scope(event) != LOCAL_MACHINE_SCOPE {
            return None;
        }
        let source = norm_path(&event.source_path);
        if !source.starts_with("daily-rollup|") {
            return None;
        }
        coverage_key(event)
    };
    let mut fresh_days: HashSet<String> = HashSet::new();
    for event in fresh {
        if let Some(k) = coverage_key(event) {
            fresh_days.insert(k);
        }
    }
    if fresh_days.is_empty() {
        return previous.to_vec();
    }
    previous
        .iter()
        .filter(|event| match previous_daily_key(event) {
            None => true,
            Some(k) => !fresh_days.contains(&k),
        })
        .cloned()
        .collect()
}

/// Reconcile a freshly scanned cache with the persisted high-water snapshot.
pub fn reconcile_scan_cache_high_water(existing: &[UsageEvent], next: &[UsageEvent]) -> Vec<UsageEvent> {
    if existing.is_empty() {
        return next.to_vec();
    }
    let baseline = drop_legacy_router_mirror_rows(
        &drop_previous_agent_source_events(
            &drop_previous_litellm_daily_rollups(existing, next),
            next,
            "claude-code",
        ),
        next,
    );
    let merged = enforce_monotonic_agent_days(&baseline, next);
    collapse_exact_usage_duplicates(&collapse_source_path_rollups(&collapse_router_daily_events(&merged)))
}

/// Drop byte-identical clones (same agent/time/tokens/source, different id).
pub fn collapse_exact_usage_duplicates(events: &[UsageEvent]) -> Vec<UsageEvent> {
    if events.is_empty() {
        return Vec::new();
    }
    let mut best: IndexMap<String, UsageEvent> = IndexMap::new();
    for e in events {
        let key = if is_router_usage_agent_id(e.agent) {
            [
                usage_machine_scope(e),
                e.agent.as_str().to_string(),
                router_mirror_scope(e),
                slice_prefix(&e.timestamp, 19),
                e.model.clone().unwrap_or_default(),
                js_num_to_string(n0(e.input_tokens)),
                js_num_to_string(n0(e.output_tokens)),
                e.workspace.clone().unwrap_or_default(),
            ]
            .join("|")
        } else {
            [
                usage_machine_scope(e),
                e.agent.as_str().to_string(),
                e.timestamp.clone(),
                e.model.clone().unwrap_or_default(),
                js_num_to_string(n0(e.input_tokens)),
                js_num_to_string(n0(e.output_tokens)),
                js_num_to_string(n0(e.cache_read_tokens)),
                js_num_to_string(n0(e.cache_write_tokens)),
                e.source_path.clone(),
            ]
            .join("|")
        };
        let next = match best.get(&key) {
            Some(prev) => prefer_richer_event(prev, e).clone(),
            None => e.clone(),
        };
        best.insert(key, next);
    }
    best.into_values().collect()
}

// ---------------------------------------------------------------------------
// Machine id / gist rollup identification
// ---------------------------------------------------------------------------

pub fn is_gist_rollup_event(e: &UsageEvent) -> bool {
    e.source_path.starts_with("backup:gist")
}

/// `[^a-zA-Z0-9._-]+` -> "-", trim "-", max 64 chars, else "unknown".
pub fn sanitize_machine_id(raw: &str) -> String {
    let t = js_trim(raw);
    let mut s = String::with_capacity(t.len());
    let mut in_bad_run = false;
    for c in t.chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
            s.push(c);
            in_bad_run = false;
        } else if !in_bad_run {
            s.push('-');
            in_bad_run = true;
        }
    }
    let trimmed = s.trim_matches('-');
    let cut: String = trimmed.chars().take(64).collect();
    if cut.is_empty() {
        "unknown".to_string()
    } else {
        cut
    }
}

/// Stable machine id for multi-host Gist sync (hostname).
pub fn get_machine_id() -> String {
    let env_trim = |name: &str| -> String {
        std::env::var(name)
            .ok()
            .map(|s| js_trim(&s).to_string())
            .unwrap_or_default()
    };
    let mut env = env_trim("XLAB_MACHINE_ID");
    if env.is_empty() {
        env = env_trim("COMPUTERNAME");
    }
    if env.is_empty() {
        env = env_trim("HOSTNAME");
    }
    if !env.is_empty() {
        return sanitize_machine_id(&env);
    }
    match os_hostname() {
        Some(h) if !h.is_empty() => sanitize_machine_id(&h),
        Some(_) => sanitize_machine_id("unknown"),
        None => "unknown".to_string(),
    }
}

fn os_hostname() -> Option<String> {
    let out = std::process::Command::new("hostname").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Some(s)
}

/// Parse machine id from a Gist rollup.
/// `backup:gist-hour:DESKTOP-A` / `backup:gist-daily:laptop`; legacy untagged
/// rows yield "".
pub fn machine_id_from_event(e: &UsageEvent) -> String {
    let sp = e.source_path.as_str();
    if sp.starts_with("backup:gist-hour:") || sp.starts_with("backup:gist-daily:") {
        let rest = sp.splitn(3, ':').nth(2).unwrap_or("");
        let mid = js_trim(rest);
        if !mid.is_empty() {
            return sanitize_machine_id(mid);
        }
    }
    // Legacy rows stored hostname in workspace
    if is_gist_rollup_event(e) {
        if let Some(w) = &e.workspace {
            if !js_trim(w).is_empty() {
                return sanitize_machine_id(w);
            }
        }
    }
    String::new()
}

// ---------------------------------------------------------------------------
// sanitizeEvents (raw JSON -> UsageEvent) and typed variant
// ---------------------------------------------------------------------------

fn pricing_status_from(s: Option<&str>) -> PricingStatus {
    match s {
        Some("priced") => PricingStatus::Priced,
        Some("unknown_model") => PricingStatus::UnknownModel,
        Some("zero_rate") => PricingStatus::ZeroRate,
        _ => PricingStatus::Estimated,
    }
}

fn iso_now() -> String {
    to_iso_string(now_ms()).unwrap_or_default()
}

fn sanitize_event_value(item: &Value) -> Option<UsageEvent> {
    let o = item.as_object()?;
    let id = o.get("id")?.as_str()?.to_string();
    let agent_raw = o.get("agent")?.as_str()?;

    let input_tokens = n0(js_number_of(o.get("inputTokens")));
    let output_tokens = n0(js_number_of(o.get("outputTokens")));
    let cache_read_tokens = n0(js_number_of(o.get("cacheReadTokens")));
    let cache_write_tokens = n0(js_number_of(o.get("cacheWriteTokens")));
    // XLab Router -> RouterLab (canonical agent id)
    let agent = normalize_agent_id(Some(agent_raw));
    let legacy_devin_cache_reported = matches!(o.get("cacheReported"), None | Some(Value::Null))
        && agent == AgentId::Devin
        && (cache_read_tokens > 0.0 || cache_write_tokens > 0.0);
    let request_count_raw = js_number_of(o.get("requestCount"));
    let request_count = if request_count_raw.is_finite() && request_count_raw > 0.0 {
        Some(request_count_raw.floor())
    } else {
        None
    };
    let total_raw = n0(js_number_of(o.get("totalTokens")));
    let total_tokens = if total_raw != 0.0 {
        total_raw
    } else {
        input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
    };
    let estimated_cost = match o.get("estimatedCost") {
        None | Some(Value::Null) => None,
        Some(v) => {
            let n = js_number_of(Some(v));
            if n.is_nan() {
                None
            } else {
                Some(n)
            }
        }
    };
    let model = match o.get("model") {
        None | Some(Value::Null) => None,
        Some(v) => Some(js_string_of(v)),
    };
    let workspace = match o.get("workspace") {
        None | Some(Value::Null) => None,
        Some(v) => Some(js_string_of(v)),
    };
    let timestamp = match o.get("timestamp").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => iso_now(),
    };
    let currency = match o.get("currency").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => "USD".to_string(),
    };
    let source_path = match o.get("sourcePath").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => "backup".to_string(),
    };
    let machine_scope = o
        .get("machineScope")
        .and_then(|v| v.as_str())
        .map(|s| js_trim(s).to_string())
        .filter(|s| !s.is_empty());
    let cache_reported = if o.get("cacheReported") == Some(&Value::Bool(true)) || legacy_devin_cache_reported {
        Some(true)
    } else {
        None
    };
    Some(UsageEvent {
        id,
        agent,
        model,
        timestamp,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens,
        estimated_cost,
        currency,
        pricing_status: pricing_status_from(o.get("pricingStatus").and_then(|v| v.as_str())),
        workspace,
        source_path,
        estimated: Some(o.get("estimated").map_or(false, js_truthy)),
        machine_scope,
        request_count,
        cache_reported,
        cost_parity_gap: None,
    })
}

/// Raw JSON -> sanitized events. `None` when `raw` is not an array.
pub fn sanitize_events(raw: &Value) -> Option<Vec<UsageEvent>> {
    let arr = raw.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        if let Some(e) = sanitize_event_value(item) {
            out.push(e);
        }
    }
    Some(out)
}

/// `sanitizeEvents` applied to already-typed events (same coercions).
fn sanitize_typed_events(events: &[UsageEvent]) -> Vec<UsageEvent> {
    events
        .iter()
        .map(|e| {
            let agent = normalize_agent_id(Some(e.agent.as_str()));
            let input_tokens = n0(e.input_tokens);
            let output_tokens = n0(e.output_tokens);
            let cache_read_tokens = n0(e.cache_read_tokens);
            let cache_write_tokens = n0(e.cache_write_tokens);
            let legacy_devin = e.cache_reported.is_none()
                && agent == AgentId::Devin
                && (cache_read_tokens > 0.0 || cache_write_tokens > 0.0);
            let total_raw = n0(e.total_tokens);
            let total_tokens = if total_raw != 0.0 {
                total_raw
            } else {
                input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
            };
            let request_count = match e.request_count {
                Some(rc) if rc.is_finite() && rc > 0.0 => Some(rc.floor()),
                _ => None,
            };
            UsageEvent {
                id: e.id.clone(),
                agent,
                model: e.model.clone(),
                timestamp: e.timestamp.clone(),
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
                total_tokens,
                estimated_cost: e.estimated_cost.filter(|c| !c.is_nan()),
                currency: e.currency.clone(),
                pricing_status: e.pricing_status,
                workspace: e.workspace.clone(),
                source_path: e.source_path.clone(),
                estimated: Some(is_est(e)),
                machine_scope: e
                    .machine_scope
                    .as_deref()
                    .map(|s| js_trim(s).to_string())
                    .filter(|s| !s.is_empty()),
                request_count,
                cache_reported: if e.cache_reported == Some(true) || legacy_devin {
                    Some(true)
                } else {
                    None
                },
                cost_parity_gap: None,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Imported events (other machines / restores)
// ---------------------------------------------------------------------------

async fn read_json_value(path: &str) -> Result<Value, String> {
    let bytes = tokio::fs::read(path).await.map_err(|e| err_msg(&e))?;
    let text = String::from_utf8_lossy(&bytes);
    serde_json::from_str::<Value>(&text).map_err(|e| err_msg(&e))
}

pub async fn load_imported_events() -> Vec<UsageEvent> {
    let p = imported_events_path();
    let mut events: Vec<UsageEvent> = Vec::new();
    if path_exists(&p).await {
        match read_json_value(&p).await {
            Ok(raw) => events = sanitize_events(&raw).unwrap_or_default(),
            Err(e) => log_error(&format!("loadImportedEvents failed: {}", e)),
        }
    }
    // Legacy fallback: merge pre-rename imported-events.json so usage never
    // drops after the XLab Token -> TokenLab rename. Union by id.
    let lp = legacy_imported_events_path();
    if path_exists(&lp).await {
        match read_json_value(&lp).await {
            Ok(legacy_raw) => {
                let legacy = sanitize_events(&legacy_raw).unwrap_or_default();
                if !legacy.is_empty() {
                    events = merge_events_by_id_prefer_richer(&[&events, &legacy]);
                    if events.len() < legacy.len() {
                        // Sanity: never return fewer than legacy
                        events = legacy;
                    }
                }
            }
            Err(e) => log_error(&format!("loadImportedEvents legacy fallback failed: {}", e)),
        }
    }
    mark_imported_events(&events)
}

pub async fn save_imported_events(events: &[UsageEvent]) -> anyhow::Result<()> {
    let p = imported_events_path();
    tokio::fs::create_dir_all(path_flavor().dirname(&p)).await?;
    let clean = sanitize_typed_events(&mark_imported_events(events));
    tokio::fs::write(&p, serde_json::to_string(&clean)?).await?;
    log(&format!("saveImportedEvents: {} \u{2192} {}", clean.len(), p));
    Ok(())
}

// ---------------------------------------------------------------------------
// Scan cache
// ---------------------------------------------------------------------------

/// Serialize writes: concurrent `save_scan_cache` must not interleave.
static SCAN_CACHE_SAVE_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

/// Last successful save fingerprint (process-local), skips identical rewrites.
static LAST_SCAN_CACHE_WRITE_FP: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));

async fn read_scan_cache_file(file_path: &str) -> Result<Vec<UsageEvent>, String> {
    let raw = read_json_value(file_path).await?;
    Ok(sanitize_events(&raw).unwrap_or_default())
}

/// Recover individual event objects from a truncated / corrupt JSON array.
/// Used when a large scan-cache write is interrupted mid-file.
pub fn salvage_scan_cache_json(text: &str) -> Vec<UsageEvent> {
    let mut out: Vec<UsageEvent> = Vec::new();
    if text.is_empty() || !text.contains('{') {
        return out;
    }
    let mut depth: i64 = 0;
    let mut start: Option<usize> = None;
    let mut in_string = false;
    let mut escape = false;
    for (i, ch) in text.char_indices() {
        if in_string {
            if escape {
                escape = false;
                continue;
            }
            if ch == '\\' {
                escape = true;
                continue;
            }
            if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            continue;
        }
        if ch == '{' {
            if depth == 0 {
                start = Some(i);
            }
            depth += 1;
            continue;
        }
        if ch == '}' && depth > 0 {
            depth -= 1;
            if depth == 0 {
                if let Some(s) = start {
                    if let Ok(obj) = serde_json::from_str::<Value>(&text[s..i + 1]) {
                        if let Some(first) = sanitize_event_value(&obj) {
                            out.push(first);
                        }
                    }
                    start = None;
                }
            }
        }
    }
    out
}

async fn load_scan_cache_candidate(file_path: &str) -> Option<Vec<UsageEvent>> {
    if !path_exists(file_path).await {
        return None;
    }
    match read_scan_cache_file(file_path).await {
        Ok(events) => {
            let events = drop_legacy_codex_proxy_attributions(&events);
            if events.is_empty() {
                None
            } else {
                Some(events)
            }
        }
        Err(_) => {
            if let Ok(bytes) = tokio::fs::read(file_path).await {
                let text = String::from_utf8_lossy(&bytes);
                let salvaged = drop_legacy_codex_proxy_attributions(&salvage_scan_cache_json(&text));
                if !salvaged.is_empty() {
                    log(&format!(
                        "loadScanCache: salvaged {} events from corrupt \u{2192} {}",
                        salvaged.len(),
                        file_path
                    ));
                    return Some(salvaged);
                }
            }
            None
        }
    }
}

#[derive(Clone, Copy, Default)]
struct ScanScore {
    count: i64,
    tokens: f64,
}

fn scan_cache_score(events: &[UsageEvent]) -> ScanScore {
    let mut tokens = 0.0;
    for e in events {
        tokens += event_token_weight(e);
    }
    ScanScore {
        count: events.len() as i64,
        tokens,
    }
}

/// Prefer more events; on near-ties pick higher token weight so a truncated
/// progressive write does not beat a slightly shorter but complete cache.
fn score_better(score: ScanScore, best: ScanScore) -> bool {
    score.count > best.count + 50
        || (score.count >= best.count - 50 && score.tokens > best.tokens)
        || (score.count > best.count && score.tokens >= best.tokens * 0.9)
}

/// Fingerprint for no-op save detection (count + token weight + cost + max ts).
pub fn scan_cache_fingerprint(events: &[UsageEvent]) -> String {
    let mut tokens = 0.0;
    let mut cost = 0.0;
    let mut max_ts = 0.0;
    for e in events {
        tokens += event_token_weight(e);
        cost += cost_of(e);
        let t = js_date_parse(&e.timestamp);
        if t.is_finite() && t > max_ts {
            max_ts = t;
        }
    }
    format!(
        "{}|{}|{}|{}",
        events.len(),
        js_num_to_string(tokens),
        js_to_fixed(cost, 4),
        js_num_to_string(max_ts)
    )
}

/// Load only the main scan-cache file (no bak/archive/legacy multi-read).
pub async fn load_scan_cache_main_only() -> Vec<UsageEvent> {
    match load_scan_cache_candidate(&scan_cache_path()).await {
        Some(events) if !events.is_empty() => {
            collapse_exact_usage_duplicates(&collapse_router_daily_events(&events))
        }
        _ => Vec::new(),
    }
}

pub async fn load_scan_cache() -> Vec<UsageEvent> {
    let p = scan_cache_path();

    // FAST PATH: valid main -> return immediately.
    if let Some(main_events) = load_scan_cache_candidate(&p).await {
        if !main_events.is_empty() {
            return collapse_exact_usage_duplicates(&collapse_router_daily_events(&main_events));
        }
    }

    // RECOVERY: main missing/corrupt - score bak + archive, then legacy dir.
    let candidates = [scan_cache_backup_path(), scan_cache_archive_path()];
    let legacy_scan = legacy_scan_cache_path();
    let legacy_candidates = [
        legacy_scan.clone(),
        format!("{}.bak", legacy_scan),
        pjoin(&[legacy_data_root().as_str(), "scan-cache.archive.json"]),
    ];
    let mut best: Vec<UsageEvent> = Vec::new();
    let mut best_score = ScanScore::default();
    let mut best_from = String::new();
    for candidate in &candidates {
        let events = match load_scan_cache_candidate(candidate).await {
            Some(e) if !e.is_empty() => e,
            _ => continue,
        };
        let score = scan_cache_score(&events);
        if score_better(score, best_score) || best.is_empty() {
            best = events;
            best_score = score;
            best_from = candidate.clone();
        }
    }
    // Union with legacy cache so usage only grows across the rename.
    let mut legacy_best: Vec<UsageEvent> = Vec::new();
    let mut legacy_best_score = ScanScore::default();
    let mut legacy_best_from = String::new();
    for candidate in &legacy_candidates {
        let events = match load_scan_cache_candidate(candidate).await {
            Some(e) if !e.is_empty() => e,
            _ => continue,
        };
        let score = scan_cache_score(&events);
        if score_better(score, legacy_best_score) || legacy_best.is_empty() {
            legacy_best = events;
            legacy_best_score = score;
            legacy_best_from = candidate.clone();
        }
    }
    if !legacy_best.is_empty() {
        if best.is_empty() {
            log(&format!(
                "loadScanCache: using legacy cache only \u{2192} {} ({} events)",
                legacy_best_from,
                legacy_best.len()
            ));
            best = legacy_best;
            best_from = legacy_best_from;
        } else {
            // Union: richer rows win on id collisions; net count can only grow.
            let union = merge_events_by_id_prefer_richer(&[&best, &legacy_best]);
            if union.len() >= best.len() {
                log(&format!(
                    "loadScanCache: merged legacy cache \u{2192} {} (best={} + legacy={} \u{2192} union={})",
                    legacy_best_from,
                    best.len(),
                    legacy_best.len(),
                    union.len()
                ));
                best = union;
                best_from = format!("{} + {}", best_from, legacy_best_from);
            }
        }
    }
    if !best.is_empty() {
        log(&format!(
            "loadScanCache: recovered {} events from \u{2192} {}",
            best.len(),
            best_from
        ));
        // Heal legacy unstable daily ids + exact clones so restart totals stay honest.
        return collapse_exact_usage_duplicates(&collapse_router_daily_events(&best));
    }
    log_error("loadScanCache: no valid cache file (main + .bak + archive all failed)");
    Vec::new()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveMode {
    /// collapse + .bak + archive (shutdown / end of full scan)
    Full,
    /// skip heavy collapse + archive (progressive mid-scan)
    Quick,
}

#[derive(Debug, Clone, Copy)]
pub struct SaveScanCacheOpts {
    pub mode: SaveMode,
}

impl Default for SaveScanCacheOpts {
    fn default() -> Self {
        SaveScanCacheOpts { mode: SaveMode::Full }
    }
}

fn mode_label(mode: SaveMode) -> &'static str {
    match mode {
        SaveMode::Full => "full",
        SaveMode::Quick => "quick",
    }
}

fn heartbeat() {
    crate::process_guard::write_heartbeat();
}

pub async fn save_scan_cache(events: &[UsageEvent], opts: SaveScanCacheOpts) -> anyhow::Result<()> {
    let mode = opts.mode;
    let p = scan_cache_path();
    let bak = scan_cache_backup_path();
    tokio::fs::create_dir_all(path_flavor().dirname(&p)).await?;

    let _guard = SCAN_CACHE_SAVE_LOCK.lock().await;

    // Keep supervisor hang-watchdog happy during large JSON serialize/write.
    heartbeat();

    // Same-process short-circuit BEFORE collapse/high-water (O(n) on 50k+ rows).
    {
        let raw = drop_legacy_codex_proxy_attributions(events);
        let early_fp = scan_cache_fingerprint(&raw);
        let same = *LAST_SCAN_CACHE_WRITE_FP.lock() == early_fp;
        if same && path_exists(&p).await {
            log(&format!("saveScanCache: skip unchanged (early) {} {}", raw.len(), mode_label(mode)));
            return Ok(());
        }
    }

    let valid_events = drop_legacy_codex_proxy_attributions(events);
    let mut clean: Vec<UsageEvent> = match mode {
        SaveMode::Quick => valid_events,
        SaveMode::Full => collapse_exact_usage_duplicates(&collapse_source_path_rollups(
            &collapse_router_daily_events(&sanitize_typed_events(&valid_events)),
        )),
    };

    // Full save: never write a thinner all-time snapshot than what is on disk.
    if mode == SaveMode::Full {
        let existing = drop_legacy_codex_proxy_attributions(&load_scan_cache_main_only().await);
        if !existing.is_empty() {
            clean = reconcile_scan_cache_high_water(&existing, &clean);
        }
        // Persist timestamp-sorted for O(log n) period filters after next load.
        clean = sort_events_by_time(&clean).0;
    }

    let fp = scan_cache_fingerprint(&clean);
    let same = *LAST_SCAN_CACHE_WRITE_FP.lock() == fp;
    if same && path_exists(&p).await {
        log(&format!("saveScanCache: skip unchanged {} {}", clean.len(), mode_label(mode)));
        return Ok(());
    }

    // One serialize only.
    let json = serde_json::to_string(&clean)?;
    if !json.starts_with('[') || !json.ends_with(']') {
        anyhow::bail!("scan cache serialize produced non-array JSON");
    }

    let tmp = format!("{}.{}.{}.tmp", p, std::process::id(), now_ms() as u64);
    let result: anyhow::Result<()> = async {
        tokio::fs::write(&tmp, &json).await?;
        // Rotate previous main -> .bak (rename, not a 20MB copy).
        if path_exists(&p).await {
            let _ = tokio::fs::remove_file(&bak).await;
            if let Err(err) = tokio::fs::rename(&p, &bak).await {
                // Fallback: copy if rename fails (cross-device / locked)
                if let Err(err2) = tokio::fs::copy(&p, &bak).await {
                    log_error(&format!("saveScanCache: backup rotate failed: {}", err_msg(&err2)));
                }
                log_error(&format!(
                    "saveScanCache: rename main\u{2192}bak failed (used copy fallback): {}",
                    err_msg(&err)
                ));
            }
        }
        tokio::fs::rename(&tmp, &p).await?;
        // First write (or rotate failed): seed .bak so corrupt-main recovery works.
        if !path_exists(&bak).await {
            if let Err(err) = tokio::fs::copy(&p, &bak).await {
                log_error(&format!("saveScanCache: seed bak failed: {}", err_msg(&err)));
            }
        }
        // Archive only on full saves.
        if mode == SaveMode::Full {
            if let Err(err) = tokio::fs::copy(&p, scan_cache_archive_path()).await {
                log_error(&format!("saveScanCache: archive copy failed: {}", err_msg(&err)));
            }
        }
        *LAST_SCAN_CACHE_WRITE_FP.lock() = fp.clone();
        log(&format!("saveScanCache: {} {} \u{2192} {}", clean.len(), mode_label(mode), p));
        heartbeat();
        Ok(())
    }
    .await;
    if let Err(err) = result {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(err);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Mirrors
// ---------------------------------------------------------------------------

fn list_files_recursive_sync(dir: &str, rel_prefix: &str, out: &mut Vec<String>) -> std::io::Result<()> {
    for ent in std::fs::read_dir(dir)? {
        let ent = ent?;
        let name = ent.file_name().to_string_lossy().to_string();
        let full = pjoin(&[dir, name.as_str()]);
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel_prefix, name)
        };
        let ft = ent.file_type()?;
        if ft.is_dir() {
            list_files_recursive_sync(&full, &rel, out)?;
        } else if ft.is_file() {
            out.push(rel);
        }
    }
    Ok(())
}

async fn list_files_recursive(dir: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if !path_exists(dir).await {
        return out;
    }
    let _ = list_files_recursive_sync(dir, "", &mut out);
    out
}

/// Mirror export: daily / aggregate only. Never ship multi-MB per-request
/// histories (usage-history.jsonl, etc.).
const MIRROR_MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024; // 8 MB total
const MIRROR_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024; // 2 MB per file

/// Basename allow-list for compact aggregate mirrors
const MIRROR_ALLOW_NAMES: [&str; 8] = [
    "usage-daily.json",
    "usagedaily.json",
    "dailysummary.json",
    "db.json",
    "usage.json",
    "usagedata.json",
    "config.json",
    "ok.json",
];

fn mirror_base(rel: &str) -> String {
    rel.rsplit('/').next().unwrap_or("").to_lowercase()
}

fn is_request_level_mirror(rel: &str) -> bool {
    let base = mirror_base(rel);
    if base.ends_with(".jsonl") {
        return true;
    }
    if base.contains("usage-history") || base.contains("usagehistory") {
        return true;
    }
    if base.contains("request-detail") || base.contains("requestdetail") {
        return true;
    }
    if base.contains("history") && base.ends_with(".jsonl") {
        return true;
    }
    false
}

fn is_allowed_mirror(rel: &str) -> bool {
    if is_request_level_mirror(rel) {
        return false;
    }
    let base = mirror_base(rel);
    if MIRROR_ALLOW_NAMES.contains(&base.as_str()) {
        return true;
    }
    // small json aggregates only
    base.ends_with(".json") && !base.contains("history")
}

pub struct CollectedMirrors {
    pub files: IndexMap<String, String>,
    pub file_count: usize,
    pub bytes: u64,
    pub skipped: Vec<String>,
}

pub async fn collect_mirrors() -> CollectedMirrors {
    let root = mirrors_root();
    let mut files: IndexMap<String, String> = IndexMap::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut bytes: u64 = 0;
    let mut rels = list_files_recursive(&root).await;
    rels.sort();
    for rel in rels {
        if !is_allowed_mirror(&rel) {
            skipped.push(format!("{} (request-level or disallowed)", rel));
            continue;
        }
        let mut parts: Vec<&str> = vec![root.as_str()];
        parts.extend(rel.split('/'));
        let full = pjoin(&parts);
        let st = match tokio::fs::metadata(&full).await {
            Ok(s) => s,
            Err(_) => {
                skipped.push(rel);
                continue;
            }
        };
        if st.len() > MIRROR_MAX_FILE_BYTES {
            skipped.push(format!("{} ({}KB > cap)", rel, js_num_to_string(js_round(st.len() as f64 / 1024.0))));
            continue;
        }
        if bytes + st.len() > MIRROR_MAX_TOTAL_BYTES {
            skipped.push(format!("{} (over total cap)", rel));
            continue;
        }
        match tokio::fs::read(&full).await {
            Ok(b) => {
                let text = String::from_utf8_lossy(&b).to_string();
                bytes += text.len() as u64;
                files.insert(rel, text);
            }
            Err(_) => skipped.push(rel),
        }
    }
    let file_count = files.len();
    CollectedMirrors {
        files,
        file_count,
        bytes,
        skipped,
    }
}

// ---------------------------------------------------------------------------
// Backup builders
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct SettingsBackupOpts {
    pub event_count_hint: Option<f64>,
    pub note: Option<String>,
}

pub fn build_settings_backup(opts: Option<&SettingsBackupOpts>) -> XlabBackup {
    let mid = get_machine_id();
    let note = opts
        .and_then(|o| o.note.clone())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| {
            "TokenLab backup file (settings): timezone, pricing, host/port, gist link \u{2014} same format as Gist/full"
                .to_string()
        });
    XlabBackup {
        format: BACKUP_FORMAT.to_string(),
        format_version: BACKUP_FORMAT_VERSION as f64,
        app_version: VERSION.to_string(),
        exported_at: iso_now(),
        platform: Some(crate::util::host_platform().to_string()),
        scope: SCOPE_SETTINGS.to_string(),
        config: build_portable_config(),
        period_stats: None,
        events: None,
        openrouter: None,
        mirrors: None,
        meta: Some(BackupMeta {
            note: Some(note),
            event_count: opts.and_then(|o| o.event_count_hint),
            machine_id: Some(mid.clone()),
            machines: Some(vec![mid]),
            ..Default::default()
        }),
    }
}

/// @deprecated use `build_settings_backup` or `build_full_backup`
pub fn build_backup(opts: Option<&SettingsBackupOpts>) -> XlabBackup {
    build_settings_backup(opts)
}

#[derive(Debug, Clone, Default)]
pub struct FullBackupOpts {
    pub include_mirrors: Option<bool>,
    pub note: Option<String>,
}

pub async fn build_full_backup(events: &[UsageEvent], opts: FullBackupOpts) -> XlabBackup {
    // Keep the downloadable full export aligned with Gist: preserve usage
    // coverage through compact hour/day rollups instead of serializing every
    // request row. Existing Gist rollups in the merged cache are passed as the
    // remote slice so another machine's data is not lost on export.
    let machine_id = get_machine_id();
    let existing_rollups: Vec<UsageEvent> = events.iter().filter(|e| is_gist_rollup_event(e)).cloned().collect();
    let mut base = build_gist_full_backup(
        events,
        GistBackupOpts {
            remote_events: Some(existing_rollups),
            machine_id: Some(machine_id),
            remote_config: None,
        },
    )
    .await;
    base.scope = SCOPE_FULL.to_string();
    {
        let mut meta = base.meta.take().unwrap_or_default();
        let note_head = opts
            .note
            .clone()
            .filter(|n| !n.is_empty())
            .or_else(|| meta.note.clone().filter(|n| !n.is_empty()))
            .unwrap_or_default();
        meta.note = Some(format!(
            "{} \u{00b7} compact usage rollups match Gist; raw request rows omitted",
            note_head
        ));
        base.meta = Some(meta);
    }

    // OpenRouter catalog from memory or disk
    let mem_models = get_open_router_models_sync();
    let mem_at = get_open_router_fetched_at();
    if !mem_models.is_empty() {
        let models: Vec<Value> = mem_models
            .iter()
            .filter_map(|m| serde_json::to_value(m).ok())
            .collect();
        base.openrouter = Some(BackupOpenrouter {
            fetched_at: if mem_at != 0.0 && !mem_at.is_nan() { mem_at } else { now_ms() },
            models,
        });
    } else {
        let p = openrouter_cache_path();
        if path_exists(&p).await {
            if let Ok(raw) = read_json_value(&p).await {
                if let Some(models) = raw.get("models").and_then(|m| m.as_array()) {
                    if !models.is_empty() {
                        let at = n0(js_number_of(raw.get("fetchedAt")));
                        base.openrouter = Some(BackupOpenrouter {
                            fetched_at: if at != 0.0 { at } else { now_ms() },
                            models: models.clone(),
                        });
                    }
                }
            }
        }
    }

    let mut mirror_file_count = 0usize;
    let mut mirror_bytes = 0u64;
    if opts.include_mirrors != Some(false) {
        let m = collect_mirrors().await;
        if m.file_count > 0 {
            base.mirrors = Some(m.files.clone());
            mirror_file_count = m.file_count;
            mirror_bytes = m.bytes;
        }
        if !m.skipped.is_empty() {
            let mut meta = base.meta.take().unwrap_or_default();
            let head: Vec<&str> = m.skipped.iter().take(5).map(|s| s.as_str()).collect();
            meta.note = Some(format!(
                "{} \u{00b7} skipped mirrors: {}{}",
                meta.note.clone().unwrap_or_default(),
                head.join(", "),
                if m.skipped.len() > 5 { "\u{2026}" } else { "" }
            ));
            base.meta = Some(meta);
        }
    }

    let rollup_count = base.events.as_ref().map_or(0, |e| e.len());
    let or_count = base.openrouter.as_ref().map_or(0, |o| o.models.len());
    let mut meta = base.meta.take().unwrap_or_default();
    // Keep source count for UI/reporting; rollupEventCount is the serialized
    // event count and is intentionally much smaller.
    meta.event_count = Some(events.len() as f64);
    meta.source_event_count = Some(events.len() as f64);
    meta.rollup_event_count = Some(rollup_count as f64);
    meta.openrouter_model_count = Some(or_count as f64);
    meta.mirror_file_count = Some(mirror_file_count as f64);
    meta.mirror_bytes = Some(mirror_bytes as f64);
    base.meta = Some(meta);
    base
}

pub fn is_xlab_backup(raw: &Value) -> bool {
    let o = match raw.as_object() {
        Some(o) => o,
        None => return false,
    };
    let fmt_ok = matches!(
        o.get("format").and_then(|f| f.as_str()),
        Some(BACKUP_FORMAT) | Some(BACKUP_FORMAT_LEGACY) | Some(BACKUP_FORMAT_LEGACY_XLAB)
    );
    // `typeof o.config === "object" && o.config != null` (arrays pass too)
    fmt_ok && matches!(o.get("config"), Some(Value::Object(_)) | Some(Value::Array(_)))
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub ok: bool,
    pub config: XlabTokenConfig,
    #[serde(with = "jsnum")]
    pub custom_rate_count: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<UsageEvent>>,
    pub openrouter_restored: bool,
    #[serde(with = "jsnum")]
    pub mirrors_restored: f64,
    /// "settings" | "full" | "period-stats"
    pub scope: String,
}

async fn restore_openrouter(or: Option<&Value>) -> anyhow::Result<bool> {
    let or = match or {
        Some(Value::Object(o)) => o,
        _ => return Ok(false),
    };
    let models_raw = match or.get("models").and_then(|m| m.as_array()) {
        Some(a) if !a.is_empty() => a,
        _ => return Ok(false),
    };
    let fetched = n0(js_number_of(or.get("fetchedAt")));
    let fetched_at = if fetched != 0.0 { fetched } else { now_ms() };
    let models: Vec<OpenRouterModelEntry> = models_raw
        .iter()
        .filter_map(|m| serde_json::from_value::<OpenRouterModelEntry>(m.clone()).ok())
        .collect();
    replace_open_router_cache(fetched_at, models).await?;
    Ok(true)
}

/// Resolve `rel` under `root`, rejecting absolute / drive-letter / parent
/// segments (path-traversal protection).
pub fn safe_mirror_path(root: &str, rel: &str) -> Option<String> {
    if rel.is_empty() {
        return None;
    }
    let replaced = rel.replace('\\', "/");
    let normalized = js_trim(replaced.trim_start_matches('/')).to_string();
    if normalized.is_empty() {
        return None;
    }
    let pf = path_flavor();
    if pf.is_absolute(&normalized) {
        return None;
    }
    let bytes = normalized.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return None;
    }
    let segs: Vec<&str> = normalized.split('/').collect();
    if segs.iter().any(|p| *p == ".." || p.is_empty() || *p == ".") {
        return None;
    }
    let root_resolved = pf.resolve(&[root]);
    let mut parts: Vec<&str> = vec![root_resolved.as_str()];
    parts.extend(segs.iter().copied());
    let full = pf.resolve(&parts);
    let sep = pf.sep();
    let prefix = if root_resolved.ends_with(sep) {
        root_resolved.clone()
    } else {
        format!("{}{}", root_resolved, sep)
    };
    if full != root_resolved && !full.starts_with(&prefix) {
        return None;
    }
    Some(full)
}

async fn restore_mirrors(mirrors: Option<&Value>) -> anyhow::Result<f64> {
    let obj = match mirrors {
        Some(Value::Object(o)) => o,
        _ => return Ok(0.0),
    };
    let root = mirrors_root();
    let mut n = 0.0;
    for (rel, content) in obj {
        let content = match content.as_str() {
            Some(c) => c,
            None => continue,
        };
        let full = match safe_mirror_path(&root, rel) {
            Some(f) => f,
            None => continue,
        };
        tokio::fs::create_dir_all(path_flavor().dirname(&full)).await?;
        tokio::fs::write(&full, content).await?;
        n += 1.0;
    }
    Ok(n)
}

fn nonempty_trimmed_str(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) if !js_trim(s).is_empty() => Some(js_trim(s).to_string()),
        _ => None,
    }
}

/// Custom rates from a backup (lenient: bad entries are skipped).
fn rates_from_value(v: &Value) -> Option<IndexMap<String, crate::types::ModelRate>> {
    let obj = v.as_object()?;
    let mut out: IndexMap<String, crate::types::ModelRate> = IndexMap::new();
    for (k, rv) in obj {
        if let Ok(rate) = serde_json::from_value::<crate::types::ModelRate>(rv.clone()) {
            out.insert(k.clone(), rate);
        }
    }
    Some(out)
}

/// Restore config (+ optional events / openrouter / mirrors). Same file format
/// as Gist.
pub async fn restore_backup(raw: &Value) -> anyhow::Result<RestoreResult> {
    if !is_xlab_backup(raw) {
        anyhow::bail!("Invalid backup file (expected tokenlab format)");
    }
    let prev = load_config().await;
    let empty = Value::Object(Map::new());
    let incoming = match raw.get("config") {
        Some(c @ Value::Object(_)) => c,
        _ => &empty,
    };
    let in_pricing = incoming.get("pricing").filter(|p| p.is_object());
    let in_backup = incoming.get("backup").filter(|b| b.is_object());

    let mut next_cfg = prev.clone();
    if let Some(tz) = nonempty_trimmed_str(incoming.get("timezone")) {
        next_cfg.timezone = Some(tz);
    }
    if let Some(h) = nonempty_trimmed_str(incoming.get("host")) {
        next_cfg.host = Some(h);
    }
    if let Some(Value::Number(n)) = incoming.get("port") {
        if let Some(f) = n.as_f64() {
            if f.is_finite() {
                next_cfg.port = Some(f);
            }
        }
    }

    let mut pricing = prev.pricing.clone().unwrap_or_default();
    let in_currency = in_pricing
        .and_then(|p| p.get("currency"))
        .filter(|c| js_truthy(c))
        .map(js_string_of);
    let prev_currency = prev
        .pricing
        .as_ref()
        .and_then(|p| p.currency.clone())
        .filter(|c| !c.is_empty());
    pricing.currency = Some(
        in_currency
            .or(prev_currency)
            .unwrap_or_else(|| "USD".to_string()),
    );
    if let Some(Value::Bool(b)) = in_pricing.and_then(|p| p.get("preferRouterCost")) {
        pricing.prefer_router_cost = Some(*b);
    }
    if let Some(rates) = in_pricing.and_then(|p| p.get("customRates")).and_then(rates_from_value) {
        pricing.custom_rates = rates;
    }
    next_cfg.pricing = Some(pricing);

    let mut backup = prev.backup.clone().unwrap_or_default();
    if let Some(ib) = in_backup {
        // Restore gist link metadata only - never a token from file
        if let Some(v) = ib.get("gistId").filter(|v| js_truthy(v)) {
            backup.gist_id = Some(js_string_of(v));
        }
        if let Some(v) = ib.get("gistUrl").filter(|v| js_truthy(v)) {
            backup.gist_url = Some(js_string_of(v));
        }
        if let Some(v) = ib.get("lastBackupAt").filter(|v| js_truthy(v)) {
            backup.last_backup_at = Some(js_string_of(v));
        }
        if let Some(Value::Bool(b)) = ib.get("autoDaily") {
            backup.auto_daily = Some(*b);
        }
    }
    next_cfg.backup = Some(backup);

    let next = save_config(&next_cfg).await?;

    let restored_events = raw.get("events").and_then(sanitize_events);
    let events = restored_events.as_ref().map(|e| mark_imported_events(e));
    let openrouter_restored = restore_openrouter(raw.get("openrouter")).await?;
    let mirrors_restored = restore_mirrors(raw.get("mirrors")).await?;
    let raw_scope = raw.get("scope").and_then(|s| s.as_str());
    let scope = if raw_scope == Some("period-stats") {
        SCOPE_PERIOD_STATS
    } else if raw_scope == Some("full")
        || events.as_ref().map_or(false, |e| !e.is_empty())
        || openrouter_restored
        || mirrors_restored > 0.0
    {
        SCOPE_FULL
    } else {
        SCOPE_SETTINGS
    };

    let custom_rate_count = next
        .pricing
        .as_ref()
        .map_or(0, |p| p.custom_rates.len()) as f64;
    Ok(RestoreResult {
        ok: true,
        config: next,
        custom_rate_count,
        events,
        openrouter_restored,
        mirrors_restored,
        scope: scope.to_string(),
    })
}

// ---------------------------------------------------------------------------
// GitHub token + compact period stats
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GistUploadResult {
    pub id: String,
    pub html_url: String,
    pub public: bool,
    pub updated: bool,
}

fn env_trimmed(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|s| js_trim(&s).to_string())
        .filter(|s| !s.is_empty())
}

fn github_token(from_body: Option<&str>) -> Option<String> {
    let t = from_body
        .map(|s| js_trim(s).to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| env_trimmed("XLAB_GITHUB_TOKEN"))
        .or_else(|| env_trimmed("GITHUB_TOKEN"))
        .or_else(|| {
            get_config_sync()
                .backup
                .as_ref()
                .and_then(|b| b.github_token.as_deref())
                .map(|s| js_trim(s).to_string())
                .filter(|s| !s.is_empty())
        });
    t
}

/// GitHub Gist hard-ish limit; keep headroom under 100MB API max
const GIST_MAX_BYTES: usize = 50 * 1024 * 1024;

fn to_compact_row(t: &TokenTotals) -> CompactTokenRow {
    CompactTokenRow {
        input_tokens: n0(t.input_tokens),
        output_tokens: n0(t.output_tokens),
        cache_read_tokens: n0(t.cache_read_tokens),
        cache_write_tokens: n0(t.cache_write_tokens),
        total_tokens: n0(t.total_tokens),
        estimated_cost: n0(t.estimated_cost),
        event_count: n0(t.event_count),
    }
}

const GIST_PERIODS: [(GistPeriodKey, Option<&str>); 5] = [
    (GistPeriodKey::Today, Some("today")),
    (GistPeriodKey::H24, Some("24h")),
    (GistPeriodKey::D7, Some("7d")),
    (GistPeriodKey::D30, Some("30d")),
    (GistPeriodKey::All, None),
];

/// Single call site of the aggregate module (`aggregate(filtered, groupBy,
/// "cost", since, null)`).
fn aggregate_cost(filtered: &[UsageEvent], group_by: GroupBy, since: Option<&str>) -> crate::types::StatsResult {
    crate::aggregate::aggregate(filtered, group_by, "cost", since, None, None, false)
}

/// Aggregate usage into dashboard periods (Today / 24h / 7D / 30D / All)
/// with both by-model and by-agent breakdowns.
pub fn build_period_stats(events: &[UsageEvent], time_zone: Option<&str>) -> IndexMap<String, PeriodSnapshot> {
    let cfg_tz = get_config_sync().timezone.clone();
    let tz: String = match time_zone {
        Some(t) => t.to_string(),
        None => cfg_tz.unwrap_or_else(|| "local".to_string()),
    };
    let mut out: IndexMap<String, PeriodSnapshot> = IndexMap::new();
    for (key, since) in GIST_PERIODS.iter() {
        let filtered = filter_by_period(events, *since, None, Some(tz.as_str()));
        let by_model = aggregate_cost(&filtered, GroupBy::Model, *since);
        let by_agent = aggregate_cost(&filtered, GroupBy::Agent, *since);
        out.insert(
            key.as_str().to_string(),
            PeriodSnapshot {
                period: *key,
                since: since.map(|s| s.to_string()),
                totals: to_compact_row(&by_model.totals),
                by_model: by_model
                    .groups
                    .iter()
                    .map(|g| PeriodGroupRow {
                        key: g.key.clone(),
                        row: to_compact_row(&g.totals),
                    })
                    .collect(),
                by_agent: by_agent
                    .groups
                    .iter()
                    .map(|g| PeriodGroupRow {
                        key: g.key.clone(),
                        row: to_compact_row(&g.totals),
                    })
                    .collect(),
            },
        );
    }
    out
}

// ---------------------------------------------------------------------------
// Gist rollups (hour / day buckets per machine)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RollupKind {
    Hour,
    Day,
}

struct RollupAcc {
    agent: AgentId,
    model: Option<String>,
    /// Bucket id: day `YYYY-MM-DD` or hour `YYYY-MM-DDTHH`
    bucket: String,
    kind: RollupKind,
    /// Latest source timestamp in bucket - keeps Today/24h/7d filters accurate
    last_ts: f64,
    input_tokens: f64,
    output_tokens: f64,
    cache_read_tokens: f64,
    cache_write_tokens: f64,
    total_tokens: f64,
    estimated_cost: f64,
    event_count: f64,
}

fn add_to_rollup(row: &mut RollupAcc, e: &UsageEvent, ts: f64) {
    let i = n0(e.input_tokens);
    let o = n0(e.output_tokens);
    let cr = n0(e.cache_read_tokens);
    let cw = n0(e.cache_write_tokens);
    row.input_tokens += i;
    row.output_tokens += o;
    row.cache_read_tokens += cr;
    row.cache_write_tokens += cw;
    let t = n0(e.total_tokens);
    row.total_tokens += if t != 0.0 { t } else { i + o + cr + cw };
    row.estimated_cost += cost_of(e);
    row.event_count += 1.0;
    if ts > row.last_ts {
        row.last_ts = ts;
    }
}

fn rollup_acc_to_event(row: &RollupAcc, machine_id: &str) -> UsageEvent {
    let mid = sanitize_machine_id(if machine_id.is_empty() { "unknown" } else { machine_id });
    let (prefix, base_path) = match row.kind {
        RollupKind::Hour => ("gist-hour", "backup:gist-hour"),
        RollupKind::Day => ("gist-daily", "backup:gist-daily"),
    };
    let model_key = match row.model.as_deref() {
        Some(m) if !m.is_empty() => m,
        _ => "unknown",
    };
    UsageEvent {
        id: stable_id(&[prefix, mid.as_str(), row.bucket.as_str(), row.agent.as_str(), model_key]),
        agent: row.agent,
        model: row.model.clone(),
        timestamp: to_iso_string(row.last_ts).unwrap_or_default(),
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cache_read_tokens: row.cache_read_tokens,
        cache_write_tokens: row.cache_write_tokens,
        total_tokens: row.total_tokens,
        estimated_cost: Some(row.estimated_cost),
        currency: "USD".to_string(),
        pricing_status: PricingStatus::Estimated,
        workspace: Some(mid.clone()),
        source_path: format!("{}:{}", base_path, mid),
        estimated: Some(true),
        ..Default::default()
    }
}

/// Compact restore rows for Gist (per machine):
/// - last 8 days -> hour x agent x model (Today / 24h / 7D stay accurate)
/// - older -> day x agent x model (30D / All)
///
/// Timestamp = last event in bucket so rolling windows match source.
pub fn build_gist_restore_rollups(events: &[UsageEvent], now_ms_val: f64, machine_id: Option<&str>) -> Vec<UsageEvent> {
    // 8d of hourly covers rolling 7d without whole-day bleed at the window edge
    let hour_cutoff = now_ms_val - 8.0 * 86_400_000.0;
    let mut map: IndexMap<String, RollupAcc> = IndexMap::new();
    let mid_in = match machine_id {
        Some(m) if !m.is_empty() => m.to_string(),
        _ => get_machine_id(),
    };
    let mid = sanitize_machine_id(&mid_in);

    for e in events {
        // Skip already-imported rollups from other machines (do not re-bucket)
        if is_gist_rollup_event(e) {
            continue;
        }
        let ts = js_date_parse(&e.timestamp);
        if ts.is_nan() {
            continue;
        }
        // Lowercase so case variants of the same model collapse into one rollup
        let model: Option<String> = normalize_model_name(e.model.as_deref()).map(|m| m.to_lowercase());
        let use_hour = ts >= hour_cutoff;
        let iso = match to_iso_string(ts) {
            Some(s) => s,
            None => continue,
        };
        let bucket = if use_hour {
            slice_prefix(&iso, 13) // YYYY-MM-DDTHH
        } else {
            slice_prefix(&iso, 10) // YYYY-MM-DD
        };
        let kind = if use_hour { RollupKind::Hour } else { RollupKind::Day };
        let key = format!(
            "{}|{}|{}|{}",
            if use_hour { "hour" } else { "day" },
            bucket,
            e.agent.as_str(),
            model.as_deref().unwrap_or("")
        );
        let row = map.entry(key).or_insert_with(|| RollupAcc {
            agent: e.agent,
            model: model.clone(),
            bucket: bucket.clone(),
            kind,
            last_ts: ts,
            input_tokens: 0.0,
            output_tokens: 0.0,
            cache_read_tokens: 0.0,
            cache_write_tokens: 0.0,
            total_tokens: 0.0,
            estimated_cost: 0.0,
            event_count: 0.0,
        });
        add_to_rollup(row, e, ts);
    }

    map.values().map(|row| rollup_acc_to_event(row, &mid)).collect()
}

/// @deprecated use `build_gist_restore_rollups`
pub fn build_daily_agent_model_rollups(events: &[UsageEvent]) -> Vec<UsageEvent> {
    build_gist_restore_rollups(events, now_ms(), None)
}

/// day|agent|model key for collapse / anti-double-count (model case-insensitive)
pub fn gist_coverage_key(e: &UsageEvent) -> String {
    let day = slice_prefix(&e.timestamp, 10);
    let model = normalize_model_name(e.model.as_deref()).unwrap_or_default().to_lowercase();
    format!("{}|{}|{}", day, e.agent.as_str(), model)
}

fn resolve_mid(machine_id: Option<&str>) -> String {
    match machine_id {
        Some(m) if !m.is_empty() => sanitize_machine_id(m),
        _ => sanitize_machine_id(&get_machine_id()),
    }
}

/// Merge local scan with imported (Gist) events.
/// - Always keep other machines' rollups (multi-host sum).
/// - Drop this machine's Gist rollups when local already has real scan rows
///   for the same day x agent x model (avoids double-count after rescan).
pub fn merge_local_prefer_over_gist_rollups(
    local: &[UsageEvent],
    imported: &[UsageEvent],
    machine_id: Option<&str>,
) -> Vec<UsageEvent> {
    // Fast path: no imports -> no allocation / merge cost
    if imported.is_empty() {
        return local.to_vec();
    }
    let imported_scoped = mark_imported_events(imported);
    if local.is_empty() {
        return imported_scoped;
    }

    let mid = resolve_mid(machine_id);
    let mut covered: HashSet<String> = HashSet::new();
    for e in local {
        if is_gist_rollup_event(e) {
            continue;
        }
        covered.insert(gist_coverage_key(e));
    }
    let filtered_imported: Vec<UsageEvent> = imported_scoped
        .into_iter()
        .filter(|e| {
            if !is_gist_rollup_event(e) {
                return true;
            }
            let event_mid = machine_id_from_event(e);
            // Other machine (or legacy untagged treated as foreign): always keep for sum
            if !event_mid.is_empty() && event_mid != mid {
                return true;
            }
            // Same machine (or untagged on this host): drop if local scan covers key
            !covered.contains(&gist_coverage_key(e))
        })
        .collect();
    if filtered_imported.is_empty() {
        return local.to_vec();
    }
    merge_events_by_id_prefer_richer(&[local, &filtered_imported])
}

/// Multi-machine Gist merge:
/// keep remote rollups from other machines + this machine's fresh local rollups.
/// Same machine remote rows are replaced by local (local is source of truth).
pub fn merge_multi_machine_gist_rollups(
    local_rollups: &[UsageEvent],
    remote_events: Option<&[UsageEvent]>,
    machine_id: Option<&str>,
) -> Vec<UsageEvent> {
    let mid = resolve_mid(machine_id);
    let mut others: Vec<UsageEvent> = Vec::new();
    for e in remote_events.unwrap_or(&[]) {
        if !is_gist_rollup_event(e) {
            // Legacy full-event backups: keep as-is (different ids)
            others.push(e.clone());
            continue;
        }
        let event_mid = machine_id_from_event(e);
        // Untagged legacy rollups: treat as foreign so we don't wipe history on first multi upgrade
        if event_mid.is_empty() || event_mid != mid {
            others.push(e.clone());
        }
    }
    merge_events_by_id_prefer_richer(&[&others, local_rollups])
}

pub fn list_machines_from_events(events: &[UsageEvent], fallback: Option<&str>) -> Vec<String> {
    let mut set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    if let Some(f) = fallback {
        if !f.is_empty() {
            set.insert(sanitize_machine_id(f));
        }
    }
    for e in events {
        let mid = machine_id_from_event(e);
        if !mid.is_empty() {
            set.insert(mid);
        }
    }
    set.into_iter().collect()
}

#[derive(Debug, Clone, Default)]
pub struct GistBackupOpts {
    pub remote_events: Option<Vec<UsageEvent>>,
    pub machine_id: Option<String>,
    pub remote_config: Option<PortableBackupConfig>,
}

/// Gist-tuned backup: settings + by-model / by-agent for Today, 24h, 7D, 30D,
/// All + hour/day rollups. Supports multi-machine: pass `remote_events` from the
/// existing Gist so other hosts are kept and usage is summed in periodStats.
pub async fn build_gist_full_backup(events: &[UsageEvent], opts: GistBackupOpts) -> XlabBackup {
    let cfg = get_config_sync();
    let tz: String = match cfg.timezone.as_deref() {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => "local".to_string(),
    };
    let mid = resolve_mid(opts.machine_id.as_deref());
    let local_rollups = build_gist_restore_rollups(events, now_ms(), Some(&mid));
    let merged_rollups = merge_multi_machine_gist_rollups(&local_rollups, opts.remote_events.as_deref(), Some(&mid));
    // periodStats from merged rollups = sum across all machines
    let period_stats = build_period_stats(&merged_rollups, Some(&tz));
    let (model_count, agent_count) = match period_stats.get("all") {
        Some(s) => (s.by_model.len(), s.by_agent.len()),
        None => (0, 0),
    };
    let hour_count = merged_rollups
        .iter()
        .filter(|e| e.source_path.contains("gist-hour"))
        .count();
    let day_count = merged_rollups.len() - hour_count;
    let machines = list_machines_from_events(&merged_rollups, Some(&mid));

    // Merge custom rates from remote + local (local wins on conflict)
    let mut custom_rates: IndexMap<String, crate::types::ModelRate> = opts
        .remote_config
        .as_ref()
        .and_then(|c| c.pricing.as_ref())
        .map(|p| p.custom_rates.clone())
        .unwrap_or_default();
    if let Some(p) = cfg.pricing.as_ref() {
        for (k, v) in p.custom_rates.iter() {
            custom_rates.insert(k.clone(), v.clone());
        }
    }
    let mut base = build_settings_backup(Some(&SettingsBackupOpts {
        event_count_hint: Some(events.len() as f64),
        note: Some(
            "TokenLab backup file (Gist/period-stats): full project settings + multi-machine usage sum".to_string(),
        ),
    }));
    // Same portable config as export; merge rates; keep remote gist id if local missing
    let portable = build_portable_config();
    let remote_backup = opts
        .remote_config
        .as_ref()
        .and_then(|c| c.backup.clone())
        .unwrap_or_default();
    let local_backup = portable.backup.clone().unwrap_or_default();
    let merged_backup = PortableBackupBlock {
        gist_id: local_backup.gist_id.or(remote_backup.gist_id),
        gist_url: local_backup.gist_url.or(remote_backup.gist_url),
        last_backup_at: local_backup.last_backup_at.or(remote_backup.last_backup_at),
        auto_daily: local_backup.auto_daily.or(remote_backup.auto_daily),
    };
    let currency = match cfg.pricing.as_ref().and_then(|p| p.currency.as_deref()) {
        Some(c) if !c.is_empty() => c.to_string(),
        _ => "USD".to_string(),
    };
    base.config = PortableBackupConfig {
        pricing: Some(PricingConfig {
            currency: Some(currency),
            prefer_router_cost: Some(cfg.pricing.as_ref().and_then(|p| p.prefer_router_cost) != Some(false)),
            custom_rates,
            extra: Map::new(),
        }),
        backup: Some(merged_backup),
        ..portable
    };
    base.format_version = BACKUP_FORMAT_VERSION as f64;
    base.scope = SCOPE_PERIOD_STATS.to_string();
    base.period_stats = Some(period_stats);
    let rollup_len = merged_rollups.len();
    base.events = Some(merged_rollups);
    let prev_note = base
        .meta
        .as_ref()
        .and_then(|m| m.note.clone())
        .unwrap_or_default();
    let mut meta = base.meta.take().unwrap_or_default();
    meta.event_count = Some(events.len() as f64);
    meta.source_event_count = Some(events.len() as f64);
    meta.rollup_event_count = Some(rollup_len as f64);
    meta.model_count = Some(model_count as f64);
    meta.agent_count = Some(agent_count as f64);
    meta.machine_id = Some(mid.clone());
    meta.openrouter_model_count = Some(0.0);
    meta.mirror_file_count = Some(0.0);
    meta.mirror_bytes = Some(0.0);
    let machines_label = if machines.is_empty() {
        mid.clone()
    } else {
        machines.join(", ")
    };
    meta.machines = Some(machines);
    meta.note = Some(format!(
        "{} \u{00b7} machines: {} \u{00b7} {} models \u{00b7} {} agents \u{00b7} {}h+{}d rollups",
        prev_note, machines_label, model_count, agent_count, hour_count, day_count
    ));
    base.meta = Some(meta);
    base
}

// ---------------------------------------------------------------------------
// GitHub Gist HTTP
// ---------------------------------------------------------------------------

const GIST_BACKUP_FILENAME: &str = "tokenlab.json";

/// `encodeURIComponent`
fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let c = b as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')') {
            out.push(c);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn github_headers(token: &str) -> reqwest::header::HeaderMap {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
    let mut h = HeaderMap::new();
    let mut put = |k: &'static str, v: String| {
        if let Ok(val) = HeaderValue::from_str(&v) {
            h.insert(HeaderName::from_static(k), val);
        }
    };
    put("accept", "application/vnd.github+json".to_string());
    put("authorization", format!("Bearer {}", token));
    put("content-type", "application/json".to_string());
    put("user-agent", format!("tokenlab/{}", VERSION));
    put("x-github-api-version", "2022-11-28".to_string());
    h
}

fn http_client() -> reqwest::Client {
    reqwest::Client::new()
}

/// Fetch the existing Gist backup JSON (no restore). `None` if missing/invalid.
/// Returns the raw JSON so callers keep every field verbatim.
pub async fn fetch_gist_backup_raw(token: &str, gist_id: &str) -> Option<Value> {
    let gist_id = js_trim(gist_id).to_string();
    if gist_id.is_empty() || token.is_empty() {
        return None;
    }
    let r: Result<Option<Value>, String> = async {
        let client = http_client();
        let res = client
            .get(format!("https://api.github.com/gists/{}", encode_uri_component(&gist_id)))
            .headers(github_headers(token))
            .send()
            .await
            .map_err(|e| err_msg(&e))?;
        if !res.status().is_success() {
            log(&format!("fetchGistBackup: {} for {}", res.status().as_u16(), gist_id));
            return Ok(None);
        }
        let data: Value = res.json().await.map_err(|e| err_msg(&e))?;
        let files = data.get("files").and_then(|f| f.as_object());
        let file = files.and_then(|f| f.get(GIST_BACKUP_FILENAME).or_else(|| f.values().next()));
        let file = match file {
            Some(f) => f,
            None => return Ok(None),
        };
        let mut text: String = file
            .get("content")
            .filter(|c| js_truthy(c))
            .map(js_string_of)
            .unwrap_or_default();
        // Large gists may truncate content - pull raw_url
        let truncated = file.get("truncated").map_or(false, js_truthy);
        let raw_url = file.get("raw_url").filter(|u| js_truthy(u)).map(js_string_of);
        if truncated {
            if let Some(url) = raw_url {
                let raw_res = client
                    .get(url)
                    .header("authorization", format!("Bearer {}", token))
                    .header("user-agent", format!("tokenlab/{}", VERSION))
                    .send()
                    .await
                    .map_err(|e| err_msg(&e))?;
                if raw_res.status().is_success() {
                    text = raw_res.text().await.map_err(|e| err_msg(&e))?;
                }
            }
        }
        if text.is_empty() {
            return Ok(None);
        }
        let raw: Value = serde_json::from_str(&text).map_err(|e| err_msg(&e))?;
        if !is_xlab_backup(&raw) {
            return Ok(None);
        }
        Ok(Some(raw))
    }
    .await;
    match r {
        Ok(v) => v,
        Err(msg) => {
            log_error(&format!("fetchGistBackup failed: {}", msg));
            None
        }
    }
}

/// Typed variant of [`fetch_gist_backup_raw`]. Events are sanitized first so
/// a legacy / foreign row never makes the whole backup fail to deserialize.
pub async fn fetch_gist_backup(token: &str, gist_id: &str) -> Option<XlabBackup> {
    let mut raw = fetch_gist_backup_raw(token, gist_id).await?;
    backup_from_value(&mut raw)
}

fn backup_from_value(raw: &mut Value) -> Option<XlabBackup> {
    if let Some(events) = raw.get("events").and_then(sanitize_events) {
        if let (Some(o), Ok(v)) = (raw.as_object_mut(), serde_json::to_value(&events)) {
            o.insert("events".to_string(), v);
        }
    }
    serde_json::from_value::<XlabBackup>(raw.clone()).ok()
}

/// Lenient `PortableBackupConfig` from raw JSON (remote Gist config).
fn portable_config_from_value(v: &Value) -> PortableBackupConfig {
    let mut out = PortableBackupConfig::default();
    let o = match v.as_object() {
        Some(o) => o,
        None => return out,
    };
    if let Some(p) = o.get("pricing").and_then(|p| p.as_object()) {
        let mut pricing = PricingConfig::default();
        if let Some(c) = p.get("currency").filter(|c| js_truthy(c)) {
            pricing.currency = Some(js_string_of(c));
        }
        if let Some(Value::Bool(b)) = p.get("preferRouterCost") {
            pricing.prefer_router_cost = Some(*b);
        }
        if let Some(r) = p.get("customRates").and_then(rates_from_value) {
            pricing.custom_rates = r;
        }
        out.pricing = Some(pricing);
    }
    if let Some(b) = o.get("backup").filter(|b| b.is_object()) {
        out.backup = serde_json::from_value::<PortableBackupBlock>(b.clone()).ok().or_else(|| {
            let bo = b.as_object()?;
            let s = |k: &str| bo.get(k).and_then(|x| x.as_str()).map(|x| x.to_string());
            Some(PortableBackupBlock {
                gist_id: s("gistId"),
                gist_url: s("gistUrl"),
                last_backup_at: s("lastBackupAt"),
                auto_daily: bo.get("autoDaily").and_then(|x| x.as_bool()),
            })
        });
    }
    out
}

#[derive(Debug, Clone, Default)]
pub struct UploadOpts {
    pub token: Option<String>,
    pub gist_id: Option<String>,
    pub public: Option<bool>,
    pub event_count_hint: Option<f64>,
    pub save_token: bool,
    /// When provided (even empty) a period-stats backup is built.
    pub events: Option<Vec<UsageEvent>>,
}

#[derive(Debug, Clone)]
pub struct UploadResult {
    pub backup: XlabBackup,
    pub gist: GistUploadResult,
    pub scope: &'static str,
}

fn machines_log(meta: Option<&BackupMeta>) -> String {
    match meta {
        Some(m) => match m.machines.as_ref().filter(|v| !v.is_empty()) {
            Some(v) => v.join(","),
            None => m.machine_id.clone().unwrap_or_default(),
        },
        None => String::new(),
    }
}

/// Create or update a secret GitHub Gist with period usage.
/// Multi-machine: downloads the existing Gist first, keeps other hosts' rollups,
/// replaces this host's slice, periodStats = sum of all machines.
pub async fn upload_backup_to_gist(opts: UploadOpts) -> anyhow::Result<UploadResult> {
    log("uploadBackupToGist called");
    log(&format!(
        "Options gistId: {} public: {} saveToken: {} events: {}",
        opts.gist_id.as_deref().unwrap_or("undefined"),
        opts.public.map_or("undefined".to_string(), |b| b.to_string()),
        opts.save_token,
        opts.events.as_ref().map_or(0, |e| e.len())
    ));

    let token = match github_token(opts.token.as_deref()) {
        Some(t) => t,
        None => {
            log_error("Missing GitHub token");
            anyhow::bail!(
                "Missing GitHub token. Pass token, set XLAB_GITHUB_TOKEN / GITHUB_TOKEN, or save one in Settings."
            );
        }
    };
    log(&format!("GitHub token resolved (length): {}", token.chars().count()));

    let prev_id: String = opts
        .gist_id
        .as_deref()
        .map(|s| js_trim(s).to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            get_config_sync()
                .backup
                .as_ref()
                .and_then(|b| b.gist_id.clone())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_default();

    // Multi-machine: pull remote before overwrite
    let mut remote: Option<Value> = None;
    if !prev_id.is_empty() {
        remote = fetch_gist_backup_raw(&token, &prev_id).await;
        if let Some(r) = &remote {
            let n = r.get("events").and_then(|e| e.as_array()).map_or(0, |a| a.len());
            let machines = r
                .get("meta")
                .and_then(|m| {
                    m.get("machines")
                        .and_then(|a| a.as_array())
                        .filter(|a| !a.is_empty())
                        .map(|a| a.iter().map(js_string_of).collect::<Vec<_>>().join(","))
                        .or_else(|| m.get("machineId").filter(|v| js_truthy(v)).map(js_string_of))
                })
                .unwrap_or_else(|| "?".to_string());
            log(&format!("Fetched remote Gist for merge: events= {} machines= {}", n, machines));
        }
    }

    // Period-stats (by model + agent) when we have the event cache
    let (backup, scope): (XlabBackup, &'static str) = match &opts.events {
        Some(events) => {
            let remote_events = remote.as_ref().and_then(|r| r.get("events")).and_then(sanitize_events);
            let remote_config = remote
                .as_ref()
                .and_then(|r| r.get("config"))
                .map(portable_config_from_value);
            (
                build_gist_full_backup(
                    events,
                    GistBackupOpts {
                        remote_events,
                        machine_id: None,
                        remote_config,
                    },
                )
                .await,
                SCOPE_PERIOD_STATS,
            )
        }
        None => (
            build_settings_backup(Some(&SettingsBackupOpts {
                event_count_hint: opts.event_count_hint,
                note: Some(
                    "Settings only \u{2014} no usage cache available at upload time; Rescan then backup again"
                        .to_string(),
                ),
            })),
            SCOPE_SETTINGS,
        ),
    };
    {
        let m = backup.meta.as_ref();
        log(&format!(
            "Backup built, scope: {} sourceEvents: {} rollups: {} models: {} agents: {} machines: {}",
            scope,
            m.and_then(|m| m.source_event_count).map_or("0".to_string(), js_num_to_string),
            backup.events.as_ref().map_or(0, |e| e.len()),
            m.and_then(|m| m.model_count).map_or("0".to_string(), js_num_to_string),
            m.and_then(|m| m.agent_count).map_or("0".to_string(), js_num_to_string),
            machines_log(m)
        ));
    }

    // Compact JSON (no pretty-print)
    let content = serde_json::to_string(&backup)?;
    let size = content.len();
    if size > GIST_MAX_BYTES {
        anyhow::bail!(
            "Period-stats backup is {}MB (limit ~{}MB). Use Export full download instead, or reduce history.",
            js_num_to_string(js_round(size as f64 / 1024.0 / 1024.0)),
            js_num_to_string(js_round(GIST_MAX_BYTES as f64 / 1024.0 / 1024.0)),
        );
    }

    let filename = GIST_BACKUP_FILENAME;
    let meta_ref = backup.meta.as_ref();
    let machines_label = {
        let joined = meta_ref
            .and_then(|m| m.machines.as_ref())
            .map(|v| v.join("+"))
            .unwrap_or_default();
        if !joined.is_empty() {
            joined
        } else {
            let mid = meta_ref.and_then(|m| m.machine_id.clone()).unwrap_or_default();
            if mid.is_empty() {
                "1host".to_string()
            } else {
                mid
            }
        }
    };
    let description = format!(
        "TokenLab multi-machine \u{00b7} {} \u{00b7} {} models \u{00b7} {} agents \u{00b7} {} \u{00b7} v{}",
        machines_label,
        meta_ref.and_then(|m| m.model_count).map_or("0".to_string(), js_num_to_string),
        meta_ref.and_then(|m| m.agent_count).map_or("0".to_string(), js_num_to_string),
        backup.exported_at,
        backup.app_version
    );

    let client = http_client();
    let headers = github_headers(&token);
    let is_public = opts.public == Some(true);
    let patch_body = || {
        serde_json::json!({
            "description": description,
            "files": { filename: { "content": content } },
        })
    };
    let post_body = || {
        serde_json::json!({
            "description": description,
            "public": is_public,
            "files": { filename: { "content": content } },
        })
    };

    // One secret Gist, one file (tokenlab.json). PATCH = new revision; POST only
    // when no gistId yet or the stored gist was deleted (404).
    let mut updated = false;
    let res: reqwest::Response;
    if !prev_id.is_empty() {
        log(&format!(
            "Updating existing Gist (PATCH revision): {} file: {}",
            prev_id, filename
        ));
        let r = client
            .patch(format!("https://api.github.com/gists/{}", encode_uri_component(&prev_id)))
            .headers(headers.clone())
            .body(serde_json::to_string(&patch_body())?)
            .send()
            .await?;
        updated = r.status().is_success();
        if r.status().as_u16() == 404 {
            log("Stored gist 404 (deleted) \u{2014} creating one replacement Gist, not a new file");
            updated = false;
            res = client
                .post("https://api.github.com/gists")
                .headers(headers.clone())
                .body(serde_json::to_string(&post_body())?)
                .send()
                .await?;
        } else {
            res = r;
        }
    } else {
        log(&format!("No gistId in config \u{2014} creating first Gist with {}", filename));
        res = client
            .post("https://api.github.com/gists")
            .headers(headers.clone())
            .body(serde_json::to_string(&post_body())?)
            .send()
            .await?;
    }

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        let head = slice_prefix(&text, 240);
        let shown = if head.is_empty() {
            status.canonical_reason().unwrap_or("").to_string()
        } else {
            head
        };
        anyhow::bail!("GitHub Gist API {}: {}", status.as_u16(), shown);
    }

    let data: Value = res.json().await?;
    let id = data.get("id").filter(|v| js_truthy(v)).map(js_string_of);
    let html_url = data.get("html_url").filter(|v| js_truthy(v)).map(js_string_of);
    let (id, html_url) = match (id, html_url) {
        (Some(i), Some(u)) => (i, u),
        _ => anyhow::bail!("GitHub Gist response missing id/url"),
    };

    let gist = GistUploadResult {
        id,
        html_url,
        public: data.get("public").map_or(false, js_truthy),
        updated,
    };

    let mut cfg = load_config().await;
    let mut b = cfg.backup.clone().unwrap_or_default();
    b.gist_id = Some(gist.id.clone());
    b.gist_url = Some(gist.html_url.clone());
    b.last_backup_at = Some(backup.exported_at.clone());
    if opts.save_token && !token.is_empty() {
        b.github_token = Some(token.clone());
    }
    cfg.backup = Some(b);
    save_config(&cfg).await?;
    // Prevent legacy xlab-token config from resurrecting a deleted gistId on restart
    sync_legacy_gist_meta(
        Some(gist.id.clone()),
        Some(gist.html_url.clone()),
        Some(backup.exported_at.clone()),
    )
    .await;
    log(&format!(
        "{} {} {}",
        if updated {
            "Gist revised (same link):"
        } else {
            "Gist created (new link once):"
        },
        gist.id,
        gist.html_url
    ));

    Ok(UploadResult { backup, gist, scope })
}

#[derive(Debug, Clone)]
pub struct DownloadResult {
    /// Raw backup JSON exactly as stored in the Gist.
    pub backup: Value,
    pub restored: RestoreResult,
}

/// Download a backup from a GitHub Gist and restore it locally.
/// If `gist_id` is omitted, uses the one saved in config.
pub async fn download_backup_from_gist(token: Option<&str>, gist_id: Option<&str>) -> anyhow::Result<DownloadResult> {
    log("downloadBackupFromGist called");
    let token = match github_token(token) {
        Some(t) => t,
        None => {
            log_error("Missing GitHub token for download");
            anyhow::bail!(
                "Missing GitHub token. Pass token, set XLAB_GITHUB_TOKEN / GITHUB_TOKEN, or save one in Settings."
            );
        }
    };

    let gist_id: String = gist_id
        .map(|s| js_trim(s).to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            get_config_sync()
                .backup
                .as_ref()
                .and_then(|b| b.gist_id.clone())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_default();
    if gist_id.is_empty() {
        log_error("No gistId provided or saved in config");
        anyhow::bail!("No gistId provided or saved in config.");
    }
    log(&format!("Downloading gist: {}", gist_id));

    let backup = match fetch_gist_backup_raw(&token, &gist_id).await {
        Some(b) => b,
        None => {
            log_error("Gist has no usable backup file");
            anyhow::bail!("Gist has no usable backup file (or invalid format).");
        }
    };

    {
        let n = backup.get("events").and_then(|e| e.as_array()).map_or(0, |a| a.len());
        let scope = backup.get("scope").map(js_string_of).unwrap_or_else(|| "undefined".to_string());
        let machines = backup
            .get("meta")
            .and_then(|m| {
                m.get("machines")
                    .and_then(|a| a.as_array())
                    .filter(|a| !a.is_empty())
                    .map(|a| a.iter().map(js_string_of).collect::<Vec<_>>().join(","))
                    .or_else(|| m.get("machineId").filter(|v| js_truthy(v)).map(js_string_of))
            })
            .unwrap_or_default();
        log(&format!(
            "Backup downloaded, events: {} scope: {} machines: {}",
            n, scope, machines
        ));
    }
    let restored = restore_backup(&backup).await?;
    log(&format!("Backup restored, scope: {}", restored.scope));

    // Save gist metadata to config if not present
    let mut cfg = load_config().await;
    let has_id = cfg
        .backup
        .as_ref()
        .and_then(|b| b.gist_id.as_deref())
        .map_or(false, |s| !s.is_empty());
    if !has_id {
        let mut b = cfg.backup.clone().unwrap_or_default();
        b.gist_id = Some(gist_id.clone());
        cfg.backup = Some(b);
        save_config(&cfg).await?;
        log("Saved gist metadata to config");
    }

    Ok(DownloadResult { backup, restored })
}

/// True if `last_backup_at` is on or after the start of "today" in the given
/// timezone (same calendar day as dashboard "Today").
pub fn is_backup_done_today(last_backup_at: Option<&str>, time_zone: Option<&str>) -> bool {
    let last = match last_backup_at {
        Some(s) if !s.is_empty() => js_date_parse(s),
        _ => return false,
    };
    if last.is_nan() {
        return false;
    }
    let start = start_of_day_in_time_zone(time_zone, now_ms());
    last >= start
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum AutoDailyGistResult {
    Skipped {
        ok: bool,
        skipped: bool,
        reason: String,
    },
    Done {
        ok: bool,
        skipped: bool,
        gist: GistUploadResult,
        #[serde(rename = "exportedAt")]
        exported_at: String,
    },
    Failed {
        ok: bool,
        error: String,
    },
}

impl AutoDailyGistResult {
    fn skipped(reason: &str) -> Self {
        AutoDailyGistResult::Skipped {
            ok: true,
            skipped: true,
            reason: reason.to_string(),
        }
    }
}

type AutoDailyRx = tokio::sync::watch::Receiver<Option<AutoDailyGistResult>>;

static AUTO_DAILY_IN_FLIGHT: Lazy<Mutex<Option<AutoDailyRx>>> = Lazy::new(|| Mutex::new(None));

/// Clears the in-flight slot even if the leader future is dropped.
struct AutoDailySlotGuard;

impl Drop for AutoDailySlotGuard {
    fn drop(&mut self) {
        *AUTO_DAILY_IN_FLIGHT.lock() = None;
    }
}

async fn auto_daily_work(events: &[UsageEvent]) -> AutoDailyGistResult {
    let r: anyhow::Result<AutoDailyGistResult> = async {
        // Disk load - never trust cold get_config_sync() defaults for gistId
        let cfg = load_config().await;
        if cfg.backup.as_ref().and_then(|b| b.auto_daily) == Some(false) {
            return Ok(AutoDailyGistResult::skipped("disabled"));
        }
        let gist_id = cfg
            .backup
            .as_ref()
            .and_then(|b| b.gist_id.as_deref())
            .map(|s| js_trim(s).to_string())
            .filter(|s| !s.is_empty());
        let token = github_token(None);
        let gist_id = match gist_id {
            Some(g) => g,
            None => return Ok(AutoDailyGistResult::skipped("no-gist")),
        };
        let token = match token {
            Some(t) => t,
            None => return Ok(AutoDailyGistResult::skipped("no-token")),
        };
        if is_backup_done_today(
            cfg.backup.as_ref().and_then(|b| b.last_backup_at.as_deref()),
            cfg.timezone.as_deref(),
        ) {
            return Ok(AutoDailyGistResult::skipped("already-today"));
        }
        if events.is_empty() {
            return Ok(AutoDailyGistResult::skipped("no-events"));
        }

        log(&format!(
            "auto daily Gist backup starting\u{2026} {} events gistId: {}",
            events.len(),
            gist_id
        ));
        let result = upload_backup_to_gist(UploadOpts {
            token: Some(token),
            gist_id: Some(gist_id),
            events: Some(events.to_vec()),
            public: Some(false),
            ..Default::default()
        })
        .await?;
        log(&format!("auto daily Gist backup OK: {}", result.gist.html_url));
        Ok(AutoDailyGistResult::Done {
            ok: true,
            skipped: false,
            gist: result.gist,
            exported_at: result.backup.exported_at,
        })
    }
    .await;
    match r {
        Ok(v) => v,
        Err(err) => {
            let msg = err.to_string();
            log_error(&format!("auto daily Gist backup failed: {}", msg));
            AutoDailyGistResult::Failed { ok: false, error: msg }
        }
    }
}

/// Background daily Gist backup when gistId + token exist and autoDaily !== false.
/// At most one successful upload per local calendar day (uses lastBackupAt).
/// Concurrent callers share the single in-flight run.
pub async fn try_auto_daily_gist_backup(events: &[UsageEvent]) -> AutoDailyGistResult {
    enum Role {
        Leader(tokio::sync::watch::Sender<Option<AutoDailyGistResult>>),
        Follower(AutoDailyRx),
    }
    let role = {
        let mut slot = AUTO_DAILY_IN_FLIGHT.lock();
        match slot.as_ref() {
            Some(rx) => Role::Follower(rx.clone()),
            None => {
                let (tx, rx) = tokio::sync::watch::channel(None);
                *slot = Some(rx);
                Role::Leader(tx)
            }
        }
    };
    match role {
        Role::Follower(mut rx) => match rx.wait_for(|v| v.is_some()).await {
            Ok(v) => v.clone().unwrap_or(AutoDailyGistResult::Failed {
                ok: false,
                error: "auto daily backup aborted".to_string(),
            }),
            Err(_) => AutoDailyGistResult::Failed {
                ok: false,
                error: "auto daily backup aborted".to_string(),
            },
        },
        Role::Leader(tx) => {
            let _guard = AutoDailySlotGuard;
            let result = auto_daily_work(events).await;
            let _ = tx.send(Some(result.clone()));
            result
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(id: &str, ts: &str, model: &str, tokens: f64, cost: f64) -> UsageEvent {
        UsageEvent {
            id: id.to_string(),
            agent: AgentId::ClaudeCode,
            model: Some(model.to_string()),
            timestamp: ts.to_string(),
            input_tokens: tokens,
            total_tokens: tokens,
            estimated_cost: Some(cost),
            currency: "USD".to_string(),
            pricing_status: PricingStatus::Priced,
            source_path: "x.jsonl".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn sanitize_machine_id_rules() {
        assert_eq!(sanitize_machine_id("  My PC!! "), "My-PC");
        assert_eq!(sanitize_machine_id("!!!"), "unknown");
        assert_eq!(sanitize_machine_id("a.b_c-d"), "a.b_c-d");
        assert_eq!(sanitize_machine_id(&"x".repeat(100)).len(), 64);
    }

    #[test]
    fn sanitize_events_coerces() {
        let raw = json!([
            {"id": "a", "agent": "claude-code", "inputTokens": "5", "outputTokens": 2, "timestamp": "2026-01-01T00:00:00.000Z"},
            {"id": 3, "agent": "claude-code"},
            "junk"
        ]);
        let out = sanitize_events(&raw).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].input_tokens, 5.0);
        assert_eq!(out[0].total_tokens, 7.0);
        assert_eq!(out[0].currency, "USD");
        assert_eq!(out[0].source_path, "backup");
        assert!(sanitize_events(&json!({})).is_none());
    }

    #[test]
    fn salvage_recovers_truncated_array() {
        let text = r#"[{"id":"a","agent":"claude-code","inputTokens":1},{"id":"b","agent":"claude-code","note":"}{"},{"id":"c","agent":"cl"#;
        let out = salvage_scan_cache_json(text);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1].id, "b");
    }

    #[test]
    fn mirror_path_rejects_traversal() {
        let root = if cfg!(windows) { "C:\\data\\mirrors" } else { "/data/mirrors" };
        assert!(safe_mirror_path(root, "9router/usage-daily.json").is_some());
        assert!(safe_mirror_path(root, "../evil.json").is_none());
        assert!(safe_mirror_path(root, "a/../../evil.json").is_none());
        assert!(safe_mirror_path(root, "").is_none());
        assert!(safe_mirror_path(root, "C:/evil.json").is_none());
    }

    #[test]
    fn mirror_allow_rules() {
        assert!(is_allowed_mirror("9router/usage-daily.json"));
        assert!(!is_allowed_mirror("9router/usage-history.jsonl"));
        assert!(!is_allowed_mirror("x/history.json"));
        assert!(is_allowed_mirror("x/other.json"));
    }

    #[test]
    fn rollups_bucket_by_hour_and_day() {
        let now = js_date_parse("2026-03-20T12:00:00.000Z");
        let events = vec![
            ev("1", "2026-03-20T11:10:00.000Z", "Claude-X", 10.0, 1.0),
            ev("2", "2026-03-20T11:50:00.000Z", "claude-x", 5.0, 0.5),
            ev("3", "2026-01-02T03:00:00.000Z", "claude-x", 7.0, 0.25),
        ];
        let out = build_gist_restore_rollups(&events, now, Some("HostA"));
        assert_eq!(out.len(), 2);
        assert!(out[0].source_path.starts_with("backup:gist-hour:HostA"));
        assert_eq!(out[0].input_tokens, 15.0);
        assert_eq!(out[0].estimated_cost, Some(1.5));
        assert!(out[1].source_path.starts_with("backup:gist-daily:HostA"));
        assert_eq!(machine_id_from_event(&out[0]), "HostA");
    }

    #[test]
    fn multi_machine_keeps_foreign_rollups() {
        let now = js_date_parse("2026-03-20T12:00:00.000Z");
        let mine = build_gist_restore_rollups(&[ev("1", "2026-03-20T11:10:00.000Z", "m", 10.0, 1.0)], now, Some("A"));
        let theirs = build_gist_restore_rollups(&[ev("9", "2026-03-20T10:10:00.000Z", "m", 3.0, 0.3)], now, Some("B"));
        let old_mine = build_gist_restore_rollups(&[ev("8", "2026-03-20T09:10:00.000Z", "m", 4.0, 0.4)], now, Some("A"));
        let mut remote = theirs.clone();
        remote.extend(old_mine);
        let merged = merge_multi_machine_gist_rollups(&mine, Some(&remote), Some("A"));
        assert_eq!(merged.len(), 2);
        let machines = list_machines_from_events(&merged, Some("A"));
        assert_eq!(machines, vec!["A".to_string(), "B".to_string()]);
    }

    #[test]
    fn encode_component_matches_js() {
        assert_eq!(encode_uri_component("abc-123"), "abc-123");
        assert_eq!(encode_uri_component("a b/c"), "a%20b%2Fc");
    }

    #[test]
    fn is_xlab_backup_checks_format() {
        assert!(is_xlab_backup(&json!({"format": "tokenlab", "config": {}})));
        assert!(is_xlab_backup(&json!({"format": "xlab-token-backup", "config": {}})));
        assert!(!is_xlab_backup(&json!({"format": "other", "config": {}})));
        assert!(!is_xlab_backup(&json!({"format": "tokenlab"})));
        assert!(!is_xlab_backup(&json!(null)));
    }
}
