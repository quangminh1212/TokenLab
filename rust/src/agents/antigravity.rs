//! Agent: Antigravity (port of `src/agents/antigravity/index.ts`).
//!
//! Antigravity IDE + antigravity-proxy usage.
//!
//! Sources (all scanned):
//!  1. antigravity-proxy SQLite  ~/.antigravity/data/proxy.db  -> real prompt/output/cost
//!  2. Local IDE brain transcripts  ~/.gemini/antigravity/brain/<id>/.../transcript*.jsonl
//!     -> estimated tokens from user + model text (no token counters are stored)
//!  3. Conversation DBs  ~/.gemini/antigravity/conversations/*.db
//!     -> model id + fallback estimate when transcript missing
//!  4. Explicit usage JSON/JSONL under antigravity roots (if any)

use crate::agents::shared::env::{env_chain, path_env, unique};
use crate::agents::shared::usage_fields::{extract_token_buckets, TokenBuckets};
use crate::agents::{parse_fn, AgentModule};
use crate::pricing::{apply_pricing, apply_pricing_with};
use crate::types::{AgentId, UsageEvent};
use crate::util::{
    estimate_tokens_from_chars, estimate_tokens_from_text, is_js_ws, js_len, js_num_to_string, js_trim, now_ms, num,
    parse_jsonl, path_exists_sync, read_text_sync, stable_id, to_iso_string, walk_files_sync, PathFlavor,
    WalkOptions,
};
use indexmap::IndexMap;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

/// Local data roots to scan on this machine.
pub fn roots() -> Vec<String> {
    let e = path_env();
    let mut r: Vec<String> = Vec::new();
    r.push(e.expand_home(&env_chain(&["TOKENLAB_ANTIGRAVITY_DIR", "ANTIGRAVITY_HOME"])));
    r.push(e.j(&[&e.home, ".antigravity"]));
    r.push(e.j(&[&e.home, ".gemini", "antigravity"]));
    r.push(e.j(&[&e.home, ".gemini"]));
    r.push(e.j(&[&e.app_data, "Antigravity"]));
    r.push(e.j(&[&e.local_app, "Antigravity"]));
    r.push(e.j(&[&e.xdg_config, "Antigravity"]));
    r.push(e.j(&[&e.xdg_data, "Antigravity"]));
    r.push(e.j(&[&e.home, "Library", "Application Support", "Antigravity"]));
    unique(r)
}

// ---------------------------------------------------------------------------
// JS-ish helpers
// ---------------------------------------------------------------------------

/// `obj[key]` with `undefined` and `null` both mapped to `None` (what `??` skips).
fn gm<'a>(m: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    match m.get(key) {
        Some(Value::Null) | None => None,
        Some(v) => Some(v),
    }
}

/// `a ?? b` over optional lookups.
fn first<'a>(c: &[Option<&'a Value>]) -> Option<&'a Value> {
    c.iter().copied().flatten().next()
}

/// JS truthiness of a value.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map_or(false, |f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `String(v)` for parsed JSON / sqlite values.
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_num_to_string(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|x| if x.is_null() { String::new() } else { js_string(x) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `String(v || "")`.
fn str_or_empty(v: Option<&Value>) -> String {
    if truthy(v) {
        js_string(v.unwrap())
    } else {
        String::new()
    }
}

fn num_opt(v: Option<&Value>) -> f64 {
    v.map_or(0.0, num)
}

/// `/^(0|[1-9]\d*)$/` below 2^32-1 (array-index keys sort first in JS objects).
fn array_index(k: &str) -> Option<u64> {
    if k.is_empty() || (k.len() > 1 && k.starts_with('0')) || !k.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u64 = k.parse().ok()?;
    if n < 4_294_967_295 {
        Some(n)
    } else {
        None
    }
}

fn json_escape(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `JSON.stringify(v)` (numbers use JS formatting, integer-like keys sort first).
fn js_json_stringify(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            if f.is_finite() {
                out.push_str(&js_num_to_string(f));
            } else {
                out.push_str("null");
            }
        }
        Value::String(s) => json_escape(s, out),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                js_json_stringify(x, out);
            }
            out.push(']');
        }
        Value::Object(m) => {
            let mut idx: Vec<(u64, &String)> = Vec::new();
            let mut rest: Vec<&String> = Vec::new();
            for k in m.keys() {
                match array_index(k) {
                    Some(n) => idx.push((n, k)),
                    None => rest.push(k),
                }
            }
            idx.sort_by_key(|(n, _)| *n);
            out.push('{');
            let mut firstk = true;
            for k in idx.into_iter().map(|(_, k)| k).chain(rest) {
                if !firstk {
                    out.push(',');
                }
                firstk = false;
                json_escape(k, out);
                out.push(':');
                js_json_stringify(&m[k], out);
            }
            out.push('}');
        }
    }
}

/// `textFromUnknown`.
fn text_from_unknown(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(_)) | Some(Value::Bool(_)) => js_string(v.unwrap()),
        Some(Value::Array(a)) => a.iter().map(|x| text_from_unknown(Some(x))).collect::<Vec<_>>().join("\n"),
        Some(o @ Value::Object(m)) => {
            if let Some(Value::String(s)) = m.get("text") {
                return s.clone();
            }
            if let Some(Value::String(s)) = m.get("content") {
                return s.clone();
            }
            let mut out = String::new();
            js_json_stringify(o, &mut out);
            out
        }
    }
}

/// `text.slice(0, n)` by UTF-16 code units.
fn slice_head(text: &str, n: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= n {
        return text.to_string();
    }
    String::from_utf16_lossy(&units[..n])
}

/// `text.slice(-n)` by UTF-16 code units.
fn slice_tail(text: &str, n: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= n {
        return text.to_string();
    }
    String::from_utf16_lossy(&units[units.len() - n..])
}

