//! Agent: QwenCoder Cloud (port of `src/agents/qwencoder/index.ts`).
//!
//! QwenCoder Cloud dashboard usage (`https://qwencoder.cloud/dashboard`).
//!
//! Data sources under mirrors/qwencoder (prefer rich -> sparse):
//!  1. API dumps: api_v1_dashboard_me_stats.json, ..._models_me.json, ..._chart.json
//!  2. dashboard-scrape.json (from live Brave page text when session JWT unavailable)
//!  3. usage-daily.json (normalized daily rollups)

use crate::agents::shared::env::{env_chain, path_env, unique};
use crate::agents::{parse_fn, AgentModule};
use crate::pricing::{apply_pricing, apply_pricing_with};
use crate::types::{AgentId, UsageEvent};
use crate::util::{
    app_data_dir, env_nonempty, home_dir, js_date_parse, js_num_to_string, js_trim, now_ms, num, path_exists, pjoin,
    read_text, stable_id, to_iso_string,
};
use serde_json::{Map, Value};
use std::collections::HashSet;

/// Local data roots to scan on this machine.
pub fn roots() -> Vec<String> {
    let e = path_env();
    let data = env_nonempty("TOKENLAB_DATA_DIR").unwrap_or_else(|| e.j(&[&app_data_dir(), "tokenlab"]));
    let mut r: Vec<String> = Vec::new();
    r.push(e.expand_home(&env_chain(&["TOKENLAB_QWENCODER_DIR", "QWENCODER_HOME"])));
    r.push(e.j(&[&data, "mirrors", "qwencoder"]));
    r.push(e.j(&[&home_dir(), ".tokenlab", "mirrors", "qwencoder"]));
    r.push(e.j(&[&app_data_dir(), "xlab-token", "mirrors", "qwencoder"]));
    unique(r)
}

// ---------------------------------------------------------------------------
// JS-ish helpers
// ---------------------------------------------------------------------------

/// `obj[key]` with `undefined`/`null` both mapped to `None` (what `??` skips).
/// Non-objects (including arrays) have none of the keys used here.
fn g<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    match v {
        Value::Object(m) => match m.get(key) {
            Some(Value::Null) | None => None,
            Some(x) => Some(x),
        },
        _ => None,
    }
}

/// `num(a ?? b ?? c)`.
fn n_of(v: &Value, keys: &[&str]) -> f64 {
    for k in keys {
        if let Some(x) = g(v, k) {
            return num(x);
        }
    }
    0.0
}

/// First non-nullish value among `keys`.
fn first_of<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| g(v, k))
}

