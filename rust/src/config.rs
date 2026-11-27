//! Port of `src/config.ts`: `config.json` load / merge / save with unknown-key
//! preservation, a memoized frozen "sync view" and the scan cadence helpers.

use crate::types::{jsnum, ModelRate};
use crate::util::{
    app_data_dir, env_nonempty, js_number_from_str, js_round, js_trim, local_offset_at_utc, now_ms, path_exists,
    path_flavor, pjoin,
};
use indexmap::IndexMap;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use std::sync::Arc;

/// Background light scan cadence (minutes) when config says nothing (1h).
pub const DEFAULT_SCAN_INTERVAL_MINUTES: f64 = 60.0;
/// Full all-agent rescan cadence (minutes) when config says nothing (1h).
pub const DEFAULT_FULL_SCAN_INTERVAL_MINUTES: f64 = 60.0;
const MIN_SCAN_INTERVAL_MINUTES: f64 = 1.0;
const MAX_SCAN_INTERVAL_MINUTES: f64 = 60.0;
const MIN_FULL_SCAN_INTERVAL_MINUTES: f64 = 5.0;
const MAX_FULL_SCAN_INTERVAL_MINUTES: f64 = 1440.0;

// ---------------------------------------------------------------------------
// Lenient (de)serialization helpers: a hand-edited config.json with a wrongly
// typed field must degrade to "unset", never fail the whole load.
// ---------------------------------------------------------------------------

fn lenient<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let v = Option::<Value>::deserialize(d)?;
    Ok(v.and_then(|v| T::deserialize(v).ok()))
}

fn lenient_num<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    let v = Option::<Value>::deserialize(d)?;
    Ok(match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => {
            let n = js_number_from_str(&s);
            if n.is_nan() {
                None
            } else {
                Some(n)
            }
        }
        _ => None,
    })
}

fn lenient_rates<'de, D: Deserializer<'de>>(d: D) -> Result<IndexMap<String, ModelRate>, D::Error> {
    let v = Option::<Value>::deserialize(d)?;
    let mut out = IndexMap::new();
    if let Some(Value::Object(o)) = v {
        for (k, val) in o {
            if let Ok(r) = ModelRate::deserialize(val) {
                out.insert(k, r);
            }
        }
    }
    Ok(out)
}

