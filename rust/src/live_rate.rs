//! Port of `src/live-rate.ts`.
//!
//! Live request-rate helpers.
//!
//! Scan-cache often collapses 9router/RouterLab/LiteLLM to estimated daily
//! rollups for totals. RPM must still count real per-call rows, so they are
//! read from hot VPS mirror history tails.

use crate::agents::agent_path_specs;
use crate::types::{jsnum, AgentId, PricingStatus, UsageEvent};
use crate::util::{
    app_data_dir, js_date_parse, js_num_to_string, js_round, js_trim, now_ms, num, or_zero, pjoin, stamp_file,
    to_iso_string,
};
use indexmap::IndexMap;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::io::SeekFrom;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

/// `process.env[name]?.trim()` — trimmed value, empty when unset.
fn env_trimmed(name: &str) -> String {
    std::env::var(name).map(|v| js_trim(&v).to_string()).unwrap_or_default()
}

fn tokenlab_data_root() -> String {
    for name in ["TOKENLAB_DATA_DIR", "XLAB_TOKEN_DATA_DIR"] {
        if let Ok(v) = std::env::var(name) {
            if !v.is_empty() {
                return v;
            }
        }
    }
    pjoin(&[app_data_dir().as_str(), "tokenlab"])
}

#[derive(Debug, Clone, PartialEq)]
struct HotEntry {
    agent: String,
    file: String,
}

