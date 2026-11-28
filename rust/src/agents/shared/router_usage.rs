//! Port of `src/agents/shared/router-usage.ts`.
//!
//! Shared parser for 9router / routerlab (ex xlabrouter) / litellm local data.
//!
//! Preference (request-first for RECENT EVENTS, daily as gap-fill):
//!  1. Per-request history (jsonl / usageHistory / request-details) when a multi-RQ sample exists
//!  2. usage-daily / usageDaily / dailySummary byModel as the all-time floor when
//!     history is missing or only a partial window
//!
//! The TS `WeakMap<UsageEvent, ...>` side tables (native request id, root scope)
//! are carried in the private [`REvent`] wrapper instead.

use crate::config::get_config_sync;
use crate::types::{AgentId, ModelRate, UsageEvent};
use crate::util::{
    js_date_parse, js_num_to_string, js_trim, normalize_model_name, now_ms, num, parse_jsonl,
    parse_timestamp_in_zone, path_exists, pjoin, read_text, stable_id, to_iso_string,
};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap, HashSet};

const ROUTER_MIRROR_MARKER: &str = "#mirror-root=";

/// Source tag for rows synthesized from a daily rollup (see TS `ROLLUP_SOURCE`).
const ROLLUP_SOURCE: &str = "daily-rollup";

/// `parseRouterUsage` options.
#[derive(Debug, Clone, Copy, Default)]
pub struct RouterUsageOptions {
    pub recent_only: bool,
}

/// An event plus the side-table data the TS keeps in WeakMaps.
struct REvent {
    event: UsageEvent,
    native_id: String,
    scope: String,
}

struct DailySource {
    #[allow(dead_code)]
    source: String,
    daily: Map<String, Value>,
    scope: String,
}

// ---------------------------------------------------------------------------
// Pricing shims (single place to reconcile with `crate::pricing`)
// ---------------------------------------------------------------------------

fn price_event(partial: UsageEvent, router_cost: Option<f64>) -> UsageEvent {
    crate::pricing::apply_pricing_with(partial, router_cost)
}

fn rate_for_model(model: Option<&str>) -> Option<ModelRate> {
    Some(crate::pricing::get_rate_for_model(model).rate)
}

// ---------------------------------------------------------------------------
// JS-semantics helpers
// ---------------------------------------------------------------------------

/// `a.b` as "defined and not null" (nullish-coalescing view).
fn g<'a>(m: &'a Map<String, Value>, k: &str) -> Option<&'a Value> {
    match m.get(k) {
        None | Some(Value::Null) => None,
        Some(v) => Some(v),
    }
}

/// First non-nullish of the candidates (`a ?? b ?? c`).
fn first<'a>(c: &[Option<&'a Value>]) -> Option<&'a Value> {
    c.iter().copied().flatten().next()
}

fn n(v: Option<&Value>) -> f64 {
    v.map_or(0.0, num)
}

fn gstr<'a>(m: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    match m.get(k) {
        Some(Value::String(s)) => Some(s.as_str()),
        _ => None,
    }
}

