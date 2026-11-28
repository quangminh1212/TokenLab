//! Agent: OpenClaw (port of `src/agents/openclaw/index.ts`).
//!
//! OpenClaw (+ legacy clawdbot / moltbot / moldbot):
//! - ~/.openclaw/agents/<agent>/sessions/*.jsonl
//! - sessions.json index pointing at transcript files
//! - current builds keep transcripts in an `openclaw-agent.sqlite` event log
//!
//! Usage from assistant message.usage / modelId.

use crate::agents::shared::env::{path_env, unique};
use crate::agents::shared::usage_fields::{extract_model, extract_timestamp, extract_token_buckets};
use crate::agents::{parse_fn, AgentModule};
use crate::pricing::apply_pricing;
use crate::types::{AgentId, UsageEvent};
use crate::util::{
    js_num_to_string, js_trim, path_exists, read_json_cached, read_jsonl_cached, read_text, stable_id,
    walk_files, PathFlavor, WalkOptions,
};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::HashSet;

static PATH_KEY: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)path|file|session|transcript").unwrap());
static FULL_PATH_HINT: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)session|transcript|chat|agent").unwrap());

/// Local data roots to scan on this machine.
pub fn roots() -> Vec<String> {
    let e = path_env();
    let mut r: Vec<String> = Vec::new();
    r.push(e.j(&[&e.home, ".openclaw"]));
    r.push(e.j(&[&e.home, ".clawdbot"]));
    r.push(e.j(&[&e.home, ".moltbot"]));
    r.push(e.j(&[&e.home, ".moldbot"]));
    r.push(e.j(&[&e.app_data, "openclaw"]));
    r.push(e.j(&[&e.local_app, "openclaw"]));
    r.push(e.j(&[&e.xdg_data, "openclaw"]));
    r.push(e.j(&[&e.xdg_config, "openclaw"]));
    unique(r)
}

// ---------------------------------------------------------------------------
// JS-ish helpers
// ---------------------------------------------------------------------------

/// `obj[key]` with undefined/null both mapped to `None` (what `??` skips).
fn g<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match v {
        Some(Value::Object(m)) => match m.get(key) {
            Some(Value::Null) | None => None,
            Some(x) => Some(x),
        },
        _ => None,
    }
}

/// `v && typeof v === "object"` (objects and arrays).
fn obj_like(v: Option<&Value>) -> Option<&Value> {
    match v {
        Some(x @ Value::Object(_)) | Some(x @ Value::Array(_)) => Some(x),
        _ => None,
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

/// `String(a ?? b ?? c ?? "")`.
fn first_string(cands: &[Option<&Value>]) -> String {
    for c in cands.iter().flatten() {
        return js_string(c);
    }
    String::new()
}

fn model_value(m: &Option<String>) -> Option<Value> {
    m.as_ref().map(|s| Value::String(s.clone()))
}

fn is_model_type(t: &str) -> bool {
    t == "model_change" || t == "session_meta" || t == "system"
}

/// `/^(0|[1-9]\d*)$/` below 2^32-1 (array-index keys sort first in JS objects).
fn array_index(k: &str) -> Option<u64> {
    if k.is_empty() || !k.bytes().all(|b| b.is_ascii_digit()) || (k.len() > 1 && k.starts_with('0')) {
        return None;
    }
    k.parse::<u64>().ok().filter(|n| *n < 4_294_967_295)
}

/// `Object.entries` order: integer-like keys ascending, then insertion order.
fn js_entries(m: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut idx: Vec<(u64, &String, &Value)> = Vec::new();
    let mut rest: Vec<(&String, &Value)> = Vec::new();
    for (k, v) in m {
        match array_index(k) {
            Some(n) => idx.push((n, k, v)),
            None => rest.push((k, v)),
        }
    }
    idx.sort_by_key(|(n, _, _)| *n);
    idx.into_iter().map(|(_, k, v)| (k, v)).chain(rest).collect()
}

/// JS truthiness of a parsed JSON value.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map_or(false, |f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

pub async fn parse_openclaw(roots: Vec<String>) -> anyhow::Result<Vec<UsageEvent>> {
    let flavor = PathFlavor::host();
    let mut events: Vec<UsageEvent> = Vec::new();
    let mut seen_files: HashSet<String> = HashSet::new();
    let mut seen_databases: HashSet<String> = HashSet::new();

    for root in &roots {
        if !path_exists(root).await {
            continue;
        }

        // Follow sessions.json indexes
        let indexes = walk_files(
            root,
            WalkOptions::new()
                .max_depth(8)
                .matching(|n, _| n == "sessions.json" || n == "session-index.json"),
        )
        .await;
        for index_path in indexes {
            let text = match read_text(&index_path).await {
                Some(t) if !t.is_empty() => t,
                _ => continue,
            };
            let data: Value = match serde_json::from_str(&text) {
                Ok(d) => d,
                Err(_) => continue, // ignore bad index
            };
            let refs = collect_path_refs(&data, &flavor.dirname(&index_path));
            for r in refs {
                parse_session_file(&mut events, &r, &mut seen_files).await;
            }
        }

        // Direct walk: agents, sessions, jsonl
        let files = walk_files(
            root,
            WalkOptions::new().max_depth(10).matching(|n, full| {
                if n.ends_with(".jsonl") {
                    return true;
                }
                n.ends_with(".json") && FULL_PATH_HINT.is_match(full)
            }),
        )
        .await;
        for file in files {
            if flavor.basename(&file) == "sessions.json" {
                continue;
            }
            parse_session_file(&mut events, &file, &mut seen_files).await;
        }

        // Current OpenClaw stores session transcripts in a SQLite event log.
        let databases =
            walk_files(root, WalkOptions::new().max_depth(10).matching(|n, _| n == "openclaw-agent.sqlite")).await;
        for database in databases {
            let key = flavor.resolve(&[database.as_str()]).to_lowercase();
            if !seen_databases.insert(key) {
                continue;
            }
            let db = database.clone();
            let mut found = tokio::task::spawn_blocking(move || parse_openclaw_database(&db)).await.unwrap_or_default();
            events.append(&mut found);
        }
    }

    Ok(events)
}

// ---------------------------------------------------------------------------
// SQLite transcript
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
                    m.insert(c.clone(), row.get_ref(i).map(sqlite_value).unwrap_or(Value::Null));
                }
                out.push(m);
            }
            Ok(None) => break,
            Err(_) => return None,
        }
    }
    Some(out)
}