fn lenient_extra<'de, D: Deserializer<'de>>(d: D) -> Result<Map<String, Value>, D::Error> {
    Map::<String, Value>::deserialize(d)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateFlagConfig {
    /// Hours of first->last span at or above which a day is flagged.
    #[serde(default, deserialize_with = "lenient_num", serialize_with = "jsnum::ser_opt", skip_serializing_if = "Option::is_none")]
    pub span_hours: Option<f64>,
    /// Hours of request-bearing minutes at or above which a day is flagged.
    #[serde(default, deserialize_with = "lenient_num", serialize_with = "jsnum::ser_opt", skip_serializing_if = "Option::is_none")]
    pub active_hours: Option<f64>,
    /// Gap in seconds still counted as the same continuous run.
    #[serde(default, deserialize_with = "lenient_num", serialize_with = "jsnum::ser_opt", skip_serializing_if = "Option::is_none")]
    pub continuous_gap_seconds: Option<f64>,
    /// Idle hours inside the span allowed before a day reads as "always on".
    #[serde(default, deserialize_with = "lenient_num", serialize_with = "jsnum::ser_opt", skip_serializing_if = "Option::is_none")]
    pub max_idle_hours: Option<f64>,
    /// Share (0-1) of sub-60s gaps that reads as an automated cadence.
    #[serde(default, deserialize_with = "lenient_num", serialize_with = "jsnum::ser_opt", skip_serializing_if = "Option::is_none")]
    pub automated_gap_share: Option<f64>,
    #[serde(flatten, deserialize_with = "lenient_extra")]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitConfig {
    /// Windows as "limit/window" pairs, e.g. "1/1s,60/60s".
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub windows: Option<String>,
    /// Model ids the guard applies to; "*" or empty means all.
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub models: Option<String>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub flag: Option<RateFlagConfig>,
    #[serde(flatten, deserialize_with = "lenient_extra")]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingConfig {
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    /// Prefer router-reported cost when > 0 (default true).
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub prefer_router_cost: Option<bool>,
    /// USD per 1M tokens overrides, keyed by normalized model name.
    #[serde(default, deserialize_with = "lenient_rates")]
    pub custom_rates: IndexMap<String, ModelRate>,
    #[serde(flatten, deserialize_with = "lenient_extra")]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanConfig {
    /// Minutes between two background light scans (1-60). Default 60.
    #[serde(default, deserialize_with = "lenient_num", serialize_with = "jsnum::ser_opt", skip_serializing_if = "Option::is_none")]
    pub interval_minutes: Option<f64>,
    // Field order mirrors normalizeScanConfig() so config.json key order matches TS.
    /// Minutes between two full all-agent scans (5-1440). Default 60.
    #[serde(default, deserialize_with = "lenient_num", serialize_with = "jsnum::ser_opt", skip_serializing_if = "Option::is_none")]
    pub full_interval_minutes: Option<f64>,
    /// When false, no background scan runs (manual Rescan still works). Default true.
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub periodic_enabled: Option<bool>,
    #[serde(flatten, deserialize_with = "lenient_extra")]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupConfig {
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub gist_id: Option<String>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub gist_url: Option<String>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub last_backup_at: Option<String>,
    /// Optional classic PAT with `gist` scope (prefer env XLAB_GITHUB_TOKEN).
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub github_token: Option<String>,
    /// When true (default) and gistId + token exist, auto-upload once per local day.
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub auto_daily: Option<bool>,
    #[serde(flatten, deserialize_with = "lenient_extra")]
    pub extra: Map<String, Value>,
}

/// Top-level key order of the config object as loaded / merged. JS objects keep
/// insertion order, so the TS build writes (and serves) config.json keys in the
/// order they were first added; this lets the typed struct do the same instead of
/// always emitting struct-field order. Ignored by equality.
#[derive(Debug, Clone, Default)]
pub struct KeyOrder(pub Vec<String>);

impl PartialEq for KeyOrder {
    fn eq(&self, _other: &Self) -> bool {
        true
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XlabTokenConfig {
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, deserialize_with = "lenient_num", serialize_with = "jsnum::ser_opt", skip_serializing_if = "Option::is_none")]
    pub port: Option<f64>,
    /// IANA timezone for "Today" / "Yesterday" filters; "local" or "UTC" allowed.
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub pricing: Option<PricingConfig>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub scan: Option<ScanConfig>,
    /// RATES_VERSION the scan cache was last priced with. Managed automatically.
    #[serde(default, deserialize_with = "lenient_num", serialize_with = "jsnum::ser_opt", skip_serializing_if = "Option::is_none")]
    pub scan_cache_rates_version: Option<f64>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub backup: Option<BackupConfig>,
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub rate_limit: Option<RateLimitConfig>,
    #[serde(flatten, deserialize_with = "lenient_extra")]
    pub extra: Map<String, Value>,
    #[serde(skip)]
    pub key_order: KeyOrder,
}

fn default_config() -> XlabTokenConfig {
    XlabTokenConfig {
        timezone: Some("local".to_string()),
        pricing: Some(PricingConfig {
            currency: Some("USD".to_string()),
            prefer_router_cost: Some(true),
            custom_rates: IndexMap::new(),
            extra: Map::new(),
        }),
        scan: Some(ScanConfig {
            interval_minutes: Some(DEFAULT_SCAN_INTERVAL_MINUTES),
            periodic_enabled: Some(true),
            full_interval_minutes: Some(DEFAULT_FULL_SCAN_INTERVAL_MINUTES),
            extra: Map::new(),
        }),
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Default)]
struct State {
    cached: Option<XlabTokenConfig>,
    /// Pre-normalized snapshot handed to hot paths (pricing runs per event).
    sync_view: Option<Arc<XlabTokenConfig>>,
}

static STATE: Lazy<Mutex<State>> = Lazy::new(|| Mutex::new(State::default()));

/// Serializes config read-merge-write sequences.
static CONFIG_WRITE: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));
/// True while config.json exists but could not be parsed (kept on disk, backed up).
static CONFIG_CORRUPT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Write `contents` to `path` via a unique temp file + rename. Falls back to a
/// direct write if the rename keeps failing (locked target on Windows).
pub(crate) async fn write_atomic(path: &str, contents: &[u8]) -> std::io::Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = format!("{}.{}.{}.tmp", path, std::process::id(), now);
    if tokio::fs::write(&tmp, contents).await.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
        return tokio::fs::write(path, contents).await;
    }
    for attempt in 0..4u64 {
        if tokio::fs::rename(&tmp, path).await.is_ok() {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(40 * (attempt + 1))).await;
    }
    let r = tokio::fs::write(path, contents).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    r
}

