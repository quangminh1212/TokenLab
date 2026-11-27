//! Port of `src/openrouter-models.ts`.
//!
//! OpenRouter model catalog: fetch (12h TTL, stale-cache fallback), disk cache
//! shared with the TS build (`openrouter-models.json`), and the model-name ->
//! catalog-entry lookup used by `pricing`.

use crate::types::{jsnum, ModelRate};
use crate::util::{
    app_data_dir, env_nonempty, js_len, js_num_to_string, js_number_from_str, js_round, js_trim, now_ms, pjoin,
    path_flavor,
};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::time::Duration;

const OPENROUTER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
/// Refresh at most once per 12 hours unless forced.
const CACHE_TTL_MS: f64 = 12.0 * 60.0 * 60.0 * 1000.0;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterModelEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// provider slug, e.g. openai
    #[serde(default)]
    pub provider: String,
    /// model slug without provider, e.g. gpt-4o
    #[serde(default)]
    pub slug: String,
    #[serde(default, with = "jsnum")]
    pub context_length: f64,
    #[serde(default)]
    pub modality: String,
    #[serde(rename = "inputPer1M", default, with = "jsnum")]
    pub input_per_1m: f64,
    #[serde(rename = "outputPer1M", default, with = "jsnum")]
    pub output_per_1m: f64,
    #[serde(
        rename = "cacheReadPer1M",
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub cache_read_per_1m: Option<f64>,
    #[serde(
        rename = "cacheWritePer1M",
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub cache_write_per_1m: Option<f64>,
    #[serde(default)]
    pub free: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "jsnum::ser_opt",
        deserialize_with = "jsnum::de_opt"
    )]
    pub created: Option<f64>,
}

/// On-disk / in-memory catalog (`CacheFile` in TS).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterCache {
    #[serde(default, with = "jsnum")]
    pub fetched_at: f64,
    #[serde(default)]
    pub models: Vec<OpenRouterModelEntry>,
}

/// Result of [`lookup_open_router_rate`].
#[derive(Debug, Clone, PartialEq)]
pub struct OpenRouterLookup {
    pub key: String,
    pub rate: ModelRate,
    pub entry: OpenRouterModelEntry,
}

static MEMORY: Lazy<Mutex<Option<Arc<OpenRouterCache>>>> = Lazy::new(|| Mutex::new(None));

/// Serialises catalog fetches. The stored value is the result of the most
/// recent fetch so callers that queued behind it share it (the TS `inflight`
/// promise).
static FETCH_LOCK: Lazy<tokio::sync::Mutex<Option<Result<(), String>>>> =
    Lazy::new(|| tokio::sync::Mutex::new(None));
static FETCH_GEN: AtomicU64 = AtomicU64::new(0);

fn memory_snapshot() -> Option<Arc<OpenRouterCache>> {
    MEMORY.lock().clone()
}

fn set_memory(cache: OpenRouterCache) -> Arc<OpenRouterCache> {
    let a = Arc::new(cache);
    *MEMORY.lock() = Some(a.clone());
    a
}

pub fn openrouter_cache_path() -> String {
    if let Some(p) = env_nonempty("TOKENLAB_OPENROUTER_CACHE") {
        return p;
    }
    let dir = env_nonempty("TOKENLAB_DATA_DIR").unwrap_or_else(|| pjoin(&[app_data_dir().as_str(), "tokenlab"]));
    pjoin(&[dir.as_str(), "openrouter-models.json"])
}

// ---------------------------------------------------------------------------
// JS value coercions (just enough for `parseEntry`)
// ---------------------------------------------------------------------------

/// `Number(value)` of an optional JSON value (`undefined` -> NaN).
fn js_number(v: Option<&Value>) -> f64 {
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
        Some(Value::Array(a)) => {
            // Number([]) = 0, Number([x]) = Number(x), otherwise NaN.
            match a.len() {
                0 => 0.0,
                1 => js_number(a.first()),
                _ => f64::NAN,
            }
        }
        Some(Value::Object(_)) => f64::NAN,
    }
}

