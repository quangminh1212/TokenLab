//! Agent: OpenCode (port of `src/agents/opencode/index.ts`).
//!
//! OpenCode stores current usage in SQLite (`message` / `session_message` /
//! `session_v2`) and older installs in JSON / JSONL files. Database rows have a
//! higher priority than legacy JSON rows for the same message id, and the
//! cumulative `session_v2` rollup fills the gap left by compacted history.

use crate::agents::shared::env::{path_env, unique};
use crate::agents::shared::usage_fields::{extract_model, extract_timestamp, extract_token_buckets, TokenBuckets};
use crate::agents::{parse_fn, AgentModule};
use crate::pricing::apply_pricing;
use crate::types::{AgentId, UsageEvent};
use crate::util::{js_num_to_string, js_trim, num, path_exists, read_json_cached, read_jsonl_cached, stable_id, walk_files, WalkOptions};
use indexmap::IndexMap;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::HashSet;

/// Local data roots to scan on this machine.
pub fn roots() -> Vec<String> {
    let e = path_env();
    let mut r: Vec<String> = Vec::new();
    r.push(e.j(&[&e.xdg_data, "opencode"]));
    r.push(e.j(&[&e.home, ".local", "share", "opencode"]));
    r.push(e.j(&[&e.home, ".opencode"]));
    r.push(e.j(&[&e.app_data, "opencode"]));
    r.push(e.j(&[&e.local_app, "opencode"]));
    unique(r)
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Opencode,
        label: "OpenCode",
        roots,
        parse: parse_fn(parse_opencode),
        parse_light: None,
    }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Message,
    Rollup,
}

struct IndexedEvent {
    event: UsageEvent,
    priority: u32,
    kind: Kind,
    session_id: Option<String>,
}

type EventIndex = IndexMap<String, IndexedEvent>;

struct Parsed {
    key: String,
    event: UsageEvent,
    session_id: Option<String>,
}

struct SessionRollup {
    directory: Option<String>,
    model: Option<Value>,
    created_at: Option<Value>,
    updated_at: Option<Value>,
    input_tokens: f64,
    output_tokens: f64,
    reasoning_tokens: f64,
    cache_read_tokens: f64,
    cache_write_tokens: f64,
    /// Whether the session table actually carried cache columns.
    cache_reported: bool,
}

#[derive(Default)]
struct SessionDetail {
    input_tokens: f64,
    output_tokens: f64,
    cache_read_tokens: f64,
    cache_write_tokens: f64,
    models: Vec<String>,
}

// ---------------------------------------------------------------------------
// JS-ish helpers
// ---------------------------------------------------------------------------

/// `asRecord`: a non-null, non-array object.
fn as_record(v: Option<&Value>) -> Option<&Map<String, Value>> {
    match v {
        Some(Value::Object(m)) => Some(m),
        _ => None,
    }
}

/// `m[key]` with `undefined` and `null` both mapped to `None`.
fn gv<'a>(m: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    match m.get(key) {
        Some(Value::Null) | None => None,
        Some(v) => Some(v),
    }
}

/// `firstValue(...)`: first candidate that is neither undefined nor null.
fn first_value<'a>(cands: &[Option<&'a Value>]) -> Option<&'a Value> {
    cands.iter().copied().flatten().find(|v| !v.is_null())
}

/// `firstValue(...)` as an owned JSON value (`null` when absent).
fn fv(cands: &[Option<&Value>]) -> Value {
    first_value(cands).cloned().unwrap_or(Value::Null)
}

fn num_of(v: Option<&Value>) -> f64 {
    v.map_or(0.0, num)
}

// ---------------------------------------------------------------------------
// Record parsing
// ---------------------------------------------------------------------------