fn build_sync_view(c: &XlabTokenConfig) -> XlabTokenConfig {
    let mut view = c.clone();
    view.timezone = Some(normalize_timezone(c.timezone.as_deref()));
    if let Some(p) = &c.pricing {
        let mut p = p.clone();
        // customRates is always an object in the view
        let _ = &mut p.custom_rates;
        view.pricing = Some(p);
    }
    if let Some(rl) = &c.rate_limit {
        let mut rl = rl.clone();
        if rl.flag.is_none() {
            rl.flag = Some(RateFlagConfig::default());
        }
        view.rate_limit = Some(rl);
    }
    view
}

fn set_cached_config(next: Option<XlabTokenConfig>) {
    let mut s = STATE.lock();
    s.cached = next;
    s.sync_view = None;
}

/// Path of `config.json` (TOKENLAB_CONFIG, or TOKENLAB_DATA_DIR / %APPDATA%\tokenlab).
pub fn config_path() -> String {
    if let Some(p) = env_nonempty("TOKENLAB_CONFIG") {
        return p;
    }
    let dir = env_nonempty("TOKENLAB_DATA_DIR").unwrap_or_else(|| pjoin(&[app_data_dir().as_str(), "tokenlab"]));
    pjoin(&[dir.as_str(), "config.json"])
}

/// Normalize timezone for "Today" filters (a stored "UTC" on a non-UTC machine
/// is a common misconfig, so prefer machine local unless forced).
pub fn normalize_timezone(tz: Option<&str>) -> String {
    let t = tz.map(js_trim).filter(|s| !s.is_empty()).unwrap_or("local");
    if t == "UTC" || t == "Etc/UTC" {
        if std::env::var("TOKENLAB_FORCE_UTC").ok().as_deref() == Some("1") {
            return "UTC".to_string();
        }
        if local_offset_at_utc(now_ms()) != 0.0 {
            return "local".to_string();
        }
    }
    t.to_string()
}

fn merge_objects(parts: &[Option<&Map<String, Value>>]) -> Map<String, Value> {
    let mut out = Map::new();
    for p in parts.iter().flatten() {
        for (k, v) in p.iter() {
            out.insert(k.clone(), v.clone());
        }
    }
    out
}

fn obj<'a>(v: Option<&'a Value>) -> Option<&'a Map<String, Value>> {
    match v {
        Some(Value::Object(o)) => Some(o),
        _ => None,
    }
}