/// JS truthiness of a JSON value.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(x)) => x.as_f64().map_or(false, |f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `String(v)` for a JSON value.
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(x) => match x.as_i64() {
            Some(i) => i.to_string(),
            None => js_num_to_string(x.as_f64().unwrap_or(f64::NAN)),
        },
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|e| if e.is_null() { String::new() } else { js_string(e) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `/^\d{4}-\d{2}-\d{2}$/`
fn is_date_key(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}

/// Object (non-array) view, `v && typeof v === "object" && !Array.isArray(v)`.
fn as_obj(v: Option<&Value>) -> Option<&Map<String, Value>> {
    match v {
        Some(Value::Object(m)) => Some(m),
        _ => None,
    }
}

fn js_slice_chars(s: &str, end: usize) -> String {
    s.chars().take(end).collect()
}

fn num_str(x: f64) -> String {
    js_num_to_string(x)
}

// ---------------------------------------------------------------------------
// Roots / scopes / model
// ---------------------------------------------------------------------------

/// Order roots so the preferred VPS mirror is scanned first.
fn prioritize_router_roots(roots: &[String]) -> Vec<String> {
    fn score(r: &str) -> i32 {
        let s = r.replace('\\', "/").to_lowercase();
        if s.contains("/mirrors/routerlab") || s.contains("/mirrors/9router") || s.contains("/mirrors/litellm") {
            return 100;
        }
        if s.contains("/mirrors/xlabrouter") {
            return 90;
        }
        if s.contains("my.bnix.one")
            && (s.contains("routerlab") || s.contains("9router") || s.contains("xlabrouter") || s.contains("litellm"))
        {
            return 80;
        }
        if s.contains("/.9router") || s.contains("/var/lib/xlabrouter") || s.contains("/opt/litellm") {
            return 70;
        }
        if s.contains("xlab-token/mirrors") {
            return 60;
        }
        10
    }
    let mut v: Vec<String> = roots.to_vec();
    v.sort_by(|a, b| score(b).cmp(&score(a)));
    v
}

fn scope_router_event(ev: &mut REvent, root_scope: &str) {
    ev.scope = root_scope.to_string();
    if root_scope == "primary" {
        return;
    }
    ev.event.id = stable_id(&["router-mirror-event", root_scope, &ev.event.id.to_str()]).into();
    if !ev.event.source_path.contains(ROUTER_MIRROR_MARKER) {
        ev.event.source_path = format!("{}{}{}", ev.event.source_path, ROUTER_MIRROR_MARKER, root_scope).into();
    }
}

/// Resolve the display model for router data (`routerModelFromRecord`).
fn router_model_from_record(agent: AgentId, record: &Map<String, Value>, fallback: Option<&str>) -> Option<String> {
    let keys = [
        "model_group",
        "modelGroup",
        "displayModel",
        "display_model",
        "model",
        "modelId",
        "model_id",
        "model_name",
        "rawModel",
    ];
    let mut cands: Vec<Option<&str>> = keys.iter().map(|k| gstr(record, k)).collect();
    cands.push(fallback);
    let mut model: Option<String> = None;
    for c in cands.into_iter().flatten() {
        if js_trim(c).is_empty() {
            continue;
        }
        model = normalize_model_name(Some(c));
        if model.is_some() {
            break;
        }
    }
    let model = model?;
    if agent == AgentId::Litellm && model.to_lowercase() == "openclaw" {
        return Some("glm-5.3".to_string());
    }
    Some(model)
}

// ---------------------------------------------------------------------------
// rowToEvent
// ---------------------------------------------------------------------------

fn details_map<'a>(tokens: &'a Map<String, Value>, empty: &'a Map<String, Value>) -> Option<&'a Map<String, Value>> {
    for k in ["prompt_tokens_details", "promptTokensDetails", "input_tokens_details"] {
        match tokens.get(k) {
            Some(Value::Object(m)) => return Some(m),
            Some(Value::Array(_)) => return Some(empty),
            _ => {}
        }
    }
    None
}

fn row_to_event(row: &Value, agent: AgentId, source: &str, tag: &str) -> Option<REvent> {
    let r = match row {
        Value::Object(m) => m,
        _ => return None,
    };
    let empty: Map<String, Value> = Map::new();

    let mut tokens_obj: Map<String, Value> = Map::new();
    match r.get("tokens") {
        Some(Value::Object(m)) => tokens_obj = m.clone(),
        Some(Value::String(s)) if !js_trim(s).is_empty() => {
            if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(s) {
                tokens_obj = m;
            }
        }
        _ => {}
    }
    let t = &tokens_obj;
    let pd = details_map(t, &empty);
    let pdg = |k: &str| pd.and_then(|m| g(m, k));

    let input_tokens = n(first(&[
        g(t, "prompt_tokens"),
        g(t, "promptTokens"),
        g(t, "input_tokens"),
        g(t, "inputTokens"),
        g(r, "promptTokens"),
        g(r, "prompt_tokens"),
        g(r, "inputTokens"),
        g(r, "input_tokens"),
    ]));
    let output_tokens = n(first(&[
        g(t, "completion_tokens"),
        g(t, "completionTokens"),
        g(t, "output_tokens"),
        g(t, "outputTokens"),
        g(r, "completionTokens"),
        g(r, "completion_tokens"),
        g(r, "outputTokens"),
        g(r, "output_tokens"),
    ]));

    let cache_read_c = [
        g(t, "cached_tokens"),
        g(t, "cache_read_tokens"),
        g(t, "cache_read_input_tokens"),
        g(t, "cacheReadTokens"),
        g(t, "cachedReadTokens"),
        g(t, "cached_content_token_count"),
        pdg("cached_tokens"),
        pdg("cache_read_tokens"),
        pdg("cachedTokens"),
        pdg("cache_read_input_tokens"),
        g(r, "cachedTokens"),
        g(r, "cached_tokens"),
        g(r, "cacheReadTokens"),
        g(r, "cache_read_input_tokens"),
        g(r, "cache_read_tokens"),
    ];
    let cache_read_tokens = n(first(&cache_read_c));
    let cache_write_c = [
        g(t, "cache_write_tokens"),
        g(t, "cache_creation_input_tokens"),
        g(t, "cacheWriteTokens"),
        g(t, "cache_creation_tokens"),
        pdg("cache_write_tokens"),
        pdg("cache_creation_input_tokens"),
        g(r, "cacheWriteTokens"),
        g(r, "cache_write_tokens"),
        g(r, "cache_creation_input_tokens"),
    ];
    let cache_write_tokens = n(first(&cache_write_c));

    // Did the source expose a cache field, even as an explicit zero?
    // (Read candidates + write candidates; the TS lists exactly these keys.)
    let has_cache_field = cache_read_c.iter().chain(cache_write_c.iter()).any(|v| v.is_some());

    let request_hint = n(first(&[g(r, "requests"), g(r, "requestCount"), g(r, "request_count")]));
    let router_cost_hint = n(first(&[g(r, "cost"), g(r, "estimatedCost"), g(r, "usd")]));

    // LiteLLM's prompt count is INCLUSIVE of cache reads for per-request rows.
    let mut effective_input = input_tokens;
    let is_rollup_row = source.starts_with(ROLLUP_SOURCE);
    if agent == AgentId::Litellm && cache_read_tokens > 0.0 && !is_rollup_row && input_tokens >= cache_read_tokens {
        let billed = cache_read_tokens.min(input_tokens);
        effective_input = input_tokens - billed;
    }

    let sum = effective_input + output_tokens + cache_read_tokens + cache_write_tokens;
    if sum <= 0.0 && router_cost_hint <= 0.0 {
        return None;
    }
    if sum <= 0.0 && request_hint <= 0.0 {
        return None;
    }

    let model_label = router_model_from_record(agent, r, None);
    let provider = gstr(r, "provider").map(|s| s.to_string());

    let ts_raw = first(&[
        g(r, "timestamp"),
        g(r, "createdAt"),
        g(r, "created_at"),
        g(r, "date"),
        g(r, "ts"),
    ]);
    let mut ts: Option<String> = None;
    match ts_raw {
        Some(Value::String(s)) if !js_trim(s).is_empty() && !js_date_parse(s).is_nan() => {
            let cfg = get_config_sync();
            let ms = parse_timestamp_in_zone(s, cfg.timezone.as_deref());
            if !ms.is_nan() {
                ts = to_iso_string(ms);
            }
        }
        Some(Value::Number(x)) => {
            let v = x.as_f64().unwrap_or(f64::NAN);
            if v.is_finite() && v > 0.0 {
                let ms = if v > 1e12 {
                    v
                } else if v > 1e9 {
                    v * 1000.0
                } else {
                    f64::NAN
                };
                if ms.is_finite() {
                    ts = to_iso_string(ms);
                }
            }
        }
        _ => {}
    }
    let ts = ts?;

    // Router-reported cost: use when > 0.
    let meta = match r.get("meta") {
        Some(Value::Object(m)) => Some(m),
        Some(Value::Array(_)) => Some(&empty),
        _ => None,
    };
    let has_router_cost_field = g(r, "cost").is_some()
        || g(r, "estimatedCost").is_some()
        || g(r, "usd").is_some()
        || meta.map_or(false, |m| g(m, "cost").is_some() || g(m, "estimatedCost").is_some());
    let router_cost_raw = n(first(&[
        g(r, "cost"),
        g(r, "estimatedCost"),
        g(r, "usd"),
        meta.and_then(|m| first(&[g(m, "cost"), g(m, "estimatedCost")])),
    ]));
    let connection_id = gstr(r, "connectionId").unwrap_or("").to_string();
    let endpoint = gstr(r, "endpoint").unwrap_or("").to_string();
    let native_id = match g(r, "id") {
        Some(v) => js_string(v),
        None => tag.to_string(),
    };

    // Token/cost parity flag (see TS comment): gateway cost below what its own tokens imply.
    let rate = rate_for_model(model_label.as_deref());
    let mut cost_parity_gap = false;
    if has_router_cost_field && router_cost_raw > 0.0 {
        if let Some(rate) = &rate {
            let implied = (effective_input / 1e6) * rate.input_per_1m
                + (output_tokens / 1e6) * rate.output_per_1m
                + (cache_write_tokens / 1e6) * rate.cache_write_per_1m.unwrap_or(0.0);
            cost_parity_gap = implied > 0.0 && router_cost_raw < implied * 0.95;
        }
    }

    let request_count_raw = request_hint;
    let request_count = if request_count_raw > 0.0 { request_count_raw.floor() } else { 1.0 };

    let id = stable_id(&[
        agent.as_str(),
        &native_id,
        &num_str(effective_input),
        &num_str(output_tokens),
        &ts,
        &connection_id,
        model_label.as_deref().unwrap_or(""),
    ]);
    let partial = UsageEvent {
        id: id.into(),
        agent,
        model: model_label.map(Into::into),
        timestamp: ts.into(),
        input_tokens: effective_input,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        workspace: (provider.as_ref().filter(|p| !p.is_empty()).map(|p| format!("provider:{}", p))).map(Into::into),
        source_path: source.to_string().into(),
        request_count: Some(request_count),
        cache_reported: Some(has_cache_field),
        cost_parity_gap: Some(cost_parity_gap),
        ..UsageEvent::default()
    };
    let router_cost = if has_router_cost_field && router_cost_raw > 0.0 {
        Some(router_cost_raw)
    } else {
        None
    };
    let mut event = price_event(partial, router_cost);

    if !endpoint.is_empty() && event.workspace.is_none() {
        event.workspace = Some(endpoint.into());
    }
    event.request_count = Some(request_count);

    let native = if g(r, "id").is_some() { native_id } else { String::new() };
    Some(REvent { event, native_id: native, scope: String::new() })
}

fn history_to_events(history: &[Value], agent: AgentId, source: &str) -> Vec<REvent> {
    let mut out = Vec::new();
    for (i, row) in history.iter().enumerate() {
        if let Some(e) = row_to_event(row, agent, source, &(i + 1).to_string()) {
            out.push(e);
        }
    }
    out
}

fn extract_history_array(data: &Value) -> Vec<Value> {
    match data {
        Value::Array(a) => a.clone(),
        Value::Object(o) => {
            for k in ["history", "records", "events", "usageHistory"] {
                if let Some(Value::Array(a)) = o.get(k) {
                    return a.clone();
                }
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Sources: sqlite, JSON, jsonl
// ---------------------------------------------------------------------------

fn sqlite_value(v: rusqlite::types::ValueRef<'_>) -> Value {
    use rusqlite::types::ValueRef;
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(_) => Value::Null,
    }
}

fn open_ro(db_path: &str) -> Option<rusqlite::Connection> {
    rusqlite::Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
}

fn query_rows(conn: &rusqlite::Connection, sql: &str) -> Option<Vec<Map<String, Value>>> {
    let mut stmt = conn.prepare(sql).ok()?;
    let cols: Vec<String> = stmt.column_names().into_iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.query([]).ok()?;
    let mut out = Vec::new();
    loop {
        match rows.next() {
            Ok(Some(row)) => {
                let mut m = Map::new();
                for (i, c) in cols.iter().enumerate() {
                    let v = row.get_ref(i).map(sqlite_value).unwrap_or(Value::Null);
                    m.insert(c.clone(), v);
                }
                out.push(m);
            }
            Ok(None) => break,
            Err(_) => return None,
        }
    }
    Some(out)
}

fn parse_sqlite_usage_blocking(db_path: &str, agent: AgentId, limit: f64) -> Vec<REvent> {
    let mut events = Vec::new();
    let lim = (limit.floor()).min(20_000.0).max(100.0) as i64;
    let conn = match open_ro(db_path) {
        Some(c) => c,
        None => return events,
    };
    let rows = query_rows(
        &conn,
        &format!(
            "SELECT id, timestamp, provider, model, model_group, connectionId, apiKey, endpoint, \
             promptTokens, completionTokens, cost, status, tokens, meta \
             FROM usageHistory ORDER BY id DESC LIMIT {}",
            lim
        ),
    )
    .or_else(|| query_rows(&conn, &format!("SELECT * FROM usageHistory ORDER BY rowid DESC LIMIT {}", lim)))
    .unwrap_or_default();
    for row in rows {
        let tag = match first(&[g(&row, "id"), g(&row, "rowid")]) {
            Some(v) => js_string(v),
            None => String::new(),
        };
        if let Some(e) = row_to_event(&Value::Object(row), agent, db_path, &tag) {
            events.push(e);
        }
    }
    events
}

async fn parse_sqlite_usage(db_path: &str, agent: AgentId, limit: f64) -> Vec<REvent> {
    let p = db_path.to_string();
    tokio::task::spawn_blocking(move || parse_sqlite_usage_blocking(&p, agent, limit))
        .await
        .unwrap_or_default()
}

/// Read usageDaily table into a dateKey map of day payloads.
fn parse_sqlite_daily_blocking(db_path: &str) -> Option<Map<String, Value>> {
    let conn = open_ro(db_path)?;
    let rows = query_rows(&conn, "SELECT dateKey, data FROM usageDaily")?;
    let mut daily = Map::new();
    for row in rows {
        let key = match row.get("dateKey") {
            Some(Value::String(s)) if !s.is_empty() => s.clone(),
            Some(v @ Value::Number(_)) if truthy(Some(v)) => js_string(v),
            _ => continue,
        };
        if let Some(Value::String(s)) = row.get("data") {
            if let Ok(parsed @ (Value::Object(_) | Value::Array(_))) = serde_json::from_str::<Value>(s) {
                daily.insert(key, parsed);
            }
        }
    }
    if daily.is_empty() {
        None
    } else {
        Some(daily)
    }
}

async fn parse_sqlite_daily(db_path: &str) -> Option<Map<String, Value>> {
    let p = db_path.to_string();
    tokio::task::spawn_blocking(move || parse_sqlite_daily_blocking(&p)).await.ok().flatten()
}

/// Single disk read + JSON parse; None when missing or invalid.
async fn read_json_if_exists(file: &str) -> Option<Value> {
    if !path_exists(file).await {
        return None;
    }
    let text = read_text(file).await?;
    if text.is_empty() {
        return None;
    }
    serde_json::from_str::<Value>(&text).ok()
}

fn daily_from_usage_json(data: Option<&Value>) -> Option<Map<String, Value>> {
    let o = as_obj(data)?;
    let nested = as_obj(g(o, "usageData")).and_then(|u| g(u, "dailySummary"));
    let daily = first(&[g(o, "dailySummary"), g(o, "daily"), g(o, "usageDaily"), nested]);
    as_obj(daily).cloned()
}

fn daily_from_db_json(data: Option<&Value>) -> Option<Map<String, Value>> {
    let o = as_obj(data)?;
    let usage_data = as_obj(first(&[g(o, "usageData"), g(o, "usage")]))?;
    as_obj(g(usage_data, "dailySummary")).cloned()
}

fn history_from_usage_json(data: Option<&Value>, agent: AgentId, source: &str) -> Vec<REvent> {
    match data {
        None | Some(Value::Null) => Vec::new(),
        Some(d) => history_to_events(&extract_history_array(d), agent, source),
    }
}

fn history_from_db_json(data: Option<&Value>, agent: AgentId, source: &str) -> Vec<REvent> {
    let o = match as_obj(data) {
        Some(o) => o,
        None => return Vec::new(),
    };
    match first(&[g(o, "usageData"), g(o, "usage")]) {
        Some(u @ (Value::Object(_) | Value::Array(_))) => history_to_events(&extract_history_array(u), agent, source),
        _ => Vec::new(),
    }
}

/// Standalone daily file shapes: map, VPS export array, or wrapper.
async fn read_daily_summary_standalone(file: &str) -> Option<Map<String, Value>> {
    let text = read_text(file).await?;
    if text.is_empty() {
        return None;
    }
    let data: Value = serde_json::from_str(&text).ok()?;
    normalize_daily_map(&data).filter(|m| !m.is_empty())
}

/// Normalize various daily export shapes into dateKey -> day payload map.
fn normalize_daily_map(data: &Value) -> Option<Map<String, Value>> {
    if !truthy(Some(data)) {
        return None;
    }

    // B) array of { dateKey, data }
    if let Value::Array(rows) = data {
        let mut daily = Map::new();
        for row in rows {
            let r = match row {
                Value::Object(m) => m,
                _ => continue,
            };
            let key_raw = first(&[g(r, "dateKey"), g(r, "date"), g(r, "day"), g(r, "key")]);
            let key = match key_raw {
                Some(Value::String(s)) => js_trim(s).to_string(),
                _ => String::new(),
            };
            if !is_date_key(&key) {
                continue;
            }
            // `!== undefined`: an explicit JSON null counts as defined.
            let mut payload: Value = if let Some(v) = r.get("data") {
                v.clone()
            } else if let Some(v) = r.get("payload") {
                v.clone()
            } else {
                row.clone()
            };
            if let Value::String(s) = &payload {
                if !js_trim(s).is_empty() {
                    match serde_json::from_str::<Value>(s) {
                        Ok(v) => payload = v,
                        Err(_) => continue,
                    }
                }
            }
            if let Value::Object(p) = &payload {
                let defined = |k: &str| p.contains_key(k);
                if truthy(p.get("dateKey")) && (defined("data") || defined("promptTokens") || defined("requests")) {
                    if defined("promptTokens") || defined("requests") || defined("cost") || truthy(p.get("byModel")) {
                        daily.insert(key, payload.clone());
                    } else if matches!(p.get("data"), Some(Value::Object(_) | Value::Array(_))) {
                        daily.insert(key, p.get("data").cloned().unwrap());
                    } else {
                        daily.insert(key, payload.clone());
                    }
                } else {
                    daily.insert(key, payload.clone());
                }
            }
        }
        return if daily.is_empty() { None } else { Some(daily) };
    }

    let o = match data {
        Value::Object(o) => o,
        _ => return None,
    };

    // C) wrapper
    if let Some(Value::Object(m)) = o.get("dailySummary") {
        return Some(m.clone());
    }
    if let Some(v @ Value::Object(_)) = o.get("usageDaily") {
        return normalize_daily_map(v);
    }
    if let Some(v @ Value::Array(_)) = o.get("days") {
        return normalize_daily_map(v);
    }

    // A) plain dateKey map (or mixed - keep only date keys)
    let mut daily = Map::new();
    let mut date_keys = 0;
    for (k, v) in o {
        if !is_date_key(k) {
            continue;
        }
        date_keys += 1;
        match v {
            Value::Object(_) | Value::Array(_) => {
                daily.insert(k.clone(), v.clone());
            }
            Value::String(s) => {
                if let Ok(parsed @ (Value::Object(_) | Value::Array(_))) = serde_json::from_str::<Value>(s) {
                    daily.insert(k.clone(), parsed);
                }
            }
            _ => {}
        }
    }
    if date_keys > 0 {
        return if daily.is_empty() { None } else { Some(daily) };
    }
    None
}

async fn parse_history_export(file: &str, agent: AgentId) -> Vec<REvent> {
    let text = match read_text(file).await {
        Some(t) if !t.is_empty() => t,
        _ => return Vec::new(),
    };
    if file.ends_with(".jsonl") {
        return history_to_events(&parse_jsonl(&text), agent, file);
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(data) => history_to_events(&extract_history_array(&data), agent, file),
        Err(_) => Vec::new(),
    }
}

/// Read only the last ~max_bytes of a large jsonl.
async fn parse_history_export_tail(file: &str, agent: AgentId, max_bytes: u64) -> Vec<REvent> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let inner = async {
        let mut fh = tokio::fs::File::open(file).await.ok()?;
        let size = fh.metadata().await.ok()?.len();
        if size == 0 {
            return Some(Vec::new());
        }
        let start = size.saturating_sub(max_bytes.max(64 * 1024));
        fh.seek(std::io::SeekFrom::Start(start)).await.ok()?;
        let mut buf = Vec::with_capacity((size - start) as usize);
        fh.take(size - start).read_to_end(&mut buf).await.ok()?;
        let mut text = String::from_utf8_lossy(&buf).into_owned();
        if start > 0 {
            if let Some(nl) = text.find('\n') {
                text = text[nl + 1..].to_string();
            }
        }
        Some(history_to_events(&parse_jsonl(&text), agent, file))
    };
    inner.await.unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/// Stable, non-future timestamp for a synthetic daily rollup event.
fn synthetic_daily_timestamp(date_key: &str, preferred: Option<&str>) -> String {
    let noon = js_date_parse(&format!("{}T12:00:00.000Z", date_key));
    let day_start = js_date_parse(&format!("{}T00:00:00.000Z", date_key));
    let now = now_ms();

    if let Some(p) = preferred.filter(|p| !p.is_empty()) {
        let t = js_date_parse(p);
        if t.is_finite() && day_start.is_finite() && noon.is_finite() {
            if let Some(iso) = to_iso_string(t) {
                let pref_day = js_slice_chars(&iso, 10);
                if pref_day == date_key && t >= day_start && t <= noon {
                    return iso;
                }
            }
        }
    }
    if noon.is_finite() && noon <= now {
        return format!("{}T12:00:00.000Z", date_key);
    }
    format!("{}T00:00:00.000Z", date_key)
}

fn latest_timestamp(events: &[UsageEvent]) -> Option<String> {
    let mut best: Option<String> = None;
    let mut best_ms = f64::NEG_INFINITY;
    for e in events {
        let t = e.timestamp.js_ms();
        if !t.is_finite() {
            continue;
        }
        if t >= best_ms {
            best_ms = t;
            best = Some(e.timestamp.clone().to_string());
        }
    }
    best
}

fn latest_timestamp_for_model(events: &[UsageEvent], model: &str) -> Option<String> {
    if model.is_empty() {
        return latest_timestamp(events);
    }
    let matched: Vec<UsageEvent> = events
        .iter()
        .filter(|e| {
            let m = normalize_model_name(e.model.as_deref())
                .or_else(|| (e.model.clone().filter(|s| !s.is_empty())).map(|s| s.to_string()))
                .unwrap_or_default();
            m == model
        })
        .cloned()
        .collect();
    if matched.is_empty() {
        latest_timestamp(events)
    } else {
        latest_timestamp(&matched)
    }
}

// ---------------------------------------------------------------------------
// Daily rollups
// ---------------------------------------------------------------------------

fn daily_rollup_id(agent: AgentId, source: &str, date_key: &str, model_key: &str) -> String {
    let prefix = format!("{}|", ROLLUP_SOURCE);
    let scope = source.strip_prefix(prefix.as_str()).unwrap_or("primary");
    if scope == "primary" {
        stable_id(&[agent.as_str(), "daily-rollup", date_key, model_key])
    } else {
        stable_id(&[agent.as_str(), "daily-rollup", scope, date_key, model_key])
    }
}

/// One model's aggregated daily totals after key consolidation.
#[derive(Clone)]
struct DailyModelTotals {
    requests: f64,
    prompt_tokens: f64,
    completion_tokens: f64,
    cached_tokens: f64,
    cost: f64,
    raw_model: String,
    provider: Option<String>,
    display: String,
    canonical_key: String,
}

/// Collapse a daily `byModel` map into one entry per resolved public model.
fn group_daily_by_model(agent: AgentId, by_model: &Map<String, Value>) -> IndexMap<String, DailyModelTotals> {
    let litellm = agent == AgentId::Litellm;
    let mut grouped: IndexMap<String, DailyModelTotals> = IndexMap::new();
    for (model_key, mraw) in by_model {
        let m = match mraw {
            Value::Object(m) => m,
            _ => continue,
        };
        let seg0 = model_key.split('|').next().unwrap_or("");
        let fallback = if seg0.is_empty() { model_key.as_str() } else { seg0 };
        let model = router_model_from_record(agent, m, Some(fallback)).unwrap_or_else(|| "mixed".to_string());
        let raw_model = match gstr(m, "rawModel") {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => model.clone(),
        };
        let provider_s = match gstr(m, "provider") {
            Some(p) if !js_trim(p).is_empty() => js_trim(p).to_string(),
            _ => {
                if let Some(i) = model_key.find('|') {
                    js_trim(&model_key[i + 1..]).to_string()
                } else if let Some(i) = raw_model.find('/') {
                    js_trim(&raw_model[..i]).to_string()
                } else {
                    String::new()
                }
            }
        };
        let normalized = match normalize_model_name(Some(&raw_model)) {
            Some(s) if !s.is_empty() => s,
            _ => raw_model.clone(),
        };
        let provider_key = provider_s.to_lowercase();
        let canonical_key = format!(
            "{}|{}",
            provider_key,
            if litellm { normalized.to_lowercase() } else { normalized.clone() }
        );
        let key = if litellm {
            format!("{}|{}", provider_key, js_trim(&raw_model).to_lowercase())
        } else {
            canonical_key.clone()
        };

        let row = DailyModelTotals {
            requests: n(g(m, "requests")),
            prompt_tokens: n(first(&[g(m, "promptTokens"), g(m, "prompt_tokens"), g(m, "inputTokens")])),
            completion_tokens: n(first(&[g(m, "completionTokens"), g(m, "completion_tokens"), g(m, "outputTokens")])),
            cached_tokens: n(first(&[g(m, "cachedTokens"), g(m, "cached_tokens"), g(m, "cacheReadTokens")])),
            cost: n(g(m, "cost")),
            raw_model: raw_model.clone(),
            provider: match gstr(m, "provider") {
                Some(p) => Some(p.to_string()),
                None => {
                    if provider_s.is_empty() {
                        None
                    } else {
                        Some(provider_s.clone())
                    }
                }
            },
            display: model.clone(),
            canonical_key,
        };

        let prev = match grouped.get_mut(&key) {
            None => {
                grouped.insert(key, row);
                continue;
            }
            Some(p) => p,
        };
        // Overlapping views of the same day -> keep the most complete one, never sum.
        let prev_weight = prev.prompt_tokens + prev.completion_tokens + prev.cached_tokens;
        let next_weight = row.prompt_tokens + row.completion_tokens + row.cached_tokens;
        let model_len = js_len_str(&model);
        if next_weight > prev_weight {
            let display = if model_len > js_len_str(&prev.display) { model.clone() } else { prev.display.clone() };
            let cached = prev.cached_tokens.max(row.cached_tokens);
            let cost = prev.cost.max(row.cost);
            *prev = DailyModelTotals { display, cached_tokens: cached, cost, ..row };
        } else if model_len > js_len_str(&prev.display) || row.cached_tokens > prev.cached_tokens || row.cost > prev.cost {
            if row.cached_tokens > prev.cached_tokens {
                prev.cached_tokens = row.cached_tokens;
            }
            if model_len > js_len_str(&prev.display) {
                prev.display = model.clone();
            }
            if row.cost > prev.cost {
                prev.cost = row.cost;
            }
        }
    }

    let mut resolved: IndexMap<String, DailyModelTotals> = IndexMap::new();
    for row in grouped.into_values() {
        match resolved.get_mut(&row.canonical_key) {
            None => {
                resolved.insert(row.canonical_key.clone(), row);
            }
            Some(prev) => {
                let keep_row_label = js_len_str(&row.display) > js_len_str(&prev.display);
                let provider = match &prev.provider {
                    Some(p) if !p.is_empty() => prev.provider.clone(),
                    _ => row.provider.clone(),
                };
                *prev = DailyModelTotals {
                    requests: prev.requests + row.requests,
                    prompt_tokens: prev.prompt_tokens + row.prompt_tokens,
                    completion_tokens: prev.completion_tokens + row.completion_tokens,
                    cached_tokens: prev.cached_tokens + row.cached_tokens,
                    cost: prev.cost + row.cost,
                    raw_model: if keep_row_label { row.raw_model.clone() } else { prev.raw_model.clone() },
                    provider,
                    display: if keep_row_label { row.display.clone() } else { prev.display.clone() },
                    canonical_key: row.canonical_key.clone(),
                };
            }
        }
    }
    resolved
}

fn js_len_str(s: &str) -> usize {
    crate::util::js_len(s)
}

fn daily_row_value(id: String, ts: &str, model: &str, provider: Option<&str>, p: f64, c: f64, cr: f64, cost: f64, req: f64) -> Value {
    json!({
        "id": id,
        "timestamp": ts,
        "model": model,
        "provider": provider,
        "promptTokens": p,
        "completionTokens": c,
        "cachedTokens": cr,
        "cost": cost,
        "requests": req,
        "tokens": { "prompt_tokens": p, "completion_tokens": c, "cached_tokens": cr },
    })
}

/// Mark a synthesized rollup row (stable id, estimated flag, request count).
fn finish_rollup(mut e: REvent, id: String, request_count: f64) -> UsageEvent {
    e.event.id = id.into();
    e.event.estimated = Some(true);
    e.event.request_count = Some(request_count);
    e.event
}

/// Expand one dailySummary / usageDaily day into synthetic UsageEvents.
fn expand_one_day(
    date_key: &str,
    day: &Map<String, Value>,
    agent: AgentId,
    source: &str,
    day_events: &[UsageEvent],
) -> Vec<UsageEvent> {
    let day_input = n(first(&[g(day, "promptTokens"), g(day, "prompt_tokens")]));
    let day_output = n(first(&[g(day, "completionTokens"), g(day, "completion_tokens")]));
    let day_cache = n(first(&[g(day, "cachedTokens"), g(day, "cached_tokens"), g(day, "cacheReadTokens")]));
    let day_cost = n(g(day, "cost"));
    let day_fallback_ts = synthetic_daily_timestamp(date_key, latest_timestamp(day_events).as_deref());

    if let Some(Value::Object(by_model)) = day.get("byModel") {
        let mut out: Vec<UsageEvent> = Vec::new();
        let mut model_cost = 0.0;
        let mut model_tokens = 0.0;
        let mut model_cache = 0.0;
        for (model, m) in group_daily_by_model(agent, by_model) {
            let model_key = model.clone();
            let label: &str = if m.display.is_empty() { &model } else { &m.display };
            let provider = m.provider.as_deref();
            let (input_tokens, output_tokens, cache_read_tokens, cost, model_requests) =
                (m.prompt_tokens, m.completion_tokens, m.cached_tokens, m.cost, m.requests);
            if input_tokens + output_tokens + cache_read_tokens <= 0.0 && cost <= 0.0 && model_requests <= 0.0 {
                continue;
            }
            model_cost += cost;
            model_tokens += input_tokens + output_tokens;
            model_cache += cache_read_tokens;
            let pref = latest_timestamp_for_model(day_events, &model).or_else(|| Some(day_fallback_ts.clone()));
            let ts = synthetic_daily_timestamp(date_key, pref.as_deref());
            let req = if model_requests > 0.0 { model_requests } else { 1.0 };
            let row = daily_row_value(
                format!("daily:{}:{}", date_key, model_key),
                &ts,
                label,
                provider,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cost,
                req,
            );
            let tag = format!("daily-{}-{}", date_key, model_key);
            if let Some(e) = row_to_event(&row, agent, source, &tag) {
                out.push(finish_rollup(e, daily_rollup_id(agent, source, date_key, &model_key), req));
            }
        }
        // Price per real model; the remainder is emitted as its own row.
        let day_tok = day_input + day_output + day_cache;
        if !out.is_empty() {
            let covered_req: f64 = out.iter().fold(0.0, |a, e| a + e.request_count.unwrap_or(1.0));
            let covered_in: f64 = out.iter().fold(0.0, |a, e| a + e.input_tokens);
            let covered_out: f64 = out.iter().fold(0.0, |a, e| a + e.output_tokens);
            let covered_tok = model_tokens + model_cache;
            let rem_req = (n(g(day, "requests")) - covered_req).max(0.0);
            let rem_in = (day_input - covered_in).max(0.0);
            let rem_out = (day_output - covered_out).max(0.0);
            let rem_cache = (day_cache - model_cache).max(0.0);
            let material = rem_in > 100_000.0 || rem_out > 100_000.0 || rem_cache > 100_000.0 || rem_req > 10.0;
            if !material && (covered_tok - day_tok).abs() <= 100_000.0 {
                return out;
            }
            let remainder = remainder_row(
                date_key,
                agent,
                source,
                &day_fallback_ts,
                rem_req,
                rem_in,
                rem_out,
                rem_cache,
                day_cost,
                model_cost,
            );
            if let Some(r) = remainder {
                out.push(r);
            }
            return out;
        }
    }

    // No usable byModel -> whole day as one "unattributed" row.
    if day_input + day_output + day_cache <= 0.0 && day_cost <= 0.0 {
        return Vec::new();
    }
    let day_requests = n(g(day, "requests"));
    let req = if day_requests > 0.0 { day_requests } else { 1.0 };
    let row = daily_row_value(
        format!("daily:{}:all", date_key),
        &day_fallback_ts,
        "unattributed",
        None,
        day_input,
        day_output,
        day_cache,
        day_cost,
        req,
    );
    match row_to_event(&row, agent, source, &format!("daily-{}", date_key)) {
        Some(e) => vec![finish_rollup(e, daily_rollup_id(agent, source, date_key, "all"), req)],
        None => Vec::new(),
    }
}

/// Emit the slice of a day that `byModel` did not cover as a separate source row.
#[allow(clippy::too_many_arguments)]
fn remainder_row(
    date_key: &str,
    agent: AgentId,
    source: &str,
    timestamp: &str,
    requests: f64,
    input_tokens: f64,
    output_tokens: f64,
    cache_read_tokens: f64,
    day_cost: f64,
    model_cost: f64,
) -> Option<UsageEvent> {
    if input_tokens + output_tokens + cache_read_tokens <= 0.0 && requests <= 0.0 {
        return None;
    }
    let cost = (day_cost - model_cost).max(0.0);
    let req = if requests > 0.0 { requests } else { 1.0 };
    let row = daily_row_value(
        format!("daily:{}:unattributed", date_key),
        timestamp,
        "unattributed",
        None,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cost,
        req,
    );
    let e = row_to_event(&row, agent, source, &format!("daily-{}-unattributed", date_key))?;
    Some(finish_rollup(e, daily_rollup_id(agent, source, date_key, "unattributed"), req))
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

fn event_token_weight(e: &UsageEvent) -> f64 {
    if e.total_tokens.is_finite() {
        e.total_tokens
    } else {
        e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_write_tokens
    }
}

fn event_request_count(e: &UsageEvent) -> f64 {
    match e.request_count {
        Some(c) if c > 0.0 => c.floor(),
        _ => 1.0,
    }
}

/// Request-first reconciliation (multi-request history wins, else daily rollup).
fn reconcile_events_and_daily(event_level: Vec<REvent>, daily_maps: Vec<DailySource>, agent: AgentId) -> Vec<UsageEvent> {
    // Merge daily representations within each root (richer request count wins).
    let mut merged_daily: HashMap<String, Map<String, Value>> = HashMap::new();
    for DailySource { daily, scope, .. } in daily_maps {
        for (date_key, raw) in daily {
            if !is_date_key(&date_key) {
                continue;
            }
            let day = match raw {
                Value::Object(m) => m,
                Value::Array(_) => Map::new(),
                _ => continue,
            };
            let scoped_day = format!("{}|{}", scope, date_key);
            let next_req = n(day.get("requests"));
            let replace = match merged_daily.get(&scoped_day) {
                None => true,
                Some(prev) => next_req >= n(prev.get("requests")),
            };
            if replace {
                merged_daily.insert(scoped_day, day);
            }
        }
    }

    let mut events_by_day: HashMap<String, Vec<UsageEvent>> = HashMap::new();
    let mut no_day: Vec<UsageEvent> = Vec::new();
    for re in event_level {
        let day = js_slice_chars(&re.event.timestamp.to_str(), 10);
        if !is_date_key(&day) {
            no_day.push(re.event);
            continue;
        }
        let scope = if re.scope.is_empty() { "primary".to_string() } else { re.scope.clone() };
        events_by_day.entry(format!("{}|{}", scope, day)).or_default().push(re.event);
    }

    let mut out: Vec<UsageEvent> = no_day;
    let mut all_days: BTreeSet<String> = BTreeSet::new();
    all_days.extend(events_by_day.keys().cloned());
    all_days.extend(merged_daily.keys().cloned());

    for scoped_day in all_days {
        let (scope, date_key) = match scoped_day.find('|') {
            Some(i) => (scoped_day[..i].to_string(), scoped_day[i + 1..].to_string()),
            None => ("primary".to_string(), scoped_day.clone()),
        };
        let day_events = events_by_day.remove(&scoped_day).unwrap_or_default();
        let daily = merged_daily.get(&scoped_day);
        let rollup_source = format!("{}|{}", ROLLUP_SOURCE, scope);

        if !day_events.is_empty() {
            if let Some(day) = daily {
                let daily_events = expand_one_day(&date_key, day, agent, &rollup_source, &day_events);
                let sumf = |evs: &[UsageEvent], f: &dyn Fn(&UsageEvent) -> f64| evs.iter().fold(0.0, |a, e| a + f(e));
                let history_tokens = sumf(&day_events, &event_token_weight);
                let daily_tokens = sumf(&daily_events, &event_token_weight);
                let litellm = agent == AgentId::Litellm;
                let history_prompt_and_output = sumf(&day_events, &|e| {
                    e.input_tokens + e.output_tokens + if litellm { e.cache_read_tokens } else { 0.0 }
                });
                let daily_prompt_and_output = sumf(&daily_events, &|e| e.input_tokens + e.output_tokens);
                let history_cache = sumf(&day_events, &|e| e.cache_read_tokens + e.cache_write_tokens);
                let daily_cache = sumf(&daily_events, &|e| e.cache_read_tokens + e.cache_write_tokens);
                let history_requests = sumf(&day_events, &event_request_count);
                let daily_requests = sumf(&daily_events, &event_request_count);
                let request_coverage = daily_requests > 0.0 && history_requests >= daily_requests * 0.95;
                let billed_coverage =
                    daily_prompt_and_output <= 0.0 || history_prompt_and_output >= daily_prompt_and_output * 0.98;
                let cache_coverage = daily_cache <= 0.0 || history_cache >= daily_cache * 0.98;
                let history_covers_daily = daily_events.is_empty()
                    || (request_coverage && billed_coverage && cache_coverage)
                    || (daily_requests <= 0.0 && history_tokens >= daily_tokens * 0.98);
                out.extend(day_events);
                if !history_covers_daily {
                    out.extend(daily_events);
                }
            } else {
                out.extend(day_events);
            }
            continue;
        }

        // No history at all for this day -> the daily rollup is all we have.
        if let Some(day) = daily {
            out.extend(expand_one_day(&date_key, day, agent, &rollup_source, &[]));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn content_fingerprint(e: &UsageEvent) -> String {
    let ts = js_slice_chars(&e.timestamp.to_str(), 19);
    let or0 = |x: f64| if x.is_nan() || x == 0.0 { 0.0 } else { x };
    [
        e.agent.as_str().to_string(),
        ts,
        (e.model.clone().unwrap_or_default()).to_string(),
        num_str(or0(e.input_tokens)),
        num_str(or0(e.output_tokens)),
        (e.workspace.clone().unwrap_or_default()).to_string(),
    ]
    .join("|")
}

fn push_token_weight(e: &UsageEvent) -> f64 {
    let f = |x: f64| if x.is_nan() { 0.0 } else { x };
    f(e.input_tokens) + f(e.output_tokens) + f(e.cache_read_tokens) + f(e.cache_write_tokens)
}

#[derive(Default)]
struct PushState {
    event_level: Vec<REvent>,
    seen_ids: HashSet<String>,
    content_index: HashMap<String, usize>,
    native_index: HashMap<String, usize>,
}

impl PushState {
    fn push_events(&mut self, batch: Vec<REvent>, root_scope: &str) {
        for mut e in batch {
            let scoped_id = format!("{}|{}", root_scope, e.event.id);
            if self.seen_ids.contains(&scoped_id) {
                continue;
            }
            let fp = format!("{}|{}", root_scope, content_fingerprint(&e.event));
            let native_key = if e.native_id.is_empty() {
                String::new()
            } else {
                [
                    root_scope,
                    e.event.agent.as_str(),
                    e.event.workspace.as_deref().unwrap_or(""),
                    e.event.model.as_deref().unwrap_or(""),
                    e.native_id.as_str(),
                ]
                .join("|")
            };
            let mut prev_idx: Option<usize> = if native_key.is_empty() { None } else { self.native_index.get(&native_key).copied() };
            if prev_idx.is_none() {
                if let Some(&ci) = self.content_index.get(&fp) {
                    let existing_native = &self.event_level[ci].native_id;
                    // Within one root, an anonymous export row is a file twin of a native row.
                    if e.native_id.is_empty() || existing_native.is_empty() {
                        prev_idx = Some(ci);
                    }
                }
            }
            if let Some(pi) = prev_idx {
                let prev = &self.event_level[pi].event;
                let ew = push_token_weight(&e.event);
                let pw = push_token_weight(prev);
                let ec = e.event.estimated_cost.filter(|c| !c.is_nan()).unwrap_or(0.0);
                let pc = prev.estimated_cost.filter(|c| !c.is_nan()).unwrap_or(0.0);
                let prefer_next = ew > pw || (ec > pc && ew >= pw);
                if prefer_next {
                    scope_router_event(&mut e, root_scope);
                    self.event_level[pi] = e;
                }
                if !native_key.is_empty() {
                    self.native_index.insert(native_key, pi);
                }
                self.seen_ids.insert(scoped_id);
                continue;
            }
            self.seen_ids.insert(scoped_id);
            let idx = self.event_level.len();
            self.content_index.entry(fp).or_insert(idx);
            if !native_key.is_empty() {
                self.native_index.insert(native_key, idx);
            }
            scope_router_event(&mut e, root_scope);
            self.event_level.push(e);
        }
    }
}

const DB_RELS: [&str; 3] = ["db/data.sqlite", "data.sqlite", "db.sqlite"];

/// `parseRouterUsage(roots, agent, options)`.
pub async fn parse_router_usage(roots: &[String], agent: AgentId, options: RouterUsageOptions) -> anyhow::Result<Vec<UsageEvent>> {
    let mut st = PushState::default();
    let mut daily_maps: Vec<DailySource> = Vec::new();

    let ordered = prioritize_router_roots(roots);
    let mut root_ordinal = 0usize;
    for root in ordered {
        if !path_exists(&root).await {
            continue;
        }
        let root_scope = if root_ordinal == 0 {
            "primary".to_string()
        } else {
            stable_id(&["router-mirror-root", &root.replace('\\', "/").to_lowercase()])
        };
        root_ordinal += 1;

        let mut has_daily_for_root = false;

        // --- A) Daily rollups ---
        for rel in DB_RELS {
            let db_path = pjoin(&[root.as_str(), rel]);
            if !path_exists(&db_path).await {
                continue;
            }
            if let Some(daily) = parse_sqlite_daily(&db_path).await {
                daily_maps.push(DailySource { source: format!("{}#usageDaily", db_path), daily, scope: root_scope.clone() });
                has_daily_for_root = true;
            }
        }

        let usage_path = pjoin(&[root.as_str(), "usage.json"]);
        let db_json_path = pjoin(&[root.as_str(), "db.json"]);
        let usage_data_path = pjoin(&[root.as_str(), "usageData.json"]);
        let usage_parsed = read_json_if_exists(&usage_path).await;
        let db_json_parsed = read_json_if_exists(&db_json_path).await;
        let usage_data_parsed = read_json_if_exists(&usage_data_path).await;

        for (daily, src) in [
            (daily_from_usage_json(usage_parsed.as_ref()), &usage_path),
            (daily_from_db_json(db_json_parsed.as_ref()), &db_json_path),
            (daily_from_usage_json(usage_data_parsed.as_ref()), &usage_data_path),
        ] {
            if let Some(daily) = daily {
                daily_maps.push(DailySource { source: src.clone(), daily, scope: root_scope.clone() });
                has_daily_for_root = true;
            }
        }

        let daily_path = pjoin(&[root.as_str(), "usage-daily.json"]);
        if path_exists(&daily_path).await {
            if let Some(daily) = read_daily_summary_standalone(&daily_path).await {
                daily_maps.push(DailySource { source: daily_path.clone(), daily, scope: root_scope.clone() });
                has_daily_for_root = true;
            }
        }

        // --- B) Per-request history ---
        for rel in DB_RELS {
            let db_path = pjoin(&[root.as_str(), rel]);
            if !path_exists(&db_path).await {
                continue;
            }
            let limit = if options.recent_only {
                1_000.0
            } else if has_daily_for_root {
                5_000.0
            } else {
                20_000.0
            };
            let rows = parse_sqlite_usage(&db_path, agent, limit).await;
            if !rows.is_empty() {
                st.push_events(rows, &root_scope);
            }
        }

        let rows = history_from_usage_json(usage_parsed.as_ref(), agent, &usage_path);
        if !rows.is_empty() {
            st.push_events(rows, &root_scope);
        }
        let rows = history_from_db_json(db_json_parsed.as_ref(), agent, &db_json_path);
        if !rows.is_empty() {
            st.push_events(rows, &root_scope);
        }
        let rows = history_from_usage_json(usage_data_parsed.as_ref(), agent, &usage_data_path);
        if !rows.is_empty() {
            st.push_events(rows, &root_scope);
        }

        // One preferred history stream per root.
        let history_preference = [
            "request-details.json",
            "request-details.jsonl",
            "usage-history.json",
            "usageHistory.json",
            "usage-history.jsonl",
        ];
        for name in history_preference {
            let p = pjoin(&[root.as_str(), name]);
            if !path_exists(&p).await {
                continue;
            }
            let batch = if name.ends_with(".jsonl") {
                match tokio::fs::metadata(&p).await {
                    Ok(meta) => {
                        let max_bytes: u64 = if options.recent_only { 1024 * 1024 } else { 12 * 1024 * 1024 };
                        if meta.len() > max_bytes {
                            let tail = if options.recent_only { 512 * 1024 } else { 2 * 1024 * 1024 };
                            parse_history_export_tail(&p, agent, tail).await
                        } else {
                            parse_history_export(&p, agent).await
                        }
                    }
                    Err(_) => parse_history_export(&p, agent).await,
                }
            } else {
                parse_history_export(&p, agent).await
            };
            st.push_events(batch, &root_scope);
            break;
        }
    }

    Ok(reconcile_events_and_daily(st.event_level, daily_maps, agent))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_key_shape() {
        assert!(is_date_key("2026-07-14"));
        assert!(!is_date_key("2026-7-14"));
        assert!(!is_date_key("2026-07-14\n"));
    }

    #[test]
    fn roots_are_prioritized() {
        let v = prioritize_router_roots(&[
            "C:\\x\\other".to_string(),
            "C:\\Users\\a\\AppData\\Local\\tokenlab\\mirrors\\9router".to_string(),
            "/home/a/.9router".to_string(),
        ]);
        assert!(v[0].contains("mirrors"));
        assert_eq!(v[1], "/home/a/.9router");
    }

    #[test]
    fn normalizes_array_daily_export() {
        let data = json!([
            {"dateKey": "2026-07-14", "data": "{\"requests\":3,\"promptTokens\":10}"},
            {"dateKey": "bad", "data": {}},
        ]);
        let m = normalize_daily_map(&data).unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m["2026-07-14"]["requests"], json!(3));
    }

    #[test]
    fn normalizes_plain_map_and_wrapper() {
        let m = normalize_daily_map(&json!({"2026-07-14": {"requests": 1}, "x": 1})).unwrap();
        assert_eq!(m.len(), 1);
        let w = normalize_daily_map(&json!({"dailySummary": {"2026-07-14": {"requests": 2}}})).unwrap();
        assert_eq!(w["2026-07-14"]["requests"], json!(2));
        assert!(normalize_daily_map(&json!("str")).is_none());
    }

    #[test]
    fn groups_litellm_duplicate_views() {
        let by_model = json!({
            "anthropic/claude-opus-5.5|openai": {"requests": 1, "promptTokens": 1000, "completionTokens": 100, "cachedTokens": 236416},
            "claude-opus-5.5|openai": {"requests": 1, "promptTokens": 1000, "completionTokens": 100, "cachedTokens": 0},
        });
        let g = group_daily_by_model(AgentId::Litellm, by_model.as_object().unwrap());
        assert_eq!(g.len(), 1);
        let t = g.values().next().unwrap();
        assert_eq!(t.prompt_tokens, 1000.0);
        assert_eq!(t.cached_tokens, 236416.0);
    }

    #[test]
    fn synthetic_timestamp_past_day_is_noon() {
        assert_eq!(synthetic_daily_timestamp("2020-01-02", None), "2020-01-02T12:00:00.000Z");
        assert_eq!(
            synthetic_daily_timestamp("2020-01-02", Some("2020-01-02T03:04:05.000Z")),
            "2020-01-02T03:04:05.000Z"
        );
        // late-evening UTC time is not inherited
        assert_eq!(
            synthetic_daily_timestamp("2020-01-02", Some("2020-01-02T17:12:00.000Z")),
            "2020-01-02T12:00:00.000Z"
        );
    }
}