fn js_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `String(value)`.
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_num_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|x| if x.is_null() { String::new() } else { js_string(x) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `String(v || fallback)`.
fn js_string_or(v: Option<&Value>, fallback: &str) -> String {
    if js_truthy(v) {
        js_string(v.unwrap())
    } else {
        fallback.to_string()
    }
}

/// OpenRouter API prices are USD per token -> convert to USD per 1M tokens.
pub fn per_token_to_per_1m(v: Option<&Value>) -> f64 {
    let n = js_number(v);
    if !n.is_finite() || n < 0.0 {
        return 0.0;
    }
    js_round(n * 1_000_000.0 * 1e6) / 1e6
}

fn parse_entry(raw: &serde_json::Map<String, Value>) -> Option<OpenRouterModelEntry> {
    let id = js_trim(&js_string_or(raw.get("id"), "")).to_string();
    if id.is_empty() || id.starts_with('~') {
        return None; // skip redirect aliases
    }
    let name = js_trim(&js_string_or(raw.get("name"), &id)).to_string();
    let slash = id.find('/');
    let (provider, slug) = match slash {
        Some(i) if i > 0 => (id[..i].to_string(), id[i + 1..].to_string()),
        _ => ("other".to_string(), id.clone()),
    };
    let pricing = raw.get("pricing").and_then(|p| p.as_object());
    fn pget<'a>(pricing: Option<&'a serde_json::Map<String, Value>>, k: &str) -> Option<&'a Value> {
        pricing.and_then(|p| p.get(k))
    }
    let input_per_1m = per_token_to_per_1m(pget(pricing, "prompt"));
    let output_per_1m = per_token_to_per_1m(pget(pricing, "completion"));
    fn non_null(v: Option<&Value>) -> Option<&Value> {
        v.filter(|x| !x.is_null())
    }
    let cache_read = non_null(pget(pricing, "input_cache_read")).map(|v| per_token_to_per_1m(Some(v)));
    let cache_write = non_null(pget(pricing, "input_cache_write")).map(|v| per_token_to_per_1m(Some(v)));
    let arch = raw.get("architecture").and_then(|a| a.as_object());
    let modality = js_string_or(arch.and_then(|a| a.get("modality")), "text->text");
    let context_length = {
        let n = js_number(raw.get("context_length"));
        if n.is_nan() || n == 0.0 {
            0.0
        } else {
            n
        }
    };
    let free = input_per_1m == 0.0 && output_per_1m == 0.0;
    let created = {
        let n = js_number(raw.get("created"));
        if n.is_nan() || n == 0.0 {
            None
        } else {
            Some(n)
        }
    };
    Some(OpenRouterModelEntry {
        id,
        name,
        provider,
        slug,
        context_length,
        modality,
        input_per_1m,
        output_per_1m,
        cache_read_per_1m: cache_read,
        cache_write_per_1m: cache_write,
        free,
        created,
    })
}

// ---------------------------------------------------------------------------
// `String.prototype.localeCompare` (default ICU root collation, ASCII-accurate)
// ---------------------------------------------------------------------------

/// Primary collation weight of one character (CLDR root order: whitespace,
/// punctuation, symbols, digits, letters; letters compare case-insensitively
/// at the primary level).
fn collation_primary(c: char) -> u32 {
    const PUNCT: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    if c == '\t' {
        return 1;
    }
    if c == '\n' {
        return 2;
    }
    if c == '\r' {
        return 3;
    }
    if c == ' ' {
        return 4;
    }
    if let Some(i) = PUNCT.find(c) {
        return 10 + i as u32;
    }
    if c.is_ascii_digit() {
        return 100 + (c as u32 - '0' as u32);
    }
    if c.is_ascii_alphabetic() {
        return 200 + (c.to_ascii_lowercase() as u32 - 'a' as u32);
    }
    1000 + c as u32
}

/// `a.localeCompare(b)` as an [`Ordering`].
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let pa: Vec<u32> = a.chars().map(collation_primary).collect();
    let pb: Vec<u32> = b.chars().map(collation_primary).collect();
    match pa.cmp(&pb) {
        Ordering::Equal => {}
        o => return o,
    }
    // Tertiary: lowercase sorts before uppercase.
    for (ca, cb) in a.chars().zip(b.chars()) {
        if ca != cb {
            let (la, lb) = (ca.is_lowercase(), cb.is_lowercase());
            if la != lb {
                return if la { Ordering::Less } else { Ordering::Greater };
            }
        }
    }
    a.cmp(b)
}

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------