/// `v != null` for any of `keys`.
fn any_present(v: &Value, keys: &[&str]) -> bool {
    keys.iter().any(|k| g(v, k).is_some())
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

/// `String(v)` for parsed JSON values.
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

/// `String(a ?? b ?? ... ?? default)`.
fn str_of(v: &Value, keys: &[&str], default: &str) -> String {
    match first_of(v, keys) {
        Some(x) => js_string(x),
        None => default.to_string(),
    }
}

/// `typeof v === "object" && v` (objects and arrays).
fn is_obj(v: &Value) -> bool {
    matches!(v, Value::Object(_) | Value::Array(_))
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

/// `Object.entries(v)` in JS property order (integer-like keys ascending first).
fn js_entries(v: &Value) -> Vec<(String, &Value)> {
    match v {
        Value::Object(m) => {
            let mut idx: Vec<(u64, &String, &Value)> = Vec::new();
            let mut rest: Vec<(String, &Value)> = Vec::new();
            for (k, x) in m {
                match array_index(k) {
                    Some(i) => idx.push((i, k, x)),
                    None => rest.push((k.clone(), x)),
                }
            }
            idx.sort_by_key(|t| t.0);
            idx.into_iter().map(|(_, k, x)| (k.clone(), x)).chain(rest).collect()
        }
        Value::Array(a) => a.iter().enumerate().map(|(i, x)| (i.to_string(), x)).collect(),
        _ => Vec::new(),
    }
}

/// `/^\d{4}-\d{2}-\d{2}$/`
fn is_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

/// `s.slice(0, 10)` (UTF-16 code units).
fn slice10(s: &str) -> String {
    let units: Vec<u16> = s.encode_utf16().take(10).collect();
    String::from_utf16_lossy(&units)
}

fn now_iso() -> String {
    to_iso_string(now_ms()).unwrap_or_default()
}

/// `readText` + `JSON.parse`; `None` when missing/empty/invalid.
async fn read_json(file: &str) -> Option<Value> {
    let text = read_text(file).await?;
    if text.is_empty() {
        return None;
    }
    serde_json::from_str(&text).ok()
}

/// `reqs > 0 ? { requestCount: Math.floor(reqs) } : {}`
fn request_count(reqs: f64) -> Option<f64> {
    if reqs > 0.0 {
        Some(reqs.floor())
    } else {
        None
    }
}

/// JS `a || b` for numbers.
fn or(a: f64, b: f64) -> f64 {
    if a != 0.0 && !a.is_nan() {
        a
    } else {
        b
    }
}

/// `String(x)` for numbers.
fn s(x: f64) -> String {
    js_num_to_string(x)
}

/// Common event skeleton (`agent: "qwencoder"`, `workspace: null`, `estimated: true`).
#[allow(clippy::too_many_arguments)]
fn base_event(
    id: String,
    model: String,
    timestamp: String,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    file: &str,
) -> UsageEvent {
    UsageEvent {
        id,
        agent: AgentId::Qwencoder,
        model: Some(model),
        timestamp,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
        workspace: None,
        source_path: file.to_string(),
        estimated: Some(true),
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

fn push_new(events: &mut Vec<UsageEvent>, seen: &mut HashSet<String>, batch: Vec<UsageEvent>) {
    for e in batch {
        if seen.contains(&e.id) {
            continue;
        }
        seen.insert(e.id.clone());
        events.push(e);
    }
}

pub async fn parse_qwen_coder(roots: Vec<String>) -> anyhow::Result<Vec<UsageEvent>> {
    let mut events: Vec<UsageEvent> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for root in &roots {
        if !path_exists(root).await {
            continue;
        }

        // 1) Normalized daily rollups
        let daily_path = pjoin(&[root.as_str(), "usage-daily.json"]);
        if path_exists(&daily_path).await {
            let batch = parse_usage_daily(&daily_path).await;
            push_new(&mut events, &mut seen, batch);
        }

        // 2) Official API model analysis (richest per-model)
        for name in ["api_v1_dashboard_analysis_models_me.json", "dashboard_analysis_models_me.json", "models_me.json"] {
            let fp = pjoin(&[root.as_str(), name]);
            if !path_exists(&fp).await {
                continue;
            }
            let batch = parse_models_api(&fp).await?;
            push_new(&mut events, &mut seen, batch);
        }

        // 3) Stats summary (totals when models missing)
        for name in ["api_v1_dashboard_me_stats.json", "dashboard_me_stats.json", "stats.json"] {
            let fp = pjoin(&[root.as_str(), name]);
            if !path_exists(&fp).await {
                continue;
            }
            let batch = parse_stats_api(&fp).await?;
            push_new(&mut events, &mut seen, batch);
        }

        // 4) Chart series
        for name in ["api_v1_dashboard_me_chart.json", "dashboard_me_chart.json", "chart.json"] {
            let fp = pjoin(&[root.as_str(), name]);
            if !path_exists(&fp).await {
                continue;
            }
            let batch = parse_chart_api(&fp).await;
            push_new(&mut events, &mut seen, batch);
        }

        // 5) Brave dashboard scrape (when JWT cannot be exported)
        let scrape = pjoin(&[root.as_str(), "dashboard-scrape.json"]);
        if path_exists(&scrape).await {
            let batch = parse_dashboard_scrape(&scrape).await;
            push_new(&mut events, &mut seen, batch);
        }
    }

    Ok(events)
}

async fn parse_usage_daily(file: &str) -> Vec<UsageEvent> {
    let data = match read_json(file).await {
        Some(d) => d,
        None => return Vec::new(),
    };
    let mut events: Vec<UsageEvent> = Vec::new();
    let daily = match &data {
        Value::Object(_) => data.clone(),
        _ => Value::Object(Map::new()),
    };

    for (day, row) in js_entries(&daily) {
        if !is_day(&day) || !is_obj(row) {
            continue;
        }
        // `row.byModel || row.models || null`
        let by_model = {
            let a = g(row, "byModel");
            if truthy(a) {
                a
            } else {
                let b = g(row, "models");
                if truthy(b) {
                    b
                } else {
                    None
                }
            }
        };

        if let Some(by_model) = by_model.filter(|v| is_obj(v)) {
            for (model, m) in js_entries(by_model) {
                if !is_obj(m) {
                    continue;
                }
                let input_tokens = n_of(m, &["inputTokens", "input_tokens", "prompt_tokens", "input"]);
                let output_tokens = n_of(m, &["outputTokens", "output_tokens", "completion_tokens", "output"]);
                let total = n_of(m, &["totalTokens", "total_tokens", "tokens"]);
                let in_t = or(input_tokens, if output_tokens != 0.0 { 0.0 } else { total });
                let out_t = output_tokens;
                if in_t + out_t <= 0.0 && total <= 0.0 {
                    continue;
                }
                let reqs = n_of(m, &["requests", "requestCount", "count"]);
                let mut ev = base_event(
                    stable_id(&["qwencoder", file, &day, &model, &s(or(in_t, total)), &s(out_t)]),
                    model.clone(),
                    format!("{day}T12:00:00.000Z"),
                    or(in_t, total),
                    out_t,
                    n_of(m, &["cacheReadTokens", "cache_read_tokens"]),
                    n_of(m, &["cacheWriteTokens", "cache_write_tokens"]),
                    file,
                );
                if any_present(m, &["cacheReadTokens", "cache_read_tokens"]) {
                    ev.cache_reported = Some(true);
                }
                ev.request_count = request_count(reqs);
                let cost = n_of(m, &["cost", "estimatedCost"]);
                events.push(if cost > 0.0 { apply_pricing_with(ev, Some(cost)) } else { apply_pricing(ev) });
            }
            continue;
        }

        let input_tokens = n_of(row, &["inputTokens", "input_tokens"]);
        let output_tokens = n_of(row, &["outputTokens", "output_tokens"]);
        let total = n_of(row, &["totalTokens", "tokens", "total_tokens"]);
        if input_tokens + output_tokens + total <= 0.0 {
            continue;
        }
        let ev = base_event(
            stable_id(&["qwencoder", file, &day, "all", &s(or(total, input_tokens))]),
            "qwencoder".to_string(),
            format!("{day}T12:00:00.000Z"),
            or(input_tokens, total),
            output_tokens,
            0.0,
            0.0,
            file,
        );
        events.push(apply_pricing(ev));
    }
    events
}

async fn parse_models_api(file: &str) -> anyhow::Result<Vec<UsageEvent>> {
    let data = match read_json(file).await {
        Some(d) => d,
        None => return Ok(Vec::new()),
    };
    let root = match unwrap_data(&data) {
        Some(r) => r,
        None => return Ok(Vec::new()),
    };
    models_from_root(file, root)
}

fn models_from_root(file: &str, root: &Value) -> anyhow::Result<Vec<UsageEvent>> {
    let list = extract_model_list(root);
    if list.is_empty() {
        return Ok(Vec::new());
    }

    let ts = match extract_as_of(root)? {
        Some(t) => t,
        None => now_iso(),
    };
    let mut events: Vec<UsageEvent> = Vec::new();
    for m in &list {
        let model = str_of(m, &["model", "name", "id"], "unknown");
        let input_tokens = n_of(m, &["inputTokens", "input_tokens", "prompt_tokens", "input", "promptTokens"]);
        let output_tokens =
            n_of(m, &["outputTokens", "output_tokens", "completion_tokens", "output", "completionTokens"]);
        let total = n_of(m, &["totalTokens", "total_tokens", "tokens", "token", "usage"]);
        let in_t = or(input_tokens, if output_tokens > 0.0 { 0.0 } else { total });
        let out_t = output_tokens;
        if in_t + out_t + total <= 0.0 {
            continue;
        }
        let reqs = n_of(m, &["requests", "requestCount", "count", "success_count"]);
        let mut ev = base_event(
            stable_id(&["qwencoder", file, "models", &model, &s(or(in_t, total)), &s(out_t)]),
            model.clone(),
            ts.clone(),
            or(in_t, total),
            out_t,
            n_of(m, &["cacheReadTokens", "cache_read_tokens"]),
            n_of(m, &["cacheWriteTokens", "cache_write_tokens"]),
            file,
        );
        if any_present(m, &["cacheReadTokens", "cache_read_tokens"]) {
            ev.cache_reported = Some(true);
        }
        ev.request_count = request_count(reqs);
        events.push(apply_pricing(ev));
    }
    Ok(events)
}

async fn parse_stats_api(file: &str) -> anyhow::Result<Vec<UsageEvent>> {
    let data = match read_json(file).await {
        Some(d) => d,
        None => return Ok(Vec::new()),
    };
    let root = match unwrap_data(&data) {
        Some(r) => r,
        None => return Ok(Vec::new()),
    };

    // Prefer nested models if present
    if !extract_model_list(root).is_empty() {
        return models_from_root(file, root);
    }

    let input_tokens = n_of(root, &["inputTokens", "input_tokens", "prompt_tokens", "totalInputTokens"]);
    let output_tokens = n_of(root, &["outputTokens", "output_tokens", "completion_tokens", "totalOutputTokens"]);
    let total = n_of(root, &["totalTokens", "total_tokens", "tokensUsed", "tokens_used", "tokens"]);
    if input_tokens + output_tokens + total <= 0.0 {
        return Ok(Vec::new());
    }

    let reqs = n_of(root, &["requests", "requestCount", "total_requests", "success_requests"]);
    let ts = match extract_as_of(root)? {
        Some(t) => t,
        None => now_iso(),
    };
    let mut ev = base_event(
        stable_id(&["qwencoder", file, "stats", &s(or(total, input_tokens))]),
        "qwencoder".to_string(),
        ts,
        or(input_tokens, total),
        output_tokens,
        0.0,
        0.0,
        file,
    );
    ev.request_count = request_count(reqs);
    Ok(vec![apply_pricing(ev)])
}

async fn parse_chart_api(file: &str) -> Vec<UsageEvent> {
    let data = match read_json(file).await {
        Some(d) => d,
        None => return Vec::new(),
    };
    let root = match unwrap_data(&data) {
        Some(r) => r,
        None => return Vec::new(),
    };

    let mut events: Vec<UsageEvent> = Vec::new();
    // Common shapes: { series: [{date, input, output, model?}] } or { points: [...] }
    let from_keys: Option<&Vec<Value>> = ["series", "points", "data"].iter().find_map(|k| match root {
        Value::Object(m) => match m.get(*k) {
            Some(Value::Array(a)) => Some(a),
            _ => None,
        },
        _ => None,
    });
    let series: Option<&Vec<Value>> = from_keys.or(match root {
        Value::Array(a) => Some(a),
        _ => None,
    });
    let series = match series {
        Some(v) => v,
        None => return events,
    };

    for p in series {
        if !is_obj(p) {
            continue;
        }
        let day = slice10(&str_of(p, &["date", "day", "label"], ""));
        if !is_day(&day) {
            continue;
        }
        let model = str_of(p, &["model", "name"], "qwencoder");
        let input_tokens = n_of(p, &["input", "inputTokens", "input_tokens", "prompt_tokens"]);
        let output_tokens = n_of(p, &["output", "outputTokens", "output_tokens", "completion_tokens"]);
        let total = n_of(p, &["tokens", "totalTokens", "total"]);
        if input_tokens + output_tokens + total <= 0.0 {
            continue;
        }
        let reqs = n_of(p, &["requests", "requestCount"]);
        let mut ev = base_event(
            stable_id(&["qwencoder", file, "chart", &day, &model, &s(or(input_tokens, total))]),
            model.clone(),
            format!("{day}T12:00:00.000Z"),
            or(input_tokens, total),
            output_tokens,
            0.0,
            0.0,
            file,
        );
        ev.request_count = request_count(reqs);
        events.push(apply_pricing(ev));
    }
    events
}

/// Parse Brave dashboard scrape written by pull-qwencoder-usage.py.
/// Shape: { scrapedAt, periodDays, totals, models: [{model, requests, tokens, pct}] }
async fn parse_dashboard_scrape(file: &str) -> Vec<UsageEvent> {
    let d = match read_json(file).await {
        Some(d) if is_obj(&d) => d,
        _ => return Vec::new(),
    };
    let scraped_at = match g(&d, "scrapedAt") {
        Some(Value::String(t)) if !t.is_empty() => t.clone(),
        _ => now_iso(),
    };
    let day = slice10(&scraped_at);
    let empty: Vec<Value> = Vec::new();
    let models: &Vec<Value> = match g(&d, "models") {
        Some(Value::Array(a)) => a,
        _ => &empty,
    };
    let mut events: Vec<UsageEvent> = Vec::new();

    // Prefer per-model rows
    for m in models {
        if !is_obj(m) {
            continue;
        }
        let model = js_trim(&str_of(m, &["model", "name"], "")).to_string();
        if model.is_empty() {
            continue;
        }
        let tokens = n_of(m, &["tokens", "totalTokens", "total_tokens"]);
        let input_tokens = n_of(m, &["inputTokens", "input_tokens"]);
        let output_tokens = n_of(m, &["outputTokens", "output_tokens"]);
        let in_t = or(input_tokens, if output_tokens != 0.0 { 0.0 } else { tokens });
        let out_t = output_tokens;
        if in_t + out_t + tokens <= 0.0 {
            continue;
        }
        let reqs = n_of(m, &["requests", "requestCount"]);
        let mut ev = base_event(
            stable_id(&["qwencoder", file, "scrape", &model, &s(or(in_t, tokens)), &day]),
            model.clone(),
            scraped_at.clone(),
            or(in_t, tokens),
            out_t,
            0.0,
            0.0,
            file,
        );
        ev.request_count = request_count(reqs);
        events.push(apply_pricing(ev));
    }

    // Preserve account usage that is not assigned to a model row.
    if let Some(t) = g(&d, "totals").filter(|t| is_obj(t)) {
        let total_tokens = n_of(t, &["tokensUsed", "totalTokens", "tokens"]).max(n_of(t, &["tokens30d"]));
        let total_requests = n_of(t, &["requests", "totalRequests"]).max(n_of(t, &["successRequests"]));
        let model_tokens: f64 = events
            .iter()
            .map(|e| e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_write_tokens)
            .fold(0.0, |a, b| a + b);
        let model_requests: f64 = events
            .iter()
            .map(|e| match e.request_count {
                Some(c) if c > 0.0 => c.floor(),
                _ => 1.0,
            })
            .fold(0.0, |a, b| a + b);
        let tokens = (total_tokens - model_tokens).max(0.0);
        let reqs = (total_requests - model_requests).max(0.0);
        if tokens > 0.0 || reqs > 0.0 || events.is_empty() {
            let mut ev = base_event(
                stable_id(&["qwencoder", file, "scrape-total", &s(total_tokens), &s(total_requests), &day]),
                "unattributed".to_string(),
                scraped_at.clone(),
                tokens,
                0.0,
                0.0,
                0.0,
                file,
            );
            ev.request_count = request_count(reqs);
            events.push(apply_pricing(ev));
        }
    }

    events
}

fn unwrap_data(data: &Value) -> Option<&Value> {
    if !is_obj(data) {
        return None;
    }
    if let Value::Object(o) = data {
        if let Some(inner @ Value::Object(_)) = o.get("data") {
            return Some(inner);
        }
    }
    Some(data)
}

fn extract_model_list(root: &Value) -> Vec<Value> {
    let m = match root {
        Value::Object(m) => m,
        _ => return Vec::new(),
    };
    for key in ["models", "items", "list", "byModel", "breakdown", "data"] {
        match m.get(key) {
            Some(Value::Array(a)) => return a.iter().filter(|x| is_obj(x)).cloned().collect(),
            Some(v @ Value::Object(_)) => {
                return js_entries(v)
                    .into_iter()
                    .map(|(model, rest)| {
                        let mut out = Map::new();
                        match rest {
                            Value::Object(r) => {
                                out.insert("model".to_string(), Value::String(model));
                                for (k, x) in r {
                                    out.insert(k.clone(), x.clone());
                                }
                            }
                            Value::Array(_) => {
                                // `{ model, ...array }` only adds index keys, never read here.
                                out.insert("model".to_string(), Value::String(model));
                            }
                            other => {
                                out.insert("model".to_string(), Value::String(model));
                                out.insert("tokens".to_string(), other.clone());
                            }
                        }
                        Value::Object(out)
                    })
                    .collect();
            }
            _ => {}
        }
    }
    Vec::new()
}

/// `extractAsOf`: `Err` mirrors the `RangeError` `toISOString()` throws for out-of-range dates.
fn extract_as_of(root: &Value) -> anyhow::Result<Option<String>> {
    for k in ["asOf", "as_of", "updatedAt", "updated_at", "timestamp", "time"] {
        match g(root, k) {
            Some(Value::String(v)) if !js_trim(v).is_empty() => {
                let ms = js_date_parse(v);
                if !ms.is_nan() {
                    return Ok(to_iso_string(ms));
                }
            }
            Some(Value::Number(n)) => {
                let v = n.as_f64().unwrap_or(0.0);
                if v.is_finite() && v > 1e9 {
                    let ms = if v > 1e12 { v } else { v * 1000.0 };
                    return match to_iso_string(ms) {
                        Some(t) => Ok(Some(t)),
                        None => Err(anyhow::anyhow!("Invalid time value")),
                    };
                }
            }
            _ => {}
        }
    }
    Ok(None)
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Qwencoder,
        label: "QwenCoder Cloud",
        roots,
        parse: parse_fn(parse_qwen_coder),
        parse_light: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &std::path::Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).unwrap();
    }

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "qwencoder");
        assert_eq!(a.label, "QwenCoder Cloud");
    }

    #[tokio::test]
    async fn reads_dashboard_scrape_models() {
        let root = tempfile::tempdir().unwrap();
        write(
            root.path(),
            "dashboard-scrape.json",
            r#"{"scrapedAt":"2026-08-05T10:00:00.000Z","periodDays":30,
              "totals":{"tokensUsed":2394300000,"requests":45928,"successRequests":41433},
              "models":[{"model":"qwen3.7-max","requests":17861,"tokens":1505400000,"pct":63.5},
                        {"model":"gpt-5.6-sol","requests":10985,"tokens":453600000,"pct":19.1}]}"#,
        );
        let events = parse_qwen_coder(vec![root.path().to_string_lossy().to_string()]).await.unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].agent, AgentId::Qwencoder);
        let q = events.iter().find(|e| e.model.as_deref() == Some("qwen3.7-max")).unwrap();
        assert_eq!(q.input_tokens, 1_505_400_000.0);
        assert_eq!(q.request_count, Some(17861.0));
        let total_in: f64 = events.iter().map(|e| e.input_tokens).sum();
        assert_eq!(total_in, 2_394_300_000.0);
        let rem = events.iter().find(|e| e.model.as_deref() == Some("unattributed")).unwrap();
        assert_eq!(rem.input_tokens, 435_300_000.0);
        assert_eq!(rem.request_count, Some(17_082.0));
    }

    #[tokio::test]
    async fn reads_models_api_envelope() {
        let root = tempfile::tempdir().unwrap();
        write(
            root.path(),
            "api_v1_dashboard_analysis_models_me.json",
            r#"{"success":true,"data":{"models":[{"model":"kimi-k3","input_tokens":1000,"output_tokens":200,"requests":3}]}}"#,
        );
        let events = parse_qwen_coder(vec![root.path().to_string_lossy().to_string()]).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].model.as_deref(), Some("kimi-k3"));
        assert_eq!(events[0].input_tokens, 1000.0);
        assert_eq!(events[0].output_tokens, 200.0);
        assert_eq!(events[0].request_count, Some(3.0));
    }

    #[tokio::test]
    async fn usage_daily_by_model() {
        let root = tempfile::tempdir().unwrap();
        write(
            root.path(),
            "usage-daily.json",
            r#"{"2026-08-01":{"byModel":{"gpt-5.6-sol":{"inputTokens":5000,"outputTokens":100,"requests":2}}}}"#,
        );
        let events = parse_qwen_coder(vec![root.path().to_string_lossy().to_string()]).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(&events[0].timestamp[..10], "2026-08-01");
        assert_eq!(events[0].input_tokens, 5000.0);
    }

    #[tokio::test]
    async fn stats_and_chart_fallbacks() {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "stats.json", r#"{"data":{"totalTokens":900,"requests":4.7,"asOf":1760000000}}"#);
        write(root.path(), "chart.json", r#"{"series":[{"date":"2026-08-02T00:00:00Z","tokens":50,"model":"m"}]}"#);
        let events = parse_qwen_coder(vec![root.path().to_string_lossy().to_string()]).await.unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].timestamp, "2025-10-09T08:53:20.000Z");
        assert_eq!(events[0].input_tokens, 900.0);
        assert_eq!(events[0].request_count, Some(4.0));
        assert_eq!(events[1].timestamp, "2026-08-02T12:00:00.000Z");
        assert_eq!(events[1].input_tokens, 50.0);
    }

    #[test]
    fn helpers() {
        assert!(is_day("2026-08-01"));
        assert!(!is_day("2026-8-01"));
        let v: Value = serde_json::from_str(r#"{"b":1,"2":2,"a":3,"1":4}"#).unwrap();
        let keys: Vec<String> = js_entries(&v).into_iter().map(|(k, _)| k).collect();
        assert_eq!(keys, vec!["1", "2", "b", "a"]);
    }
}