/// `Buffer.toString("latin1")`.
fn latin1(buf: &[u8]) -> String {
    buf.iter().map(|&b| b as char).collect()
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/// Prefer backend model id when it looks real; else Antigravity alias.
fn pick_model(model: Option<&Value>, resolved: Option<&Value>) -> Option<String> {
    let m = match model {
        Some(Value::String(s)) => js_trim(s).to_string(),
        _ => String::new(),
    };
    let r = match resolved {
        Some(Value::String(s)) => js_trim(s).to_string(),
        _ => String::new(),
    };
    if !r.is_empty() && (r.contains('.') || r.contains('/') || r.contains('-') || js_len(&r) > 8) {
        return Some(r);
    }
    if !m.is_empty() {
        return Some(m);
    }
    if r.is_empty() {
        None
    } else {
        Some(r)
    }
}

/// Rank model ids so "gemini-3.6-flash-high" wins over bare "gemini" / gemini-api.
fn model_specificity(id: &str) -> i32 {
    let s = id.to_lowercase();
    if s.is_empty() || s == "gemini" || s == "gemini-api" {
        return 1;
    }
    if s.contains("flash-high") || s.contains("flash_high") {
        return 100;
    }
    if s.contains("flash-tiered") || s.contains("flash_tiered") {
        return 90;
    }
    if s.contains("flash") {
        return 80;
    }
    if s.contains("pro") {
        return 70;
    }
    if s.starts_with("gemini-") {
        return 60;
    }
    if s.starts_with("claude-") {
        return 55;
    }
    if s.starts_with("gpt-") || s.starts_with("kimi-") || s.starts_with("qwen") {
        return 50;
    }
    10
}

fn pick_best_model_id<S: AsRef<str>>(candidates: &[S]) -> Option<String> {
    let mut best: Option<String> = None;
    let mut best_score: i32 = -1;
    for raw in candidates {
        let raw = raw.as_ref();
        if raw.is_empty() {
            continue;
        }
        let id = js_trim(raw).to_lowercase();
        if id.is_empty() || js_len(&id) < 3 {
            continue;
        }
        // Skip path noise / flags
        if id.contains('\\') || id.contains('/') || id.contains(' ') {
            continue;
        }
        if id.contains("placeholder") || id.contains("used_") {
            continue;
        }
        if id == "gemini-api" {
            continue;
        }
        let score = model_specificity(&id);
        let best_len = best.as_deref().map_or(0, js_len);
        if score > best_score || (score == best_score && js_len(&id) > best_len) {
            best = Some(id);
            best_score = score;
        }
    }
    best
}

/// Map Antigravity MODEL_PLACEHOLDER_M* enums seen in local DBs.
fn map_model_placeholder(ph: &str) -> Option<&'static str> {
    static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"MODEL_PLACEHOLDER_M([0-9]+)").unwrap());
    let upper = ph.to_uppercase();
    let m = RE.captures(&upper)?;
    let n: f64 = m.get(1)?.as_str().parse().ok()?;
    if n == 71.0 {
        return Some("gemini-3.6-flash-high");
    }
    if n == 196.0 {
        return Some("gemini-3.6-flash-tiered");
    }
    None
}

/// Normalize UI label -> stable model id.
fn ui_label_to_model_id(label: &str) -> Option<&'static str> {
    let mut cleaned = String::new();
    let mut in_ws = false;
    for c in js_trim(label).chars() {
        if is_js_ws(c) {
            if !in_ws {
                cleaned.push('-');
            }
            in_ws = true;
        } else {
            in_ws = false;
            cleaned.push(c);
        }
    }
    let cleaned = cleaned.to_lowercase();
    if cleaned.is_empty() {
        return None;
    }
    let has = |s: &str| cleaned.contains(s);
    if has("gemini") || has("flash") || has("pro") {
        if (has("flash") || has("gemini")) && has("high") {
            return Some("gemini-3.6-flash-high");
        }
        if has("tiered") {
            return Some("gemini-3.6-flash-tiered");
        }
        if has("flash") {
            return Some("gemini-3.6-flash");
        }
        if has("pro") {
            return Some("gemini-3.6-pro");
        }
    }
    if has("claude") && has("sonnet") {
        return Some("claude-sonnet");
    }
    if has("claude") && has("opus") {
        return Some("claude-opus");
    }
    None
}

/// ASCII case-insensitive literal (JS `/i` without the `u` flag folds ASCII only).
fn ci(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphabetic() {
                format!("[{}{}]", c.to_ascii_lowercase(), c.to_ascii_uppercase())
            } else {
                regex::escape(&c.to_string())
            }
        })
        .collect()
}

/// JS `\s`.
const WS: &str = r"[\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]";
/// JS `\b` (ASCII word boundary).
const WB: &str = r"(?-u:\b)";

struct ModelRes {
    vendors: Vec<Regex>,
    placeholder: Regex,
    gemini_any: Regex,
    ui: Vec<Regex>,
}

static MODEL_RES: Lazy<ModelRes> = Lazy::new(|| {
    let vendor = |prefix: &str, hyphen: bool| {
        Regex::new(&format!(
            r"{WB}({}{}[A-Za-z0-9_.\-]+){WB}",
            ci(prefix),
            if hyphen { "-" } else { "" }
        ))
        .unwrap()
    };
    let gem = format!("{}{}*3\\.?[0-9]*{}*{}", ci("Gemini"), WS, WS, ci("Flash"));
    let ui = vec![
        Regex::new(&format!(
            "{m}{w}*{s}[`'\"]?{w}*{f}{w}+[^\\n]{{0,40}}?{w}+{t}{w}+([^\\n.<]{{3,80}})",
            m = ci("Model"),
            s = ci("Selection"),
            f = ci("from"),
            t = ci("to"),
            w = WS
        ))
        .unwrap(),
        Regex::new(&format!("{WB}({gem}{WS}*\\({WS}*{}{WS}*\\))", ci("High"))).unwrap(),
        Regex::new(&format!("{WB}({gem}{WS}*\\({WS}*{}{WS}*\\))", ci("Tiered"))).unwrap(),
        Regex::new(&format!("{WB}({gem}{WS}+{}){WB}", ci("High"))).unwrap(),
        Regex::new(&format!("{WB}({gem}{WS}+{}){WB}", ci("Tiered"))).unwrap(),
        Regex::new(&format!("{WB}({gem}){WB}")).unwrap(),
        Regex::new(&format!("{WB}({}{}*3\\.?[0-9]*{}*{}){WB}", ci("Gemini"), WS, WS, ci("Pro"))).unwrap(),
    ];
    ModelRes {
        vendors: vec![
            vendor("gemini", true),
            vendor("claude", true),
            vendor("gpt", true),
            vendor("kimi", true),
            vendor("qwen", false),
        ],
        placeholder: Regex::new(&format!("{WB}(MODEL_PLACEHOLDER_M[0-9]+){WB}")).unwrap(),
        gemini_any: vendor("gemini", true),
        ui,
    }
});

/// Pull the most specific model id from free text / protobuf strings.
/// Prefer gemini-3.6-flash-high / -tiered over bare "gemini".
pub fn extract_model_from_text(parts: &[&str]) -> Option<String> {
    let blob = parts.iter().filter(|p| !p.is_empty()).copied().collect::<Vec<_>>().join("\n");
    if blob.is_empty() {
        return None;
    }
    let res = &*MODEL_RES;
    let mut candidates: Vec<String> = Vec::new();

    // Explicit vendor ids (collect all, then rank)
    for re in &res.vendors {
        for m in re.captures_iter(&blob) {
            if let Some(g) = m.get(1) {
                candidates.push(g.as_str().to_string());
            }
        }
    }
    // MODEL_PLACEHOLDER_M71 / M196
    for m in res.placeholder.captures_iter(&blob) {
        if let Some(mapped) = map_model_placeholder(&m[1]) {
            candidates.push(mapped.to_string());
        }
    }
    // UI labels: "Gemini 3.6 Flash (High)" / Model Selection ... to ...
    for re in &res.ui {
        for m in re.captures_iter(&blob) {
            let label = m.get(1).map_or("", |g| g.as_str());
            if let Some(mapped) = ui_label_to_model_id(label) {
                candidates.push(mapped.to_string());
            }
        }
    }
    pick_best_model_id(&candidates)
}

/// Candidates found in a latin1 blob: best of text + every `gemini-*` + placeholders.
fn push_blob_candidates(latin: &str, candidates: &mut Vec<String>) {
    if let Some(t) = extract_model_from_text(&[latin]) {
        candidates.push(t);
    }
    for m in MODEL_RES.gemini_any.captures_iter(latin) {
        if let Some(g) = m.get(1) {
            candidates.push(g.as_str().to_string());
        }
    }
    for m in MODEL_RES.placeholder.captures_iter(latin) {
        if let Some(mapped) = map_model_placeholder(&m[1]) {
            candidates.push(mapped.to_string());
        }
    }
}