async fn read_disk_cache() -> Option<OpenRouterCache> {
    let p = openrouter_cache_path();
    let bytes = tokio::fs::read(&p).await.ok()?;
    let raw: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()?,
    };
    drop(bytes);
    let Value::Object(mut obj) = raw else { return None };
    if !obj.get("models")?.is_array() {
        return None;
    }
    if !js_truthy(obj.get("fetchedAt")) {
        return None;
    }
    let fetched_at = js_number(obj.get("fetchedAt"));
    let Some(Value::Array(items)) = obj.remove("models") else { return None };
    let models: Vec<OpenRouterModelEntry> = items
        .into_iter()
        .filter_map(|m| serde_json::from_value::<OpenRouterModelEntry>(m).ok())
        .collect();
    Some(OpenRouterCache {
        fetched_at: if fetched_at.is_nan() { 0.0 } else { fetched_at },
        models,
    })
}

async fn write_disk_cache(cache: &OpenRouterCache) -> anyhow::Result<()> {
    let p = openrouter_cache_path();
    let dir = path_flavor().dirname(&p);
    tokio::fs::create_dir_all(&dir).await?;
    crate::config::write_atomic(&p, serde_json::to_string(cache)?.as_bytes()).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async fn fetch_network() -> anyhow::Result<Vec<OpenRouterModelEntry>> {
    let client = reqwest::Client::builder().connect_timeout(Duration::from_millis(8_000)).timeout(Duration::from_millis(25_000)).build()?;
    let res = client
        .get(OPENROUTER_MODELS_URL)
        .header("Accept", "application/json")
        .header("User-Agent", "tokenlab")
        .send()
        .await?;
    if !res.status().is_success() {
        anyhow::bail!("OpenRouter models HTTP {}", res.status().as_u16());
    }
    let mut body: Value = res.json().await?;
    let list = match body.get_mut("data").map(Value::take) {
        Some(Value::Array(a)) => a,
        _ => Vec::new(),
    };
    drop(body);
    let mut models: Vec<OpenRouterModelEntry> = Vec::with_capacity(list.len());
    for item in &list {
        let Some(obj) = item.as_object() else { continue };
        if let Some(entry) = parse_entry(obj) {
            models.push(entry);
        }
    }
    drop(list);
    models.sort_by(|a, b| {
        let cb = b.created.unwrap_or(0.0);
        let ca = a.created.unwrap_or(0.0);
        (cb - ca)
            .partial_cmp(&0.0)
            .unwrap_or(Ordering::Equal)
            .then_with(|| locale_compare(&a.id, &b.id))
    });
    let cache = OpenRouterCache { fetched_at: now_ms(), models };
    let mem = set_memory(cache);
    let _ = write_disk_cache(&mem).await;
    Ok(mem.models.clone())
}

async fn fetch_inner(force: bool) -> anyhow::Result<Vec<OpenRouterModelEntry>> {
    let attempt: anyhow::Result<Vec<OpenRouterModelEntry>> = async {
        if !force {
            if let Some(mem) = memory_snapshot() {
                if now_ms() - mem.fetched_at < CACHE_TTL_MS {
                    return Ok(mem.models.clone());
                }
            }
            if let Some(disk) = read_disk_cache().await {
                if now_ms() - disk.fetched_at < CACHE_TTL_MS && !disk.models.is_empty() {
                    let models = disk.models.clone();
                    set_memory(disk);
                    return Ok(models);
                }
            }
        }
        fetch_network().await
    }
    .await;
    match attempt {
        Ok(v) => Ok(v),
        Err(err) => {
            // Fall back to stale cache if network fails
            if let Some(mem) = memory_snapshot() {
                if !mem.models.is_empty() {
                    return Ok(mem.models.clone());
                }
            }
            if let Some(disk) = read_disk_cache().await {
                if !disk.models.is_empty() {
                    let models = disk.models.clone();
                    set_memory(disk);
                    return Ok(models);
                }
            }
            Err(err)
        }
    }
}

/// Fetch (or reuse) the OpenRouter catalog. `force` bypasses the 12h TTL.
pub async fn fetch_open_router_models(force: bool) -> anyhow::Result<Vec<OpenRouterModelEntry>> {
    let gen_before = FETCH_GEN.load(AtomicOrdering::SeqCst);
    let mut guard = FETCH_LOCK.lock().await;
    if FETCH_GEN.load(AtomicOrdering::SeqCst) != gen_before {
        // A fetch completed while we were queued: share its result.
        match guard.as_ref() {
            Some(Err(e)) => return Err(anyhow::anyhow!(e.clone())),
            Some(Ok(())) => {
                if let Some(mem) = memory_snapshot() {
                    return Ok(mem.models.clone());
                }
            }
            None => {}
        }
    }
    let result = fetch_inner(force).await;
    *guard = Some(match &result {
        Ok(_) => Ok(()),
        Err(e) => Err(e.to_string()),
    });
    FETCH_GEN.fetch_add(1, AtomicOrdering::SeqCst);
    result
}

/// Sync snapshot (may be empty until first fetch).
pub fn get_open_router_models_sync() -> Vec<OpenRouterModelEntry> {
    memory_snapshot().map(|m| m.models.clone()).unwrap_or_default()
}

/// Shared (non-cloning) view of the in-memory catalog.
pub fn open_router_models_arc() -> Option<Arc<OpenRouterCache>> {
    memory_snapshot()
}

pub fn get_open_router_fetched_at() -> f64 {
    memory_snapshot().map(|m| m.fetched_at).unwrap_or(0.0)
}

/// Warm cache from disk without network (startup).
pub async fn load_open_router_cache_from_disk() -> usize {
    if let Some(mem) = memory_snapshot() {
        if !mem.models.is_empty() {
            return mem.models.len();
        }
    }
    if let Some(disk) = read_disk_cache().await {
        if !disk.models.is_empty() {
            let n = disk.models.len();
            set_memory(disk);
            return n;
        }
    }
    0
}

/// Replace OpenRouter catalog (used by full backup restore).
pub async fn replace_open_router_cache(fetched_at: f64, models: Vec<OpenRouterModelEntry>) -> anyhow::Result<usize> {
    let fetched_at = if fetched_at.is_finite() && fetched_at != 0.0 { fetched_at } else { now_ms() };
    let cache = OpenRouterCache { fetched_at, models };
    let n = cache.models.len();
    let arc = set_memory(cache);
    write_disk_cache(&arc).await?;
    Ok(n)
}

fn rate_from_entry(e: &OpenRouterModelEntry) -> ModelRate {
    ModelRate {
        input_per_1m: e.input_per_1m,
        output_per_1m: e.output_per_1m,
        cache_read_per_1m: e.cache_read_per_1m,
        cache_write_per_1m: e.cache_write_per_1m,
        estimated: None,
        long_context_threshold_tokens: None,
    }
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default)]
struct RankOpts {
    prefer_google: bool,
    want_image: bool,
    want_preview: bool,
}