/// Hot history files that update when remote routers serve traffic.
fn hot_history_files() -> Vec<HotEntry> {
    // Keep this list in sync with the router agent roots instead of assuming
    // only the current TokenLab mirror folder.
    const HISTORY_NAMES: [&str; 11] = [
        "request-details.jsonl",
        "usage-history.jsonl",
        "request-details.json",
        "usage-history.json",
        "usageHistory.json",
        "usageData.json",
        "usage.json",
        "db.json",
        "db/data.sqlite",
        "data.sqlite",
        "db.sqlite",
    ];
    let mut out: Vec<HotEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let hot_agents = ["9router", "routerlab", "xlabrouter", "litellm"];

    let mut configured_root = env_trimmed("TOKENLAB_DATA_DIR");
    if configured_root.is_empty() {
        configured_root = env_trimmed("XLAB_TOKEN_DATA_DIR");
    }
    let norm_key = |s: &str| -> String { s.replace('\\', "/").trim_end_matches('/').to_lowercase() };
    let configured_key = norm_key(&configured_root);
    let is_configured_path = |root: &str| -> bool {
        if configured_key.is_empty() {
            return true;
        }
        let key = norm_key(root);
        key == configured_key || key.starts_with(&format!("{configured_key}/"))
    };

    for spec in agent_path_specs() {
        let agent = spec.id.as_str();
        if !hot_agents.contains(&agent) {
            continue;
        }
        for root in &spec.roots {
            if root.is_empty() || !is_configured_path(root) {
                continue;
            }
            for name in HISTORY_NAMES {
                let file = pjoin(&[root.as_str(), name]);
                let key = format!("{agent}\0{}", file.replace('\\', "/").to_lowercase());
                if !seen.insert(key) {
                    continue;
                }
                out.push(HotEntry {
                    agent: if agent == "xlabrouter" { "routerlab".to_string() } else { agent.to_string() },
                    file,
                });
            }
        }
    }

    // The explicit fallback also keeps tests and portable installs working when
    // an agent module changes its roots before the hot reader is updated.
    let root = tokenlab_data_root();
    let groups: [(&str, &[&str]); 3] = [
        ("9router", &["9router"]),
        ("routerlab", &["routerlab", "xlabrouter"]),
        ("litellm", &["litellm"]),
    ];
    for (agent, aliases) in groups {
        for alias in aliases {
            for name in HISTORY_NAMES {
                let file = pjoin(&[root.as_str(), "mirrors", alias, name]);
                let key = format!("{agent}\0{}", file.replace('\\', "/").to_lowercase());
                if !seen.insert(key) {
                    continue;
                }
                out.push(HotEntry { agent: agent.to_string(), file });
            }
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
struct HotFileStat {
    agent: String,
    file: String,
    size: f64,
    mtime_ms: f64,
}

/// Read one byte range from a file.
async fn read_range(file: &str, start: u64, length: u64) -> std::io::Result<String> {
    let mut fh = tokio::fs::File::open(file).await?;
    fh.seek(SeekFrom::Start(start)).await?;
    let mut buf: Vec<u8> = Vec::new();
    fh.take(length).read_to_end(&mut buf).await?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

#[derive(Clone, Copy, PartialEq)]
enum EdgeMode {
    Head,
    Tail,
    Full,
}

fn complete_jsonl_lines(text: &str, mode: EdgeMode) -> Vec<String> {
    let mut value = text;
    match mode {
        EdgeMode::Tail => {
            // The first line can begin before the selected range.
            if let Some(i) = value.find('\n') {
                value = &value[i + 1..];
            }
        }
        EdgeMode::Head => {
            // The last line can continue beyond the selected range.
            if let Some(i) = value.rfind('\n') {
                value = &value[..i];
            }
        }
        EdgeMode::Full => {}
    }
    value
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .filter(|l| !js_trim(l).is_empty())
        .map(|l| l.to_string())
        .collect()
}

/// Read both edges of a JSONL file. Most exports append oldest to newest, but
/// request-details exports have also been written newest to oldest. Reading
/// only the tail silently misses the newest rows in the latter format.
async fn read_jsonl_edges(file: &str, size: f64, edge_bytes: f64) -> std::io::Result<Vec<String>> {
    if size <= 0.0 {
        return Ok(Vec::new());
    }
    // The mirror sync keeps normal request exports small (a few MB). Read
    // those completely so a 24h period is not missing the middle of the file;
    // edge sampling is only the safety valve for unexpectedly large histories.
    if size <= 8.0 * 1024.0 * 1024.0 {
        return Ok(complete_jsonl_lines(&read_range(file, 0, size as u64).await?, EdgeMode::Full));
    }
    let edge = edge_bytes.max(0.0) as u64;
    let mut out = complete_jsonl_lines(&read_range(file, 0, edge).await?, EdgeMode::Head);
    let tail_start = (size - edge_bytes).max(0.0) as u64;
    out.extend(complete_jsonl_lines(&read_range(file, tail_start, edge).await?, EdgeMode::Tail));
    Ok(out)
}

fn history_rows(data: &Value) -> Vec<Value> {
    match data {
        Value::Array(a) => return a.clone(),
        Value::Object(o) => {
            for key in ["history", "records", "events", "usageHistory", "requestDetails", "request_details"] {
                if let Some(Value::Array(a)) = o.get(key) {
                    return a.clone();
                }
            }
            for key in ["usageData", "usage", "data"] {
                if let Some(nested) = o.get(key) {
                    let rows = history_rows(nested);
                    if !rows.is_empty() {
                        return rows;
                    }
                }
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn sqlite_value(v: rusqlite::types::ValueRef<'_>) -> Value {
    use rusqlite::types::ValueRef;
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        // node:sqlite hands back a Uint8Array; no live-rate field reads one.
        ValueRef::Blob(_) => Value::Null,
    }
}

fn sqlite_query(conn: &rusqlite::Connection, sql: &str) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().into_iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.query([])?;
    let mut out: Vec<Value> = Vec::new();
    while let Some(row) = rows.next()? {
        let mut m = Map::new();
        for (i, name) in names.iter().enumerate() {
            m.insert(name.clone(), sqlite_value(row.get_ref(i)?));
        }
        out.push(Value::Object(m));
    }
    Ok(out)
}

/// Read the newest rows from a router SQLite mirror without blocking on a full scan.
fn read_sqlite_rows_blocking(file: &str) -> Vec<Value> {
    // SQLite may be locked, unavailable, or not a usage database. JSON/JSONL
    // mirrors remain the normal fast path.
    let conn = match rusqlite::Connection::open_with_flags(
        file,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    match sqlite_query(
        &conn,
        "SELECT id, timestamp, provider, model, connectionId, apiKey, endpoint,
                promptTokens, completionTokens, cost, status, tokens, meta
         FROM usageHistory
         ORDER BY id DESC
         LIMIT 5000",
    ) {
        Ok(rows) => rows,
        Err(_) => sqlite_query(&conn, "SELECT * FROM usageHistory ORDER BY rowid DESC LIMIT 5000").unwrap_or_default(),
    }
}

async fn read_sqlite_rows(file: &str) -> Vec<Value> {
    let file = file.to_string();
    tokio::task::spawn_blocking(move || read_sqlite_rows_blocking(&file)).await.unwrap_or_default()
}

/// Read a hot history source without loading large JSONL histories in full.
async fn read_hot_rows(file: &str, size: f64, edge_bytes: f64) -> Vec<Value> {
    let lower = file.to_lowercase();
    if lower.ends_with(".sqlite") || lower.ends_with(".db") {
        return read_sqlite_rows(file).await;
    }
    if lower.ends_with(".jsonl") {
        let lines = match read_jsonl_edges(file, size, edge_bytes).await {
            Ok(l) => l,
            Err(_) => return Vec::new(),
        };
        // Ignore a concurrently-written or malformed row.
        return lines.iter().filter_map(|l| serde_json::from_str::<Value>(l).ok()).collect();
    }
    // db.json / usageData.json are compact mirror snapshots. Do not turn an
    // unexpectedly huge JSON snapshot into an event-loop pause.
    if size > 8.0 * 1024.0 * 1024.0 {
        return Vec::new();
    }
    match crate::util::read_text(file).await {
        Some(text) => match serde_json::from_str::<Value>(&text) {
            Ok(v) => history_rows(&v),
            Err(_) => Vec::new(),
        },
        None => Vec::new(),
    }
}

async fn hot_files_with_stats() -> Vec<HotFileStat> {
    let entries = hot_history_files();
    let found = futures::future::join_all(entries.into_iter().map(|entry| async move {
        // Candidate source may not exist or may be replaced by a sync.
        let st = stamp_file(&entry.file).await?;
        if st.size == 0 {
            return None;
        }
        Some(HotFileStat { agent: entry.agent, file: entry.file, size: st.size as f64, mtime_ms: st.mtime_ms })
    }))
    .await;
    found.into_iter().flatten().collect()
}

// ---------------------------------------------------------------------------
// JS value helpers
// ---------------------------------------------------------------------------

/// `obj[key]` with `undefined` and `null` both treated as absent (`??` semantics).
fn get<'a>(m: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    match m.get(key) {
        None | Some(Value::Null) => None,
        Some(v) => Some(v),
    }
}

/// First non-nullish value of a `a ?? b ?? c` chain.
fn first<'a>(candidates: &[Option<&'a Value>]) -> &'a Value {
    for c in candidates {
        if let Some(v) = c {
            return v;
        }
    }
    &Value::Null
}

/// JS `String(value)` for the id-like values a row can carry.
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

static EMPTY_MAP: Lazy<Map<String, Value>> = Lazy::new(Map::new);

/// `v && typeof v === "object"` for an object-ish row field. Arrays count (and
/// expose no named fields), exactly like the JS truthy-object test.
fn as_objectish(v: Option<&Value>) -> Option<&Map<String, Value>> {
    match v {
        Some(Value::Object(m)) => Some(m),
        Some(Value::Array(_)) => Some(&EMPTY_MAP),
        _ => None,
    }
}

fn str_field<'a>(m: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    match m.get(key) {
        Some(Value::String(s)) => Some(s.as_str()),
        _ => None,
    }
}