/// `mergeConfig(base, over)` evaluated on raw JSON so key order and unknown
/// keys behave exactly like the object spreads in the TS version.
fn merge_config_values(base: &Map<String, Value>, over: &Map<String, Value>) -> Map<String, Value> {
    let mut out = merge_objects(&[Some(base), Some(over)]);

    let tz_src = match over.get("timezone") {
        Some(Value::Null) | None => base.get("timezone"),
        Some(v) => Some(v),
    };
    let tz = match tz_src {
        Some(Value::String(s)) => normalize_timezone(Some(s.as_str())),
        Some(Value::Null) | None => normalize_timezone(Some("local")),
        Some(other) => normalize_timezone(Some(&value_to_js_string(other))),
    };
    out.insert("timezone".to_string(), Value::String(tz));

    let base_p = obj(base.get("pricing"));
    let over_p = obj(over.get("pricing"));
    let mut pricing = merge_objects(&[base_p, over_p]);
    let base_rates = base_p.and_then(|p| obj(p.get("customRates")));
    let over_rates = over_p.and_then(|p| obj(p.get("customRates")));
    pricing.insert("customRates".to_string(), Value::Object(merge_objects(&[base_rates, over_rates])));
    out.insert("pricing".to_string(), Value::Object(pricing));

    let merged_scan = merge_objects(&[obj(base.get("scan")), obj(over.get("scan"))]);
    let scan_typed: ScanConfig = serde_json::from_value(Value::Object(merged_scan)).unwrap_or_default();
    let scan_norm = normalize_scan_config(Some(&scan_typed));
    out.insert("scan".to_string(), serde_json::to_value(scan_norm).unwrap_or(Value::Null));

    let backup = merge_objects(&[obj(base.get("backup")), obj(over.get("backup"))]);
    out.insert("backup".to_string(), Value::Object(backup));
    out
}

fn value_to_js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => crate::util::js_num_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}

/// The config as a JSON object, top-level keys in the order they were loaded
/// (struct order for keys that were never seen), like the TS object spreads.
pub fn to_map(cfg: &XlabTokenConfig) -> Map<String, Value> {
    let mut m = match serde_json::to_value(cfg) {
        Ok(Value::Object(o)) => o,
        _ => Map::new(),
    };
    if cfg.key_order.0.is_empty() {
        return m;
    }
    let mut out = Map::new();
    for k in &cfg.key_order.0 {
        if let Some(v) = m.shift_remove(k) {
            out.insert(k.clone(), v);
        }
    }
    for (k, v) in m {
        out.insert(k, v);
    }
    out
}

fn from_map(m: Map<String, Value>) -> XlabTokenConfig {
    config_from_value(Value::Object(m)).unwrap_or_default()
}

/// Typed config from a JSON value, remembering its top-level key order.
pub fn config_from_value(v: Value) -> Result<XlabTokenConfig, serde_json::Error> {
    let order: Vec<String> = match &v {
        Value::Object(o) => o.keys().cloned().collect(),
        _ => Vec::new(),
    };
    let mut cfg: XlabTokenConfig = serde_json::from_value(v)?;
    cfg.key_order = KeyOrder(order);
    Ok(cfg)
}

/// `mergeConfig(base, over)` on typed configs.
fn merge_config(base: &XlabTokenConfig, over: &XlabTokenConfig) -> XlabTokenConfig {
    from_map(merge_config_values(&to_map(base), &to_map(over)))
}

fn pretty(cfg: &XlabTokenConfig) -> String {
    serde_json::to_string_pretty(&Value::Object(to_map(cfg))).unwrap_or_else(|_| "{}".to_string())
}

/// Load (and memoize) the merged config; falls back to defaults on any failure.
pub async fn load_config() -> XlabTokenConfig {
    if let Some(c) = STATE.lock().cached.clone() {
        return c;
    }
    let p = config_path();
    if path_exists(&p).await {
        if let Ok(bytes) = tokio::fs::read(&p).await {
            let raw = match String::from_utf8(bytes) {
                Ok(s) => s,
                Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
            };
            let parsed = serde_json::from_str::<Value>(&raw);
            if !matches!(parsed, Ok(Value::Object(_))) && !raw.trim().is_empty() {
                // Keep the unreadable file so it is never silently lost.
                CONFIG_CORRUPT.store(true, std::sync::atomic::Ordering::SeqCst);
                let ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                let _ = tokio::fs::copy(&p, format!("{}.corrupt-{}", p, ms)).await;
            }
            if let Ok(Value::Object(parsed_map)) = parsed {
                CONFIG_CORRUPT.store(false, std::sync::atomic::Ordering::SeqCst);
                let base = to_map(&default_config());
                let mut merged_map = merge_config_values(&base, &parsed_map);
                let parsed_tz = parsed_map.get("timezone").and_then(|v| v.as_str()).map(|s| s.to_string());
                let mut merged = from_map(std::mem::take(&mut merged_map));
                set_cached_config(Some(merged.clone()));
                // Persist migration UTC -> local once so Settings/API stay consistent
                if matches!(parsed_tz.as_deref(), Some("UTC") | Some("Etc/UTC")) {
                    let fixed = normalize_timezone(parsed_tz.as_deref());
                    if fixed != "UTC" {
                        merged.timezone = Some(fixed);
                        set_cached_config(Some(merged.clone()));
                        let _ = write_atomic(&p, pretty(&merged).as_bytes()).await;
                    }
                }
                return merged;
            }
        }
    }
    let fallback = default_config();
    set_cached_config(Some(fallback.clone()));
    fallback
}