/// Rank OpenRouter catalog rows: paid > non-batch > non-image (unless asked) > google for gemini.
fn open_router_entry_score(e: &OpenRouterModelEntry, opts: RankOpts) -> f64 {
    let id = e.id.to_lowercase();
    let slug = e.slug.to_lowercase();
    let mut s = 0.0;
    if !e.free {
        s += 200.0;
    }
    if !id.contains(":batch") && !slug.contains(":batch") {
        s += 80.0;
    }
    let is_image = id.contains("image") || slug.contains("image");
    if opts.want_image {
        if is_image {
            s += 40.0;
        }
    } else if !is_image {
        s += 40.0;
    }
    let is_preview = id.contains("preview") || slug.contains("preview");
    if opts.want_preview {
        if is_preview {
            s += 30.0;
        }
    } else if !is_preview {
        // Prefer stable non-preview when both google/gemini-2.5-pro and …-preview match
        s += 30.0;
    }
    if opts.prefer_google && e.provider.to_lowercase() == "google" {
        s += 50.0;
    }
    // Slight preference for longer (more specific) slug, capped
    s += (js_len(&slug) as f64).min(80.0);
    s
}

fn better_open_router_entry(a: &OpenRouterModelEntry, b: &OpenRouterModelEntry, opts: RankOpts) -> bool {
    let sa = open_router_entry_score(a, opts);
    let sb = open_router_entry_score(b, opts);
    if sa != sb {
        return sa > sb;
    }
    js_len(&a.slug) > js_len(&b.slug)
}