fn row_to_live_event(row: &Map<String, Value>, agent: &str, source: &str) -> Option<UsageEvent> {
    let ts_raw = first(&[
        get(row, "timestamp"),
        get(row, "createdAt"),
        get(row, "created_at"),
        get(row, "date"),
        get(row, "ts"),
    ]);
    let mut ts: Option<String> = None;
    match ts_raw {
        Value::String(s) => {
            if !js_trim(s).is_empty() {
                let ms = js_date_parse(s);
                if !ms.is_nan() {
                    ts = to_iso_string(ms);
                }
            }
        }
        Value::Number(n) => {
            let n = n.as_f64().unwrap_or(f64::NAN);
            if n.is_finite() && n > 0.0 {
                let ms = if n > 1e12 {
                    n
                } else if n > 1e9 {
                    n * 1000.0
                } else {
                    f64::NAN
                };
                if ms.is_finite() {
                    ts = to_iso_string(ms.trunc());
                }
            }
        }
        _ => {}
    }
    let ts = ts?;

    let mut tokens_obj: Map<String, Value> = Map::new();
    match row.get("tokens") {
        Some(Value::Object(m)) => tokens_obj = m.clone(),
        Some(Value::String(s)) if !js_trim(s).is_empty() => {
            // Ignore an incomplete token blob while the source is being written.
            if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(s) {
                tokens_obj = m;
            }
        }
        _ => {}
    }
    let t = &tokens_obj;

    let input_tokens = num(first(&[
        get(t, "prompt_tokens"),
        get(t, "promptTokens"),
        get(t, "input_tokens"),
        get(t, "inputTokens"),
        get(row, "promptTokens"),
        get(row, "prompt_tokens"),
        get(row, "inputTokens"),
        get(row, "input_tokens"),
    ]));
    let output_tokens = num(first(&[
        get(t, "completion_tokens"),
        get(t, "completionTokens"),
        get(t, "output_tokens"),
        get(t, "outputTokens"),
        get(row, "completionTokens"),
        get(row, "completion_tokens"),
        get(row, "outputTokens"),
        get(row, "output_tokens"),
    ]));
    let prompt_details: Option<&Map<String, Value>> = as_objectish(get(t, "prompt_tokens_details"))
        .or_else(|| as_objectish(get(t, "promptTokensDetails")))
        .or_else(|| as_objectish(get(t, "input_tokens_details")));
    let pd = |key: &str| -> Option<&Value> { prompt_details.and_then(|m| get(m, key)) };
    let cache_read_tokens = num(first(&[
        get(t, "cached_tokens"),
        get(t, "cache_read_tokens"),
        get(t, "cache_read_input_tokens"),
        get(t, "cacheReadTokens"),
        get(t, "cachedReadTokens"),
        get(t, "cached_content_token_count"),
        pd("cached_tokens"),
        pd("cache_read_tokens"),
        pd("cache_read_input_tokens"),
        pd("cachedTokens"),
        get(row, "cachedTokens"),
        get(row, "cached_tokens"),
        get(row, "cachedReadTokens"),
        get(row, "cacheReadTokens"),
        get(row, "cache_read_tokens"),
        get(row, "cache_read_input_tokens"),
    ]));
    let cache_write_tokens = num(first(&[
        get(t, "cache_write_tokens"),
        get(t, "cache_creation_input_tokens"),
        get(t, "cache_creation_tokens"),
        get(t, "cacheWriteTokens"),
        pd("cache_write_tokens"),
        pd("cache_creation_input_tokens"),
        get(row, "cache_creation_tokens"),
        get(row, "cacheWriteTokens"),
        get(row, "cache_write_tokens"),
        get(row, "cache_creation_input_tokens"),
    ]));
    let meta = as_objectish(row.get("meta"));
    let cost = num(first(&[
        get(row, "cost"),
        get(row, "estimatedCost"),
        get(row, "usd"),
        get(row, "routerCost"),
        meta.and_then(|m| get(m, "cost")),
        meta.and_then(|m| get(m, "estimatedCost")),
    ]));
    // Zero-token stream probes do not count toward live RPM
    if input_tokens + output_tokens + cache_read_tokens + cache_write_tokens <= 0.0 && cost <= 0.0 {
        return None;
    }

    let native_id = ["id", "requestId", "request_id", "requestID", "traceId", "rowid"]
        .iter()
        .find_map(|k| get(row, k))
        .map(js_string)
        .unwrap_or_else(|| {
            format!("{}:{}:{}", ts, js_num_to_string(input_tokens), js_num_to_string(output_tokens))
        });
    let request_count_raw = num(first(&[get(row, "requests"), get(row, "requestCount"), get(row, "request_count")]));
    let request_count = if request_count_raw > 0.0 { request_count_raw.floor() } else { 1.0 };

    let model = str_field(row, "model")
        .or_else(|| str_field(row, "rawModel"))
        .or_else(|| str_field(row, "model_group"))
        .map(|s| s.to_string());

    Some(UsageEvent {
        id: format!("hotlive:{agent}:{native_id}").into(),
        agent: AgentId::from_id(agent).unwrap_or(AgentId::Custom),
        model: model.map(Into::into),
        timestamp: ts.into(),
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens: input_tokens + output_tokens + cache_read_tokens + cache_write_tokens,
        estimated_cost: if cost > 0.0 { Some(cost) } else { None },
        currency: ("USD".to_string()).into(),
        pricing_status: if cost > 0.0 { PricingStatus::Priced } else { PricingStatus::Estimated },
        workspace: (str_field(row, "provider").map(|p| format!("provider:{p}"))).map(Into::into),
        source_path: source.to_string().into(),
        estimated: Some(false),
        request_count: Some(request_count),
        ..UsageEvent::default()
    })
}