fn parse_openclaw_database(db_path: &str) -> Vec<UsageEvent> {
    let mut events: Vec<UsageEvent> = Vec::new();
    let conn = match rusqlite::Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(c) => c,
        Err(_) => return events,
    };
    // A database may be mid-migration: any failure keeps what was parsed so far.
    let tables = match query_rows(&conn, "SELECT name FROM sqlite_master WHERE type = 'table'") {
        Some(t) => t,
        None => return events,
    };
    let has_table = |n: &str| tables.iter().any(|t| matches!(t.get("name"), Some(Value::String(s)) if s == n));
    if !has_table("transcript_events") {
        return events;
    }

    let mut session_models: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if has_table("session_windows") {
        // Keep parsing event-local models when the session index differs by version.
        if let Some(columns) = query_rows(&conn, "PRAGMA table_info(session_windows)") {
            let names: HashSet<String> = columns
                .iter()
                .filter_map(|c| match c.get("name") {
                    Some(Value::String(s)) => Some(s.clone()),
                    _ => None,
                })
                .collect();
            if names.contains("session_id") && names.contains("model") {
                if let Some(rows) = query_rows(&conn, "SELECT session_id, model FROM session_windows") {
                    for row in rows {
                        let session_id = first_string(&[g(Some(&Value::Object(row.clone())), "session_id")]);
                        let model = match row.get("model") {
                            Some(Value::String(s)) if !js_trim(s).is_empty() => Some(js_trim(s).to_string()),
                            _ => None,
                        };
                        if let (false, Some(m)) = (session_id.is_empty(), model) {
                            session_models.insert(session_id, m);
                        }
                    }
                }
            }
        }
    }

    let rows = match query_rows(
        &conn,
        "SELECT session_id, seq, event_json, created_at FROM transcript_events ORDER BY created_at, seq",
    ) {
        Some(r) => r,
        None => return events,
    };
    let mut event_models: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for row in rows {
        let session_id = match row.get("session_id") {
            Some(Value::Null) | None => String::new(),
            Some(v) => js_string(v),
        };
        let event_json = match row.get("event_json") {
            Some(Value::String(s)) => s,
            _ => continue,
        };
        if session_id.is_empty() {
            continue;
        }
        let parsed: Value = match serde_json::from_str(event_json) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if !matches!(parsed, Value::Object(_) | Value::Array(_)) {
            continue;
        }
        let record = Some(&parsed);
        let rtype = first_string(&[g(record, "type"), g(record, "role"), g(record, "event")]);
        let current_model: Option<String> =
            event_models.get(&session_id).or_else(|| session_models.get(&session_id)).cloned();

        if is_model_type(&rtype) {
            let cm = model_value(&current_model);
            let model = extract_model(&[record, g(record, "message"), cm.as_ref()]);
            if let Some(m) = model {
                event_models.insert(session_id, m);
            }
            continue;
        }

        let message = obj_like(g(record, "message")).or(record);
        let role = first_string(&[g(message, "role"), g(record, "role")]).to_lowercase();
        if !role.is_empty() && role != "assistant" {
            continue;
        }
        let usage = g(message, "usage").or_else(|| g(record, "usage")).or_else(|| g(record, "token_usage"));
        let buckets = match extract_token_buckets(usage.or(message)) {
            Some(b)
                if b.input_tokens + b.output_tokens + b.cache_read_tokens + b.cache_write_tokens > 0.0 =>
            {
                b
            }
            _ => continue,
        };

        let cm = model_value(&current_model);
        let model = extract_model(&[record, message, cm.as_ref()]).filter(|m| !m.is_empty());
        if let Some(m) = &model {
            event_models.insert(session_id.clone(), m.clone());
        }
        let seq = match row.get("seq") {
            Some(Value::Null) | None => String::new(),
            Some(v) => js_string(v),
        };
        let created_at = row.get("created_at");
        events.push(apply_pricing(UsageEvent {
            id: stable_id(&[
                "openclaw",
                db_path,
                session_id.as_str(),
                seq.as_str(),
                js_num_to_string(buckets.input_tokens).as_str(),
                js_num_to_string(buckets.output_tokens).as_str(),
            ]).into(),
            agent: AgentId::Openclaw,
            model: model.map(Into::into),
            timestamp: extract_timestamp(&[record, message, created_at]).into(),
            input_tokens: buckets.input_tokens,
            output_tokens: buckets.output_tokens,
            cache_read_tokens: buckets.cache_read_tokens,
            cache_write_tokens: buckets.cache_write_tokens,
            cache_reported: if buckets.cache_reported == Some(true) { Some(true) } else { None },
            workspace: match g(record, "cwd") {
                Some(Value::String(s)) => Some(s.clone().into()),
                _ => None,
            },
            source_path: db_path.to_string().into(),
            ..Default::default()
        }));
    }
    events
}