/// `new Date(ms).toISOString()` of "now".
fn now_iso() -> String {
    to_iso_string(now_ms()).unwrap_or_default()
}

/// `requestTimestamp`. `Err(())` models the `RangeError` a bad epoch throws.
fn request_timestamp(ts: Option<&Value>) -> Result<String, ()> {
    match ts {
        Some(Value::String(s)) if !js_trim(s).is_empty() => return Ok(js_trim(s).to_string()),
        Some(Value::Number(n)) => {
            if let Some(f) = n.as_f64() {
                if f.is_finite() {
                    let ms = if f > 1e12 { f } else { f * 1000.0 };
                    return to_iso_string(ms).ok_or(());
                }
            }
        }
        _ => {}
    }
    Ok(now_iso())
}

// ---------------------------------------------------------------------------
// SQLite helpers
// ---------------------------------------------------------------------------

fn sqlite_value(v: rusqlite::types::ValueRef<'_>) -> Value {
    use rusqlite::types::ValueRef;
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        // node:sqlite hands BLOBs back as Uint8Array (String() joins the bytes with commas).
        ValueRef::Blob(b) => Value::Array(b.iter().map(|x| Value::from(*x)).collect()),
    }
}

fn open_ro(db_path: &str) -> Option<rusqlite::Connection> {
    rusqlite::Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
}

/// Run a query returning rows as JSON-ish maps; `None` when the statement or iteration fails.
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

/// `toBuffer(data)` for one blob-ish column. `Err` where JS throws (numeric column).
fn column_bytes(v: rusqlite::types::ValueRef<'_>) -> Result<Vec<u8>, ()> {
    use rusqlite::types::ValueRef;
    match v {
        ValueRef::Null => Ok(Vec::new()),
        ValueRef::Text(t) => Ok(t.to_vec()),
        ValueRef::Blob(b) => Ok(b.to_vec()),
        ValueRef::Integer(_) | ValueRef::Real(_) => Err(()),
    }
}

/// Stream column `col` of `sql` through `f` (one `toBuffer` per row).
/// Returns `(row_count, completed)`. Like JS, the row count covers every row even
/// after a `toBuffer` throw (which stops further `f` calls and clears `completed`).
/// `None` when the statement itself does not prepare.
fn for_each_blob(
    conn: &rusqlite::Connection,
    sql: &str,
    col: usize,
    mut f: impl FnMut(Vec<u8>),
) -> Option<(usize, bool)> {
    let mut stmt = conn.prepare(sql).ok()?;
    let mut rows = stmt.query([]).ok()?;
    let mut n = 0usize;
    let mut completed = true;
    loop {
        match rows.next() {
            Ok(Some(row)) => {
                n += 1;
                if !completed {
                    continue;
                }
                match row.get_ref(col).map_err(|_| ()).and_then(column_bytes) {
                    Ok(b) => f(b),
                    Err(()) => completed = false,
                }
            }
            Ok(None) => return Some((n, completed)),
            Err(_) => return Some((n, false)),
        }
    }
}

// ---------------------------------------------------------------------------
// Proxy DB
// ---------------------------------------------------------------------------

/// Parse antigravity-proxy SQLite (`requests` table).
/// Rows with zero tokens and zero cost are skipped (errors / empty probes).
fn parse_proxy_db_sync(db_path: &str) -> Vec<UsageEvent> {
    let mut events: Vec<UsageEvent> = Vec::new();
    let conn = match open_ro(db_path) {
        Some(c) => c,
        None => return events,
    };
    let tables = match query_rows(&conn, "SELECT name FROM sqlite_master WHERE type='table'") {
        Some(t) => t,
        None => return events,
    };
    let has_requests = tables
        .iter()
        .any(|t| matches!(t.get("name"), Some(Value::String(s)) if s.to_lowercase() == "requests"));
    if !has_requests {
        return events;
    }

    let rows = query_rows(
        &conn,
        "SELECT id, timestamp, model, resolved_model, provider, direction, type, \
         prompt_tokens, output_tokens, cost, content FROM requests ORDER BY timestamp ASC",
    )
    .or_else(|| query_rows(&conn, "SELECT * FROM requests ORDER BY rowid ASC"));
    let rows = match rows {
        Some(r) => r,
        None => return events,
    };

    let mut by_id: IndexMap<String, Map<String, Value>> = IndexMap::new();
    let mut auto_idx = 0usize;
    for row in rows {
        auto_idx += 1;
        let id = match first(&[gm(&row, "id"), gm(&row, "rowid")]) {
            Some(v) => js_string(v),
            None => format!("row-{}", auto_idx),
        };
        let prev = match by_id.get(&id) {
            Some(p) => p,
            None => {
                by_id.insert(id, row);
                continue;
            }
        };
        let prev_dir = str_or_empty(gm(prev, "direction"));
        let next_dir = str_or_empty(gm(&row, "direction"));
        let tok = |r: &Map<String, Value>| {
            num_opt(first(&[gm(r, "prompt_tokens"), gm(r, "promptTokens")]))
                + num_opt(first(&[gm(r, "output_tokens"), gm(r, "outputTokens")]))
        };
        let prev_tok = tok(prev);
        let next_tok = tok(&row);
        let prefer_next = (next_dir == "outgoing" && prev_dir != "outgoing")
            || next_tok > prev_tok
            || (num_opt(gm(&row, "cost")) > num_opt(gm(prev, "cost")) && next_tok >= prev_tok);
        if prefer_next {
            // Map.set on an existing key keeps its original position.
            by_id.insert(id, row);
        }
    }

    for (native_id, row) in &by_id {
        // Prefer structured usage when proxy stores OpenAI/Gemini-style buckets
        let rowv = Value::Object(row.clone());
        let buckets: Option<TokenBuckets> = extract_token_buckets(Some(&rowv))
            .or_else(|| extract_token_buckets(row.get("usage")))
            .or_else(|| extract_token_buckets(row.get("tokens")));
        let has_buckets = buckets.is_some();
        let mut input_tokens = match &buckets {
            Some(b) => b.input_tokens,
            None => num_opt(first(&[gm(row, "prompt_tokens"), gm(row, "promptTokens")])),
        };
        let output_tokens = match &buckets {
            Some(b) => b.output_tokens,
            None => num_opt(first(&[gm(row, "output_tokens"), gm(row, "outputTokens")])),
        };
        let cache_read_tokens = match &buckets {
            Some(b) => b.cache_read_tokens,
            None => num_opt(first(&[
                gm(row, "cached_tokens"),
                gm(row, "cache_read_tokens"),
                gm(row, "cache_read_input_tokens"),
                gm(row, "cacheReadTokens"),
                gm(row, "cachedTokens"),
                gm(row, "cached_content_token_count"),
            ])),
        };
        let cache_write_tokens = match &buckets {
            Some(b) => b.cache_write_tokens,
            None => num_opt(first(&[
                gm(row, "cache_write_tokens"),
                gm(row, "cache_creation_input_tokens"),
                gm(row, "cacheWriteTokens"),
            ])),
        };
        // prompt_tokens often includes cache hits - uncached for cost split when cache known
        if cache_read_tokens > 0.0 && input_tokens >= cache_read_tokens && !has_buckets {
            input_tokens = (input_tokens - cache_read_tokens).max(0.0);
        }
        let cache_reported = buckets.as_ref().map_or(false, |b| b.cache_reported == Some(true))
            || [
                "cached_tokens",
                "cache_read_tokens",
                "cache_read_input_tokens",
                "cacheReadTokens",
                "cachedTokens",
                "cached_content_token_count",
                "cache_write_tokens",
                "cache_creation_input_tokens",
                "cacheWriteTokens",
            ]
            .iter()
            .any(|k| gm(row, k).is_some());
        let router_cost = num_opt(gm(row, "cost"));
        if input_tokens + output_tokens + cache_read_tokens + cache_write_tokens <= 0.0 && router_cost <= 0.0 {
            continue;
        }

        if str_or_empty(gm(row, "direction")) == "incoming" && router_cost <= 0.0 && output_tokens <= 0.0 {
            if input_tokens + cache_read_tokens <= 0.0 {
                continue;
            }
        }

        let model = pick_model(gm(row, "model"), first(&[gm(row, "resolved_model"), gm(row, "resolvedModel")]));
        let ts = match request_timestamp(gm(row, "timestamp")) {
            Ok(t) => t,
            // `toISOString()` threw: the whole parse aborts, keeping what was collected.
            Err(()) => return events,
        };

        let id = stable_id(&[
            "antigravity",
            "proxy",
            db_path,
            native_id,
            &js_num_to_string(input_tokens),
            &js_num_to_string(output_tokens),
            &js_num_to_string(cache_read_tokens),
        ]);
        let partial = UsageEvent {
            id,
            agent: AgentId::Antigravity,
            model,
            timestamp: ts,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
            workspace: None,
            source_path: db_path.to_string(),
            request_count: Some(1.0),
            cache_reported: if cache_reported { Some(true) } else { None },
            ..UsageEvent::default()
        };
        events.push(apply_pricing_with(partial, if router_cost > 0.0 { Some(router_cost) } else { None }));
    }
    events
}