fn token_weight(e: &UsageEvent) -> f64 {
    or_zero(e.input_tokens) + or_zero(e.output_tokens) + or_zero(e.cache_read_tokens) + or_zero(e.cache_write_tokens)
}

/// True for per-call rows suitable for RECENT EVENTS.
/// False for estimated daily/model rollups (e.g. 298M tokens, 3946 requests).
///
/// Allows estimated *single-turn* rows (Antigravity brain transcripts, Grok
/// chat text estimates) so local agents without proxy counters still appear
/// in history next to real proxy/router rows.
pub fn is_live_request_event(e: &UsageEvent) -> bool {
    let rc = e.request_count.filter(|v| v.is_finite());
    // Fat multi-request packs are rollups, not a single API call
    if matches!(rc, Some(v) if v > 5.0) {
        return false;
    }

    if e.estimated == Some(true) {
        // Estimated day/model blobs: either multi-RQ or absurd token totals
        if matches!(rc, Some(v) if v > 1.0) {
            return false;
        }
        let mut total = or_zero(e.total_tokens);
        if total == 0.0 {
            total = token_weight(e);
        }
        // Single-turn estimates stay well below this; daily floors do not
        if total > 2_000_000.0 {
            return false;
        }
        // Zero-token estimated shells are noise
        if total <= 0.0 && !(e.estimated_cost.map_or(false, |c| c > 0.0)) {
            return false;
        }
        return true;
    }
    true
}

/// Process-local hot-mirror cache: period switches must not re-read multi-MB jsonl each time.
struct HotMirrorCache {
    at: f64,
    lookback_minutes: f64,
    tail_bytes: f64,
    files: Vec<HotFileStat>,
    events: Vec<UsageEvent>,
}

static HOT_MIRROR_CACHE: Lazy<Mutex<Option<HotMirrorCache>>> = Lazy::new(|| Mutex::new(None));

const HOT_MIRROR_TTL_MS: f64 = 3_000.0;

/// Drop the memoized hot-mirror pass (tests, config reload).
pub fn clear_hot_mirror_cache() {
    *HOT_MIRROR_CACHE.lock() = None;
}

fn in_live_window(e: &UsageEvent, start: f64, now: f64) -> bool {
    let t = e.timestamp.js_ms();
    t.is_finite() && t >= start && t <= now + 5_000.0
}

/// [`load_hot_mirror_live_events`] with the TS defaults (now, 30 minutes, 512 KiB).
pub async fn load_hot_mirror_live_events_default() -> Vec<UsageEvent> {
    load_hot_mirror_live_events(now_ms(), 30.0, 512.0 * 1024.0).await
}