// ---------------------------------------------------------------------------
// JSON / JSONL session files
// ---------------------------------------------------------------------------

async fn parse_session_file(events: &mut Vec<UsageEvent>, file: &str, seen: &mut HashSet<String>) {
    if !seen.insert(file.to_string()) {
        return;
    }

    // Cached by (size, mtime): unchanged files skip read + JSON.parse.
    let rows = if file.ends_with(".jsonl") {
        read_jsonl_cached(file, None).await.ok().flatten()
    } else {
        read_json_cached(file).await
    };
    let rows = match rows {
        Some(r) if !r.is_empty() => r,
        _ => return,
    };

    let mut idx: f64 = 0.0;
    let mut model: Option<String> = None;
    let mut workspace: Option<String> = None;

    for row in rows.iter() {
        idx += 1.0;
        if !matches!(row, Value::Object(_) | Value::Array(_)) {
            continue;
        }
        let r = Some(row);
        let rtype = first_string(&[g(r, "type"), g(r, "role"), g(r, "event")]);

        if is_model_type(&rtype) {
            let cm = model_value(&model);
            model = extract_model(&[r, g(r, "message"), cm.as_ref()]).or(model);
            if let Some(Value::String(c)) = g(r, "cwd") {
                workspace = Some(c.clone());
            }
            continue;
        }

        // assistant / message with usage
        let msg = obj_like(g(r, "message")).or(r);
        let usage = g(msg, "usage").or_else(|| g(r, "usage")).or_else(|| g(r, "token_usage"));
        let buckets = match extract_token_buckets(usage.or(msg)) {
            Some(b) => b,
            None => continue,
        };

        let cm = model_value(&model);
        model = extract_model(&[r, msg, cm.as_ref()]).or(model);
        let ts = extract_timestamp(&[r, msg]);

        events.push(apply_pricing(UsageEvent {
            id: stable_id(&[
                "openclaw",
                file,
                js_num_to_string(idx).as_str(),
                js_num_to_string(buckets.input_tokens).as_str(),
                js_num_to_string(buckets.output_tokens).as_str(),
            ]).into(),
            agent: AgentId::Openclaw,
            model: model.clone().map(Into::into),
            timestamp: ts.into(),
            input_tokens: buckets.input_tokens,
            output_tokens: buckets.output_tokens,
            cache_read_tokens: buckets.cache_read_tokens,
            cache_write_tokens: buckets.cache_write_tokens,
            cache_reported: if buckets.cache_reported == Some(true) { Some(true) } else { None },
            workspace: workspace.clone().map(Into::into),
            source_path: file.to_string().into(),
            ..Default::default()
        }));
    }
}