/// Hot-path config read: a cached, pre-normalized view (no clone per call).
pub fn get_config_sync() -> Arc<XlabTokenConfig> {
    let mut s = STATE.lock();
    if let Some(v) = &s.sync_view {
        return v.clone();
    }
    let view = Arc::new(match &s.cached {
        Some(c) => build_sync_view(c),
        None => build_sync_view(&default_config()),
    });
    s.sync_view = Some(view.clone());
    view
}

fn clamp_minutes(value: Option<f64>, min: f64, max: f64, fallback: f64) -> f64 {
    let n = match value {
        Some(v) => js_round(v),
        None => f64::NAN,
    };
    if !n.is_finite() {
        return fallback;
    }
    n.max(min).min(max)
}

/// Resolved background light-scan cadence in minutes (clamped, never NaN).
pub fn scan_interval_minutes() -> f64 {
    clamp_minutes(
        get_config_sync().scan.as_ref().and_then(|s| s.interval_minutes),
        MIN_SCAN_INTERVAL_MINUTES,
        MAX_SCAN_INTERVAL_MINUTES,
        DEFAULT_SCAN_INTERVAL_MINUTES,
    )
}

/// Resolved full all-agent rescan cadence in minutes.
pub fn full_scan_interval_minutes() -> f64 {
    clamp_minutes(
        get_config_sync().scan.as_ref().and_then(|s| s.full_interval_minutes),
        MIN_FULL_SCAN_INTERVAL_MINUTES,
        MAX_FULL_SCAN_INTERVAL_MINUTES,
        DEFAULT_FULL_SCAN_INTERVAL_MINUTES,
    )
}

/// Background scanning master switch (default on).
pub fn scan_periodic_enabled() -> bool {
    get_config_sync()
        .scan
        .as_ref()
        .and_then(|s| s.periodic_enabled)
        != Some(false)
}

/// Normalize a stored scan block: clamp values, drop junk, keep defaults for missing.
pub fn normalize_scan_config(scan: Option<&ScanConfig>) -> ScanConfig {
    ScanConfig {
        interval_minutes: Some(clamp_minutes(
            scan.and_then(|s| s.interval_minutes),
            MIN_SCAN_INTERVAL_MINUTES,
            MAX_SCAN_INTERVAL_MINUTES,
            DEFAULT_SCAN_INTERVAL_MINUTES,
        )),
        full_interval_minutes: Some(clamp_minutes(
            scan.and_then(|s| s.full_interval_minutes),
            MIN_FULL_SCAN_INTERVAL_MINUTES,
            MAX_FULL_SCAN_INTERVAL_MINUTES,
            DEFAULT_FULL_SCAN_INTERVAL_MINUTES,
        )),
        periodic_enabled: Some(scan.and_then(|s| s.periodic_enabled) != Some(false)),
        extra: Map::new(),
    }
}

/// Drop the memoized config so the next `load_config()` re-reads from disk.
pub fn reset_config_cache() {
    set_cached_config(None);
}

/// Merge `next` over the defaults, normalize the timezone and write config.json.
pub async fn save_config(next: &XlabTokenConfig) -> anyhow::Result<XlabTokenConfig> {
    let _g = CONFIG_WRITE.lock().await;
    save_config_inner(next).await
}