fn parse_opencode_record(
    value: &Value,
    source_path: &str,
    source_identity: &str,
    fallback_timestamp: Option<&Value>,
    fallback_workspace: Option<&str>,
) -> Option<Parsed> {
    let message = as_record(Some(value))?;

    let role = match gv(message, "role") {
        Some(Value::String(s)) => s.to_lowercase(),
        _ => match gv(message, "type") {
            Some(Value::String(s)) => s.to_lowercase(),
            _ => String::new(),
        },
    };
    if !role.is_empty() && role != "assistant" {
        return None;
    }

    let native_tokens = as_record(gv(message, "tokens"));
    let (usage, usage_is_tokens): (&Map<String, Value>, bool) = if let Some(u) = as_record(gv(message, "usage")) {
        (u, false)
    } else if let Some(t) = native_tokens {
        (t, true)
    } else if let Some(c) = as_record(gv(message, "cost")) {
        (c, false)
    } else {
        (message, false)
    };
    let cache = as_record(gv(usage, "cache"));
    let raw_output = first_value(&[
        gv(usage, "output"),
        gv(usage, "output_tokens"),
        gv(usage, "outputTokens"),
        gv(usage, "completion_tokens"),
        gv(usage, "completionTokens"),
        gv(usage, "total_output_tokens"),
    ]);
    let raw_reasoning = first_value(&[
        gv(usage, "reasoning"),
        gv(usage, "reasoning_tokens"),
        gv(usage, "reasoningTokens"),
        gv(usage, "reasoning_output_tokens"),
        gv(usage, "reasoningOutputTokens"),
    ]);
    // OpenCode stores output and reasoning as separate, non-overlapping counts.
    let native_open_code_tokens = usage_is_tokens && (usage.contains_key("reasoning") || cache.is_some());

    let mut normalized: Map<String, Value> = usage.clone();
    if let Some(v) = first_value(&[
        gv(usage, "cache_read"),
        gv(usage, "cache_read_tokens"),
        gv(usage, "cacheReadTokens"),
        gv(usage, "cachedReadTokens"),
        cache.and_then(|c| gv(c, "read")),
    ]) {
        normalized.insert("cache_read_tokens".to_string(), v.clone());
    }
    if let Some(v) = first_value(&[
        gv(usage, "cache_write"),
        gv(usage, "cache_write_tokens"),
        gv(usage, "cacheWriteTokens"),
        gv(usage, "cachedWriteTokens"),
        cache.and_then(|c| gv(c, "write")),
    ]) {
        normalized.insert("cache_write_tokens".to_string(), v.clone());
    }
    if native_open_code_tokens && (raw_output.is_some() || raw_reasoning.is_some()) {
        let sum = num_of(raw_output) + num_of(raw_reasoning);
        normalized.insert(
            "output_tokens".to_string(),
            serde_json::Number::from_f64(sum).map(Value::Number).unwrap_or(Value::Null),
        );
    }

    let extracted = extract_token_buckets(Some(&Value::Object(normalized)));
    let reported_total = num_of(first_value(&[gv(usage, "total"), gv(usage, "total_tokens"), gv(usage, "totalTokens")]));
    let mut buckets: Option<TokenBuckets> = extracted;
    let mut estimated = false;
    if buckets.is_none() && reported_total > 0.0 {
        buckets = Some(TokenBuckets {
            input_tokens: reported_total,
            output_tokens: 0.0,
            cache_read_tokens: 0.0,
            cache_write_tokens: 0.0,
            input_includes_cache: None,
            cache_reported: None,
        });
        estimated = true;
    } else if let Some(b) = buckets.as_mut() {
        if reported_total > 0.0 {
            let categorized = b.input_tokens + b.output_tokens + b.cache_read_tokens + b.cache_write_tokens;
            if reported_total > categorized {
                b.input_tokens = b.input_tokens + reported_total - categorized;
                estimated = true;
            }
        }
    }
    let buckets = buckets?;

    let message_id: Option<&str> = match message.get("id") {
        Some(Value::String(s)) if !js_trim(s).is_empty() => Some(js_trim(s)),
        _ => None,
    };
    let key = match message_id {
        Some(id) => format!("message:{id}"),
        None => source_identity.to_string(),
    };
    let session_id: Option<String> = match first_value(&[
        gv(message, "sessionID"),
        gv(message, "sessionId"),
        gv(message, "session_id"),
    ]) {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    };
    let model_val = gv(message, "model");
    let model_str = match model_val {
        Some(Value::String(_)) => model_val,
        _ => None,
    };
    let model_record = as_record(model_val);
    let model = extract_model(&[
        gv(message, "modelID"),
        gv(message, "modelId"),
        gv(message, "model_id"),
        model_str,
        model_record.and_then(|r| gv(r, "id")),
        model_record.and_then(|r| gv(r, "modelID")),
        model_record.and_then(|r| gv(r, "modelId")),
    ]);
    let message_time = as_record(gv(message, "time"));
    let message_path = as_record(gv(message, "path"));
    let nonempty_str = |v: Option<&Value>| -> Option<String> {
        match v {
            Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
            _ => None,
        }
    };
    let workspace: Option<String> = nonempty_str(message_path.and_then(|p| gv(p, "cwd")))
        .or_else(|| nonempty_str(gv(message, "cwd")))
        .or_else(|| nonempty_str(gv(message, "workspace")))
        .or_else(|| fallback_workspace.filter(|s| !s.is_empty()).map(|s| s.to_string()));

    let timestamp = extract_timestamp(&[
        gv(message, "timestamp"),
        gv(message, "timeCreated"),
        message_time.and_then(|t| gv(t, "created")),
        fallback_timestamp,
    ]);

    let event = apply_pricing(UsageEvent {
        id: stable_id(&["opencode", key.as_str()]).into(),
        agent: AgentId::Opencode,
        model: model.map(Into::into),
        timestamp: timestamp.into(),
        input_tokens: buckets.input_tokens,
        output_tokens: buckets.output_tokens,
        cache_read_tokens: buckets.cache_read_tokens,
        cache_write_tokens: buckets.cache_write_tokens,
        workspace: workspace.map(Into::into),
        source_path: source_path.to_string().into(),
        estimated: if estimated { Some(true) } else { None },
        // Carry the extractor's cache-presence verdict; the synthesized
        // total-only fallback above never sets it, which is correct.
        cache_reported: if buckets.cache_reported == Some(true) { Some(true) } else { None },
        ..Default::default()
    });
    Some(Parsed { key, event, session_id })
}