fn collect_path_refs(data: &Value, base_dir: &str) -> Vec<String> {
    let flavor = PathFlavor::host();
    let mut out: Vec<String> = Vec::new();
    let abs = |v: &str| -> String {
        if flavor.is_absolute(v) {
            v.to_string()
        } else {
            flavor.resolve(&[base_dir, v])
        }
    };
    fn visit(v: &Value, out: &mut Vec<String>, abs: &dyn Fn(&str) -> String) {
        if !truthy(v) {
            return;
        }
        match v {
            Value::String(s) => {
                if s.ends_with(".jsonl") || s.ends_with(".json") {
                    out.push(abs(s));
                }
            }
            Value::Array(a) => {
                for x in a {
                    visit(x, out, abs);
                }
            }
            Value::Object(m) => {
                for (k, val) in js_entries(m) {
                    if let (true, Value::String(s)) = (PATH_KEY.is_match(k), val) {
                        out.push(abs(s));
                    } else {
                        visit(val, out, abs);
                    }
                }
            }
            _ => {}
        }
    }
    visit(data, &mut out, &abs);
    let mut seen = HashSet::new();
    out.retain(|p| seen.insert(p.clone()));
    out
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Openclaw,
        label: "OpenClaw",
        roots,
        parse: parse_fn(parse_openclaw),
        parse_light: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "openclaw");
        assert_eq!(a.label, "OpenClaw");
    }

    #[tokio::test]
    async fn reads_per_response_usage_from_sqlite_transcript() {
        let d = tempfile::tempdir().unwrap();
        let agent_dir = d.path().join("agents").join("main").join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        let db_path = agent_dir.join("openclaw-agent.sqlite");
        {
            let db = rusqlite::Connection::open(&db_path).unwrap();
            db.execute_batch(
                "CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, model_provider TEXT, model TEXT);
                 CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER);
                 INSERT INTO session_windows VALUES ('session-1', 'hermes', 'glm-5.3');",
            )
            .unwrap();
            let events = [
                (json!({"type":"model_change","timestamp":"2026-09-20T08:04:17.356Z","provider":"hermes","modelId":"glm-5.3"}), 1_789_891_457_356i64),
                (
                    json!({"type":"message","timestamp":"2026-09-20T08:04:24.280Z","message":{"role":"assistant","usage":{
                        "input":36869,"output":33,"cacheRead":0,"cacheWrite":0,"total":36902}}}),
                    1_789_891_464_280i64,
                ),
            ];
            for (i, (e, ts)) in events.iter().enumerate() {
                db.execute(
                    "INSERT INTO transcript_events VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params!["session-1", i as i64 + 1, e.to_string(), ts],
                )
                .unwrap();
            }
        }
        let usage = parse_openclaw(vec![d.path().to_string_lossy().to_string()]).await.unwrap();
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0].agent, AgentId::Openclaw);
        assert_eq!(usage[0].model.as_deref(), Some("glm-5.3"));
        assert_eq!(usage[0].timestamp, "2026-09-20T08:04:24.280Z");
        assert_eq!(usage[0].input_tokens, 36869.0);
        assert_eq!(usage[0].output_tokens, 33.0);
        assert_eq!(usage[0].total_tokens, 36902.0);
    }

    #[tokio::test]
    async fn reads_jsonl_transcript_and_follows_index_once() {
        let d = tempfile::tempdir().unwrap();
        let sessions = d.path().join("agents").join("main").join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let rows = [
            json!({"type":"session_meta","cwd":"/w","modelId":"glm-5.3"}),
            json!({"type":"message","timestamp":"2026-09-20T08:04:24.280Z","message":{"role":"assistant","usage":{"input":10,"output":2}}}),
            json!({"type":"message","message":{"role":"user"}}),
        ];
        let text: String = rows.iter().map(|r| format!("{r}\n")).collect();
        std::fs::write(sessions.join("a.jsonl"), text).unwrap();
        std::fs::write(sessions.join("sessions.json"), json!({"main": {"sessionFile": "a.jsonl"}}).to_string())
            .unwrap();
        let usage = parse_openclaw(vec![d.path().to_string_lossy().to_string()]).await.unwrap();
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0].workspace.as_deref(), Some("/w"));
        assert_eq!(usage[0].model.as_deref(), Some("glm-5.3"));
        assert_eq!(usage[0].input_tokens, 10.0);
        assert_eq!(usage[0].timestamp, "2026-09-20T08:04:24.280Z");
    }

    #[test]
    fn path_refs_follow_js_entry_order_and_dedupe() {
        let data = json!({"b": "x.jsonl", "2": {"transcriptPath": "/abs/t.json"}, "1": "y.json", "n": 5, "z": ["", "q.jsonl", "x.jsonl"]});
        let refs = collect_path_refs(&data, "/base");
        let flavor = PathFlavor::host();
        assert_eq!(
            refs,
            vec![
                "y.json".to_string().replace("y.json", &flavor.resolve(&["/base", "y.json"])),
                "/abs/t.json".to_string(),
                flavor.resolve(&["/base", "x.jsonl"]),
                flavor.resolve(&["/base", "q.jsonl"]),
            ]
        );
    }
}