async fn save_config_inner(next: &XlabTokenConfig) -> anyhow::Result<XlabTokenConfig> {
    let mut merged = merge_config(&default_config(), next);
    merged.timezone = Some(normalize_timezone(merged.timezone.as_deref()));
    let p = config_path();
    let dir = path_flavor().dirname(&p);
    tokio::fs::create_dir_all(&dir).await?;
    write_atomic(&p, pretty(&merged).as_bytes()).await?;
    CONFIG_CORRUPT.store(false, std::sync::atomic::Ordering::SeqCst);
    set_cached_config(Some(merged.clone()));
    Ok(merged)
}

/// Record the RATES_VERSION the scan cache is now priced with.
pub async fn set_scan_cache_rates_version(version: f64) -> anyhow::Result<()> {
    let _g = CONFIG_WRITE.lock().await;
    let cfg = load_config().await;
    if cfg.scan_cache_rates_version == Some(version) {
        return Ok(());
    }
    if CONFIG_CORRUPT.load(std::sync::atomic::Ordering::SeqCst) {
        // Do not overwrite an unreadable user config with defaults automatically.
        return Ok(());
    }
    let mut next = cfg;
    next.scan_cache_rates_version = Some(version);
    save_config_inner(&next).await?;
    Ok(())
}

/// Add (or, with `replace`, replace) custom model rates. Blank keys are dropped.
pub async fn set_custom_rates(
    rates: IndexMap<String, ModelRate>,
    replace: bool,
) -> anyhow::Result<XlabTokenConfig> {
    let _g = CONFIG_WRITE.lock().await;
    let cfg = load_config().await;
    let prev = cfg
        .pricing
        .as_ref()
        .map(|p| p.custom_rates.clone())
        .unwrap_or_default();
    let mut custom_rates: IndexMap<String, ModelRate> = if replace {
        rates
    } else {
        let mut m = prev;
        for (k, v) in rates {
            m.insert(k, v);
        }
        m
    };
    custom_rates.retain(|k, _| !js_trim(k).is_empty());
    let mut next = cfg.clone();
    let mut pricing = cfg.pricing.clone().unwrap_or_default();
    pricing.custom_rates = custom_rates;
    next.pricing = Some(pricing);
    save_config_inner(&next).await
}