/// Parse antigravity-proxy SQLite (`requests` table).
pub async fn parse_antigravity_proxy_db(db_path: &str) -> Vec<UsageEvent> {
    let p = db_path.to_string();
    tokio::task::spawn_blocking(move || parse_proxy_db_sync(&p)).await.unwrap_or_default()
}

fn discover_proxy_dbs(root: &str) -> Vec<String> {
    let f = PathFlavor::host();
    let mut out: Vec<String> = Vec::new();
    for c in [
        f.join(&[root, "data", "proxy.db"]),
        f.join(&[root, "proxy.db"]),
        f.join(&[root, "data", "data.sqlite"]),
    ] {
        if path_exists_sync(&c) {
            out.push(c);
        }
    }

    let _ = (|| -> std::io::Result<()> {
        for e in std::fs::read_dir(root)?.flatten() {
            if !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            let n = name.to_lowercase();
            if n == "proxy.db" || (n.contains("proxy") && (n.ends_with(".db") || n.ends_with(".sqlite"))) {
                out.push(f.join(&[root, name.as_str()]));
            }
        }
        let data_dir = f.join(&[root, "data"]);
        if path_exists_sync(&data_dir) {
            for e in std::fs::read_dir(&data_dir)?.flatten() {
                if !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let name = e.file_name().to_string_lossy().to_string();
                let n = name.to_lowercase();
                if n == "proxy.db"
                    || ((n.ends_with(".db") || n.ends_with(".sqlite"))
                        && (n.contains("proxy") || n == "data.sqlite" || n == "usage.db"))
                {
                    out.push(f.join(&[data_dir.as_str(), name.as_str()]));
                }
            }
        }
        Ok(())
    })();

    let mut seen: HashSet<String> = HashSet::new();
    let mut resolved: Vec<String> = Vec::new();
    for p in out {
        let r = f.resolve(&[p.as_str()]);
        if seen.insert(r.clone()) {
            resolved.push(r);
        }
    }
    resolved
}

// ---------------------------------------------------------------------------
// IDE data roots + conversation models
// ---------------------------------------------------------------------------

/// Discover local Antigravity IDE data roots under a scanned root.
fn ide_data_candidates(root: &str) -> Vec<String> {
    let f = PathFlavor::host();
    let mut out: Vec<String> = vec![root.to_string(), f.join(&[root, "antigravity"])];
    let lower = root.replace('\\', "/").to_lowercase();
    if lower.ends_with("/.gemini") || lower.ends_with("/gemini") {
        out.push(f.join(&[root, "antigravity"]));
    }
    unique(out)
}

/// Single-conversation model lookup from conversations/<id>.db.
fn lookup_conversation_model(ide_root: &str, conv_id: &str) -> Option<String> {
    if conv_id.is_empty() {
        return None;
    }
    let f = PathFlavor::host();
    let db_path = f.join(&[ide_root, "conversations", &format!("{}.db", conv_id)]);
    if !path_exists_sync(&db_path) {
        return None;
    }
    let conn = open_ro(&db_path)?;
    let mut candidates: Vec<String> = Vec::new();
    let (_, ok) = for_each_blob(&conn, "SELECT data FROM gen_metadata", 0, |b| {
        push_blob_candidates(&latin1(&b), &mut candidates)
    })?;
    if !ok {
        return None;
    }
    pick_best_model_id(&candidates)
}

/// `*.db` files directly under `dir` (`isFile()` entries only), with their conversation id.
fn conversation_db_files(dir: &str) -> Option<Vec<(String, String)>> {
    let f = PathFlavor::host();
    let rd = std::fs::read_dir(dir).ok()?;
    let mut out = Vec::new();
    for e in rd.flatten() {
        if !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(".db") {
            continue;
        }
        let conv_id = name[..name.len() - 3].to_string();
        out.push((conv_id, f.join(&[dir, name.as_str()])));
    }
    Some(out)
}

fn load_conversation_models_sync(ide_root: &str) -> HashMap<String, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    let f = PathFlavor::host();
    let conv_dir = f.join(&[ide_root, "conversations"]);
    if !path_exists_sync(&conv_dir) {
        return map;
    }
    for (conv_id, db_path) in conversation_db_files(&conv_dir).unwrap_or_default() {
        let conn = match open_ro(&db_path) {
            Some(c) => c,
            None => continue, // locked / not sqlite
        };
        let mut candidates: Vec<String> = Vec::new();
        // Scan all gen_metadata rows (model id often appears mid-blob). latin1 keeps
        // ascii model ids even when mixed with binary.
        let _ = for_each_blob(&conn, "SELECT data FROM gen_metadata", 0, |b| {
            push_blob_candidates(&latin1(&b), &mut candidates)
        });
        let _ = for_each_blob(&conn, "SELECT data FROM trajectory_metadata_blob LIMIT 1", 0, |b| {
            if let Some(t) = extract_model_from_text(&[&latin1(&b)]) {
                candidates.push(t);
            }
        });
        if let Some(model) = pick_best_model_id(&candidates) {
            map.insert(conv_id, model);
        }
    }
    map
}