fn after_last_slash(s: &str) -> &str {
    match s.rfind('/') {
        Some(i) => &s[i + 1..],
        None => s,
    }
}

/// Expand Antigravity / IDE model aliases into OpenRouter lookup keys.
/// e.g. gemini-3.6-flash-high -> gemini-3.6-flash, google/gemini-3.6-flash
///      gemini-3.1-pro-low -> gemini-3.1-pro -> gemini-3.1-pro-preview
pub fn open_router_lookup_candidates(model: &str) -> Vec<String> {
    let raw = js_trim(model).to_lowercase().replace('_', "-");
    if raw.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    fn add(out: &mut Vec<String>, s: &str) {
        let t = js_trim(s).to_lowercase().replace('_', "-");
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
    }
    add(&mut out, &raw);
    let bare = after_last_slash(&raw).to_string();
    add(&mut out, &bare);

    // Strip UI / Antigravity tier suffixes (not core "flash" / "pro" / "lite")
    const STRIP_END: [&str; 15] = [
        ":batch",
        ":free",
        "-openai-compact",
        "-high",
        "-tiered",
        "-low",
        "-medium",
        "-xhigh",
        "-compact",
        "-thinking",
        "-fast",
        "-exp",
        "-latest",
        "-preview",
        "-free",
    ];
    let mut cur = bare;
    // Peel suffixes repeatedly
    let mut changed = true;
    while changed {
        changed = false;
        for suf in STRIP_END {
            if cur.ends_with(suf) && js_len(&cur) > js_len(suf) + 3 {
                cur.truncate(cur.len() - suf.len());
                add(&mut out, &cur);
                changed = true;
            }
        }
    }

    // gemini-3.1-pro-low -> gemini-3.1-pro -> gemini-3.1-pro-preview (OR naming)
    // Only for *-pro bases so gemini-2.5-flash is not rewritten to a preview slug.
    if cur.contains("gemini") && (cur == "pro" || cur.ends_with("-pro")) {
        add(&mut out, &format!("{cur}-preview"));
    }

    // Provider-qualified forms
    for c in out.clone() {
        if !c.contains('/') && c.starts_with("gemini") {
            add(&mut out, &format!("google/{c}"));
        }
    }
    out
}