/// Live per-call events from router mirrors (always fresh after VPS sync).
/// Used so RPM / RECENT EVENTS do not show only daily rollup blobs.
///
/// `lookback_minutes` is how far back to keep (slightly larger than the RPM
/// window for lastRequestAt). Results are memoized ~3s so a dashboard
/// double-fetch (stats x2 + events) shares one disk pass.
pub async fn load_hot_mirror_live_events(now_ms: f64, lookback_minutes: f64, tail_bytes: f64) -> Vec<UsageEvent> {
    let mins = f64::max(1.0, lookback_minutes);
    let bytes = f64::max(64.0 * 1024.0, tail_bytes);
    let files = hot_files_with_stats().await;

    // Reuse only when the source signatures are unchanged. A TTL alone made a
    // newly appended request invisible for up to 3s (and a snapshot replacement
    // could remain stale for the whole TTL).
    {
        let guard = HOT_MIRROR_CACHE.lock();
        if let Some(c) = guard.as_ref() {
            if now_ms - c.at < HOT_MIRROR_TTL_MS
                && c.lookback_minutes >= mins
                && c.tail_bytes >= bytes
                && c.files == files
            {
                let start = now_ms - mins * 60_000.0;
                return c.events.iter().filter(|e| in_live_window(e, start, now_ms)).cloned().collect();
            }
        }
    }

    let start = now_ms - mins * 60_000.0;
    let mut out: Vec<UsageEvent> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for f in &files {
        let rows = read_hot_rows(&f.file, f.size, bytes).await;
        for row in &rows {
            let Value::Object(m) = row else { continue };
            let Some(e) = row_to_live_event(m, &f.agent, &f.file) else { continue };
            if !is_live_request_event(&e) {
                continue;
            }
            let t = e.timestamp.js_ms();
            if !t.is_finite() || t < start || t > now_ms + 5_000.0 {
                continue;
            }
            if !seen.insert(e.id.clone().to_string()) {
                continue;
            }
            out.push(e);
        }
    }
    *HOT_MIRROR_CACHE.lock() =
        Some(HotMirrorCache { at: now_ms, lookback_minutes: mins, tail_bytes: bytes, files, events: out.clone() });
    out
}

/// Options for [`build_recent_live_events`].
#[derive(Debug, Clone, Default)]
pub struct RecentLiveOptions<'a> {
    /// Page size, clamped to 1..=1000 (default 50).
    pub limit: Option<f64>,
    pub since_ms: Option<f64>,
    pub until_ms: Option<f64>,
    pub agent: Option<String>,
    pub now_ms: Option<f64>,
    /// Parallel ms index (ascending) when the cache is time-sorted.
    pub timestamps_ms: Option<&'a [f64]>,
}

fn recent_key(e: &UsageEvent) -> String {
    // Collapse twin cache vs mirror copies of the same call at millisecond
    // precision. Second precision dropped legitimate bursts from the same
    // model with equal token counts.
    let parsed = e.timestamp.js_ms();
    let ts = if parsed.is_finite() {
        match to_iso_string(parsed) {
            Some(iso) => iso.chars().take(23).collect::<String>(),
            None => e.timestamp.clone().to_string(),
        }
    } else {
        e.timestamp.clone().to_string()
    };
    let agent = if e.agent == AgentId::Xlabrouter { "routerlab" } else { e.agent.as_str() };
    [
        agent.to_string(),
        ts,
        (e.model.clone().unwrap_or_default()).to_string(),
        js_num_to_string(or_zero(e.input_tokens)),
        js_num_to_string(or_zero(e.output_tokens)),
    ]
    .join("|")
}

fn put_recent(by_key: &mut IndexMap<String, UsageEvent>, e: &UsageEvent) {
    let key = recent_key(e);
    match by_key.get(&key) {
        None => {
            by_key.insert(key, e.clone());
        }
        Some(previous) => {
            let previous_ts = previous.timestamp.js_ms();
            let next_ts = e.timestamp.js_ms();
            // Reverse cache traversal sees newest first. Never let an older
            // duplicate overwrite it; a same-time mirror row may still win when
            // it is richer.
            if next_ts > previous_ts || (next_ts == previous_ts && token_weight(e) > token_weight(previous)) {
                by_key.insert(key, e.clone());
            }
        }
    }
}