/// Model map conversationId -> most specific model from conversations/*.db.
pub async fn load_conversation_models(ide_root: &str) -> HashMap<String, String> {
    let p = ide_root.to_string();
    tokio::task::spawn_blocking(move || load_conversation_models_sync(&p)).await.unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Brain transcripts
// ---------------------------------------------------------------------------

const TRANSCRIPT_CONCURRENCY: usize = 4;

fn parse_one_transcript(
    file: &str,
    brain: &str,
    ide_root: &str,
    ide_data_root: &str,
    model_by_conv: &parking_lot::Mutex<HashMap<String, String>>,
) -> Vec<UsageEvent> {
    let mut out: Vec<UsageEvent> = Vec::new();
    let f = PathFlavor::host();
    // conversation id = first path segment under brain/
    let rel = f.relative(brain, file);
    let conv_id = match rel.split(f.sep()).next() {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => f.basename(&f.dirname(file)),
    };
    let text = match read_text_sync(file) {
        Some(t) if !t.is_empty() => t,
        _ => return out,
    };

    // Resolve specific model: conversation DB -> transcript (head+tail) -> generic
    let from_transcript = if js_len(&text) > 100_000 {
        extract_model_from_text(&[&slice_head(&text, 100_000), &slice_tail(&text, 80_000)])
    } else {
        extract_model_from_text(&[&text, ""])
    };
    // Lazy DB lookup if map miss (map may be empty when ide root differed)
    let mut from_db: Option<String> = model_by_conv.lock().get(&conv_id).cloned().filter(|s| !s.is_empty());
    if from_db.as_deref().map_or(true, |m| model_specificity(m) < 60) {
        let looked = lookup_conversation_model(ide_root, &conv_id)
            .or_else(|| lookup_conversation_model(ide_data_root, &conv_id));
        if let Some(l) = looked {
            from_db = Some(l.clone());
            model_by_conv.lock().insert(conv_id.clone(), l);
        }
    }
    let mut model: String = pick_best_model_id(&[
        from_db.clone().unwrap_or_default(),
        from_transcript.clone().unwrap_or_default(),
    ])
    .or(from_db)
    .or(from_transcript)
    .unwrap_or_else(|| "gemini".to_string());

    let mut context_chars: f64 = 0.0;
    let mut turn: u64 = 0;
    let mut last_user_ts: Option<String> = None;

    for row in parse_jsonl(&text) {
        // Non-objects (and arrays, which carry no fields) contribute nothing.
        let r = match &row {
            Value::Object(m) => m,
            _ => continue,
        };
        let type_ = str_or_empty(r.get("type"));
        let source = str_or_empty(r.get("source"));
        let ts_key = |k: &str| -> Option<String> {
            match r.get(k) {
                Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
                _ => None,
            }
        };
        let ts: String = ts_key("created_at")
            .or_else(|| ts_key("timestamp"))
            .or_else(|| last_user_ts.clone())
            .unwrap_or_else(now_iso);

        // Model switch in user metadata / settings - always prefer more specific id
        if type_ == "USER_INPUT" || source == "USER_EXPLICIT" || type_ == "SYSTEM_MESSAGE" {
            let content = text_from_unknown(r.get("content"));
            if let Some(m) = extract_model_from_text(&[&content]) {
                let ranked = pick_best_model_id(&[model.clone(), m.clone()]);
                model = ranked.unwrap_or(m);
            }
            if type_ == "USER_INPUT" || source == "USER_EXPLICIT" {
                context_chars += js_len(&content) as f64;
                last_user_ts = Some(ts);
                continue;
            }
        }

        let extra_len = |r: &Map<String, Value>| -> f64 {
            (js_len(&text_from_unknown(r.get("content")))
                + js_len(&text_from_unknown(r.get("thinking")))
                + js_len(&text_from_unknown(r.get("tool_calls")))
                + js_len(&text_from_unknown(r.get("result")))) as f64
        };

        // System / history / tool results expand context for later model turns
        if source == "SYSTEM"
            || matches!(
                type_.as_str(),
                "CONVERSATION_HISTORY" | "SYSTEM_MESSAGE" | "TOOL_RESULT" | "GENERIC" | "CHECKPOINT"
            )
        {
            context_chars += extra_len(r);
            continue;
        }

        // Model turns (planner / response / code action with thinking)
        let is_model = source == "MODEL"
            || matches!(type_.as_str(), "PLANNER_RESPONSE" | "MODEL_RESPONSE" | "CODE_ACTION" | "ERROR_MESSAGE");
        if !is_model {
            // Other steps (list_dir, run_command, ...) still contribute tool result text
            context_chars += extra_len(r);
            continue;
        }

        let out_text = text_from_unknown(r.get("thinking"))
            + &text_from_unknown(r.get("content"))
            + &text_from_unknown(r.get("tool_calls"));
        // Skip empty model shells
        if js_trim(&out_text).is_empty() && context_chars <= 0.0 {
            continue;
        }

        turn += 1;
        let input_tokens = estimate_tokens_from_chars(context_chars);
        let output_tokens = estimate_tokens_from_text(if out_text.is_empty() { " " } else { &out_text });
        context_chars += js_len(&out_text) as f64;
        if input_tokens + output_tokens <= 0.0 {
            continue;
        }

        let step = match gm(r, "step_index") {
            Some(v) => js_string(v),
            None => turn.to_string(),
        };
        let id = stable_id(&[
            "antigravity",
            "transcript",
            &conv_id,
            file,
            &turn.to_string(),
            &step,
            &js_num_to_string(input_tokens),
            &js_num_to_string(output_tokens),
        ]);
        out.push(apply_pricing(UsageEvent {
            id,
            agent: AgentId::Antigravity,
            model: Some(model.clone()),
            timestamp: ts,
            input_tokens,
            output_tokens,
            cache_read_tokens: 0.0,
            cache_write_tokens: 0.0,
            workspace: None,
            source_path: file.to_string(),
            estimated: Some(true),
            request_count: Some(1.0),
            ..UsageEvent::default()
        }));
    }
    out
}

/// Estimate usage from brain transcripts.
/// Prefer transcript_full.jsonl over transcript.jsonl (same folder).
/// Emits one event per MODEL step (cumulative context like Grok estimate).
fn parse_transcripts_sync(
    ide_root: &str,
    model_by_conv: HashMap<String, String>,
) -> Vec<UsageEvent> {
    let mut events: Vec<UsageEvent> = Vec::new();
    let f = PathFlavor::host();
    let brain = f.join(&[ide_root, "brain"]);
    if !path_exists_sync(&brain) {
        return events;
    }

    let files = walk_files_sync(
        &brain,
        &WalkOptions::new()
            .max_depth(10)
            .matching(|n, _| n == "transcript_full.jsonl" || n == "transcript.jsonl"),
    );

    // Prefer full: skip plain if full exists in same dir
    let mut by_dir: IndexMap<String, Vec<String>> = IndexMap::new();
    for file in files {
        by_dir.entry(f.dirname(&file)).or_default().push(file);
    }
    let mut selected: Vec<String> = Vec::new();
    for (_, list) in &by_dir {
        let full = list.iter().find(|p| f.basename(p) == "transcript_full.jsonl");
        selected.push(full.unwrap_or(&list[0]).clone());
    }

    // Parent of brain is IDE data root - conversation DBs live next to brain/
    let ide_data_root = f.dirname(&brain);
    let model_by_conv = parking_lot::Mutex::new(model_by_conv);

    // Parse several transcripts at once; cap concurrency to limit RAM.
    for chunk in selected.chunks(TRANSCRIPT_CONCURRENCY) {
        let batches: Vec<Vec<UsageEvent>> = std::thread::scope(|s| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|file| {
                    let brain = &brain;
                    let ide_data_root = &ide_data_root;
                    let map = &model_by_conv;
                    s.spawn(move || parse_one_transcript(file, brain, ide_root, ide_data_root, map))
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap_or_default()).collect()
        });
        for batch in batches {
            events.extend(batch);
        }
    }
    events
}

