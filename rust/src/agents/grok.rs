//! Agent: Grok (xAI) (port of `src/agents/grok/index.ts`).
//!
//! Grok Build CLI: `~/.grok/sessions/<cwd>/<id>/`
//!
//! Policy: prefer over-count over missing usage.
//! - Discover sessions via usage.json, summary.json, updates.jsonl, or chat_history.jsonl
//! - Prefer turn_completed.usage (input includes cache; split cache for pricing)
//! - Prefer usage.json's aggregate snapshot over replaying completed turns
//! - Stream totalTokens floor for in-progress turns
//! - Chat text estimate only when no real counters (include synthetics - they are billed)

use crate::agents::shared::env::{path_env, unique};
use crate::agents::shared::usage_fields::{resolve_span_ms, split_usage_row, SplitPiece, SplittableUsage};
use crate::agents::{parse_fn, AgentModule};
use crate::pricing::apply_pricing_with;
use crate::types::{AgentId, UsageEvent};
use crate::util::{
    cached_events_for_file, estimate_tokens_from_chars, estimate_tokens_from_text, js_date_parse, js_len,
    js_num_to_string, js_trim, now_ms, num, path_exists, read_json_cached, read_jsonl_cached, read_text, stable_id,
    stamp_file, time_clip, to_iso_string, walk_files, EventCacheOpts, PathFlavor, WalkOptions,
};
use anyhow::Result;
use indexmap::IndexMap;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;

/// Local data roots to scan on this machine.
pub fn roots() -> Vec<String> {
    let e = path_env();
    let mut r: Vec<String> = Vec::new();
    r.push(e.j(&[&e.home, ".grok"]));
    r.push(e.j(&[&e.app_data, "Grok"]));
    unique(r)
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Grok,
        label: "Grok (xAI)",
        roots,
        parse: parse_fn(parse_grok),
        parse_light: None,
    }
}

// ---------------------------------------------------------------------------
// JS-ish value helpers
// ---------------------------------------------------------------------------

/// `v[key]` with `undefined` and `null` both mapped to `None` (what `??` skips).
fn get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    match v.get(key) {
        Some(Value::Null) | None => None,
        Some(x) => Some(x),
    }
}

/// `v[a] ?? v[b] ?? ...`
fn co<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| get(v, k))
}

/// `num(v[a] ?? v[b] ?? ...)`
fn numco(v: &Value, keys: &[&str]) -> f64 {
    co(v, keys).map_or(0.0, num)
}

/// `typeof x === "string" && x` (non-empty string).
fn ne_str(v: Option<&Value>) -> Option<&str> {
    match v {
        Some(Value::String(s)) if !s.is_empty() => Some(s.as_str()),
        _ => None,
    }
}

/// `typeof v[key] === "string" && v[key]`
fn ne_str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    ne_str(v.get(key))
}

/// `typeof v === "object" && v` truthy object-ish (object or array).
fn is_objectish(v: &Value) -> bool {
    matches!(v, Value::Object(_) | Value::Array(_))
}

/// `String(v)` for JSON values.
fn js_str(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_num_to_string(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|x| if x.is_null() { String::new() } else { js_str(x) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `JSON.stringify(v)` (only its length matters here).
fn js_stringify(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&js_num_to_string(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                js_stringify(x, out);
            }
            out.push(']');
        }
        Value::Object(m) => {
            out.push('{');
            for (i, (k, x)) in m.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                js_stringify(x, out);
            }
            out.push('}');
        }
    }
}

/// Canonical array-index key (`"0"`, `"17"`, not `"01"`, < 2^32 - 1).
fn array_index(k: &str) -> Option<u64> {
    if k.is_empty() || !k.bytes().all(|b| b.is_ascii_digit()) || (k.len() > 1 && k.starts_with('0')) {
        return None;
    }
    k.parse::<u64>().ok().filter(|i| *i < 4_294_967_295)
}

/// `Object.entries(v)` order: integer-like keys ascending first, then insertion order.
/// Arrays yield their indices; anything else yields `None`.
fn entries_of(v: &Value) -> Option<Vec<(String, &Value)>> {
    match v {
        Value::Object(m) => {
            let mut ints: Vec<(u64, String, &Value)> = Vec::new();
            let mut rest: Vec<(String, &Value)> = Vec::new();
            for (k, x) in m {
                match array_index(k) {
                    Some(i) => ints.push((i, k.clone(), x)),
                    None => rest.push((k.clone(), x)),
                }
            }
            ints.sort_by_key(|t| t.0);
            let mut out: Vec<(String, &Value)> = ints.into_iter().map(|(_, k, x)| (k, x)).collect();
            out.extend(rest);
            Some(out)
        }
        Value::Array(a) => Some(a.iter().enumerate().map(|(i, x)| (i.to_string(), x)).collect()),
        _ => None,
    }
}