/// Build a newest-first RECENT EVENTS list: live cache rows + hot router history.
/// Daily estimated rollups (multi-million-token "events") are never included.
///
/// Optimized for dashboard period switches: UI only shows ~25 rows, so we never
/// re-parse multi-day / multi-MB history tails for every 30D/All click.
pub async fn build_recent_live_events(cache: &[UsageEvent], opts: &RecentLiveOptions<'_>) -> Vec<UsageEvent> {
    let limit = f64::min(1000.0, f64::max(1.0, opts.limit.unwrap_or(50.0)));
    let now = opts.now_ms.unwrap_or_else(now_ms);
    let since_ms = opts.since_ms;
    let until_ms = opts.until_ms;
    // RECENT list normally needs newest rows only; keep the first pass cheap.
    // If the selected period has fewer than `limit` real rows in scan-cache,
    // expand below so a sparse/partial scan does not hide older requests that
    // still belong to the selected period.
    let requested_lookback_min = match since_ms {
        Some(s) if s.is_finite() => f64::max(60.0, ((now - s) / 60_000.0).ceil() + 15.0),
        _ => 6.0 * 60.0,
    };
    let fast_lookback_min = f64::min(24.0 * 60.0, requested_lookback_min);
    let hot = load_hot_mirror_live_events(now, fast_lookback_min, 256.0 * 1024.0).await;

    let agent_filter = opts.agent.as_deref().filter(|a| !a.is_empty());
    let in_period = |e: &UsageEvent| -> bool {
        let t = e.timestamp.js_ms();
        if !t.is_finite() {
            return false;
        }
        // Daily rollups from older cache versions can carry a future anchor. Do
        // this before applying the page limit; the UI also filters future rows,
        // but filtering only there can make valid requests fall off the page.
        if t > now + 5_000.0 {
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
        if let Some(a) = agent_filter {
            if e.agent.as_str() != a {
                return false;
            }
        }
        true
    };

    let mut by_key: IndexMap<String, UsageEvent> = IndexMap::new();

    // Prefer reverse scan of sorted cache (newest first) and stop once we have enough.
    let sorted_asc = matches!(opts.timestamps_ms, Some(ts) if ts.len() == cache.len() && !cache.is_empty());
    let need = f64::max(limit * 4.0, 80.0);
    if sorted_asc {
        for e in cache.iter().rev() {
            if by_key.len() as f64 >= need {
                break;
            }
            if !is_live_request_event(e) || !in_period(e) {
                continue;
            }
            put_recent(&mut by_key, e);
        }
    } else {
        for e in cache {
            if !is_live_request_event(e) || !in_period(e) {
                continue;
            }
            put_recent(&mut by_key, e);
        }
    }
    for e in &hot {
        if in_period(e) {
            put_recent(&mut by_key, e);
        }
    }

    // A 30D/All view with a thin cache can legitimately have its latest request
    // older than 24h. Only pay for the wider mirror edge read when the fast pass
    // did not already provide enough rows for the requested page.
    if (by_key.len() as f64) < limit && requested_lookback_min > fast_lookback_min {
        let extended_lookback_min = f64::min(30.0 * 24.0 * 60.0, requested_lookback_min);
        let extended = load_hot_mirror_live_events(now, extended_lookback_min, 1024.0 * 1024.0).await;
        for e in &extended {
            if in_period(e) {
                put_recent(&mut by_key, e);
            }
        }
    }

    let mut rows: Vec<UsageEvent> = by_key.into_values().collect();
    // Stable sort, newest first (Array.prototype.sort).
    rows.sort_by(|a, b| {
        let (ta, tb) = (a.timestamp.js_ms(), b.timestamp.js_ms());
        tb.partial_cmp(&ta).unwrap_or(std::cmp::Ordering::Equal)
    });
    rows.truncate(limit.trunc() as usize);
    rows
}

/// The live-rate result: the sliding-window rate fields (flattened, as the TS
/// object spread) plus when the last live request happened.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardLiveRate<R: Serialize> {
    #[serde(flatten)]
    pub rate: R,
    pub last_request_at: Option<String>,
    #[serde(serialize_with = "jsnum::ser_opt")]
    pub last_request_age_sec: Option<f64>,
}