#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_merge() {
        let base = to_map(&default_config());
        let over: Map<String, Value> = serde_json::from_str(
            r#"{"host":"0.0.0.0","port":8787,"customThing":{"a":1},"scan":{"intervalMinutes":0,"fullIntervalMinutes":"20"},
                "pricing":{"customRates":{"m":{"inputPer1M":1,"outputPer1M":2}}}}"#,
        )
        .unwrap();
        let merged = from_map(merge_config_values(&base, &over));
        assert_eq!(merged.host.as_deref(), Some("0.0.0.0"));
        assert_eq!(merged.port, Some(8787.0));
        assert_eq!(merged.extra.get("customThing").unwrap()["a"], 1);
        let scan = merged.scan.unwrap();
        assert_eq!(scan.interval_minutes, Some(1.0));
        assert_eq!(scan.full_interval_minutes, Some(20.0));
        assert_eq!(scan.periodic_enabled, Some(true));
        let p = merged.pricing.unwrap();
        assert_eq!(p.currency.as_deref(), Some("USD"));
        assert_eq!(p.prefer_router_cost, Some(true));
        assert_eq!(p.custom_rates["m"].output_per_1m, 2.0);
        assert!(merged.backup.is_some());
    }

    #[test]
    fn top_level_key_order_follows_the_loaded_object() {
        let keys = |c: &XlabTokenConfig| to_map(c).keys().cloned().collect::<Vec<_>>();
        let base = to_map(&default_config());
        let over: Map<String, Value> = serde_json::from_str(
            r#"{"timezone":"local","backup":{"gistId":"g"},"scanCacheRatesVersion":11,"customThing":1}"#,
        )
        .unwrap();
        let mut cfg = from_map(merge_config_values(&base, &over));
        let expected = ["timezone", "pricing", "scan", "backup", "scanCacheRatesVersion", "customThing"];
        assert_eq!(keys(&cfg), expected);
        // The written file keeps the same order, also after a field changes.
        cfg.scan_cache_rates_version = Some(12.0);
        let written: Map<String, Value> = serde_json::from_str(&pretty(&cfg)).unwrap();
        assert_eq!(written.keys().cloned().collect::<Vec<_>>(), expected);
        // A config that never came from a file keeps struct-field order.
        assert_eq!(keys(&default_config()), ["timezone", "pricing", "scan"]);
        // Key order is not part of config equality.
        assert_eq!(from_map(merge_config_values(&base, &over)), cfg_with_version(11.0));
    }

    fn cfg_with_version(v: f64) -> XlabTokenConfig {
        let base = to_map(&default_config());
        let over: Map<String, Value> = serde_json::from_str(r#"{"customThing":1,"backup":{"gistId":"g"}}"#).unwrap();
        let mut c = from_map(merge_config_values(&base, &over));
        c.scan_cache_rates_version = Some(v);
        c
    }

    #[test]
    fn clamp_rules() {
        assert_eq!(clamp_minutes(None, 1.0, 60.0, 60.0), 60.0);
        assert_eq!(clamp_minutes(Some(0.0), 1.0, 60.0, 60.0), 1.0);
        assert_eq!(clamp_minutes(Some(999.0), 1.0, 60.0, 60.0), 60.0);
        assert_eq!(clamp_minutes(Some(2.5), 1.0, 60.0, 60.0), 3.0);
        assert_eq!(clamp_minutes(Some(f64::NAN), 1.0, 60.0, 7.0), 7.0);
    }

    #[test]
    fn timezone_normalization() {
        let _g = TEST_ENV_LOCK.lock();
        assert_eq!(normalize_timezone(None), "local");
        assert_eq!(normalize_timezone(Some("  ")), "local");
        assert_eq!(normalize_timezone(Some("Asia/Ho_Chi_Minh")), "Asia/Ho_Chi_Minh");
    }

    #[test]
    fn wrong_types_degrade_to_unset() {
        let cfg: XlabTokenConfig =
            serde_json::from_str(r#"{"host":5,"port":"9000","scan":{"intervalMinutes":[1]},"pricing":"x"}"#).unwrap();
        assert_eq!(cfg.host, None);
        assert_eq!(cfg.port, Some(9000.0));
        assert_eq!(cfg.scan.unwrap().interval_minutes, None);
        assert!(cfg.pricing.is_none());
    }

    #[tokio::test]
    async fn save_and_load_roundtrip() {
        let _g = TEST_ENV_LOCK.lock();
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("sub").join("config.json");
        std::env::set_var("TOKENLAB_CONFIG", p.to_string_lossy().to_string());
        reset_config_cache();
        let mut cfg = load_config().await;
        assert_eq!(cfg.timezone.as_deref(), Some("local"));
        cfg.port = Some(1234.0);
        cfg.extra.insert("keepMe".into(), Value::Bool(true));
        let saved = save_config(&cfg).await.unwrap();
        assert_eq!(saved.port, Some(1234.0));
        reset_config_cache();
        let again = load_config().await;
        assert_eq!(again.port, Some(1234.0));
        assert_eq!(again.extra.get("keepMe"), Some(&Value::Bool(true)));
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.contains("\n  \"timezone\""));
        set_scan_cache_rates_version(7.0).await.unwrap();
        assert_eq!(load_config().await.scan_cache_rates_version, Some(7.0));
        let mut rates = IndexMap::new();
        rates.insert(
            "x".to_string(),
            ModelRate { input_per_1m: 1.0, output_per_1m: 2.0, ..Default::default() },
        );
        rates.insert("  ".to_string(), ModelRate::default());
        let after = set_custom_rates(rates, false).await.unwrap();
        assert_eq!(after.pricing.unwrap().custom_rates.len(), 1);
        std::env::remove_var("TOKENLAB_CONFIG");
        reset_config_cache();
    }
}