/// Estimate usage from brain transcripts (see [`parse_transcripts_sync`]).
pub async fn parse_antigravity_transcripts(ide_root: &str, model_by_conv: HashMap<String, String>) -> Vec<UsageEvent> {
    let p = ide_root.to_string();
    tokio::task::spawn_blocking(move || parse_transcripts_sync(&p, model_by_conv))
        .await
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Conversation DB fallback
// ---------------------------------------------------------------------------

/// Fallback when a conversation has a DB but no usable transcript:
/// estimate from gen_metadata blob sizes + step count.
fn parse_conversation_dbs_sync(ide_root: &str, already_covered: &HashSet<String>) -> Vec<UsageEvent> {
    let mut events: Vec<UsageEvent> = Vec::new();
    let f = PathFlavor::host();
    let conv_dir = f.join(&[ide_root, "conversations"]);
    if !path_exists_sync(&conv_dir) {
        return events;
    }
    for (conv_id, db_path) in conversation_db_files(&conv_dir).unwrap_or_default() {
        if already_covered.contains(&conv_id) {
            continue;
        }
        let conn = match open_ro(&db_path) {
            Some(c) => c,
            None => continue,
        };
        let mut model: Option<String> = None;
        let mut gen_bytes: usize = 0;
        let gen_count = for_each_blob(&conn, "SELECT data FROM gen_metadata", 0, |b| {
            gen_bytes += b.len();
            if model.is_none() {
                model = extract_model_from_text(&[&latin1(&b)]);
            }
        })
        .map_or(0, |(n, _)| n);

        let mut payload_bytes: usize = 0;
        let step_count =
            for_each_blob(&conn, "SELECT step_type, step_payload FROM steps", 1, |b| payload_bytes += b.len())
                .map_or(0, |(n, _)| n);

        if gen_count + step_count == 0 {
            continue;
        }
        // Rough: gen_metadata ~ model I/O envelopes; payloads ~ tool/user text
        let input_tokens = estimate_tokens_from_chars(payload_bytes.max(gen_bytes) as f64);
        let output_tokens =
            estimate_tokens_from_chars(gen_bytes.max((payload_bytes as f64 * 0.25).floor() as usize) as f64);
        if input_tokens + output_tokens <= 0.0 {
            continue;
        }

        let ts = std::fs::metadata(&db_path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|d| to_iso_string(d.as_millis() as f64))
            .unwrap_or_else(now_iso);

        let id = stable_id(&[
            "antigravity",
            "convdb",
            &conv_id,
            &gen_count.to_string(),
            &step_count.to_string(),
            &js_num_to_string(input_tokens),
            &js_num_to_string(output_tokens),
        ]);
        let request_count = if gen_count > 0 { gen_count } else { (step_count + 3) / 4 };
        events.push(apply_pricing(UsageEvent {
            id,
            agent: AgentId::Antigravity,
            model: Some(model.unwrap_or_else(|| "gemini".to_string())),
            timestamp: ts,
            input_tokens,
            output_tokens,
            cache_read_tokens: 0.0,
            cache_write_tokens: 0.0,
            workspace: None,
            source_path: db_path.clone(),
            estimated: Some(true),
            request_count: Some(request_count.max(1) as f64),
            ..UsageEvent::default()
        }));
    }
    events
}

/// Fallback when a conversation has a DB but no usable transcript.
pub async fn parse_antigravity_conversation_dbs(ide_root: &str, already_covered: HashSet<String>) -> Vec<UsageEvent> {
    let p = ide_root.to_string();
    tokio::task::spawn_blocking(move || parse_conversation_dbs_sync(&p, &already_covered))
        .await
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Explicit usage exports
// ---------------------------------------------------------------------------

/// Explicit usage objects in JSON/JSONL (rare exports). `Err` mirrors the uncaught
/// `RangeError` a bad epoch timestamp throws in the TS parser.
fn parse_explicit_usage_files_sync(roots: &[String]) -> Result<Vec<UsageEvent>, ()> {
    let mut events: Vec<UsageEvent> = Vec::new();
    for root in roots {
        if !path_exists_sync(root) {
            continue;
        }
        let files = walk_files_sync(
            root,
            &WalkOptions::new().max_depth(8).matching(|n, full| {
                let lower = full.to_lowercase().replace('\\', "/");
                if lower.contains("/cache/")
                    || lower.contains("/code cache/")
                    || lower.contains("/gpucache/")
                    || lower.contains("/blob_storage/")
                    || lower.contains("/node_modules/")
                    || lower.contains("/brain/") // handled by transcript parser
                    || lower.contains("/conversations/")
                {
                    return false;
                }
                let nl = n.to_lowercase();
                (nl.ends_with(".jsonl") || nl.ends_with(".json"))
                    && (nl.contains("usage") || nl.contains("history") || nl.contains("billing") || nl.contains("token"))
            }),
        );

        for file in files {
            let text = match read_text_sync(&file) {
                Some(t) if !t.is_empty() => t,
                _ => continue,
            };
            let rows: Vec<Value> = if file.ends_with(".jsonl") {
                parse_jsonl(&text)
            } else {
                match serde_json::from_str::<Value>(&text) {
                    Ok(Value::Array(a)) => a,
                    Ok(Value::Object(o)) => {
                        let arr = ["messages", "events", "usage"].iter().find_map(|k| match o.get(*k) {
                            Some(Value::Array(a)) => Some(a.clone()),
                            _ => None,
                        });
                        arr.unwrap_or_else(|| vec![Value::Object(o)])
                    }
                    _ => Vec::new(),
                }
            };

            let mut idx = 0usize;
            for row in &rows {
                idx += 1;
                let m: Option<&Map<String, Value>> = match row {
                    Value::Object(m) => Some(m),
                    Value::Array(_) => None,
                    _ => continue,
                };
                let usage_src: &Value = match m {
                    Some(m) => first(&[
                        gm(m, "usage"),
                        gm(m, "token_usage"),
                        gm(m, "tokenUsage"),
                        gm(m, "token_count"),
                    ])
                    .unwrap_or(row),
                    None => row,
                };
                let b = match extract_token_buckets(Some(usage_src)) {
                    Some(b) => b,
                    None => continue,
                };
                let model = match m.and_then(|m| match m.get("model") {
                    Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
                    _ => None,
                }) {
                    Some(s) => Some(s),
                    None => {
                        let mut s = String::new();
                        js_json_stringify(row, &mut s);
                        extract_model_from_text(&[&slice_head(&s, 500)])
                    }
                };
                let ts_raw = m.and_then(|m| first(&[gm(m, "timestamp"), gm(m, "created_at"), gm(m, "createdAt")]));
                let timestamp = request_timestamp(ts_raw)?;
                let id = stable_id(&[
                    "antigravity",
                    "export",
                    &file,
                    &idx.to_string(),
                    &js_num_to_string(b.input_tokens),
                    &js_num_to_string(b.output_tokens),
                ]);
                events.push(apply_pricing(UsageEvent {
                    id,
                    agent: AgentId::Antigravity,
                    model,
                    timestamp,
                    input_tokens: b.input_tokens,
                    output_tokens: b.output_tokens,
                    cache_read_tokens: b.cache_read_tokens,
                    cache_write_tokens: b.cache_write_tokens,
                    workspace: None,
                    source_path: file.clone(),
                    request_count: Some(1.0),
                    cache_reported: b.cache_reported,
                    ..UsageEvent::default()
                }));
            }
        }
    }
    Ok(events)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// `/\/brain\/([^/]+)\//i` on a forward-slashed source path.
fn brain_conv_id(source_path: &str) -> Option<String> {
    static RE: Lazy<Regex> = Lazy::new(|| Regex::new(&format!("/{}/([^/]+)/", ci("brain"))).unwrap());
    let p = source_path.replace('\\', "/");
    RE.captures(&p).map(|c| c[1].to_string())
}

fn parse_antigravity_sync(roots: &[String]) -> anyhow::Result<Vec<UsageEvent>> {
    let f = PathFlavor::host();
    let mut events: Vec<UsageEvent> = Vec::new();
    let mut seen_db: HashSet<String> = HashSet::new();
    let mut seen_event_ids: HashSet<String> = HashSet::new();
    let mut seen_ide: HashSet<String> = HashSet::new();
    let mut transcript_conv_ids: HashSet<String> = HashSet::new();

    fn push(events: &mut Vec<UsageEvent>, seen: &mut HashSet<String>, batch: Vec<UsageEvent>) {
        for e in batch {
            if !seen.insert(e.id.clone()) {
                continue;
            }
            events.push(e);
        }
    }

    // 1) Proxy real usage
    for root in roots {
        if !path_exists_sync(root) {
            continue;
        }
        for db_path in discover_proxy_dbs(root) {
            if !seen_db.insert(db_path.to_lowercase()) {
                continue;
            }
            push(&mut events, &mut seen_event_ids, parse_proxy_db_sync(&db_path));
        }
    }

    // 2) Local IDE: transcripts + conversation DBs
    for root in roots {
        if !path_exists_sync(root) {
            continue;
        }
        for ide in ide_data_candidates(root) {
            if !path_exists_sync(&ide) {
                continue;
            }
            let ide_key = f.resolve(&[ide.as_str()]).to_lowercase();
            if seen_ide.contains(&ide_key) {
                continue;
            }
            // Must look like antigravity data (brain or conversations)
            let has_brain = path_exists_sync(&f.join(&[ide.as_str(), "brain"]));
            let has_conv = path_exists_sync(&f.join(&[ide.as_str(), "conversations"]));
            if !has_brain && !has_conv {
                continue;
            }
            seen_ide.insert(ide_key);

            let model_by_conv = load_conversation_models_sync(&ide);
            let transcript_events = parse_transcripts_sync(&ide, model_by_conv);
            for e in &transcript_events {
                // sourcePath .../brain/<convId>/...
                if let Some(id) = brain_conv_id(&e.source_path) {
                    transcript_conv_ids.insert(id);
                }
            }
            push(&mut events, &mut seen_event_ids, transcript_events);
            push(
                &mut events,
                &mut seen_event_ids,
                parse_conversation_dbs_sync(&ide, &transcript_conv_ids),
            );
        }
    }

    // 3) Explicit usage exports
    let explicit = parse_explicit_usage_files_sync(roots)
        .map_err(|_| anyhow::anyhow!("Invalid time value"))?;
    push(&mut events, &mut seen_event_ids, explicit);

    Ok(events)
}

pub async fn parse_antigravity(roots: Vec<String>) -> anyhow::Result<Vec<UsageEvent>> {
    tokio::task::spawn_blocking(move || parse_antigravity_sync(&roots))
        .await
        .map_err(|e| anyhow::anyhow!("antigravity parser panicked: {}", e))?
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Antigravity,
        label: "Antigravity",
        roots,
        parse: parse_fn(parse_antigravity),
        parse_light: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn seed_proxy_db(db_path: &str) {
        let db = rusqlite::Connection::open(db_path).unwrap();
        db.execute_batch(
            "CREATE TABLE requests (
               id TEXT PRIMARY KEY, session_id TEXT, timestamp TEXT NOT NULL, model TEXT,
               resolved_model TEXT, provider TEXT, direction TEXT, type TEXT, content TEXT,
               prompt_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, tool_calls TEXT,
               error TEXT, duration_ms INTEGER, attempts INTEGER DEFAULT 1, cost REAL DEFAULT 0
             );
             INSERT INTO requests (id, timestamp, model, resolved_model, provider, direction, type,
               prompt_tokens, output_tokens, cost) VALUES
               ('req_ok_1','2026-07-31T04:57:41.579Z','gemini-3.6-flash-high','kimi-k3','openai','outgoing','tool-call',24334,88,0.012299),
               ('req_err_1','2026-07-31T04:59:23.664Z','gemini-3.6-flash-tiered','','','outgoing','error',0,0,0),
               ('req_ok_2','2026-07-31T05:00:00.000Z','gemini-3.6-flash-high','XLab','openrouter','outgoing','text',1000,50,0.001);",
        )
        .unwrap();
    }

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "antigravity");
        assert_eq!(a.label, "Antigravity");
    }

    #[tokio::test]
    async fn proxy_db_reads_requests_and_skips_empty_errors() {
        let root = tempfile::tempdir().unwrap();
        let data_dir = root.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let db_path = data_dir.join("proxy.db").to_string_lossy().to_string();
        seed_proxy_db(&db_path);

        let events = parse_antigravity_proxy_db(&db_path).await;
        assert_eq!(events.len(), 2, "two billable rows");

        let first = events.iter().find(|e| e.input_tokens == 24334.0).unwrap();
        assert_eq!(first.agent, AgentId::Antigravity);
        assert_eq!(first.model.as_deref(), Some("kimi-k3"));
        assert_eq!(first.output_tokens, 88.0);
        assert!(first.estimated_cost.unwrap_or(0.0) > 0.0);
        assert_eq!(first.request_count, Some(1.0));
        assert_eq!(first.estimated, None);

        let second = events.iter().find(|e| e.input_tokens == 1000.0).unwrap();
        assert_eq!(second.model.as_deref(), Some("gemini-3.6-flash-high"));
        // Timestamps are passed through verbatim (trimmed), not normalised.
        assert_eq!(second.timestamp, "2026-07-31T05:00:00.000Z");
    }

    #[test]
    fn extract_model_prefers_specific_gemini_flash_variants() {
        let x = |s: &str| extract_model_from_text(&[s]);
        assert_eq!(
            x("Model Selection` from None to Gemini 3.6 Flash (High).").as_deref(),
            Some("gemini-3.6-flash-high")
        );
        assert_eq!(
            x("noise gemini-3.6-flash-tiered and MODEL_PLACEHOLDER_M196").as_deref(),
            Some("gemini-3.6-flash-tiered")
        );
        assert_eq!(
            x("gemini-3.6-flash-high gemini-3.6-flash-tiered").as_deref(),
            Some("gemini-3.6-flash-high")
        );
        assert_eq!(x("MODEL_PLACEHOLDER_M71").as_deref(), Some("gemini-3.6-flash-high"));
        assert_ne!(x("C:\\\\Users\\\\.gemini\\\\antigravity\\\\brain").as_deref(), Some("gemini"));
        assert_eq!(x(""), None);
        assert_eq!(x("claude-sonnet-4 and gpt-5").as_deref(), Some("claude-sonnet-4"));
    }

    #[test]
    fn pick_model_and_best_id_rules() {
        assert_eq!(pick_model(Some(&json!("gemini-3.6-flash-high")), Some(&json!("kimi-k3"))).as_deref(), Some("kimi-k3"));
        assert_eq!(pick_model(Some(&json!("gemini-3.6-flash-high")), Some(&json!("XLab"))).as_deref(), Some("gemini-3.6-flash-high"));
        assert_eq!(pick_model(Some(&json!("")), Some(&json!("XLab"))).as_deref(), Some("XLab"));
        assert_eq!(pick_model(None, None), None);
        assert_eq!(pick_best_model_id(&["gemini", "gemini-api", "gemini-3.6-pro"]).as_deref(), Some("gemini-3.6-pro"));
        assert_eq!(pick_best_model_id(&["a/b", "xy"]), None);
    }

    #[test]
    fn json_stringify_matches_js() {
        let v: Value = serde_json::from_str(r#"{"b":1.0,"2":[1e21,"x\n"],"a":null}"#).unwrap();
        let mut s = String::new();
        js_json_stringify(&v, &mut s);
        assert_eq!(s, r#"{"2":[1e+21,"x\n"],"b":1,"a":null}"#);
        assert_eq!(text_from_unknown(Some(&json!({"text": "hi"}))), "hi");
        assert_eq!(text_from_unknown(Some(&json!(["a", 2, true]))), "a\n2\ntrue");
    }

    #[tokio::test]
    async fn transcripts_estimate_tokens_from_brain_logs() {
        let root = tempfile::tempdir().unwrap();
        let log_dir = root.path().join("brain").join("conv-abc").join(".system_generated").join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        let lines = vec![
            json!({"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE",
                   "created_at":"2026-07-31T04:57:29Z",
                   "content":"hello world check chapters\nModel Selection from None to Gemini 3.6 Flash (High)."}),
            json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE",
                   "created_at":"2026-07-31T04:57:40Z",
                   "thinking":"I will inspect the directory and list files carefully.",
                   "tool_calls":[{"name":"list_dir","args":{"DirectoryPath":"C:\\\\tmp"}}]}),
            json!({"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE",
                   "created_at":"2026-07-31T04:58:00Z","content":"Done listing. Found 3 files."}),
        ];
        let body = lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n") + "\n";
        std::fs::write(log_dir.join("transcript_full.jsonl"), body).unwrap();

        let root_s = root.path().to_string_lossy().to_string();
        let events = parse_antigravity_transcripts(&root_s, HashMap::new()).await;
        assert!(events.len() >= 2, "at least two model turns");
        assert!(events.iter().all(|e| e.estimated == Some(true)));
        assert!(events.iter().all(|e| e.agent == AgentId::Antigravity));
        assert!(events.iter().all(|e| e.model.as_deref() == Some("gemini-3.6-flash-high")));
        let total: f64 = events.iter().map(|e| e.input_tokens + e.output_tokens).sum();
        assert!(total > 20.0, "non-trivial estimated tokens");
        // Timestamps come straight from the transcript rows.
        assert_eq!(events[0].timestamp, "2026-07-31T04:57:40Z");
        // Context grows turn over turn: the second turn's input includes the first's output.
        assert!(events[1].input_tokens > events[0].input_tokens);
    }

    #[tokio::test]
    async fn parse_merges_proxy_and_local_ide_transcripts() {
        let root = tempfile::tempdir().unwrap();
        let data_dir = root.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        seed_proxy_db(&data_dir.join("proxy.db").to_string_lossy());

        let log_dir = root.path().join("brain").join("c1").join(".system_generated").join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        let rows = [
            json!({"source":"USER_EXPLICIT","type":"USER_INPUT","created_at":"2026-07-30T10:00:00Z",
                   "content": format!("write a poem about cats {}", "x".repeat(200))}),
            json!({"source":"MODEL","type":"PLANNER_RESPONSE","created_at":"2026-07-30T10:00:05Z",
                   "thinking": format!("Sure, here is a poem. {}", "y".repeat(400))}),
        ];
        let body = rows.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n") + "\n";
        std::fs::write(log_dir.join("transcript.jsonl"), body).unwrap();

        let events = parse_antigravity(vec![root.path().to_string_lossy().to_string()]).await.unwrap();
        let proxy: Vec<_> = events.iter().filter(|e| e.estimated != Some(true)).collect();
        let estimated: Vec<_> = events.iter().filter(|e| e.estimated == Some(true)).collect();
        assert_eq!(proxy.len(), 2, "proxy real rows");
        assert!(!estimated.is_empty(), "transcript estimates");
        assert!(events.iter().map(|e| e.input_tokens).sum::<f64>() > 24334.0);
    }

    #[tokio::test]
    async fn conversation_db_fallback_and_model_lookup() {
        let root = tempfile::tempdir().unwrap();
        let conv_dir = root.path().join("conversations");
        std::fs::create_dir_all(&conv_dir).unwrap();
        let db_path = conv_dir.join("conv-1.db");
        {
            let db = rusqlite::Connection::open(&db_path).unwrap();
            db.execute_batch(
                "CREATE TABLE gen_metadata (data BLOB);
                 CREATE TABLE steps (step_type TEXT, step_payload BLOB);",
            )
            .unwrap();
            db.execute(
                "INSERT INTO gen_metadata (data) VALUES (?1)",
                [b"\x01\x02 junk gemini-3.6-flash-high \x00 tail".to_vec()],
            )
            .unwrap();
            db.execute("INSERT INTO steps VALUES ('a', ?1)", [vec![7u8; 100]]).unwrap();
            db.execute("INSERT INTO steps VALUES ('b', NULL)", []).unwrap();
        }
        let root_s = root.path().to_string_lossy().to_string();
        let models = load_conversation_models(&root_s).await;
        assert_eq!(models.get("conv-1").map(String::as_str), Some("gemini-3.6-flash-high"));

        let events = parse_antigravity_conversation_dbs(&root_s, HashSet::new()).await;
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.model.as_deref(), Some("gemini-3.6-flash-high"));
        assert_eq!(e.estimated, Some(true));
        // payload 100 bytes vs gen_metadata ~40 bytes -> input from max(), output from max(gen, 25)
        assert_eq!(e.input_tokens, 25.0);
        assert_eq!(e.request_count, Some(1.0));

        let covered: HashSet<String> = ["conv-1".to_string()].into_iter().collect();
        assert!(parse_antigravity_conversation_dbs(&root_s, covered).await.is_empty());
    }

    #[tokio::test]
    async fn explicit_usage_exports_are_parsed() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("usage.json"),
            r#"{"events":[{"model":"gemini-3.6-pro","timestamp":"2026-01-02T03:04:05Z","usage":{"input_tokens":10,"output_tokens":5}},{"nothing":1}]}"#,
        )
        .unwrap();
        let events = parse_antigravity(vec![root.path().to_string_lossy().to_string()]).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].model.as_deref(), Some("gemini-3.6-pro"));
        assert_eq!(events[0].input_tokens, 10.0);
        assert_eq!(events[0].output_tokens, 5.0);
        assert_eq!(events[0].timestamp, "2026-01-02T03:04:05Z");
    }
}