/// `decodeURIComponent` (None on a malformed sequence, like the thrown URIError).
fn decode_uri_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    let hex = |c: u8| -> Option<u8> { (c as char).to_digit(16).map(|d| d as u8) };
    while i < b.len() {
        if b[i] == b'%' {
            let h = b.get(i + 1).and_then(|c| hex(*c))?;
            let l = b.get(i + 2).and_then(|c| hex(*c))?;
            out.push(h * 16 + l);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Split like Node's readline (`\r\n`, `\n` or lone `\r`); no trailing empty line.
fn split_lines(text: &str) -> Vec<&str> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < b.len() {
        match b[i] {
            b'\n' => {
                out.push(&text[start..i]);
                i += 1;
                start = i;
            }
            b'\r' => {
                out.push(&text[start..i]);
                i += if i + 1 < b.len() && b[i + 1] == b'\n' { 2 } else { 1 };
                start = i;
            }
            _ => i += 1,
        }
    }
    if start < b.len() {
        out.push(&text[start..]);
    }
    out
}

/// `new Date(ms).toISOString()` or `None` for an invalid date.
fn iso_of_ms(ms: f64) -> Option<String> {
    let t = time_clip(ms);
    if t.is_nan() {
        None
    } else {
        to_iso_string(t)
    }
}

/// `file mtime.toISOString()`.
fn mtime_iso(file: &str) -> Option<String> {
    let m = std::fs::metadata(file).ok()?;
    let d = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    iso_of_ms(d.as_millis() as f64)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const SESSION_CONC: usize = 4;

pub async fn parse_grok(roots: Vec<String>) -> Result<Vec<UsageEvent>> {
    let mut events: Vec<UsageEvent> = Vec::new();
    let mut on_disk_session_ids: HashSet<String> = HashSet::new();
    let flavor = PathFlavor::host();

    for root in &roots {
        if !path_exists(root).await {
            continue;
        }
        let sessions_root = flavor.join(&[root.as_str(), "sessions"]);
        if path_exists(&sessions_root).await {
            // Discover every session dir that has any artifact (never require summary.json).
            let markers = walk_files(
                &sessions_root,
                WalkOptions::new().max_depth(14).matching(|n, _| {
                    n == "usage.json" || n == "summary.json" || n == "updates.jsonl" || n == "chat_history.jsonl"
                }),
            )
            .await;
            let session_dirs = unique(markers.iter().map(|m| flavor.dirname(m)));
            for dir in &session_dirs {
                if let Some(id) = session_id_from_dir(dir) {
                    on_disk_session_ids.insert(id);
                }
            }

            // Parse several sessions at once - sequential I/O was the main Grok scan cost.
            for chunk in session_dirs.chunks(SESSION_CONC) {
                let handles: Vec<_> = chunk
                    .iter()
                    .map(|dir| {
                        let dir = dir.clone();
                        tokio::spawn(async move { parse_grok_session_cached(&dir).await })
                    })
                    .collect();
                for h in handles {
                    let batch = h.await??;
                    events.extend(batch);
                }
            }
        }

        // Grok keeps compact usage for older/pruned sessions here after their
        // session directories are removed.
        if flavor.basename(root).to_lowercase() == ".grok" {
            let meta = flavor.join(&[root.as_str(), "client-state", "session-meta.json"]);
            events.extend(parse_grok_session_meta(&meta, &on_disk_session_ids).await);
        }
    }

    Ok(events)
}

// ---------------------------------------------------------------------------
// Session cache
// ---------------------------------------------------------------------------

const SESSION_ARTIFACTS: [&str; 4] = ["summary.json", "usage.json", "updates.jsonl", "chat_history.jsonl"];

async fn grok_session_signature(dir: &str) -> String {
    let flavor = PathFlavor::host();
    let mut parts: Vec<String> = Vec::new();
    for name in SESSION_ARTIFACTS {
        match stamp_file(&flavor.join(&[dir, name])).await {
            Some(st) => parts.push(format!("{}|{}|{}", name, st.size, st.mtime_ms.trunc() as i64)),
            None => parts.push(format!("{}|-", name)),
        }
    }
    parts.join(",")
}

async fn parse_grok_session_cached(dir: &str) -> Result<Vec<UsageEvent>> {
    let signature = grok_session_signature(dir).await;
    let d = dir.to_string();
    cached_events_for_file(
        &format!("{}\u{0}grok-session", dir),
        move || async move { parse_grok_session(&d).await },
        EventCacheOpts { max_bytes: None, signature: Some(signature) },
    )
    .await
}

// ---------------------------------------------------------------------------
// Shared builders
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Ctx {
    session_id: String,
    model: String,
    workspace: Option<String>,
    fallback_ts: String,
}

/// Parsed usage counters (`bucketsFromUsage` result).
#[derive(Debug, Clone, Default)]
struct Buckets {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    router_cost: Option<f64>,
    request_count: Option<f64>,
    cache_reported: bool,
}

struct EventSpec<'a> {
    id: String,
    model: &'a str,
    timestamp: String,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    workspace: Option<String>,
    source_path: String,
    estimated: Option<bool>,
    request_count: Option<f64>,
    cache_reported: bool,
    router_cost: Option<f64>,
}

fn make_event(s: EventSpec<'_>) -> UsageEvent {
    apply_pricing_with(
        UsageEvent {
            id: s.id,
            agent: AgentId::Grok,
            model: Some(s.model.to_string()),
            timestamp: s.timestamp,
            input_tokens: s.input,
            output_tokens: s.output,
            cache_read_tokens: s.cache_read,
            cache_write_tokens: s.cache_write,
            workspace: s.workspace,
            source_path: s.source_path,
            estimated: s.estimated,
            request_count: s.request_count,
            cache_reported: if s.cache_reported { Some(true) } else { None },
            ..Default::default()
        },
        s.router_cost,
    )
}

/// Spread a session rollup's aggregate request count over `[start, end]`.
fn split_buckets(b: &Buckets, requests: f64, start: f64, end: f64) -> Vec<SplitPiece> {
    split_usage_row(
        &SplittableUsage {
            request_count: Some(requests),
            input_tokens: Some(b.input),
            output_tokens: Some(b.output),
            cache_read_tokens: Some(b.cache_read),
            cache_write_tokens: Some(b.cache_write),
            estimated_cost: b.router_cost,
            ..Default::default()
        },
        requests,
        start,
        end,
    )
}

fn split_to_event(
    b: &Buckets,
    part: &SplitPiece,
    id: String,
    model: &str,
    workspace: Option<String>,
    source_path: String,
    estimated: Option<bool>,
) -> UsageEvent {
    make_event(EventSpec {
        id,
        model,
        timestamp: part.timestamp.clone(),
        input: part.input_tokens,
        output: part.output_tokens,
        cache_read: part.cache_read_tokens,
        cache_write: part.cache_write_tokens,
        workspace,
        source_path,
        estimated,
        request_count: Some(part.request_count),
        cache_reported: b.cache_reported,
        router_cost: if b.router_cost.is_some() { part.estimated_cost } else { None },
    })
}

// ---------------------------------------------------------------------------
// Usage object -> buckets
// ---------------------------------------------------------------------------

/// Grok turn_completed.usage (real CLI shape):
/// - inputTokens = FULL prompt (includes cache hits)
/// - cachedReadTokens = cache hit portion of input
/// - cacheCreationTokens = cache write / creation tokens
/// - outputTokens already includes reasoningTokens when both present
/// - costUsdTicks = official USD x 1e10 (prefer over table rates)
fn buckets_from_usage(usage: &Value) -> Option<Buckets> {
    let full_input = numco(usage, &["inputTokens", "input_tokens", "prompt_tokens", "promptTokens"]);
    let mut output = numco(usage, &["outputTokens", "output_tokens", "completion_tokens", "completionTokens"]);
    let reasoning = numco(
        usage,
        &[
            "reasoningTokens",
            "reasoning_tokens",
            "reasoning_output_tokens",
            "reasoningOutputTokens",
            "thinking_tokens",
            "thinkingOutputTokens",
        ],
    );
    if reasoning > 0.0 {
        if output <= 0.0 {
            output = reasoning;
        } else if reasoning > output {
            output = reasoning;
        }
    }

    let cache_read = numco(
        usage,
        &[
            "cachedReadTokens",
            "cached_input_tokens",
            "cachedInputTokens",
            "cache_read_input_tokens",
            "cacheReadInputTokens",
            "cache_read_tokens",
            "cacheReadTokens",
            "cached_tokens",
            "cached_content_token_count",
            "cachedContentTokenCount",
        ],
    );
    let cache_write = numco(
        usage,
        &[
            "cacheCreationTokens",
            "cache_creation_tokens",
            "cache_creation_input_tokens",
            "cache_write_input_tokens",
            "cacheWriteInputTokens",
            "cacheWriteTokens",
            "cache_write_tokens",
            "cachedWriteTokens",
        ],
    );

    let uncached = (full_input - cache_read).max(0.0);
    if uncached + output + cache_read + cache_write <= 0.0 {
        return None;
    }

    let ticks = numco(usage, &["costUsdTicks", "cost_usd_ticks"]);
    let router_cost = if ticks > 0.0 { Some(ticks / 1e10) } else { None };
    let calls = numco(usage, &["modelCalls", "model_calls", "apiCalls", "api_calls"]);
    let has_cach_key = match usage {
        Value::Object(m) => m.keys().any(|k| k.to_lowercase().contains("cach")),
        _ => false,
    };
    let cache_reported = has_cach_key || cache_read > 0.0 || cache_write > 0.0;

    Some(Buckets {
        input: uncached,
        output,
        cache_read,
        cache_write,
        router_cost,
        request_count: if calls > 0.0 { Some(calls.floor()) } else { None },
        cache_reported,
    })
}

fn model_from_usage(usage: &Value, fallback: &str) -> String {
    if let Some(Value::String(s)) = co(usage, &["primaryModelId", "primary_model_id"]) {
        if !s.is_empty() {
            return s.clone();
        }
    }
    let Some(mu) = get(usage, "modelUsage") else {
        return fallback.to_string();
    };
    let Some(entries) = entries_of(mu) else {
        return fallback.to_string();
    };
    if entries.is_empty() {
        return fallback.to_string();
    }
    if entries.len() == 1 && !entries[0].0.is_empty() {
        return entries[0].0.clone();
    }
    let mut best = if entries[0].0.is_empty() { fallback.to_string() } else { entries[0].0.clone() };
    let mut best_total = -1.0;
    for (k, row) in &entries {
        let total = numco(row, &["totalTokens", "inputTokens", "input_tokens"]);
        if total > best_total {
            best_total = total;
            best = k.clone();
        }
    }
    best
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

fn timestamp_from_update(row: &Value, fallback: &str) -> String {
    match row.get("timestamp") {
        Some(Value::Number(n)) => {
            if let Some(t) = n.as_f64() {
                if t.is_finite() && t > 0.0 {
                    let ms = if t > 1e12 { t } else { t * 1000.0 };
                    if let Some(s) = iso_of_ms(ms) {
                        return s;
                    }
                }
            }
        }
        Some(Value::String(t)) => {
            if !js_trim(t).is_empty() {
                if let Some(s) = iso_of_ms(js_date_parse(t)) {
                    return s;
                }
            }
        }
        _ => {}
    }
    let params = row.get("params");
    let update = params.and_then(|p| p.get("update"));
    let nn = |v: Option<&'_ Value>| -> Option<Value> {
        match v {
            Some(Value::Null) | None => None,
            Some(x) => Some(x.clone()),
        }
    };
    let meta = nn(update.and_then(|u| u.get("_meta")))
        .or_else(|| nn(params.and_then(|p| p.get("_meta"))))
        .or_else(|| nn(row.get("_meta")));
    if let Some(meta) = meta {
        for key in ["agentTimestampMs", "streamStartMs", "turnStartMs"] {
            if let Some(Value::Number(n)) = meta.get(key) {
                if let Some(v) = n.as_f64() {
                    if v.is_finite() && v > 1e11 {
                        if let Some(s) = iso_of_ms(v) {
                            return s;
                        }
                    }
                }
            }
        }
    }
    fallback.to_string()
}

fn valid_timestamp(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) => {
            if !js_trim(s).is_empty() {
                let ms = js_date_parse(s);
                if !ms.is_nan() {
                    return iso_of_ms(ms);
                }
            }
            None
        }
        Some(Value::Number(n)) => {
            let v = n.as_f64()?;
            if v.is_finite() && v > 0.0 {
                let ms = if v > 1e12 { v } else { v * 1000.0 };
                iso_of_ms(ms)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn timestamp_from_session_id(session_id: &str) -> Option<String> {
    let compact: String = session_id.chars().filter(|c| *c != '-').collect();
    if compact.len() != 32 || !compact.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let ms = u64::from_str_radix(&compact[..12], 16).ok()? as f64;
    if ms <= 0.0 {
        return None;
    }
    iso_of_ms(ms)
}

fn latest_event_timestamp(events: &[&UsageEvent]) -> Option<f64> {
    let mut latest: Option<f64> = None;
    for e in events {
        let ms = js_date_parse(&e.timestamp);
        if !ms.is_finite() {
            continue;
        }
        if latest.map_or(true, |l| ms > l) {
            latest = Some(ms);
        }
    }
    latest
}

fn is_after_timestamp(timestamp: &str, boundary: &str) -> bool {
    let a = js_date_parse(timestamp);
    let b = js_date_parse(boundary);
    a.is_finite() && b.is_finite() && a > b
}

fn session_id_from_dir(dir: &str) -> Option<String> {
    let base = PathFlavor::host().basename(dir);
    if !base.is_empty() && base != "sessions" {
        Some(base)
    } else {
        None
    }
}

/// Best-effort workspace from encoded session folder path.
fn decode_workspace_from_session_path(dir: &str) -> Option<String> {
    // .../sessions/C%3A%5CDev%5CXLab_Token/<id>
    let f = PathFlavor::host();
    let parent = f.basename(&f.dirname(dir));
    if parent.is_empty() || parent == "sessions" {
        return None;
    }
    let decoded = decode_uri_component(&parent)?;
    if decoded.contains(':') || decoded.starts_with('/') || decoded.starts_with('\\') {
        Some(decoded)
    } else {
        None
    }
}

fn turn_end_span_ms(turns: &[Value]) -> Option<(f64, f64)> {
    let mut times: Vec<f64> = Vec::new();
    for t in turns {
        if !is_objectish(t) {
            continue;
        }
        for key in ["endedAt", "ended_at", "updatedAt", "createdAt"] {
            if let Some(Value::String(v)) = t.get(key) {
                let ms = js_date_parse(v);
                if ms.is_finite() {
                    times.push(ms);
                    break;
                }
            }
        }
    }
    if times.len() < 2 {
        return None;
    }
    let mut min = times[0];
    let mut max = times[0];
    for t in &times {
        if *t < min {
            min = *t;
        }
        if *t > max {
            max = *t;
        }
    }
    Some((min, max))
}

fn extract_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|part| match part {
                Value::String(s) => s.clone(),
                Value::Object(_) => match part.get("text") {
                    Some(Value::String(t)) => t.clone(),
                    _ => String::new(),
                },
                _ => String::new(),
            })
            .collect::<String>(),
        Some(c @ Value::Object(_)) => match c.get("text") {
            Some(Value::String(t)) => t.clone(),
            _ => String::new(),
        },
        _ => String::new(),
    }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

async fn parse_grok_session(dir: &str) -> Result<Vec<UsageEvent>> {
    let flavor = PathFlavor::host();
    let mut events: Vec<UsageEvent> = Vec::new();
    let summary_path = flavor.join(&[dir, "summary.json"]);
    let mut summary = Value::Object(Default::default());
    if let Some(text) = read_text(&summary_path).await {
        if !text.is_empty() {
            summary = serde_json::from_str::<Value>(&text).unwrap_or(Value::Object(Default::default()));
        }
    }

    let null = Value::Null;
    let info: &Value = get(&summary, "info").unwrap_or(&null);
    let model: String = ne_str_of(&summary, "current_model_id")
        .or_else(|| ne_str_of(&summary, "model"))
        .unwrap_or("grok-4.5")
        .to_string();
    let workspace: Option<String> = ne_str_of(info, "cwd")
        .map(str::to_string)
        .or_else(|| ne_str_of(&summary, "git_root_dir").map(str::to_string))
        .or_else(|| decode_workspace_from_session_path(dir));
    let mut ts: String = ne_str_of(&summary, "updated_at")
        .or_else(|| ne_str_of(&summary, "last_active_at"))
        .or_else(|| ne_str_of(&summary, "created_at"))
        .unwrap_or("")
        .to_string();
    let updates_path = flavor.join(&[dir, "updates.jsonl"]);
    let chat_path = flavor.join(&[dir, "chat_history.jsonl"]);
    if ts.is_empty() {
        ts = mtime_iso(&updates_path)
            .or_else(|| mtime_iso(&chat_path))
            .or_else(|| mtime_iso(&summary_path))
            .unwrap_or_else(|| iso_of_ms(now_ms()).unwrap_or_default());
    }
    let session_id: String = ne_str_of(info, "id").map(str::to_string).unwrap_or_else(|| flavor.basename(dir));

    let ctx = Ctx { session_id: session_id.clone(), model: model.clone(), workspace: workspace.clone(), fallback_ts: ts.clone() };

    // 1) Grok's persisted session snapshot is authoritative for completed usage.
    let usage_path = flavor.join(&[dir, "usage.json"]);
    let usage_snapshot = read_grok_usage_snapshot(&usage_path, &ctx).await;

    // 2) Real usage/residuals from updates.jsonl
    let mut from_updates: Vec<UsageEvent> = Vec::new();
    if path_exists(&updates_path).await {
        from_updates = parse_updates_usage(&updates_path, &ctx).await;
    }

    // 2a) Legacy turns[] usage.json export - per-turn events are authoritative when present.
    let persisted = parse_persisted_usage(&usage_path, &ctx).await;
    let real_updates: Vec<&UsageEvent> = from_updates.iter().filter(|e| e.estimated != Some(true)).collect();
    if !persisted.events.is_empty() && (real_updates.is_empty() || persisted_usage_is_richer(&persisted, &real_updates)) {
        events.extend(persisted.events.iter().cloned());
        // Keep only usage written after the persisted rollup (active turn only).
        if let Some(updated_at) = &persisted.updated_at {
            events.extend(from_updates.iter().filter(|e| is_after_timestamp(&e.timestamp, updated_at)).cloned());
        }
    } else if !from_updates.is_empty() {
        let latest_real_ts = latest_event_timestamp(&real_updates);
        let snapshot_ts = match usage_snapshot.last() {
            Some(e) => js_date_parse(&e.timestamp),
            None => f64::NAN,
        };
        if usage_snapshot.is_empty()
            || matches!(latest_real_ts, Some(l) if !snapshot_ts.is_finite() || l > snapshot_ts + 1000.0)
        {
            events.extend(from_updates.iter().cloned());
        } else {
            events.extend(from_updates.iter().filter(|e| e.estimated == Some(true)).cloned());
        }
    }
    let mut had_real_usage = events.iter().any(|e| e.estimated != Some(true));

    if !usage_snapshot.is_empty() && !had_real_usage {
        let mut merged = usage_snapshot.clone();
        merged.extend(events);
        events = merged;
        had_real_usage = true;
    }

    // 3) Explicit usage on summary
    if !had_real_usage {
        if let Some(usage) = co(&summary, &["usage", "token_usage"]) {
            if let Some(b) = buckets_from_usage(usage) {
                let span = resolve_span_ms(
                    summary.get("created_at"),
                    co(&summary, &["updated_at", "last_active_at"]),
                );
                let base_id = stable_id(&["grok", session_id.as_str(), "usage"]);
                let split = match (span, b.request_count) {
                    (Some(sp), Some(rc)) if rc > 1.0 => Some((sp, rc)),
                    _ => None,
                };
                if let Some((sp, rc)) = split {
                    let parts = split_buckets(&b, rc, sp.0, sp.1);
                    for (p, part) in parts.iter().enumerate() {
                        let id = if parts.len() > 1 { format!("{}-s{}", base_id, p) } else { base_id.clone() };
                        events.push(split_to_event(
                            &b,
                            part,
                            id,
                            &model,
                            workspace.clone(),
                            summary_path.clone(),
                            None,
                        ));
                    }
                } else {
                    events.push(make_event(EventSpec {
                        id: base_id,
                        model: &model,
                        timestamp: ts.clone(),
                        input: b.input,
                        output: b.output,
                        cache_read: b.cache_read,
                        cache_write: b.cache_write,
                        workspace: workspace.clone(),
                        source_path: summary_path.clone(),
                        estimated: None,
                        request_count: b.request_count.filter(|rc| *rc > 0.0),
                        cache_reported: b.cache_reported,
                        router_cost: b.router_cost,
                    }));
                }
                had_real_usage = true;
            }
        }
    }

    // 4) Chat text estimate only when no real counters
    if had_real_usage {
        return Ok(events);
    }

    let Some(chat_rows) = read_jsonl_cached(&chat_path, None).await? else {
        return Ok(events);
    };

    // Cumulative context chars -> each assistant turn prices full history (over-count friendly)
    let mut context_chars: f64 = 0.0;
    let mut turn: u64 = 0;
    let mut emitted: u64 = 0;
    for row in chat_rows.iter() {
        if !is_objectish(row) {
            continue;
        }
        let typ = row_type(row);
        let content = extract_text(row.get("content"));
        if content.is_empty() {
            continue;
        }
        let clen = js_len(&content) as f64;
        if matches!(typ, "user" | "human" | "system" | "tool_result" | "tool") {
            context_chars += clen;
            continue;
        }
        if matches!(typ, "assistant" | "ai" | "model" | "reasoning") {
            turn += 1;
            let input_tokens = estimate_tokens_from_chars(context_chars);
            let output_tokens = estimate_tokens_from_text(&content);
            context_chars += clen;
            if input_tokens + output_tokens <= 0.0 {
                continue;
            }
            let row_ts = ne_str_of(row, "timestamp")
                .or_else(|| ne_str_of(row, "created_at"))
                .or_else(|| ne_str_of(row, "ts"))
                .map(str::to_string)
                .unwrap_or_else(|| ts.clone());
            let turn_s = turn.to_string();
            let in_s = js_num_to_string(input_tokens);
            let out_s = js_num_to_string(output_tokens);
            events.push(make_event(EventSpec {
                id: stable_id(&["grok", session_id.as_str(), "turn", turn_s.as_str(), in_s.as_str(), out_s.as_str()]),
                model: &model,
                timestamp: row_ts,
                input: input_tokens,
                output: output_tokens,
                cache_read: 0.0,
                cache_write: 0.0,
                workspace: workspace.clone(),
                source_path: chat_path.clone(),
                estimated: Some(true),
                request_count: None,
                cache_reported: false,
                router_cost: None,
            }));
            emitted += 1;
        }
    }

    if emitted == 0 {
        let mut user_chars: f64 = 0.0;
        let mut assistant_chars: f64 = 0.0;
        for row in chat_rows.iter() {
            if !is_objectish(row) {
                continue;
            }
            let typ = row_type(row);
            let content = extract_text(row.get("content"));
            if content.is_empty() {
                continue;
            }
            let clen = js_len(&content) as f64;
            if matches!(typ, "user" | "human" | "system") {
                user_chars += clen;
            }
            if matches!(typ, "assistant" | "ai" | "model" | "reasoning") {
                assistant_chars += clen;
            }
        }
        if user_chars + assistant_chars == 0.0 {
            return Ok(events);
        }
        let input_tokens = estimate_tokens_from_chars(user_chars);
        let output_tokens = estimate_tokens_from_chars(assistant_chars);
        let in_s = js_num_to_string(input_tokens);
        let out_s = js_num_to_string(output_tokens);
        events.push(make_event(EventSpec {
            id: stable_id(&["grok", session_id.as_str(), "est", in_s.as_str(), out_s.as_str()]),
            model: &model,
            timestamp: ts.clone(),
            input: input_tokens,
            output: output_tokens,
            cache_read: 0.0,
            cache_write: 0.0,
            workspace: workspace.clone(),
            source_path: chat_path.clone(),
            estimated: Some(true),
            request_count: None,
            cache_reported: false,
            router_cost: None,
        }));
    }
    Ok(events)
}

/// `String(r.type ?? r.role ?? "")` reduced to what can match a known type name.
fn row_type(row: &Value) -> &str {
    match co(row, &["type", "role"]) {
        Some(Value::String(s)) => s.as_str(),
        _ => "",
    }
}

// ---------------------------------------------------------------------------
// usage.json snapshot
// ---------------------------------------------------------------------------

async fn read_grok_usage_snapshot(usage_path: &str, ctx: &Ctx) -> Vec<UsageEvent> {
    // Cached by (size, mtime) so an unchanged usage.json is not re-read per scan.
    let Some(rows) = read_json_cached(usage_path).await else {
        return Vec::new();
    };
    let Some(root) = rows.first() else {
        return Vec::new();
    };
    if !is_objectish(root) {
        return Vec::new();
    }
    let session: &Value = co(root, &["session", "usage"]).unwrap_or(root);
    if !is_objectish(session) {
        return Vec::new();
    }
    let Some(b) = buckets_from_usage(session) else {
        return Vec::new();
    };

    let empty: Vec<Value> = Vec::new();
    let turns: &Vec<Value> = match root.get("turns") {
        Some(Value::Array(a)) => a,
        _ => &empty,
    };
    // Newest object turn, scanning backwards.
    let last_turn: Option<&Value> = turns.iter().rev().find(|t| is_objectish(t));
    let timestamp: String = ne_str_of(root, "updatedAt")
        .or_else(|| last_turn.and_then(|t| ne_str_of(t, "endedAt")))
        .map(str::to_string)
        .unwrap_or_else(|| ctx.fallback_ts.clone());
    let model: String = match ne_str_of(session, "primaryModelId") {
        Some(m) => m.to_string(),
        None => model_from_usage(session, &ctx.model),
    };

    // This snapshot is a SESSION ROLLUP: split the aggregate request count across the
    // turn span when available; otherwise report one request for the row.
    let base_id = stable_id(&["grok", ctx.session_id.as_str(), "usage"]);
    let turn_span = turn_end_span_ms(turns);
    if let (Some(sp), Some(rc)) = (turn_span, b.request_count) {
        if rc > 1.0 {
            let parts = split_buckets(&b, rc, sp.0, sp.1);
            return parts
                .iter()
                .enumerate()
                .map(|(p, part)| {
                    let id = if parts.len() > 1 { format!("{}-s{}", base_id, p) } else { base_id.clone() };
                    split_to_event(&b, part, id, &model, ctx.workspace.clone(), usage_path.to_string(), Some(false))
                })
                .collect();
        }
    }
    vec![make_event(EventSpec {
        id: base_id,
        model: &model,
        timestamp,
        input: b.input,
        output: b.output,
        cache_read: b.cache_read,
        cache_write: b.cache_write,
        workspace: ctx.workspace.clone(),
        source_path: usage_path.to_string(),
        estimated: Some(false),
        request_count: Some(1.0),
        cache_reported: b.cache_reported,
        router_cost: b.router_cost,
    })]
}

// ---------------------------------------------------------------------------
// client-state/session-meta.json (pruned sessions)
// ---------------------------------------------------------------------------

async fn parse_grok_session_meta(meta_path: &str, on_disk_session_ids: &HashSet<String>) -> Vec<UsageEvent> {
    let Some(text) = read_text(meta_path).await else {
        return Vec::new();
    };
    if text.is_empty() {
        return Vec::new();
    }
    let Ok(root) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let Some(entries) = entries_of(&root) else {
        return Vec::new();
    };
    let mut events: Vec<UsageEvent> = Vec::new();
    for (session_id, entry) in entries {
        if on_disk_session_ids.contains(&session_id) {
            continue;
        }
        let Some(usage) = get(entry, "usage") else {
            continue;
        };
        if !is_objectish(usage) {
            continue;
        }
        let Some(b) = buckets_from_usage(usage) else {
            continue;
        };
        let model = model_from_usage(usage, "grok-4.5");
        let timestamp = match timestamp_from_session_id(&session_id).or_else(|| mtime_iso(meta_path)) {
            Some(t) => t,
            None => continue,
        };
        let source_path = format!("{}#{}", meta_path, session_id);
        let usage_id = stable_id(&["grok", session_id.as_str(), "usage"]);
        // No honest span unless the entry exposes one; otherwise report a single request.
        let span = match b.request_count {
            Some(rc) if rc > 1.0 => {
                resolve_span_ms(entry.get("created_at"), co(entry, &["updated_at", "last_active_at"]))
                    .map(|sp| (sp, rc))
            }
            _ => None,
        };
        if let Some((sp, rc)) = span {
            let parts = split_buckets(&b, rc, sp.0, sp.1);
            for (p, part) in parts.iter().enumerate() {
                events.push(split_to_event(
                    &b,
                    part,
                    format!("{}-s{}", usage_id, p),
                    &model,
                    None,
                    source_path.clone(),
                    Some(false),
                ));
            }
            continue;
        }
        events.push(make_event(EventSpec {
            id: usage_id,
            model: &model,
            timestamp,
            input: b.input,
            output: b.output,
            cache_read: b.cache_read,
            cache_write: b.cache_write,
            workspace: None,
            source_path,
            estimated: Some(false),
            request_count: Some(1.0),
            cache_reported: b.cache_reported,
            router_cost: b.router_cost,
        }));
    }
    events
}

// ---------------------------------------------------------------------------
// updates.jsonl
// ---------------------------------------------------------------------------

/// Peak stream totals + cache reads + output-ish chars per prompt_id.
#[derive(Debug, Clone, Copy, Default)]
struct PromptPeak {
    total: f64,
    cached: f64,
    out_chars: f64,
}

const WS: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
const CACHE_KEYS: &str =
    "cachedReadTokens|cached_input_tokens|cachedInputTokens|cache_read_input_tokens|cacheReadInputTokens|cached_tokens|cache_read_tokens";

static RE_PROMPT_ID: Lazy<Regex> = Lazy::new(|| Regex::new(&format!(r#""promptId"{WS}*:{WS}*"([^"]+)""#)).unwrap());
static RE_PROMPT_ID_SNAKE: Lazy<Regex> =
    Lazy::new(|| Regex::new(&format!(r#""prompt_id"{WS}*:{WS}*"([^"]+)""#)).unwrap());
static RE_TOTAL: Lazy<Regex> = Lazy::new(|| Regex::new(&format!(r#""totalTokens"{WS}*:{WS}*([0-9]+)"#)).unwrap());
static RE_CACHED: Lazy<Regex> =
    Lazy::new(|| Regex::new(&format!(r#""(?:{CACHE_KEYS})"{WS}*:{WS}*([0-9]+)"#)).unwrap());
static RE_TOOL_CALL: Lazy<Regex> =
    Lazy::new(|| Regex::new(&format!(r#""sessionUpdate"{WS}*:{WS}*"tool_call""#)).unwrap());
static RE_TEXT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(r#""text"{WS}*:{WS}*"((?:\\[^\n\r\x{{2028}}\x{{2029}}]|[^"\\])*)""#)).unwrap()
});

fn has_cache_key(line: &str) -> bool {
    line.contains("cachedReadTokens")
        || line.contains("cached_input_tokens")
        || line.contains("cachedInputTokens")
        || line.contains("cache_read_input_tokens")
        || line.contains("cacheReadInputTokens")
        || line.contains("cached_tokens")
        || line.contains("cache_read_tokens")
}

/// `/"sessionUpdate"\s*:\s*"tool_call"(?![_a-zA-Z])/.test(line)`
fn is_exact_tool_call(line: &str) -> bool {
    RE_TOOL_CALL.find_iter(line).any(|m| match line[m.end()..].chars().next() {
        Some(c) => !(c == '_' || c.is_ascii_alphabetic()),
        None => true,
    })
}

fn parse_digits(s: &str) -> Option<f64> {
    s.parse::<f64>().ok().filter(|v| v.is_finite())
}

fn note_prompt_peak(line: &str, prompt_peak: &mut IndexMap<String, PromptPeak>, done: &HashSet<String>) {
    let pm = RE_PROMPT_ID.captures(line).or_else(|| RE_PROMPT_ID_SNAKE.captures(line));
    let Some(prompt_id) = pm.and_then(|c| c.get(1)).map(|m| m.as_str().to_string()) else {
        return;
    };
    // Prompts already emitted/completed must never be re-added (stream meta after turn_completed).
    if done.contains(&prompt_id) {
        return;
    }

    let mut prev = prompt_peak.get(&prompt_id).copied().unwrap_or_default();
    let mut changed = false;

    if line.contains("totalTokens") || has_cache_key(line) {
        if let Some(tt) = RE_TOTAL.captures(line).and_then(|c| parse_digits(&c[1])) {
            if tt > prev.total {
                prev.total = tt;
                changed = true;
            }
        }
        // Stream meta sometimes reports cache hits before turn_completed.usage
        if let Some(cr) = RE_CACHED.captures(line).and_then(|c| parse_digits(&c[1])) {
            if cr > prev.cached {
                prev.cached = cr;
                changed = true;
            }
        }
    }

    // In-progress turns: estimate output from streamed model text (no usage yet).
    // Count agent thought/message + tool_call args (model-generated). Never tool results.
    let is_thought_or_msg = line.contains("agent_thought_chunk")
        || line.contains("agent_message_chunk")
        || line.contains("AgentThoughtChunk")
        || line.contains("AgentMessageChunk");
    let is_tool_call = is_exact_tool_call(line);
    if is_thought_or_msg || is_tool_call {
        let mut add: f64 = 0.0;
        if is_thought_or_msg {
            for m in RE_TEXT.captures_iter(line) {
                add += m.get(1).map_or(0, |g| js_len(g.as_str())) as f64;
            }
        }
        if is_tool_call {
            if let Ok(row) = serde_json::from_str::<Value>(line) {
                let u = row.get("params").and_then(|p| p.get("update"));
                let raw_input = u.and_then(|u| get(u, "rawInput"));
                match raw_input {
                    Some(Value::String(s)) => add += js_len(s) as f64,
                    Some(v) => {
                        let mut s = String::new();
                        js_stringify(v, &mut s);
                        add += js_len(&s) as f64;
                    }
                    None => {
                        if let Some(Value::String(t)) = u.and_then(|u| u.get("title")) {
                            add += js_len(t) as f64;
                        }
                    }
                }
            }
        }
        if add > 0.0 {
            prev.out_chars += add;
            changed = true;
        }
    }

    if changed {
        prompt_peak.insert(prompt_id, prev);
    }
}

/// Stable per-prompt id so residual -> turn_completed.usage replaces in place (no ghost rows).
fn turn_event_id(session_id: &str, prompt_id: &str) -> String {
    stable_id(&["grok", session_id, "tc", prompt_id])
}

fn peak_to_output_tokens(peak: &PromptPeak) -> f64 {
    if peak.out_chars <= 0.0 {
        return 0.0;
    }
    estimate_tokens_from_chars(peak.out_chars)
}

fn peak_is_empty(peak: &PromptPeak) -> bool {
    peak.total <= 0.0 && peak.cached <= 0.0 && peak.out_chars <= 0.0
}

/// `(cacheRead, uncached)` from a peak: `min(cached, total || cached)`, `max(0, (total || cacheRead) - cacheRead)`.
fn peak_split(total: f64, cached: f64) -> (f64, f64) {
    let cache_read = cached.min(if total != 0.0 { total } else { cached });
    let uncached = ((if total != 0.0 { total } else { cache_read }) - cache_read).max(0.0);
    (cache_read, uncached)
}

fn estimated_event(
    id: String,
    ctx: &Ctx,
    ts: String,
    uncached: f64,
    out: f64,
    cache_read: f64,
    updates_path: &str,
) -> UsageEvent {
    make_event(EventSpec {
        id,
        model: &ctx.model,
        timestamp: ts,
        input: uncached,
        output: out,
        cache_read,
        cache_write: 0.0,
        workspace: ctx.workspace.clone(),
        source_path: updates_path.to_string(),
        estimated: Some(true),
        request_count: None,
        cache_reported: cache_read > 0.0,
        router_cost: None,
    })
}

/// Stream updates.jsonl and emit one event per turn_completed with usage.
async fn parse_updates_usage(updates_path: &str, ctx: &Ctx) -> Vec<UsageEvent> {
    let Some(text) = read_text(updates_path).await else {
        return Vec::new();
    };
    let mut events: Vec<UsageEvent> = Vec::new();
    let mut idx: u64 = 0;
    let mut max_stream_tokens: f64 = 0.0;
    let mut max_stream_cached: f64 = 0.0;
    let mut max_stream_ts = ctx.fallback_ts.clone();
    let mut prompt_peak: IndexMap<String, PromptPeak> = IndexMap::new();
    // Prompts already billed with real turn_completed.usage - never residual again.
    let mut completed_with_usage: HashSet<String> = HashSet::new();
    // Prompts already emitted (usage or usage-less tc) - residual must not re-emit same id.
    let mut emitted_prompt_ids: HashSet<String> = HashSet::new();

    for line in split_lines(&text) {
        // emitted_prompt_ids is a superset of completed_with_usage; completed prompts are never re-added.
        note_prompt_peak(line, &mut prompt_peak, &emitted_prompt_ids);

        // Session-level stream floor (in-progress turns)
        if !line.contains("\"sessionUpdate\":\"turn_completed\"") && !line.contains("\"sessionUpdate\": \"turn_completed\"") {
            if line.contains("totalTokens") {
                if let Some(tt) = RE_TOTAL.captures(line).and_then(|c| parse_digits(&c[1])) {
                    if tt > max_stream_tokens {
                        max_stream_tokens = tt;
                    }
                }
            }
            if has_cache_key(line) {
                if let Some(cr) = RE_CACHED.captures(line).and_then(|c| parse_digits(&c[1])) {
                    if cr > max_stream_cached {
                        max_stream_cached = cr;
                    }
                }
            }
            continue;
        }

        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(update) = row.get("params").and_then(|p| p.get("update")) else {
            continue;
        };
        if update.get("sessionUpdate").and_then(|v| v.as_str()) != Some("turn_completed") {
            continue;
        }

        idx += 1;

        let prompt_id: String = ne_str_of(update, "prompt_id")
            .or_else(|| ne_str_of(update, "promptId"))
            .map(str::to_string)
            .unwrap_or_else(|| idx.to_string());

        let ts = timestamp_from_update(&row, &ctx.fallback_ts);
        max_stream_ts = ts.clone();

        let usage = get(update, "usage");
        let buckets = match usage {
            Some(u) if is_objectish(u) => buckets_from_usage(u),
            _ => None,
        };

        if let (Some(b), Some(usage)) = (buckets, usage) {
            let mut model = ctx.model.clone();
            if let Some(mu) = get(usage, "modelUsage") {
                if let Some(entries) = entries_of(mu) {
                    if entries.len() == 1 && !entries[0].0.is_empty() {
                        model = entries[0].0.clone();
                    } else if entries.len() > 1 {
                        let mut best = entries[0].0.clone();
                        let mut best_tot = -1.0;
                        for (k, mu_row) in &entries {
                            let t = numco(mu_row, &["totalTokens", "inputTokens"]);
                            if t > best_tot {
                                best_tot = t;
                                best = k.clone();
                            }
                        }
                        if !best.is_empty() {
                            model = best;
                        }
                    }
                }
            }
            events.push(make_event(EventSpec {
                id: turn_event_id(&ctx.session_id, &prompt_id),
                model: &model,
                timestamp: ts,
                input: b.input,
                output: b.output,
                cache_read: b.cache_read,
                cache_write: b.cache_write,
                workspace: ctx.workspace.clone(),
                source_path: updates_path.to_string(),
                estimated: Some(false),
                request_count: b.request_count,
                cache_reported: b.cache_reported,
                router_cost: b.router_cost,
            }));
            prompt_peak.shift_remove(&prompt_id);
            completed_with_usage.insert(prompt_id.clone());
            emitted_prompt_ids.insert(prompt_id);
            continue;
        }

        // Newer Grok CLI: turn_completed without usage - bill peak stream tokens + cache
        let peak = prompt_peak.get(&prompt_id).copied().unwrap_or_default();
        if peak_is_empty(&peak) {
            continue;
        }
        let (cache_read, uncached) = peak_split(peak.total, peak.cached);
        let out_est = peak_to_output_tokens(&peak);
        events.push(estimated_event(
            // Same id family as real usage so a later usage row replaces this estimate.
            turn_event_id(&ctx.session_id, &prompt_id),
            ctx,
            ts,
            uncached,
            out_est,
            cache_read,
            updates_path,
        ));
        prompt_peak.shift_remove(&prompt_id);
        emitted_prompt_ids.insert(prompt_id);
    }

    // Residual in-progress prompts only - never re-bill completed promptIds.
    if !prompt_peak.is_empty() {
        for (prompt_id, peak) in &prompt_peak {
            if completed_with_usage.contains(prompt_id) || emitted_prompt_ids.contains(prompt_id) {
                continue;
            }
            if peak_is_empty(peak) {
                continue;
            }
            let (cache_read, uncached) = peak_split(peak.total, peak.cached);
            let out_est = peak_to_output_tokens(peak);
            events.push(estimated_event(
                turn_event_id(&ctx.session_id, prompt_id),
                ctx,
                max_stream_ts.clone(),
                uncached,
                out_est,
                cache_read,
                updates_path,
            ));
        }
    } else if events.is_empty() && (max_stream_tokens > 0.0 || max_stream_cached > 0.0) {
        // No prompt ids in stream meta - session-level floor only (stable id, no peak)
        let (cache_read, uncached) = peak_split(max_stream_tokens, max_stream_cached);
        events.push(estimated_event(
            stable_id(&["grok", ctx.session_id.as_str(), "stream-floor"]),
            ctx,
            max_stream_ts.clone(),
            uncached,
            0.0,
            cache_read,
            updates_path,
        ));
    }
    events
}

// ---------------------------------------------------------------------------
// Persisted usage.json turns[] (best-of-both merge)
// ---------------------------------------------------------------------------

struct PersistedGrokUsage {
    events: Vec<UsageEvent>,
    updated_at: Option<String>,
    token_weight: f64,
    router_cost: f64,
}

fn persisted_usage_is_richer(persisted: &PersistedGrokUsage, updates: &[&UsageEvent]) -> bool {
    let mut update_tokens = 0.0;
    let mut update_cost = 0.0;
    for e in updates {
        update_tokens += if e.total_tokens.is_nan() { 0.0 } else { e.total_tokens };
        update_cost += e.estimated_cost.filter(|c| !c.is_nan()).unwrap_or(0.0);
    }
    if persisted.token_weight > update_tokens * 1.001 {
        return true;
    }
    if update_tokens > persisted.token_weight * 1.001 {
        return false;
    }
    persisted.router_cost > update_cost * 1.001
}

async fn parse_persisted_usage(file: &str, ctx: &Ctx) -> PersistedGrokUsage {
    let empty = PersistedGrokUsage { events: Vec::new(), updated_at: None, token_weight: 0.0, router_cost: 0.0 };
    let Some(rows) = read_json_cached(file).await else {
        return empty;
    };
    let Some(raw) = rows.first() else {
        return empty;
    };
    if !matches!(raw, Value::Object(_)) {
        return empty;
    }

    let updated_at = valid_timestamp(raw.get("updatedAt")).or_else(|| valid_timestamp(raw.get("updated_at")));
    let empty_turns: Vec<Value> = Vec::new();
    let turns: &Vec<Value> = match raw.get("turns") {
        Some(Value::Array(a)) => a,
        _ => &empty_turns,
    };
    let mut events: Vec<UsageEvent> = Vec::new();
    for (i, turn) in turns.iter().enumerate() {
        if !matches!(turn, Value::Object(_)) {
            continue;
        }
        let Some(b) = buckets_from_usage(turn) else {
            continue;
        };
        let tn = co(turn, &["turnNumber", "turn_number"]);
        let turn_number = if matches!(turn.get("turnNumber"), Some(Value::Number(_)))
            || matches!(turn.get("turn_number"), Some(Value::Number(_)))
        {
            tn.map(js_str).unwrap_or_else(|| (i + 1).to_string())
        } else {
            (i + 1).to_string()
        };
        let timestamp = valid_timestamp(turn.get("endedAt"))
            .or_else(|| valid_timestamp(turn.get("ended_at")))
            .or_else(|| valid_timestamp(turn.get("updatedAt")))
            .or_else(|| updated_at.clone())
            .unwrap_or_else(|| ctx.fallback_ts.clone());
        let model = model_from_usage(turn, &ctx.model);
        events.push(make_event(EventSpec {
            id: stable_id(&["grok", ctx.session_id.as_str(), "usage-turn", turn_number.as_str()]),
            model: &model,
            timestamp,
            input: b.input,
            output: b.output,
            cache_read: b.cache_read,
            cache_write: b.cache_write,
            workspace: ctx.workspace.clone(),
            source_path: file.to_string(),
            estimated: Some(false),
            request_count: b.request_count,
            cache_reported: b.cache_reported,
            router_cost: b.router_cost,
        }));
    }

    // If the export has no per-turn list, retain the session rollup as one event.
    // Never emit both session and turns: session is cumulative.
    if events.is_empty() {
        if let Some(session @ Value::Object(_)) = raw.get("session") {
            if let Some(b) = buckets_from_usage(session) {
                let model = model_from_usage(session, &ctx.model);
                events.push(make_event(EventSpec {
                    id: stable_id(&["grok", ctx.session_id.as_str(), "usage-session"]),
                    model: &model,
                    timestamp: updated_at.clone().unwrap_or_else(|| ctx.fallback_ts.clone()),
                    input: b.input,
                    output: b.output,
                    cache_read: b.cache_read,
                    cache_write: b.cache_write,
                    workspace: ctx.workspace.clone(),
                    source_path: file.to_string(),
                    estimated: Some(false),
                    request_count: b.request_count,
                    cache_reported: b.cache_reported,
                    router_cost: b.router_cost,
                }));
            }
        }
    }

    let mut token_weight = 0.0;
    let mut router_cost = 0.0;
    for e in &events {
        token_weight += if e.total_tokens.is_nan() { 0.0 } else { e.total_tokens };
        // applyPricing stores a positive router-reported cost in estimatedCost.
        router_cost += e.estimated_cost.filter(|c| !c.is_nan()).unwrap_or(0.0);
    }
    PersistedGrokUsage { events, updated_at, token_weight, router_cost }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pricing::price_tokens;
    use serde_json::json;
    use std::path::Path;

    fn write(p: &Path, content: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    fn summary(dir: &Path, id: &str, model: &str, updated: &str) {
        write(
            &dir.join("summary.json"),
            &json!({"info": {"id": id, "cwd": "C:\\Dev\\Demo"}, "current_model_id": model, "updated_at": updated})
                .to_string(),
        );
    }

    fn update_line(timestamp: Value, prompt_id: &str, usage: Value) -> String {
        json!({
            "timestamp": timestamp,
            "method": "session/update",
            "params": {"sessionId": "s", "update": {"sessionUpdate": "turn_completed", "prompt_id": prompt_id, "usage": usage}},
        })
        .to_string()
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "grok");
        assert_eq!(a.label, "Grok (xAI)");
    }

    #[tokio::test]
    async fn prefers_turn_completed_usage_and_splits_cache() {
        let root = tempfile::tempdir().unwrap();
        let sd = root.path().join("sessions").join("proj").join("sess-1");
        summary(&sd, "sess-1", "grok-4.5", "2026-07-15T10:00:00.000Z");
        let usage_line = update_line(
            json!(1784110894),
            "prompt-abc",
            json!({
                "inputTokens": 100000, "outputTokens": 2000, "totalTokens": 102000,
                "cachedReadTokens": 80000, "cacheCreationTokens": 1200, "reasoningTokens": 500,
                "modelCalls": 3, "costUsdTicks": 2991092000u64,
                "modelUsage": {"grok-4.5": {"inputTokens": 100000, "outputTokens": 2000, "totalTokens": 102000,
                    "cachedReadTokens": 80000, "cacheCreationTokens": 1200}},
            }),
        );
        let noise = json!({"timestamp": 1784110890, "method": "session/update", "params": {"sessionId": "sess-1",
            "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hello"},
            "_meta": {"totalTokens": 999999}}}})
        .to_string();
        write(&sd.join("updates.jsonl"), &format!("{noise}\n{usage_line}\n"));
        write(
            &sd.join("chat_history.jsonl"),
            &[
                json!({"type": "user", "content": "x".repeat(50000)}).to_string(),
                json!({"type": "assistant", "content": "y".repeat(50000)}).to_string(),
            ]
            .join("\n"),
        );

        let events = parse_grok(vec![s(root.path())]).await.unwrap();
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.agent, AgentId::Grok);
        assert_eq!(e.model.as_deref(), Some("grok-4.5"));
        assert_eq!(e.estimated, Some(false));
        assert_eq!(e.input_tokens, 20000.0);
        assert_eq!(e.cache_read_tokens, 80000.0);
        assert_eq!(e.cache_write_tokens, 1200.0);
        assert_eq!(e.output_tokens, 2000.0);
        assert_eq!(e.total_tokens, 103200.0);
        assert_eq!(e.pricing_status, crate::types::PricingStatus::Priced);
        assert!((e.estimated_cost.unwrap() - 0.2991092).abs() < 1e-9);
        assert_eq!(e.workspace.as_deref(), Some("C:\\Dev\\Demo"));
        assert_eq!(e.timestamp, to_iso_string(1784110894000.0).unwrap());
        assert_eq!(e.request_count, Some(3.0));
        assert_eq!(e.cache_reported, Some(true));

        let table = price_tokens(Some("grok-4.5"), 20000.0, 2000.0, 80000.0, 1200.0, "USD");
        let wrong = price_tokens(Some("grok-4.5"), 100000.0, 2000.0, 0.0, 0.0, "USD");
        assert!(table.estimated_cost < wrong.estimated_cost);
    }

    #[tokio::test]
    async fn reads_snake_case_cache_fields() {
        let root = tempfile::tempdir().unwrap();
        let sd = root.path().join("sessions").join("proj").join("sess-snake");
        summary(&sd, "sess-snake", "grok-4.6", "2026-08-05T10:00:00.000Z");
        write(
            &sd.join("updates.jsonl"),
            &(update_line(
                json!(1785900000),
                "prompt-snake",
                json!({"input_tokens": 1000, "cached_input_tokens": 700, "output_tokens": 90,
                    "cache_write_input_tokens": 12, "reasoning_output_tokens": 20}),
            ) + "\n"),
        );
        let events = parse_grok(vec![s(root.path())]).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].model.as_deref(), Some("grok-4.6"));
        assert_eq!(events[0].input_tokens, 300.0);
        assert_eq!(events[0].cache_read_tokens, 700.0);
        assert_eq!(events[0].cache_write_tokens, 12.0);
        assert_eq!(events[0].output_tokens, 90.0);
    }

    #[tokio::test]
    async fn usage_json_snapshot_without_double_counting_completed_updates() {
        let root = tempfile::tempdir().unwrap();
        let sd = root.path().join("sessions").join("proj").join("sess-snapshot");
        summary(&sd, "sess-snapshot", "grok-4.5-build", "2026-08-05T10:00:02.000Z");
        let session = json!({"inputTokens": 100000, "outputTokens": 2000, "totalTokens": 102000,
            "cachedReadTokens": 80000, "cacheCreationTokens": 0, "modelCalls": 3, "costUsdTicks": 299109200,
            "primaryModelId": "grok-4.5-build"});
        let usage = json!({"updatedAt": "2026-08-05T10:00:01.000Z", "session": session});
        write(&sd.join("usage.json"), &usage.to_string());
        let completed = update_line(json!("2026-08-05T10:00:00.000Z"), "completed", session.clone());
        let in_progress = json!({"timestamp": "2026-08-05T10:00:02.000Z", "method": "session/update",
            "params": {"sessionId": "sess-snapshot",
                "update": {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "still working"}},
                "_meta": {"totalTokens": 40000, "promptId": "live"}}})
        .to_string();
        write(&sd.join("updates.jsonl"), &format!("{completed}\n{in_progress}\n"));

        let events = parse_grok(vec![s(root.path())]).await.unwrap();
        assert_eq!(events.len(), 2);
        let snapshot = events.iter().find(|e| e.estimated != Some(true)).unwrap();
        let residual = events.iter().find(|e| e.estimated == Some(true)).unwrap();
        assert_eq!(snapshot.total_tokens, 102000.0);
        assert_eq!(snapshot.input_tokens, 20000.0);
        assert_eq!(snapshot.cache_read_tokens, 80000.0);
        assert_eq!(snapshot.request_count, Some(1.0));
        assert_eq!(snapshot.source_path, s(&sd.join("usage.json")));
        assert_eq!(residual.input_tokens, 40000.0);
    }

    #[tokio::test]
    async fn recovers_pruned_sessions_from_session_meta() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join(".grok");
        let session_id = "019f93c8-b594-7391-9505-ba4981098f0c";
        write(
            &root.join("client-state").join("session-meta.json"),
            &json!({session_id: {"usage": {"inputTokens": 120000, "outputTokens": 3000, "totalTokens": 123000,
                "cachedReadTokens": 100000, "modelCalls": 5}, "customName": "old session"}})
            .to_string(),
        );
        let events = parse_grok(vec![s(&root)]).await.unwrap();
        assert_eq!(events.len(), 1);
        assert!(!events[0].id.is_empty());
        assert_eq!(events[0].input_tokens, 20000.0);
        assert_eq!(events[0].cache_read_tokens, 100000.0);
        assert_eq!(events[0].output_tokens, 3000.0);
        assert_eq!(events[0].request_count, Some(1.0));
        assert_eq!(events[0].estimated, Some(false));
        assert_eq!(events[0].timestamp, timestamp_from_session_id(session_id).unwrap());
        assert!(events[0].source_path.ends_with(&format!("#{session_id}")));
        assert_eq!(events[0].workspace, None);
    }

    #[tokio::test]
    async fn bills_turn_completed_without_usage_via_prompt_peak() {
        let root = tempfile::tempdir().unwrap();
        let sd = root.path().join("sessions").join("proj").join("sess-nou");
        summary(&sd, "sess-nou", "grok-4.5", "2026-07-16T10:00:00.000Z");
        let pid = "prompt-no-usage-1";
        let chunk = json!({"timestamp": 1784180000, "method": "_x.ai/session/update", "params": {"sessionId": "sess-nou",
            "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hi"}},
            "_meta": {"totalTokens": 50000, "cachedReadTokens": 40000, "promptId": pid}}})
        .to_string();
        let done = json!({"timestamp": 1784180001, "method": "_x.ai/session/update", "params": {"sessionId": "sess-nou",
            "update": {"sessionUpdate": "turn_completed", "prompt_id": pid, "stop_reason": "end_turn"}}})
        .to_string();
        write(&sd.join("updates.jsonl"), &format!("{chunk}\n{done}\n"));
        let events = parse_grok(vec![s(root.path())]).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].estimated, Some(true));
        assert_eq!(events[0].input_tokens, 10000.0);
        assert_eq!(events[0].cache_read_tokens, 40000.0);
        assert!(events[0].output_tokens > 0.0);
        assert!(events[0].total_tokens >= 50000.0);
        assert_eq!(events[0].cache_reported, Some(true));
        // 1784180001 s since epoch.
        assert_eq!(events[0].timestamp, to_iso_string(1784180001000.0).unwrap());
    }

    #[tokio::test]
    async fn residual_uses_stable_tc_id_and_estimates_output_from_thought_chunks() {
        let root = tempfile::tempdir().unwrap();
        let sd = root.path().join("sessions").join("proj").join("sess-res");
        summary(&sd, "sess-res", "grok-4.5", "2026-08-05T10:00:00.000Z");
        let pid = "prompt-in-progress";
        let thought = json!({"timestamp": 1785900000, "method": "session/update", "params": {"sessionId": "sess-res",
            "update": {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "x".repeat(400)}},
            "_meta": {"totalTokens": 23100, "promptId": pid}}})
        .to_string();
        write(&sd.join("updates.jsonl"), &format!("{thought}\n"));
        let events = parse_grok(vec![s(root.path())]).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].estimated, Some(true));
        assert_eq!(events[0].input_tokens, 23100.0);
        assert!(events[0].output_tokens > 50.0);

        let with_usage = json!({"timestamp": 1785900001, "method": "session/update", "params": {"sessionId": "sess-res",
            "update": {"sessionUpdate": "turn_completed", "prompt_id": pid, "stop_reason": "end_turn",
                "usage": {"inputTokens": 25000, "outputTokens": 900, "totalTokens": 25900, "cachedReadTokens": 0,
                    "modelUsage": {"grok-4.5-build": {"inputTokens": 25000, "outputTokens": 900}}}}}})
        .to_string();
        write(&sd.join("updates.jsonl"), &format!("{thought}\n{with_usage}\n"));
        let after = parse_grok(vec![s(root.path())]).await.unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].estimated, Some(false));
        assert_eq!(after[0].output_tokens, 900.0);
        assert_eq!(after[0].model.as_deref(), Some("grok-4.5-build"));
        assert_eq!(after[0].id, events[0].id);
    }

    #[tokio::test]
    async fn no_residual_after_real_turn_completed_usage() {
        let root = tempfile::tempdir().unwrap();
        let sd = root.path().join("sessions").join("proj").join("sess-nore");
        summary(&sd, "sess-nore", "grok-4.5", "2026-08-05T12:00:00.000Z");
        let pid = "prompt-done-then-meta";
        let thought = json!({"timestamp": 1785902000, "method": "session/update", "params": {"sessionId": "sess-nore",
            "update": {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": format!("thinking {}", "x".repeat(100))}},
            "_meta": {"totalTokens": 40000, "promptId": pid}}})
        .to_string();
        let done = json!({"timestamp": 1785902001, "method": "session/update", "params": {"sessionId": "sess-nore",
            "update": {"sessionUpdate": "turn_completed", "prompt_id": pid, "stop_reason": "end_turn",
                "usage": {"inputTokens": 50000, "outputTokens": 1200, "totalTokens": 51200, "cachedReadTokens": 30000,
                    "modelUsage": {"grok-4.5-build": {"inputTokens": 50000, "outputTokens": 1200}}}}}})
        .to_string();
        let after_meta = json!({"timestamp": 1785902002, "method": "session/update", "params": {"sessionId": "sess-nore",
            "update": {"sessionUpdate": "tool_call_update", "toolCallId": "call-late", "status": "completed",
                "content": [{"type": "content", "content": {"type": "text", "text": "late"}}]},
            "_meta": {"totalTokens": 90000, "promptId": pid}}})
        .to_string();
        write(&sd.join("updates.jsonl"), &format!("{thought}\n{done}\n{after_meta}\n"));
        let events = parse_grok(vec![s(root.path())]).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].estimated, Some(false));
        assert_eq!(events[0].output_tokens, 1200.0);
        assert_eq!(events[0].input_tokens, 20000.0);
    }

    #[tokio::test]
    async fn residual_output_from_tool_call_raw_input() {
        let root = tempfile::tempdir().unwrap();
        let sd = root.path().join("sessions").join("proj").join("sess-tool");
        summary(&sd, "sess-tool", "grok-4.5", "2026-08-05T11:00:00.000Z");
        let pid = "prompt-tools";
        let tool = json!({"timestamp": 1785901000, "method": "session/update", "params": {"sessionId": "sess-tool",
            "update": {"sessionUpdate": "tool_call", "toolCallId": "call-1", "title": "run_terminal_command",
                "rawInput": {"command": format!("echo {}", "y".repeat(200))}},
            "_meta": {"totalTokens": 12000, "promptId": pid}}})
        .to_string();
        let result = json!({"timestamp": 1785901001, "method": "session/update", "params": {"sessionId": "sess-tool",
            "update": {"sessionUpdate": "tool_call_update", "toolCallId": "call-1", "status": "completed",
                "content": [{"type": "content", "content": {"type": "text", "text": "z".repeat(5000)}}]},
            "_meta": {"totalTokens": 18000, "promptId": pid}}})
        .to_string();
        write(&sd.join("updates.jsonl"), &format!("{tool}\n{result}\n"));
        let events = parse_grok(vec![s(root.path())]).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].estimated, Some(true));
        assert_eq!(events[0].input_tokens, 18000.0);
        assert!(events[0].output_tokens > 20.0, "tool_call rawInput counts as model output");
        assert!(events[0].output_tokens < 500.0, "tool_call_update text must not count as output");
    }

    #[tokio::test]
    async fn maps_cache_creation_and_fills_output_from_reasoning_only_when_needed() {
        let root = tempfile::tempdir().unwrap();
        let sd = root.path().join("sessions").join("proj").join("sess-cc");
        summary(&sd, "sess-cc", "grok-4.5-build", "2026-08-03T01:00:00.000Z");
        write(
            &sd.join("updates.jsonl"),
            &(update_line(
                json!(1785700000),
                "p-reason",
                json!({"inputTokens": 10000, "outputTokens": 0, "totalTokens": 10000, "cachedReadTokens": 0,
                    "cacheCreationTokens": 500, "reasoningTokens": 800}),
            ) + "\n"),
        );
        let events = parse_grok(vec![s(root.path())]).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].input_tokens, 10000.0);
        assert_eq!(events[0].output_tokens, 800.0);
        assert_eq!(events[0].cache_read_tokens, 0.0);
        assert_eq!(events[0].cache_write_tokens, 500.0);
    }

    #[tokio::test]
    async fn falls_back_to_chat_estimate_when_updates_has_no_usage() {
        let root = tempfile::tempdir().unwrap();
        let sd = root.path().join("sessions").join("proj").join("sess-2");
        summary(&sd, "sess-2", "grok-4.5", "2026-07-15T11:00:00.000Z");
        write(
            &sd.join("chat_history.jsonl"),
            &[
                json!({"type": "user", "content": "hello world test"}).to_string(),
                json!({"type": "user", "synthetic_reason": "system_reminder", "content": "x".repeat(10000)}).to_string(),
                json!({"type": "assistant", "content": "hi there friend"}).to_string(),
            ]
            .join("\n"),
        );
        let events = parse_grok(vec![s(root.path())]).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].estimated, Some(true));
        assert!(events[0].input_tokens > 1000.0);
        assert!(events[0].output_tokens > 0.0);
        assert_eq!(events[0].timestamp, "2026-07-15T11:00:00.000Z");
        assert!(events[0].source_path.ends_with("chat_history.jsonl"));
    }

    #[tokio::test]
    async fn reads_persisted_usage_json_when_updates_unavailable() {
        let root = tempfile::tempdir().unwrap();
        let sd = root.path().join("sessions").join("proj").join("sess-persisted");
        write(
            &sd.join("usage.json"),
            &json!({
                "sessionId": "sess-persisted", "updatedAt": "2026-09-13T02:00:00.000Z",
                "session": {"inputTokens": 3200, "outputTokens": 120, "cachedReadTokens": 700, "cacheCreationTokens": 11,
                    "totalTokens": 3320, "costUsdTicks": 2000000000u64},
                "turns": [
                    {"turnNumber": 1, "endedAt": "2026-09-13T01:59:00.000Z", "inputTokens": 1000, "outputTokens": 90,
                        "cachedReadTokens": 700, "cacheCreationTokens": 11, "costUsdTicks": 1250000000u64,
                        "primaryModelId": "grok-4.6-build"},
                    {"turnNumber": 2, "endedAt": "2026-09-13T02:00:00.000Z", "inputTokens": 2200, "outputTokens": 30,
                        "cachedReadTokens": 0, "cacheCreationTokens": 0, "costUsdTicks": 750000000u64,
                        "primaryModelId": "grok-4.6-build"},
                ],
            })
            .to_string(),
        );
        let events = parse_grok(vec![s(root.path())]).await.unwrap();
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|e| e.estimated == Some(false)));
        assert!(events.iter().all(|e| e.source_path.ends_with("usage.json")));
        assert_eq!(events[0].model.as_deref(), Some("grok-4.6-build"));
        assert_eq!(events[0].input_tokens, 300.0);
        assert_eq!(events[0].cache_read_tokens, 700.0);
        assert_eq!(events[0].cache_write_tokens, 11.0);
        assert_eq!(events[0].total_tokens, 1101.0);
        assert_eq!(events.iter().map(|e| e.total_tokens).sum::<f64>(), 3331.0);
        assert!((events[0].estimated_cost.unwrap() - 0.125).abs() < 1e-9);
        assert_eq!(events[0].timestamp, "2026-09-13T01:59:00.000Z");
    }

    #[tokio::test]
    async fn does_not_double_count_usage_json_with_matching_updates() {
        let root = tempfile::tempdir().unwrap();
        let sd = root.path().join("sessions").join("proj").join("sess-persisted-dedupe");
        let timestamp = "2026-09-13T03:00:00.000Z";
        summary(&sd, "sess-persisted-dedupe", "grok-4.6-build", timestamp);
        let usage = json!({"inputTokens": 1000, "outputTokens": 90, "cachedReadTokens": 700, "cacheCreationTokens": 11,
            "costUsdTicks": 1250000000u64});
        write(&sd.join("updates.jsonl"), &(update_line(json!(timestamp), "prompt-1", usage.clone()) + "\n"));
        let mut turn = usage.clone();
        turn["turnNumber"] = json!(1);
        turn["endedAt"] = json!(timestamp);
        write(
            &sd.join("usage.json"),
            &json!({"sessionId": "sess-persisted-dedupe", "updatedAt": timestamp, "turns": [turn]}).to_string(),
        );
        let events = parse_grok(vec![s(root.path())]).await.unwrap();
        assert_eq!(events.len(), 1);
        assert!(events[0].source_path.ends_with("updates.jsonl"));
        assert_eq!(events[0].total_tokens, 1101.0);
        assert!((events[0].estimated_cost.unwrap() - 0.125).abs() < 1e-9);
    }

    #[test]
    fn helpers_match_js_semantics() {
        assert_eq!(decode_uri_component("C%3A%5CDev%5CX").as_deref(), Some("C:\\Dev\\X"));
        assert_eq!(decode_uri_component("%E0%A4%A"), None);
        assert_eq!(decode_uri_component("100%"), None);
        assert_eq!(decode_uri_component("%FF"), None);
        assert_eq!(split_lines("a\r\nb\rc\n\nd"), vec!["a", "b", "c", "", "d"]);
        assert!(is_exact_tool_call(r#"{"sessionUpdate" : "tool_call","x":1}"#));
        assert!(!is_exact_tool_call(r#"{"sessionUpdate":"tool_call_update"}"#));
        let keys: Vec<String> =
            entries_of(&json!({"b": 1, "10": 2, "2": 3, "a": 4})).unwrap().into_iter().map(|e| e.0).collect();
        assert_eq!(keys, vec!["2", "10", "b", "a"]);
        assert_eq!(model_from_usage(&json!({"modelUsage": {"a": {"totalTokens": 1}, "b": {"inputTokens": 5}}}), "z"), "b");
        assert_eq!(model_from_usage(&json!({}), "z"), "z");
        assert!(buckets_from_usage(&json!({"inputTokens": 0})).is_none());
        let b = buckets_from_usage(&json!({"inputTokens": 10, "cached_tokens": 0, "modelCalls": 2.7})).unwrap();
        assert!(b.cache_reported);
        assert_eq!(b.request_count, Some(2.0));
        assert!(timestamp_from_session_id("019f93c8-b594-7391-9505-ba4981098f0c").is_some());
        assert_eq!(timestamp_from_session_id("nope"), None);
        let mut peaks: IndexMap<String, PromptPeak> = IndexMap::new();
        note_prompt_peak(r#"{"_meta":{"totalTokens": 5, "cachedReadTokens": 3, "promptId": "p"}}"#, &mut peaks, &HashSet::new());
        assert_eq!(peaks["p"].total, 5.0);
        assert_eq!(peaks["p"].cached, 3.0);
    }
}