/// Merge recent scan-cache + hot mirror live rows, then compute APM sliding-window RPM.
/// Also reports last live request time so the UI can explain idle zeros.
///
/// `rate_fn` is `aggregate::compute_live_request_rate(events, window_minutes, now_ms)`
/// (the TS `computeLiveRequestRate`); it is injected so this module does not
/// depend on aggregate internals. `window_minutes` is clamped to 1..=60 (default 3).
///
/// Critical: do NOT scan the full multi-day cache on every /api/stats; that
/// blocked the event loop for seconds and made period switches feel frozen.
pub async fn compute_dashboard_live_rate<R, F>(
    cache: &[UsageEvent],
    window_minutes: f64,
    now_ms: f64,
    timestamps_ms: Option<&[f64]>,
    rate_fn: F,
) -> DashboardLiveRate<R>
where
    R: Serialize,
    F: FnOnce(&[UsageEvent], f64, f64) -> R,
{
    let floored = window_minutes.floor();
    let floored = if floored.is_nan() || floored == 0.0 { 3.0 } else { floored };
    let mins = f64::max(1.0, f64::min(60.0, floored));
    // Hot mirrors: short lookback only (RPM is 3m window)
    let hot = load_hot_mirror_live_events(now_ms, f64::max(30.0, mins * 4.0), 256.0 * 1024.0).await;

    // Only feed the rate function rows that can fall inside the window (+skew).
    // Spreading 50k+ full-history events was the period-switch bottleneck.
    let window_start = now_ms - mins * 60_000.0 - 5_000.0;
    let mut recent: Vec<UsageEvent> = Vec::new();
    let sorted_asc = matches!(timestamps_ms, Some(ts) if ts.len() == cache.len() && !cache.is_empty());

    let mut last_ms: f64 = 0.0;
    let consider_last = |e: &UsageEvent, last_ms: &mut f64| {
        if !is_live_request_event(e) {
            return;
        }
        let t = e.timestamp.js_ms();
        if !t.is_finite() || t > now_ms + 5_000.0 {
            return;
        }
        if t > *last_ms {
            *last_ms = t;
        }
    };

    if sorted_asc {
        let ts = timestamps_ms.unwrap();
        let mut extra_scanned: usize = 0;
        // Ascending: walk from the end for recent window + lastRequestAt in one pass
        for i in (0..cache.len()).rev() {
            let t = ts[i];
            if !t.is_finite() || t > now_ms + 5_000.0 {
                continue;
            }
            if t > last_ms && is_live_request_event(&cache[i]) {
                last_ms = t;
            }
            if t < window_start {
                // Older than the rate window: keep walking back only to find
                // lastRequestAt (bounded), never feeding the rate function.
                if last_ms > 0.0 {
                    break;
                }
                extra_scanned += 1;
                if extra_scanned > 20_000 {
                    break;
                }
                continue;
            }
            if cache[i].estimated != Some(true) {
                recent.push(cache[i].clone());
            }
        }
    } else {
        for e in cache {
            consider_last(e, &mut last_ms);
            if e.estimated == Some(true) {
                continue;
            }
            let t = e.timestamp.js_ms();
            if t.is_finite() && t >= window_start && t <= now_ms + 5_000.0 {
                recent.push(e.clone());
            }
        }
    }
    // Cache rows win over mirror twins of the same call (avoid double counting).
    let cache_keys: std::collections::HashSet<String> = recent.iter().map(recent_key).collect();
    for e in &hot {
        consider_last(e, &mut last_ms);
        if cache_keys.contains(&recent_key(e)) {
            continue;
        }
        recent.push(e.clone());
    }

    let rate = rate_fn(&recent, mins, now_ms);

    DashboardLiveRate {
        rate,
        last_request_at: if last_ms > 0.0 { to_iso_string(last_ms) } else { None },
        last_request_age_sec: if last_ms > 0.0 {
            Some(f64::max(0.0, js_round((now_ms - last_ms) / 1000.0)))
        } else {
            None
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn live_event_from_row() {
        let r = row(json!({
            "id": 42,
            "timestamp": "2026-05-01T10:00:00Z",
            "provider": "openai",
            "model": "gpt-5",
            "tokens": "{\"prompt_tokens\": 100, \"completion_tokens\": 20, \"prompt_tokens_details\": {\"cached_tokens\": 30}}",
            "cost": 0.5
        }));
        let e = row_to_live_event(&r, "9router", "/x/db.json").unwrap();
        assert_eq!(e.id, "hotlive:9router:42");
        assert_eq!(e.agent, AgentId::NineRouter);
        assert_eq!(e.timestamp, "2026-05-01T10:00:00.000Z");
        assert_eq!((e.input_tokens, e.output_tokens, e.cache_read_tokens), (100.0, 20.0, 30.0));
        assert_eq!(e.total_tokens, 150.0);
        assert_eq!(e.estimated_cost, Some(0.5));
        assert_eq!(e.pricing_status, PricingStatus::Priced);
        assert_eq!(e.workspace.as_deref(), Some("provider:openai"));
        assert_eq!(e.request_count, Some(1.0));
        assert_eq!(e.estimated, Some(false));
    }

    #[test]
    fn live_event_rejects_probes_and_bad_ts() {
        let probe = row(json!({"timestamp": "2026-05-01T10:00:00Z", "model": "m"}));
        assert!(row_to_live_event(&probe, "litellm", "f").is_none());
        let no_ts = row(json!({"promptTokens": 5}));
        assert!(row_to_live_event(&no_ts, "litellm", "f").is_none());
        // Seconds-epoch and ms-epoch both accepted; small numbers are not timestamps.
        let secs = row(json!({"ts": 1_700_000_000, "promptTokens": 5}));
        let e = row_to_live_event(&secs, "litellm", "f").unwrap();
        assert_eq!(e.timestamp, "2023-11-14T22:13:20.000Z");
        assert_eq!(e.id, "hotlive:litellm:2023-11-14T22:13:20.000Z:5:0");
        assert!(row_to_live_event(&row(json!({"ts": 12345, "promptTokens": 5})), "litellm", "f").is_none());
        // A cost-only row counts; request count floors.
        let cost = row(json!({"timestamp": 1_700_000_000_000_i64, "usd": 0.01, "requests": 2.9, "rawModel": "x"}));
        let e = row_to_live_event(&cost, "routerlab", "f").unwrap();
        assert_eq!(e.request_count, Some(2.0));
        assert_eq!(e.model.as_deref(), Some("x"));
        assert_eq!(e.estimated_cost, Some(0.01));
    }

    #[test]
    fn live_request_filter() {
        let mut e = UsageEvent { timestamp: "2026-05-01T10:00:00.000Z".into(), ..UsageEvent::default() };
        e.input_tokens = 10.0;
        e.total_tokens = 10.0;
        assert!(is_live_request_event(&e));
        e.request_count = Some(6.0);
        assert!(!is_live_request_event(&e));
        e.request_count = Some(1.0);
        e.estimated = Some(true);
        assert!(is_live_request_event(&e));
        e.total_tokens = 3_000_000.0;
        assert!(!is_live_request_event(&e));
        e.total_tokens = 0.0;
        e.input_tokens = 0.0;
        assert!(!is_live_request_event(&e));
        e.estimated_cost = Some(0.1);
        assert!(is_live_request_event(&e));
        e.request_count = Some(2.0);
        assert!(!is_live_request_event(&e));
    }

    #[test]
    fn jsonl_edges_and_history_rows() {
        assert_eq!(complete_jsonl_lines("a\r\n\r\n b \nc", EdgeMode::Full), vec!["a", " b ", "c"]);
        assert_eq!(complete_jsonl_lines("partial\nx\ny\nhalf", EdgeMode::Tail), vec!["x", "y", "half"]);
        assert_eq!(complete_jsonl_lines("x\ny\nhalf", EdgeMode::Head), vec!["x", "y"]);
        assert_eq!(history_rows(&json!({"data": {"usage": [1, 2]}})).len(), 2);
        assert_eq!(history_rows(&json!({"history": [1], "records": [1, 2]})).len(), 1);
        assert!(history_rows(&json!("x")).is_empty());
        assert!(history_rows(&json!({"usage": [], "data": [7]})).len() == 1);
    }

    #[test]
    fn recent_key_collapses_twins() {
        let mut a = UsageEvent { timestamp: "2026-05-01T10:00:00.123Z".into(), agent: AgentId::Xlabrouter, ..Default::default() };
        a.model = Some("m".into());
        a.input_tokens = 5.0;
        let mut b = a.clone();
        b.agent = AgentId::Routerlab;
        assert_eq!(recent_key(&a), recent_key(&b));
        assert_eq!(recent_key(&a), "routerlab|2026-05-01T10:00:00.123|m|5|0");
    }

    #[tokio::test]
    async fn reads_jsonl_and_sqlite_sources() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("usage-history.jsonl");
        std::fs::write(&p, "{\"a\":1}\nnot json\n{\"b\":2}\n").unwrap();
        let size = std::fs::metadata(&p).unwrap().len() as f64;
        let rows = read_hot_rows(p.to_str().unwrap(), size, 1024.0).await;
        assert_eq!(rows.len(), 2);

        let jp = dir.path().join("db.json");
        std::fs::write(&jp, "{\"history\": [{\"x\": 1}]}").unwrap();
        let rows = read_hot_rows(jp.to_str().unwrap(), 10.0, 1024.0).await;
        assert_eq!(rows, vec![json!({"x": 1})]);

        let sp = dir.path().join("data.sqlite");
        {
            let c = rusqlite::Connection::open(&sp).unwrap();
            c.execute_batch(
                "CREATE TABLE usageHistory (id INTEGER PRIMARY KEY, timestamp TEXT, provider TEXT, model TEXT, connectionId TEXT, apiKey TEXT, endpoint TEXT, promptTokens INTEGER, completionTokens INTEGER, cost REAL, status TEXT, tokens TEXT, meta TEXT);
                 INSERT INTO usageHistory (id, timestamp, model, promptTokens, completionTokens, cost) VALUES (1, '2026-05-01T10:00:00Z', 'a', 5, 6, 0.5), (2, '2026-05-01T10:01:00Z', 'b', 7, 8, 0.0);",
            )
            .unwrap();
        }
        let rows = read_hot_rows(sp.to_str().unwrap(), 100.0, 1024.0).await;
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], json!(2));
        assert_eq!(rows[1]["cost"], json!(0.5));
        // A non-database file yields no rows rather than an error.
        let bad = dir.path().join("db.sqlite");
        std::fs::write(&bad, "garbage").unwrap();
        assert!(read_hot_rows(bad.to_str().unwrap(), 7.0, 1024.0).await.is_empty());
    }

    #[tokio::test]
    async fn dashboard_rate_tracks_last_request() {
        clear_hot_mirror_cache();
        let now = 1_800_000_000_000.0;
        let mk = |offset_s: f64, est: bool| UsageEvent {
            timestamp: to_iso_string(now - offset_s * 1000.0).unwrap().into(),
            input_tokens: 10.0,
            total_tokens: 10.0,
            estimated: Some(est),
            ..Default::default()
        };
        let cache = vec![mk(600.0, false), mk(30.0, false), mk(10.0, true)];
        let out = compute_dashboard_live_rate(&cache, 3.0, now, None, |ev, mins, _| {
            json!({"events": ev.len(), "windowMinutes": mins})
        })
        .await;
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(v["events"], json!(1));
        assert_eq!(v["windowMinutes"], json!(3.0));
        assert_eq!(v["lastRequestAgeSec"], json!(10));
        assert!(v["lastRequestAt"].is_string());
    }
}