/// Match usage model names against OpenRouter ids/slugs.
/// Prefer exact id, then slug (with Antigravity alias expand), then longest slug contained.
/// Prefer paid, non-batch, non-image (unless model asks image), google/* for gemini.
pub fn lookup_open_router_rate(model: Option<&str>) -> Option<OpenRouterLookup> {
    let snapshot = memory_snapshot()?;
    let models = &snapshot.models;
    let model = model?;
    if models.is_empty() || model.is_empty() {
        return None;
    }
    let raw = js_trim(model).to_lowercase();
    if raw.is_empty() {
        return None;
    }

    let prefer_google = raw.contains("gemini") || raw.starts_with("google/");
    let want_image = raw.contains("image");
    let want_preview = raw.contains("preview");
    let rank = RankOpts { prefer_google, want_image, want_preview };
    let candidates = open_router_lookup_candidates(&raw);

    let make = |e: &OpenRouterModelEntry| OpenRouterLookup {
        key: e.id.clone(),
        rate: rate_from_entry(e),
        entry: e.clone(),
    };

    // Exact full id (any candidate)
    let mut best: Option<&OpenRouterModelEntry> = None;
    for cand in &candidates {
        for e in models {
            if e.id.to_lowercase() == *cand && best.map_or(true, |b| better_open_router_entry(e, b, rank)) {
                best = Some(e);
            }
        }
    }
    if let Some(b) = best {
        return Some(make(b));
    }

    // Exact slug match (prefer ranked)
    best = None;
    for cand in &candidates {
        let bare = after_last_slash(cand);
        for e in models {
            let slug = e.slug.to_lowercase();
            let id_bare = if e.id.contains('/') {
                after_last_slash(&e.id).to_lowercase()
            } else {
                e.id.to_lowercase()
            };
            if (slug == bare || slug == *cand || id_bare == bare)
                && best.map_or(true, |b| better_open_router_entry(e, b, rank))
            {
                best = Some(e);
            }
        }
    }
    if let Some(b) = best {
        return Some(make(b));
    }

    // Longest slug contained in any candidate (min 6 chars; skip :batch when not asked)
    best = None;
    let raw_dashed = raw.replace('_', "-");
    for cand in &candidates {
        let norm = cand.replace('_', "-");
        for e in models {
            let s = e.slug.to_lowercase();
            if js_len(&s) < 6 {
                continue;
            }
            if s.contains(":batch") && !norm.contains("batch") {
                continue;
            }
            if (norm.contains(&s) || raw_dashed.contains(&s))
                && best.map_or(true, |b| better_open_router_entry(e, b, rank))
            {
                best = Some(e);
            }
        }
    }
    best.map(make)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(id: &str, i: f64, o: f64) -> OpenRouterModelEntry {
        let (provider, slug) = match id.find('/') {
            Some(p) => (id[..p].to_string(), id[p + 1..].to_string()),
            None => ("other".to_string(), id.to_string()),
        };
        OpenRouterModelEntry {
            id: id.to_string(),
            name: id.to_string(),
            provider,
            slug,
            context_length: 0.0,
            modality: "text->text".into(),
            input_per_1m: i,
            output_per_1m: o,
            free: i == 0.0 && o == 0.0,
            ..Default::default()
        }
    }

    #[test]
    fn per_token_conversion() {
        assert_eq!(per_token_to_per_1m(Some(&json!("0.000003"))), 3.0);
        assert_eq!(per_token_to_per_1m(Some(&json!("-1"))), 0.0);
        assert_eq!(per_token_to_per_1m(None), 0.0);
        assert_eq!(per_token_to_per_1m(Some(&json!(0.0000000028))), 0.0028);
    }

    #[test]
    fn parse_entry_basic() {
        let v = json!({
            "id": "openai/gpt-4o", "name": " GPT-4o ", "context_length": 128000, "created": 1700000000,
            "pricing": {"prompt": "0.0000025", "completion": "0.00001", "input_cache_read": "0.00000125"},
            "architecture": {"modality": "text+image->text"}
        });
        let e = parse_entry(v.as_object().unwrap()).unwrap();
        assert_eq!(e.provider, "openai");
        assert_eq!(e.slug, "gpt-4o");
        assert_eq!(e.name, "GPT-4o");
        assert_eq!(e.input_per_1m, 2.5);
        assert_eq!(e.output_per_1m, 10.0);
        assert_eq!(e.cache_read_per_1m, Some(1.25));
        assert_eq!(e.cache_write_per_1m, None);
        assert!(!e.free);
        assert!(parse_entry(json!({"id": "~alias/x"}).as_object().unwrap()).is_none());
        let j = serde_json::to_value(&e).unwrap();
        assert!(j.get("cacheWritePer1M").is_none());
        assert_eq!(j["inputPer1M"].to_string(), "2.5");
    }

    #[test]
    fn candidates() {
        assert_eq!(
            open_router_lookup_candidates("gemini-3.1-pro-low"),
            vec!["gemini-3.1-pro-low", "gemini-3.1-pro", "gemini-3.1-pro-preview", "google/gemini-3.1-pro-low", "google/gemini-3.1-pro", "google/gemini-3.1-pro-preview"]
        );
        assert_eq!(open_router_lookup_candidates("openai/gpt-4o"), vec!["openai/gpt-4o", "gpt-4o"]);
    }

    #[test]
    fn locale_order() {
        assert_eq!(locale_compare("a-b", "a.b"), Ordering::Less);
        assert_eq!(locale_compare("gpt-4", "gpt4"), Ordering::Less);
        assert_eq!(locale_compare("abc", "ABC"), Ordering::Less);
        assert_eq!(locale_compare("a1", "aa"), Ordering::Less);
    }

    #[test]
    fn lookup_ranks_paid_over_free() {
        *MEMORY.lock() = Some(Arc::new(OpenRouterCache {
            fetched_at: 1.0,
            models: vec![entry("nvidia/nemotron-3-ultra:free", 0.0, 0.0), entry("openai/gpt-4o", 2.5, 10.0)],
        }));
        let hit = lookup_open_router_rate(Some("gpt-4o")).unwrap();
        assert_eq!(hit.key, "openai/gpt-4o");
        assert_eq!(hit.rate.input_per_1m, 2.5);
        assert!(lookup_open_router_rate(Some("unknown-thing")).is_none());
        *MEMORY.lock() = None;
    }
}