fn index_event(index: &mut EventIndex, parsed: Parsed, priority: u32, kind: Kind) {
    let replace = match index.get(&parsed.key) {
        Some(current) => priority >= current.priority,
        None => true,
    };
    if replace {
        // IndexMap::insert keeps the original insertion position of an existing key,
        // like `Map.prototype.set`.
        index.insert(parsed.key, IndexedEvent { event: parsed.event, priority, kind, session_id: parsed.session_id });
    }
}

// ---------------------------------------------------------------------------
// Legacy JSON / JSONL files
// ---------------------------------------------------------------------------

async fn parse_json_files(roots: &[String], index: &mut EventIndex) {
    for root in roots {
        if !path_exists(root).await {
            continue;
        }
        let files = walk_files(
            root,
            WalkOptions::new()
                .max_depth(10)
                .matching(|name, _| name.ends_with(".jsonl") || (name.ends_with(".json") && name.contains("message"))),
        )
        .await;

        for file in files {
            // Cached by (size, mtime): unchanged files skip read + JSON.parse.
            let rows = if file.ends_with(".jsonl") {
                read_jsonl_cached(&file, None).await.ok().flatten()
            } else {
                read_json_cached(&file).await
            };
            let rows = match rows {
                Some(r) if !r.is_empty() => r,
                _ => continue,
            };

            let mut row_index: usize = 0;
            for row in rows.iter() {
                row_index += 1;
                let identity = match as_record(Some(row)).and_then(|r| r.get("id")) {
                    Some(Value::String(s)) if !js_trim(s).is_empty() => format!("message:{}", js_trim(s)),
                    _ => format!("file:{file}:{row_index}"),
                };
                if let Some(parsed) = parse_opencode_record(row, &file, &identity, None, None) {
                    index_event(index, parsed, 1, Kind::Message);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn sqlite_value(v: rusqlite::types::ValueRef<'_>) -> Value {
    use rusqlite::types::ValueRef;
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        // node:sqlite hands back a Uint8Array; no OpenCode field reads one.
        ValueRef::Blob(_) => Value::Null,
    }
}

/// `db.prepare(sql).all()` as JSON objects keyed by column name.
fn query_rows(conn: &rusqlite::Connection, sql: &str) -> rusqlite::Result<Vec<Map<String, Value>>> {
    let mut stmt = conn.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().into_iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut m = Map::new();
        for (i, name) in names.iter().enumerate() {
            m.insert(name.clone(), sqlite_value(row.get_ref(i)?));
        }
        out.push(m);
    }
    Ok(out)
}

fn table_columns(conn: &rusqlite::Connection, table: &str) -> rusqlite::Result<HashSet<String>> {
    let rows = query_rows(conn, &format!("PRAGMA table_info({})", quote_identifier(table)))?;
    Ok(rows
        .iter()
        .filter_map(|r| match r.get("name") {
            Some(Value::String(s)) => Some(s.clone()),
            _ => None,
        })
        .collect())
}

/// `String(v)` for the ids SQLite can hand back; empty for anything else.
fn record_id_string(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => js_num_to_string(n.as_f64().unwrap_or(0.0)),
        _ => String::new(),
    }
}

/// Parse a stored model value: a JSON-looking string becomes its parsed form.
fn parse_model_value(raw: Option<&Value>) -> Option<Value> {
    let mut value = match raw {
        Some(Value::Null) | None => return None,
        Some(v) => v.clone(),
    };
    if let Value::String(s) = &value {
        if s.starts_with('{') {
            if let Ok(parsed) = serde_json::from_str::<Value>(s) {
                value = parsed;
            }
        }
    }
    Some(value)
}

async fn parse_open_code_database(db_path: String, index: EventIndex) -> EventIndex {
    tokio::task::spawn_blocking(move || {
        let mut index = index;
        // OpenCode may be running or the file may be an older/non-SQLite installation.
        let _ = parse_open_code_database_blocking(&db_path, &mut index);
        index
    })
    .await
    .unwrap_or_default()
}

fn parse_open_code_database_blocking(db_path: &str, index: &mut EventIndex) -> rusqlite::Result<()> {
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let tables = query_rows(&conn, "SELECT name FROM sqlite_master WHERE type = 'table'")?;
    let table_names: HashSet<String> = tables
        .iter()
        .filter_map(|r| match r.get("name") {
            Some(Value::String(s)) => Some(s.clone()),
            _ => None,
        })
        .collect();
    let mut session_rollups: IndexMap<String, SessionRollup> = IndexMap::new();

    if table_names.contains("session_v2") {
        let session_columns = table_columns(&conn, "session_v2")?;
        if session_columns.contains("id") {
            let session_column = |name: &str| -> String {
                if session_columns.contains(name) {
                    quote_identifier(name)
                } else {
                    "NULL".to_string()
                }
            };
            let sql = format!(
                "
              SELECT
                {} AS id,
                {} AS directory,
                {} AS model,
                {} AS created_at,
                {} AS updated_at,
                {} AS input_tokens,
                {} AS output_tokens,
                {} AS reasoning_tokens,
                {} AS cache_read_tokens,
                {} AS cache_write_tokens
              FROM \"session_v2\"
            ",
                session_column("id"),
                session_column("directory"),
                session_column("model"),
                session_column("time_created"),
                session_column("time_updated"),
                session_column("tokens_input"),
                session_column("tokens_output"),
                session_column("tokens_reasoning"),
                session_column("tokens_cache_read"),
                session_column("tokens_cache_write"),
            );
            let cache_reported =
                session_columns.contains("tokens_cache_read") || session_columns.contains("tokens_cache_write");
            for session in query_rows(&conn, &sql)? {
                let id = match session.get("id") {
                    Some(Value::String(s)) => s.clone(),
                    _ => continue,
                };
                let keep = |k: &str| -> Option<Value> {
                    match session.get(k) {
                        Some(Value::Null) | None => None,
                        Some(v) => Some(v.clone()),
                    }
                };
                session_rollups.insert(
                    id,
                    SessionRollup {
                        directory: match session.get("directory") {
                            Some(Value::String(s)) => Some(s.clone()),
                            _ => None,
                        },
                        model: keep("model"),
                        created_at: keep("created_at"),
                        updated_at: keep("updated_at"),
                        input_tokens: num_of(session.get("input_tokens")),
                        output_tokens: num_of(session.get("output_tokens")),
                        reasoning_tokens: num_of(session.get("reasoning_tokens")),
                        cache_read_tokens: num_of(session.get("cache_read_tokens")),
                        cache_write_tokens: num_of(session.get("cache_write_tokens")),
                        // The session_v2 table exposed cache columns => its rollup measured
                        // cache (even 0); absent columns mean OpenCode never stored it.
                        cache_reported,
                    },
                );
            }
        }
    }

    for table in ["message", "session_message"] {
        if !table_names.contains(table) {
            continue;
        }
        let columns = table_columns(&conn, table)?;
        if !columns.contains("data") {
            continue;
        }

        let column = |name: &str| -> String {
            if columns.contains(name) {
                quote_identifier(name)
            } else {
                "NULL".to_string()
            }
        };
        let payload = format!(
            "CASE WHEN json_valid({0}) THEN {0} ELSE '{{}}' END",
            quote_identifier("data")
        );
        let json = |path: &str| format!("json_extract(payload, '{path}')");
        let id_expression = if columns.contains("id") { quote_identifier("id") } else { "rowid".to_string() };
        let role_expression = format!("LOWER(CAST(COALESCE({}, message_type, '') AS TEXT))", json("$.role"));
        let sql = format!(
            "
          WITH records AS (
            SELECT
              {id_expression} AS record_id,
              {session_id} AS session_id,
              {message_type} AS message_type,
              {row_timestamp} AS row_timestamp,
              {payload} AS payload
            FROM {table}
          )
          SELECT
            record_id,
            session_id,
            message_type,
            row_timestamp,
            {model_id} AS model_id,
            {model_id_alt} AS model_id_alt,
            {nested_model_id} AS nested_model_id,
            {nested_model_id_alt} AS nested_model_id_alt,
            {model_value} AS model_value,
            {cwd} AS cwd,
            {cwd_alt} AS cwd_alt,
            {workspace} AS workspace,
            {message_created} AS message_created,
            {message_timestamp} AS message_timestamp,
            {input_tokens} AS input_tokens,
            {input_tokens_alt} AS input_tokens_alt,
            {output_tokens} AS output_tokens,
            {reasoning_tokens} AS reasoning_tokens,
            {cache_read_tokens} AS cache_read_tokens,
            {cache_write_tokens} AS cache_write_tokens,
            {total_tokens} AS total_tokens
          FROM records
          WHERE {role_expression} = 'assistant'
        ",
            session_id = column("session_id"),
            message_type = column("type"),
            row_timestamp = column("time_created"),
            table = quote_identifier(table),
            model_id = json("$.modelID"),
            model_id_alt = json("$.modelId"),
            nested_model_id = json("$.model.id"),
            nested_model_id_alt = json("$.model.modelID"),
            model_value = json("$.model"),
            cwd = json("$.path.cwd"),
            cwd_alt = json("$.cwd"),
            workspace = json("$.workspace"),
            message_created = json("$.time.created"),
            message_timestamp = json("$.timestamp"),
            input_tokens = json("$.tokens.input"),
            input_tokens_alt = json("$.tokens.input_tokens"),
            output_tokens = json("$.tokens.output"),
            reasoning_tokens = json("$.tokens.reasoning"),
            cache_read_tokens = json("$.tokens.cache.read"),
            cache_write_tokens = json("$.tokens.cache.write"),
            total_tokens = json("$.tokens.total"),
        );
        let rows = query_rows(&conn, &sql)?;
        let priority: u32 = if table == "session_message" { 3 } else { 2 };

        for row in rows {
            let message_id = record_id_string(row.get("record_id"));
            let session_id = match row.get("session_id") {
                Some(Value::String(s)) => s.clone(),
                _ => String::new(),
            };
            let model_value = parse_model_value(row.get("model_value"));
            let model_value_record = as_record(model_value.as_ref());
            let model_value_string: Option<&Value> = match &model_value {
                Some(v @ Value::String(_)) => Some(v),
                _ => None,
            };
            let rollup_dir: Option<Value> = if session_id.is_empty() {
                None
            } else {
                session_rollups
                    .get(&session_id)
                    .and_then(|r| r.directory.clone())
                    .map(Value::String)
            };
            let g = |k: &str| gv(&row, k);

            let mut cache = Map::new();
            cache.insert("read".to_string(), g("cache_read_tokens").cloned().unwrap_or(Value::Null));
            cache.insert("write".to_string(), g("cache_write_tokens").cloned().unwrap_or(Value::Null));
            let mut tokens = Map::new();
            tokens.insert("input".to_string(), fv(&[g("input_tokens"), g("input_tokens_alt")]));
            tokens.insert("output".to_string(), g("output_tokens").cloned().unwrap_or(Value::Null));
            tokens.insert("reasoning".to_string(), g("reasoning_tokens").cloned().unwrap_or(Value::Null));
            tokens.insert("total".to_string(), g("total_tokens").cloned().unwrap_or(Value::Null));
            tokens.insert("cache".to_string(), Value::Object(cache));
            let mut path = Map::new();
            path.insert(
                "cwd".to_string(),
                fv(&[g("cwd"), g("cwd_alt"), g("workspace"), rollup_dir.as_ref()]),
            );
            let mut time = Map::new();
            time.insert("created".to_string(), fv(&[g("message_created"), g("message_timestamp")]));

            let mut record = Map::new();
            record.insert("id".to_string(), Value::String(message_id.clone()));
            record.insert("role".to_string(), Value::String("assistant".to_string()));
            record.insert("modelID".to_string(), fv(&[g("model_id"), g("model_id_alt")]));
            record.insert(
                "model".to_string(),
                fv(&[
                    g("nested_model_id"),
                    g("nested_model_id_alt"),
                    model_value_string,
                    model_value_record.and_then(|r| gv(r, "id")),
                    model_value_record.and_then(|r| gv(r, "modelID")),
                ]),
            );
            record.insert("path".to_string(), Value::Object(path));
            record.insert("sessionID".to_string(), Value::String(session_id.clone()));
            record.insert("time".to_string(), Value::Object(time));
            record.insert("tokens".to_string(), Value::Object(tokens));

            let identity = if !message_id.is_empty() {
                format!("message:{message_id}")
            } else {
                let ts = match g("row_timestamp") {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Number(n)) => js_num_to_string(n.as_f64().unwrap_or(0.0)),
                    _ => String::new(),
                };
                format!("database:{db_path}:{table}:{ts}")
            };
            if let Some(parsed) =
                parse_opencode_record(&Value::Object(record), db_path, &identity, g("row_timestamp"), None)
            {
                index_event(index, parsed, priority, Kind::Message);
            }
        }
    }

    // OpenCode compacts old messages, but session_v2 keeps cumulative usage.
    // Add only the positive difference so compacted history remains included.
    let mut details_by_session: IndexMap<String, SessionDetail> = IndexMap::new();
    for indexed in index.values() {
        if indexed.kind != Kind::Message {
            continue;
        }
        let sid = match &indexed.session_id {
            Some(s) if !s.is_empty() => s,
            _ => continue,
        };
        let detail = details_by_session.entry(sid.clone()).or_default();
        detail.input_tokens += indexed.event.input_tokens;
        detail.output_tokens += indexed.event.output_tokens;
        detail.cache_read_tokens += indexed.event.cache_read_tokens;
        detail.cache_write_tokens += indexed.event.cache_write_tokens;
        if let Some(m) = &indexed.event.model {
            if !m.is_empty() && !detail.models.contains(&m.to_string()) {
                detail.models.push(m.to_string());
            }
        }
    }

    for (session_id, rollup) in &session_rollups {
        let detail = details_by_session.get(session_id);
        let d = |f: fn(&SessionDetail) -> f64| detail.map_or(0.0, f);
        let input_tokens = (rollup.input_tokens - d(|x| x.input_tokens)).max(0.0);
        let output_tokens = (rollup.output_tokens + rollup.reasoning_tokens - d(|x| x.output_tokens)).max(0.0);
        let cache_read_tokens = (rollup.cache_read_tokens - d(|x| x.cache_read_tokens)).max(0.0);
        let cache_write_tokens = (rollup.cache_write_tokens - d(|x| x.cache_write_tokens)).max(0.0);
        if input_tokens + output_tokens + cache_read_tokens + cache_write_tokens <= 0.0 {
            continue;
        }

        let model_count = detail.map_or(0, |x| x.models.len());
        let mut model: Option<String> = None;
        if model_count == 1 {
            model = detail.and_then(|x| x.models.first().cloned());
        } else if model_count == 0 {
            let raw_model = parse_model_value(rollup.model.as_ref());
            let model_record = as_record(raw_model.as_ref());
            let raw_string: Option<&Value> = match &raw_model {
                Some(v @ Value::String(_)) => Some(v),
                _ => None,
            };
            model = extract_model(&[
                model_record.and_then(|r| gv(r, "id")),
                model_record.and_then(|r| gv(r, "modelID")),
                model_record.and_then(|r| gv(r, "modelId")),
                raw_string,
            ]);
        }

        let key = format!("session-rollup:{session_id}");
        let event = apply_pricing(UsageEvent {
            id: stable_id(&["opencode", key.as_str()]).into(),
            agent: AgentId::Opencode,
            model: model.map(Into::into),
            timestamp: extract_timestamp(&[rollup.updated_at.as_ref(), rollup.created_at.as_ref()]).into(),
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
            workspace: rollup.directory.clone().map(Into::into),
            source_path: db_path.to_string().into(),
            estimated: Some(true),
            cache_reported: if rollup.cache_reported { Some(true) } else { None },
            ..Default::default()
        });
        index_event(
            index,
            Parsed { key, event, session_id: Some(session_id.clone()) },
            4,
            Kind::Rollup,
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

static DB_NAME: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^opencode(?:[-_].*)?\.(?:db|sqlite|sqlite3)$").expect("valid regex"));

/// OpenCode stores current usage in SQLite and older installs in JSON/JSONL.
pub async fn parse_opencode(roots: Vec<String>) -> anyhow::Result<Vec<UsageEvent>> {
    let mut index: EventIndex = IndexMap::new();

    // Keep legacy JSON support. Database rows have higher priority for duplicate message IDs.
    parse_json_files(&roots, &mut index).await;

    for root in &roots {
        if !path_exists(root).await {
            continue;
        }
        let databases = walk_files(root, WalkOptions::new().max_depth(2).matching(|name, _| DB_NAME.is_match(name))).await;
        for db_path in databases {
            index = parse_open_code_database(db_path, index).await;
        }
    }

    Ok(index.into_values().map(|i| i.event).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::to_iso_string;
    use rusqlite::{params, Connection};

    const CREATED_AT: i64 = 1_780_000_000_000;

    fn create_message_database(db_path: &str) -> Connection {
        let db = Connection::open(db_path).unwrap();
        db.execute_batch(
            "
            CREATE TABLE message (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              time_created INTEGER NOT NULL,
              data TEXT NOT NULL
            );
            CREATE TABLE session_message (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              type TEXT NOT NULL,
              seq INTEGER NOT NULL,
              time_created INTEGER NOT NULL,
              time_updated INTEGER NOT NULL,
              data TEXT NOT NULL
            );
            CREATE TABLE session_v2 (
              id TEXT PRIMARY KEY,
              directory TEXT NOT NULL,
              model TEXT,
              time_created INTEGER,
              time_updated INTEGER,
              tokens_input INTEGER,
              tokens_output INTEGER,
              tokens_reasoning INTEGER,
              tokens_cache_read INTEGER,
              tokens_cache_write INTEGER
            );
            ",
        )
        .unwrap();
        db
    }

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "opencode");
        assert_eq!(a.label, "OpenCode");
    }

    #[tokio::test]
    async fn reads_v2_sqlite_usage_and_deduplicates_migrated_messages() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let db_path = dir.path().join("opencode.db").to_string_lossy().to_string();
        {
            let db = create_message_database(&db_path);
            db.execute(
                "INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    "session-1",
                    "C:\\Dev\\sample",
                    serde_json::json!({"providerID": "openai", "id": "openai/gpt-5"}).to_string(),
                    CREATED_AT,
                    CREATED_AT + 10,
                    180,
                    40,
                    7,
                    30,
                    5
                ],
            )
            .unwrap();
            db.execute(
                "INSERT INTO message VALUES (?, ?, ?, ?)",
                params![
                    "msg-overlap",
                    "session-1",
                    CREATED_AT,
                    serde_json::json!({
                        "role": "assistant",
                        "modelID": "legacy-model",
                        "time": {"created": CREATED_AT},
                        "tokens": {"total": 185, "input": 120, "output": 20, "reasoning": 10, "cache": {"read": 30, "write": 5}},
                    })
                    .to_string()
                ],
            )
            .unwrap();
            let sm = "INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)";
            db.execute(
                sm,
                params![
                    "msg-overlap",
                    "session-1",
                    "assistant",
                    1,
                    CREATED_AT,
                    CREATED_AT,
                    serde_json::json!({
                        "agent": "build",
                        "model": {"providerID": "openai", "id": "openai/gpt-5"},
                        "time": {"created": CREATED_AT},
                        "tokens": {"input": 100, "output": 20, "reasoning": 7, "cache": {"read": 25, "write": 5}},
                    })
                    .to_string()
                ],
            )
            .unwrap();
            db.execute(
                sm,
                params![
                    "msg-reasoning-only",
                    "session-1",
                    "assistant",
                    2,
                    CREATED_AT + 1,
                    CREATED_AT + 1,
                    serde_json::json!({
                        "model": {"providerID": "openai", "id": "openai/gpt-5"},
                        "time": {"created": CREATED_AT + 1},
                        "tokens": {"input": 50, "output": 0, "reasoning": 8, "cache": {"read": 0, "write": 0}},
                    })
                    .to_string()
                ],
            )
            .unwrap();
            db.execute(
                sm,
                params![
                    "msg-user",
                    "session-1",
                    "user",
                    3,
                    CREATED_AT + 2,
                    CREATED_AT + 2,
                    serde_json::json!({
                        "time": {"created": CREATED_AT + 2},
                        "tokens": {"input": 999, "output": 999, "reasoning": 0, "cache": {"read": 0, "write": 0}},
                    })
                    .to_string()
                ],
            )
            .unwrap();
        }

        let legacy_dir = dir.path().join("storage").join("message").join("session-1");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        std::fs::write(
            legacy_dir.join("message-msg-overlap.json"),
            serde_json::json!({
                "id": "msg-overlap",
                "role": "assistant",
                "modelID": "old-json-model",
                "tokens": {"input": 1, "output": 1, "reasoning": 0, "cache": {"read": 0, "write": 0}},
            })
            .to_string(),
        )
        .unwrap();

        let events = parse_opencode(vec![root]).await.unwrap();
        assert_eq!(events.len(), 3, "detail rows are deduplicated and the compacted-session gap is filled");

        let overlap = events.iter().find(|e| e.input_tokens == 100.0).expect("overlap");
        assert_eq!(overlap.model.as_deref(), Some("gpt-5"));
        assert_eq!(overlap.timestamp, to_iso_string(CREATED_AT as f64).unwrap());
        assert_eq!(overlap.workspace.as_deref(), Some("C:\\Dev\\sample"));
        assert_eq!(overlap.output_tokens, 27.0, "reasoning is added to visible output exactly once");
        assert_eq!(overlap.cache_read_tokens, 25.0);
        assert_eq!(overlap.cache_write_tokens, 5.0);
        assert_eq!(overlap.total_tokens, 157.0);
        assert_eq!(overlap.source_path, db_path);

        let reasoning_only = events.iter().find(|e| e.input_tokens == 50.0).expect("reasoning only");
        assert_eq!(reasoning_only.output_tokens, 8.0);
        assert_eq!(reasoning_only.total_tokens, 58.0);

        let gap = events.iter().find(|e| e.estimated == Some(true)).expect("compacted gap");
        assert_eq!(gap.input_tokens, 30.0);
        assert_eq!(gap.output_tokens, 12.0);
        assert_eq!(gap.cache_read_tokens, 5.0);
        assert_eq!(gap.cache_write_tokens, 0.0);
        assert_eq!(gap.total_tokens, 47.0);
        assert_eq!(gap.workspace.as_deref(), Some("C:\\Dev\\sample"));
    }

    #[tokio::test]
    async fn falls_back_to_the_legacy_sqlite_message_table() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let db_path = dir.path().join("opencode.db").to_string_lossy().to_string();
        {
            let db = Connection::open(&db_path).unwrap();
            db.execute_batch(
                "CREATE TABLE message (
                   id TEXT PRIMARY KEY,
                   session_id TEXT NOT NULL,
                   time_created INTEGER NOT NULL,
                   data TEXT NOT NULL
                 );",
            )
            .unwrap();
            db.execute(
                "INSERT INTO message VALUES (?, ?, ?, ?)",
                params![
                    "msg-v1",
                    "session-v1",
                    CREATED_AT,
                    serde_json::json!({
                        "role": "assistant",
                        "modelID": "legacy-model",
                        "path": {"cwd": "C:\\Dev\\legacy"},
                        "time": {"created": CREATED_AT},
                        "tokens": {"total": 185, "input": 120, "output": 20, "reasoning": 10, "cache": {"read": 30, "write": 5}},
                    })
                    .to_string()
                ],
            )
            .unwrap();
        }

        let events = parse_opencode(vec![root]).await.unwrap();
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.model.as_deref(), Some("legacy-model"));
        assert_eq!(e.workspace.as_deref(), Some("C:\\Dev\\legacy"));
        assert_eq!(e.input_tokens, 120.0);
        assert_eq!(e.output_tokens, 30.0);
        assert_eq!(e.cache_read_tokens, 30.0);
        assert_eq!(e.cache_write_tokens, 5.0);
        assert_eq!(e.total_tokens, 185.0);
        // The row carried a cache object, so it measured cache.
        assert_eq!(e.cache_reported, Some(true));
    }

    #[tokio::test]
    async fn keeps_support_for_legacy_json_message_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let message_dir = dir.path().join("storage").join("message").join("session-json");
        std::fs::create_dir_all(&message_dir).unwrap();
        std::fs::write(
            message_dir.join("message-json-only.json"),
            serde_json::json!({
                "id": "msg-json-only",
                "role": "assistant",
                "modelID": "legacy-json-model",
                "time": {"created": CREATED_AT},
                "tokens": {"input": 10, "output": 5, "reasoning": 2, "cache": {"read": 3, "write": 1}},
            })
            .to_string(),
        )
        .unwrap();

        let events = parse_opencode(vec![root]).await.unwrap();
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.model.as_deref(), Some("legacy-json-model"));
        assert_eq!(e.input_tokens, 10.0);
        assert_eq!(e.output_tokens, 7.0);
        assert_eq!(e.cache_read_tokens, 3.0);
        assert_eq!(e.cache_write_tokens, 1.0);
        assert_eq!(e.total_tokens, 21.0);
    }

    #[test]
    fn total_only_row_is_estimated_input() {
        let rec = serde_json::json!({"role": "assistant", "id": " m1 ", "tokens": {"total": 42}});
        let p = parse_opencode_record(&rec, "src", "fallback", None, Some("/ws")).unwrap();
        assert_eq!(p.key, "message:m1");
        assert_eq!(p.event.input_tokens, 42.0);
        assert_eq!(p.event.estimated, Some(true));
        assert_eq!(p.event.workspace.as_deref(), Some("/ws"));
        let user = serde_json::json!({"role": "user", "tokens": {"input": 1}});
        assert!(parse_opencode_record(&user, "src", "k", None, None).is_none());
    }
}
