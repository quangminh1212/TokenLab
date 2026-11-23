//! Agent: Hermes Agent (port of `src/agents/hermes/index.ts`).
//!
//! Hermes Agent (`%LOCALAPPDATA%/hermes` / `~/.hermes`).
//! Policy: prefer over-count over missing usage.
//! - session_model_usage (per-model) + gap-fill from sessions when session total is higher
//! - Always bill reasoning_tokens on top of output (Hermes stores them separately)
//! - state-snapshots: only sessions NOT already covered by live state.db (no double-count)
//! - JSONL only under sessions/ (skip node_modules / venv noise)

use crate::agents::shared::env::{path_env, unique};
use crate::agents::shared::usage_fields::{
    extract_model, extract_timestamp, extract_token_buckets, resolve_span_ms, split_usage_row, SplittableUsage,
};
use crate::agents::{parse_fn, AgentModule};
use crate::pricing::{apply_pricing, apply_pricing_with};
use crate::types::{AgentId, UsageEvent};
use crate::util::{
    env_nonempty, js_num_to_string, js_number_from_str, js_trim, num, path_exists, path_exists_sync, read_json_cached,
    read_jsonl_cached, stable_id, stamp_from_metadata, walk_files, walk_files_sync, PathFlavor, WalkOptions,
};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

/// Local data roots to scan on this machine.
pub fn roots() -> Vec<String> {
    let e = path_env();
    let mut r: Vec<String> = Vec::new();
    r.push(e.expand_home(&env_nonempty("HERMES_HOME").unwrap_or_else(|| e.j(&[&e.local_app, "hermes"]))));
    r.push(e.j(&[&e.local_app, "hermes"]));
    r.push(e.j(&[&e.home, ".hermes"]));
    r.push(e.j(&[&e.app_data, "hermes"]));
    r.push(e.j(&[&e.xdg_data, "hermes"]));
    r.push(e.j(&[&e.xdg_config, "hermes"]));
    unique(r)
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Hermes,
        label: "Hermes Agent",
        roots,
        parse: parse_fn(parse_hermes),
        parse_light: Some(parse_fn(parse_hermes_light)),
    }
}

// ---------------------------------------------------------------------------
// JS-ish row helpers (rows are `serde_json::Value::Object`s)
// ---------------------------------------------------------------------------

/// `row[key]` with `undefined` and `null` both mapped to `None` (what `??` / `!= null` skip).
fn get<'a>(row: &'a Value, key: &str) -> Option<&'a Value> {
    match row.get(key) {
        Some(Value::Null) | None => None,
        Some(v) => Some(v),
    }
}

/// `row[a] ?? row[b] ?? ...`
fn co<'a>(row: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| get(row, k))
}

/// `num(row[a] ?? row[b] ?? ...)`
fn numco(row: &Value, keys: &[&str]) -> f64 {
    co(row, keys).map_or(0.0, num)
}

/// `typeof row[key] === "string" ? row[key] : null`
fn str_of<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    match row.get(key) {
        Some(Value::String(s)) => Some(s.as_str()),
        _ => None,
    }
}

/// `String(v)` for the primitives SQLite / JSON rows can carry.
fn js_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => js_num_to_string(n.as_f64().unwrap_or(0.0)),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}

/// `Number(v)` for the primitives SQLite rows can carry (NaN when not numeric).
fn js_number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => js_number_from_str(s),
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Null => 0.0,
        _ => f64::NAN,
    }
}

fn sqlite_value(v: rusqlite::types::ValueRef<'_>) -> Value {
    use rusqlite::types::ValueRef;
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        // node:sqlite hands back a Uint8Array; no Hermes field reads one.
        ValueRef::Blob(_) => Value::Null,
    }
}

/// `db.prepare(sql).all()` as JSON objects keyed by column name.
fn query_rows(conn: &rusqlite::Connection, sql: &str) -> rusqlite::Result<Vec<Value>> {
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

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn is_gateway_alias(model: &str) -> bool {
    let m = js_trim(model).to_lowercase();
    m == "xlab" || m == "hermes" || m == "default" || m == "auto" || m == "custom"
}

/// `JSON.parse(String(row[key])).model` when it is a string (None for any other shape / parse error).
fn config_model(row: &Value, key: &str) -> Option<String> {
    let raw = str_of(row, key)?;
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(o)) => match o.get("model") {
            Some(Value::String(s)) => Some(s.clone()),
            _ => None,
        },
        _ => None,
    }
}

/// Prefer actual_cost_usd, then estimated_cost_usd when positive.
fn pick_hermes_cost(row: &Value) -> Option<f64> {
    for key in ["actual_cost_usd", "estimated_cost_usd", "cost_usd", "cost"] {
        let Some(v) = get(row, key) else { continue };
        let n = js_number(v);
        if n.is_finite() && n > 0.0 {
            return Some(n);
        }
    }
    None
}

struct HermesBuckets {
    input_tokens: f64,
    output_tokens: f64,
    cache_read_tokens: f64,
    cache_write_tokens: f64,
    cache_reported: bool,
}

fn token_buckets_from_hermes_row(row: &Value) -> Option<HermesBuckets> {
    const CACHE_READ_KEYS: [&str; 6] = [
        "cache_read_tokens",
        "cache_read_input_tokens",
        "cacheReadTokens",
        "cached_tokens",
        "cachedTokens",
        "cached_content_token_count",
    ];
    const CACHE_WRITE_KEYS: [&str; 4] =
        ["cache_write_tokens", "cache_creation_input_tokens", "cacheWriteTokens", "cache_creation_tokens"];
    let input_tokens = numco(row, &["input_tokens", "total_input_tokens", "prompt_tokens", "inputTokens"]);
    let mut output_tokens = numco(row, &["output_tokens", "total_output_tokens", "completion_tokens", "outputTokens"]);
    let cache_read_tokens = numco(row, &CACHE_READ_KEYS);
    let cache_write_tokens = numco(row, &CACHE_WRITE_KEYS);
    // Presence, not magnitude: a row carrying any cache key measured cache, even 0.
    let cache_reported = CACHE_READ_KEYS.iter().chain(CACHE_WRITE_KEYS.iter()).any(|k| get(row, k).is_some());
    // Hermes stores reasoning separately; always bill it as output.
    let reasoning = numco(row, &["reasoning_tokens", "reasoningTokens"]);
    if reasoning > 0.0 {
        output_tokens += reasoning;
    }
    if input_tokens + output_tokens + cache_read_tokens + cache_write_tokens <= 0.0 {
        return None;
    }
    Some(HermesBuckets { input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_reported })
}

fn base_event(id: String, model: Option<String>, workspace: Option<String>, source_path: &str) -> UsageEvent {
    UsageEvent {
        id,
        agent: AgentId::Hermes,
        model,
        workspace,
        source_path: source_path.to_string(),
        ..UsageEvent::default()
    }
}

// ---------------------------------------------------------------------------
// Full parse
// ---------------------------------------------------------------------------

pub async fn parse_hermes(roots: Vec<String>) -> anyhow::Result<Vec<UsageEvent>> {
    let flavor = PathFlavor::host();
    let mut events: Vec<UsageEvent> = Vec::new();
    let mut seen_db: HashSet<String> = HashSet::new();
    // Session ids already counted from a preferred (live) DB - snapshots must skip these.
    let mut covered_sessions: HashSet<String> = HashSet::new();

    for root in &roots {
        if !path_exists(root).await {
            continue;
        }

        let (primary, snapshots) = discover_hermes_db_paths(root).await;

        // 1) Live / primary DBs first (full read)
        for db_path in primary {
            let key = flavor.resolve(&[db_path.as_str()]).to_lowercase();
            if !seen_db.insert(key) {
                continue;
            }
            let (ev, session_ids) = parse_hermes_sqlite(db_path, None).await;
            events.extend(ev);
            covered_sessions.extend(session_ids);
        }

        // 2) Snapshots only for sessions missing from live (history after prune / migrate)
        for db_path in snapshots {
            let key = flavor.resolve(&[db_path.as_str()]).to_lowercase();
            if !seen_db.insert(key) {
                continue;
            }
            let (ev, session_ids) = parse_hermes_sqlite(db_path, Some(covered_sessions.clone())).await;
            events.extend(ev);
            covered_sessions.extend(session_ids);
        }

        // JSONL / session JSON under sessions/ only (not hermes-agent source trees)
        let sessions_dir = flavor.join(&[root.as_str(), "sessions"]);
        if path_exists(&sessions_dir).await {
            let files =
                walk_files(&sessions_dir, WalkOptions::new().max_depth(6).matching(|n, _| hermes_session_file(n))).await;
            for file in files {
                events.extend(parse_hermes_json_file(&file).await);
            }
        }
    }

    Ok(events)
}

fn hermes_session_file(name: &str) -> bool {
    name.ends_with(".jsonl") || (name.contains("session") && name.ends_with(".json"))
}

fn is_snapshot_db_path(db_path: &str) -> bool {
    let p = db_path.to_lowercase().replace('\\', "/");
    p.contains("/state-snapshots/") || p.contains("/snapshots/") || p.contains("/state-snapshot/")
}

const HERMES_DB_NAMES: [&str; 3] = ["state.db", "hermes.db", "sessions.db"];

fn dedupe_paths(list: Vec<String>) -> Vec<String> {
    let flavor = PathFlavor::host();
    let mut seen: HashSet<String> = HashSet::new();
    let mut uniq: Vec<String> = Vec::new();
    for p in list {
        let k = flavor.resolve(&[p.as_str()]).to_lowercase();
        if !seen.insert(k) {
            continue;
        }
        uniq.push(p);
    }
    uniq
}

/// Discover SQLite DBs: primary (live) first, then historical snapshots.
async fn discover_hermes_db_paths(root: &str) -> (Vec<String>, Vec<String>) {
    let flavor = PathFlavor::host();
    let mut primary: Vec<String> = Vec::new();
    let mut snapshots: Vec<String> = Vec::new();

    for name in HERMES_DB_NAMES {
        let p = flavor.join(&[root, name]);
        if path_exists(&p).await {
            primary.push(p);
        }
    }

    // Nested DBs: state-snapshots for history not in live DB
    let nested = walk_files(root, WalkOptions::new().max_depth(5).matching(|n, _| HERMES_DB_NAMES.contains(&n))).await;
    for p in nested {
        let base = flavor.basename(&p).to_lowercase();
        if !HERMES_DB_NAMES.iter().any(|n| n.to_lowercase() == base) {
            continue;
        }
        let lower = p.to_lowercase();
        // Skip .bak / emergency pre-update copies
        if lower.contains(".bak") {
            continue;
        }
        if lower.contains("pre-update-emergency") {
            continue;
        }
        if is_snapshot_db_path(&p) {
            snapshots.push(p);
        } else {
            // Nested non-snapshot (e.g. profiles/*/state.db) - treat as primary only if not already listed
            primary.push(p);
        }
    }

    (dedupe_paths(primary), dedupe_paths(snapshots))
}

async fn parse_hermes_json_file(file: &str) -> Vec<UsageEvent> {
    let mut events: Vec<UsageEvent> = Vec::new();
    // Cached by (size, mtime): unchanged files skip read + JSON.parse.
    let rows: Vec<Value> = if file.ends_with(".jsonl") {
        match read_jsonl_cached(file, None).await {
            Ok(Some(r)) => (*r).clone(),
            _ => Vec::new(),
        }
    } else {
        match read_json_cached(file).await {
            Some(r) => (*r).clone(),
            None => Vec::new(),
        }
    };
    if rows.is_empty() {
        return events;
    }

    let mut idx = 0usize;
    for r in &rows {
        idx += 1;
        if !matches!(r, Value::Object(_)) {
            continue;
        }
        let idx_s = idx.to_string();
        let usage = co(r, &["usage", "token_usage"]).unwrap_or(r);
        let workspace = str_of(r, "cwd").map(|s| s.to_string());
        match extract_token_buckets(Some(usage)) {
            None => {
                let input_tokens = numco(r, &["input_tokens", "total_input_tokens", "prompt_tokens"]);
                let output_tokens = numco(r, &["output_tokens", "total_output_tokens", "completion_tokens"]);
                let cache_read_tokens = numco(r, &["cache_read_tokens", "cache_read_input_tokens"]);
                let cache_write_tokens = numco(r, &["cache_write_tokens", "cache_creation_input_tokens"]);
                if input_tokens + output_tokens + cache_read_tokens + cache_write_tokens <= 0.0 {
                    continue;
                }
                // Did the row carry a cache key at all? A present-but-zero value is a
                // measurement; an absent one is silence the dashboard must not colour in.
                let cache_reported = co(
                    r,
                    &["cache_read_tokens", "cache_read_input_tokens", "cache_write_tokens", "cache_creation_input_tokens"],
                )
                .is_some();
                let in_s = js_num_to_string(input_tokens);
                let out_s = js_num_to_string(output_tokens);
                let mut ev = base_event(
                    stable_id(&["hermes", file, idx_s.as_str(), in_s.as_str(), out_s.as_str()]),
                    extract_model(&[Some(r)]),
                    workspace,
                    file,
                );
                ev.timestamp = extract_timestamp(&[Some(r)]);
                ev.input_tokens = input_tokens;
                ev.output_tokens = output_tokens;
                ev.cache_read_tokens = cache_read_tokens;
                ev.cache_write_tokens = cache_write_tokens;
                if cache_reported {
                    ev.cache_reported = Some(true);
                }
                events.push(apply_pricing(ev));
            }
            Some(b) => {
                let in_s = js_num_to_string(b.input_tokens);
                let out_s = js_num_to_string(b.output_tokens);
                let mut ev = base_event(
                    stable_id(&["hermes", file, idx_s.as_str(), in_s.as_str(), out_s.as_str()]),
                    extract_model(&[Some(r)]),
                    workspace,
                    file,
                );
                ev.timestamp = extract_timestamp(&[Some(r)]);
                ev.input_tokens = b.input_tokens;
                ev.output_tokens = b.output_tokens;
                ev.cache_read_tokens = b.cache_read_tokens;
                ev.cache_write_tokens = b.cache_write_tokens;
                ev.cache_reported = b.cache_reported;
                // `inputIncludesCache` (also spread from the buckets in TS) has no
                // UsageEvent field in the Rust model.
                events.push(apply_pricing(ev));
            }
        }
    }
    events
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/// Read one Hermes DB on a blocking thread. `skip_session_ids` is set for
/// snapshots: any session already counted in a preferred DB is skipped.
async fn parse_hermes_sqlite(
    db_path: String,
    skip_session_ids: Option<HashSet<String>>,
) -> (Vec<UsageEvent>, Vec<String>) {
    tokio::task::spawn_blocking(move || parse_hermes_sqlite_blocking(&db_path, skip_session_ids.as_ref()))
        .await
        .unwrap_or_default()
}

fn parse_hermes_sqlite_blocking(db_path: &str, skip: Option<&HashSet<String>>) -> (Vec<UsageEvent>, Vec<String>) {
    let mut events: Vec<UsageEvent> = Vec::new();
    let mut session_ids: Vec<String> = Vec::new();
    // SQLite unavailable or locked db: skip.
    let conn = match rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(c) => c,
        Err(_) => return (events, session_ids),
    };
    let table_names: Vec<String> = match query_rows(&conn, "SELECT name FROM sqlite_master WHERE type='table'") {
        Ok(rows) => rows.iter().filter_map(|r| str_of(r, "name").map(|s| s.to_string())).collect(),
        Err(_) => return (events, session_ids),
    };
    let has = |name: &str| table_names.iter().any(|n| n.to_lowercase() == name.to_lowercase());

    let session_table: Option<&String> = table_names.iter().find(|n| n.to_lowercase() == "sessions").or_else(|| {
        table_names.iter().find(|n| {
            let l = n.to_lowercase();
            l.contains("session") && !l.contains("model")
        })
    });

    // 1) Per-model rollups (real model ids: Kimi-k3, claude-opus-4.8, ...)
    let mut smu_events: Vec<UsageEvent> = Vec::new();
    if has("session_model_usage") {
        read_session_model_usage(&conn, db_path, skip, &mut session_ids, &mut smu_events);
        events.extend(smu_events.iter().cloned());
    }

    // 2) Sessions: full rows when no SMU rows were emitted (also the snapshot case where
    // every SMU row overlapped a live session); gap-fill when the session total > SMU sum.
    if let Some(st) = session_table {
        if smu_events.is_empty() {
            read_sessions_table(&conn, db_path, st, skip, &mut session_ids, &mut events);
        } else {
            gap_fill_sessions_over_smu(&conn, db_path, st, skip, &mut session_ids, &mut events);
        }
    }

    // 3) Messages only as last resort floor (token_count alone is weak)
    if events.is_empty() && skip.is_none() {
        if let Some(mt) = table_names.iter().find(|n| {
            let l = n.to_lowercase();
            l == "message" || l == "messages"
        }) {
            read_messages_usage(&conn, db_path, mt, &mut events);
        }
    }
    (events, session_ids)
}

#[derive(Default, Clone, Copy)]
struct SmuSums {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    reqs: f64,
}

/// When a session rollup is richer than the sum of its SMU rows, emit a gap event
/// for the positive deltas only (over-count policy: never leave session tokens on the floor).
fn gap_fill_sessions_over_smu(
    conn: &rusqlite::Connection,
    db_path: &str,
    session_table: &str,
    skip: Option<&HashSet<String>>,
    session_ids: &mut Vec<String>,
    out: &mut Vec<UsageEvent>,
) {
    let mut smu_by_session: HashMap<String, SmuSums> = HashMap::new();
    if let Ok(sums) = query_rows(
        conn,
        "SELECT session_id as sid,
          SUM(COALESCE(input_tokens,0)) as input,
          SUM(COALESCE(output_tokens,0)) as output,
          SUM(COALESCE(cache_read_tokens,0)) as cache_read,
          SUM(COALESCE(cache_write_tokens,0)) as cache_write,
          SUM(COALESCE(reasoning_tokens,0)) as reasoning,
          SUM(COALESCE(api_call_count,0)) as reqs
         FROM session_model_usage
         GROUP BY session_id",
    ) {
        for r in &sums {
            let sid = get(r, "sid").map(js_str).unwrap_or_default();
            if sid.is_empty() {
                continue;
            }
            // reasoning billed on top
            let output = numco(r, &["output"]) + numco(r, &["reasoning"]);
            smu_by_session.insert(
                sid,
                SmuSums {
                    input: numco(r, &["input"]),
                    output,
                    cache_read: numco(r, &["cache_read"]),
                    cache_write: numco(r, &["cache_write"]),
                    reqs: numco(r, &["reqs"]),
                },
            );
        }
    }

    let rows = match query_rows(conn, &format!("SELECT * FROM {}", quote_ident(session_table))) {
        Ok(r) => r,
        Err(_) => return,
    };
    for row in &rows {
        let sid = co(row, &["id", "session_id"]).map(js_str).unwrap_or_default();
        if sid.is_empty() {
            continue;
        }
        if skip.map_or(false, |s| s.contains(&sid)) {
            continue;
        }
        session_ids.push(sid.clone());
        let s_in = numco(row, &["input_tokens", "total_input_tokens", "prompt_tokens"]);
        let mut s_out = numco(row, &["output_tokens", "total_output_tokens", "completion_tokens"]);
        let s_cr = numco(row, &["cache_read_tokens", "cache_read_input_tokens"]);
        let s_cw = numco(row, &["cache_write_tokens", "cache_creation_input_tokens"]);
        let s_reason = numco(row, &["reasoning_tokens"]);
        // Over-count: always add reasoning to session output
        if s_reason > 0.0 {
            s_out += s_reason;
        }

        let u = smu_by_session.get(&sid).copied().unwrap_or_default();

        let d_in = (s_in - u.input).max(0.0);
        let d_out = (s_out - u.output).max(0.0);
        let d_cr = (s_cr - u.cache_read).max(0.0);
        let d_cw = (s_cw - u.cache_write).max(0.0);
        if d_in + d_out + d_cr + d_cw <= 0.0 {
            continue;
        }

        let mut model: Option<String> = str_of(row, "model").map(|s| s.to_string());
        if let Some(cfg_model) = config_model(row, "model_config") {
            if model.as_deref().map_or(true, |m| m.is_empty() || is_gateway_alias(m)) {
                model = Some(cfg_model);
            }
        }

        let api_calls = (numco(row, &["api_call_count"]) - u.reqs).max(0.0);
        let cost = pick_hermes_cost(row);
        // The gap is a session total minus the json rows already counted; whether
        // it "reports cache" is inherited from the session row that carried it.
        let cache_reported = co(
            row,
            &["cache_read_tokens", "cache_read_input_tokens", "cache_write_tokens", "cache_creation_input_tokens"],
        )
        .is_some();
        let (di, dou, dcr) = (js_num_to_string(d_in), js_num_to_string(d_out), js_num_to_string(d_cr));
        let mut ev = base_event(
            stable_id(&["hermes", db_path, "gap", sid.as_str(), di.as_str(), dou.as_str(), dcr.as_str()]),
            model,
            str_of(row, "cwd").map(|s| s.to_string()),
            db_path,
        );
        ev.timestamp = extract_timestamp(&[co(row, &["ended_at", "started_at"]), Some(row)]);
        ev.input_tokens = d_in;
        ev.output_tokens = d_out;
        ev.cache_read_tokens = d_cr;
        ev.cache_write_tokens = d_cw;
        ev.estimated = Some(true);
        if api_calls > 0.0 {
            ev.request_count = Some(api_calls.floor());
        }
        if cache_reported {
            ev.cache_reported = Some(true);
        }
        // Don't apply full session cost to a partial gap
        let router_cost = match cost {
            Some(c) if u.input + u.output == 0.0 => Some(c),
            _ => None,
        };
        out.push(apply_pricing_with(ev, router_cost));
    }
}

/// Emit the events for one session-summary row. The aggregate `api_call_count`
/// is split across the session's real start-to-end span so per-minute RPM and
/// per-day attribution stay truthful; tokens and cost are apportioned too so the
/// split rows sum back to the original totals.
#[allow(clippy::too_many_arguments)]
fn emit_summary_row(
    out: &mut Vec<UsageEvent>,
    base: UsageEvent,
    tokens: [f64; 4],
    cost: Option<f64>,
    api_calls: f64,
    span: Option<(f64, f64)>,
    timestamp: String,
    cache_reported: bool,
) {
    let [input, output, cache_read, cache_write] = tokens;
    if let (Some((s, e)), true) = (span, api_calls > 0.0) {
        let parts = split_usage_row(
            &SplittableUsage {
                request_count: Some(api_calls),
                input_tokens: Some(input),
                output_tokens: Some(output),
                cache_read_tokens: Some(cache_read),
                cache_write_tokens: Some(cache_write),
                estimated_cost: cost,
                ..SplittableUsage::default()
            },
            api_calls,
            s,
            e,
        );
        let n = parts.len();
        for (p, part) in parts.into_iter().enumerate() {
            let mut ev = base.clone();
            // Suffix keeps each split row distinct and stable across rescans.
            if n > 1 {
                ev.id = format!("{}-s{}", base.id, p);
            }
            ev.input_tokens = part.input_tokens;
            ev.output_tokens = part.output_tokens;
            ev.cache_read_tokens = part.cache_read_tokens;
            ev.cache_write_tokens = part.cache_write_tokens;
            ev.request_count = Some(part.request_count);
            ev.timestamp = part.timestamp;
            if cache_reported {
                ev.cache_reported = Some(true);
            }
            // This row's share of the cost, passed as the router-reported cost so
            // applyPricing does not re-price the whole session onto every row.
            let router_cost = match (cost, part.estimated_cost) {
                (Some(_), Some(c)) => Some(c),
                _ => None,
            };
            out.push(apply_pricing_with(ev, router_cost));
        }
    } else {
        let mut ev = base;
        ev.timestamp = timestamp;
        ev.input_tokens = input;
        ev.output_tokens = output;
        ev.cache_read_tokens = cache_read;
        ev.cache_write_tokens = cache_write;
        if cache_reported {
            ev.cache_reported = Some(true);
        }
        if api_calls > 0.0 {
            ev.request_count = Some(api_calls.floor());
        }
        out.push(apply_pricing_with(ev, cost));
    }
}

fn read_session_model_usage(
    conn: &rusqlite::Connection,
    db_path: &str,
    skip: Option<&HashSet<String>>,
    session_ids: &mut Vec<String>,
    out: &mut Vec<UsageEvent>,
) {
    let rows = match query_rows(conn, "SELECT * FROM session_model_usage") {
        Ok(r) => r,
        Err(_) => return,
    };
    // Optional join data from sessions (workspace)
    let mut session_cwd: HashMap<String, Option<String>> = HashMap::new();
    if let Ok(sess) = query_rows(conn, "SELECT id, started_at, ended_at, cwd FROM sessions") {
        for s in &sess {
            let id = get(s, "id").map(js_str).unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            session_cwd.insert(id, str_of(s, "cwd").map(|c| c.to_string()));
        }
    }

    let mut i = 0usize;
    for row in &rows {
        i += 1;
        let Some(b) = token_buckets_from_hermes_row(row) else { continue };

        let session_id = get(row, "session_id").map(js_str).unwrap_or_else(|| i.to_string());
        if skip.map_or(false, |s| s.contains(&session_id)) {
            continue;
        }
        if !session_id.is_empty() {
            session_ids.push(session_id.clone());
        }
        let mut model: Option<String> = match str_of(row, "model").map(js_trim) {
            Some(t) if !t.is_empty() => Some(t.to_string()),
            _ => extract_model(&[Some(row)]),
        };
        // Prefer concrete model from model_config when rollup label is a gateway alias
        if let Some(cfg_model) = config_model(row, "model_config") {
            if !cfg_model.is_empty() && model.as_deref().map_or(true, |m| m.is_empty() || is_gateway_alias(m)) {
                model = Some(cfg_model);
            }
        }
        // extractTimestamp(last_seen, first_seen, row) always resolves (falls back to now).
        let ts = extract_timestamp(&[get(row, "last_seen"), get(row, "first_seen"), Some(row)]);
        let cost = pick_hermes_cost(row);
        let api_calls = numco(row, &["api_call_count"]);

        let in_s = js_num_to_string(b.input_tokens);
        let out_s = js_num_to_string(b.output_tokens);
        let model_s = model.clone().filter(|m| !m.is_empty()).unwrap_or_else(|| "unknown".to_string());
        let base = base_event(
            stable_id(&["hermes", db_path, "smu", session_id.as_str(), model_s.as_str(), in_s.as_str(), out_s.as_str()]),
            model,
            session_cwd.get(&session_id).cloned().flatten(),
            db_path,
        );

        // This row is a per-model SESSION SUMMARY: split it across the session's real
        // first_seen -> last_seen span (see emit_summary_row).
        let span = if api_calls > 0.0 { resolve_span_ms(row.get("first_seen"), row.get("last_seen")) } else { None };
        emit_summary_row(
            out,
            base,
            [b.input_tokens, b.output_tokens, b.cache_read_tokens, b.cache_write_tokens],
            cost,
            api_calls,
            span,
            ts,
            b.cache_reported,
        );
    }
}

fn read_sessions_table(
    conn: &rusqlite::Connection,
    db_path: &str,
    session_table: &str,
    skip: Option<&HashSet<String>>,
    session_ids: &mut Vec<String>,
    out: &mut Vec<UsageEvent>,
) {
    let Ok(info) = query_rows(conn, &format!("PRAGMA table_info({})", quote_ident(session_table))) else {
        return;
    };
    let colset: HashSet<String> = info.iter().filter_map(|c| str_of(c, "name").map(|n| n.to_lowercase())).collect();
    // Returns the candidate name itself (not the table's own casing), like the TS `pick`.
    let pick = |names: &[&'static str]| -> Option<&'static str> {
        names.iter().copied().find(|n| colset.contains(&n.to_lowercase()))
    };

    let model_col = pick(&["model", "model_id", "model_name"]);
    let model_config_col = pick(&["model_config"]);
    let in_col = pick(&["input_tokens", "total_input_tokens", "prompt_tokens", "input"]);
    let out_col = pick(&["output_tokens", "total_output_tokens", "completion_tokens", "output"]);
    let cr_col = pick(&["cache_read_tokens", "cache_read_input_tokens", "cache_read"]);
    let cw_col = pick(&["cache_write_tokens", "cache_creation_input_tokens", "cache_write"]);
    let reason_col = pick(&["reasoning_tokens", "reasoning"]);
    let ts_col = pick(&["ended_at", "started_at", "created_at", "timestamp", "updated_at", "start_time"]);
    let id_col = pick(&["id", "session_id", "uuid"]);
    let cwd_col = pick(&["cwd", "workdir", "workspace", "project"]);
    let api_col = pick(&["api_call_count", "request_count"]);
    let start_col = pick(&["started_at", "first_seen", "created_at", "start_time"]);
    let end_col = pick(&["ended_at", "last_seen", "updated_at", "last_activity_at"]);

    if in_col.is_none() && out_col.is_none() {
        return;
    }

    let rows = match query_rows(conn, &format!("SELECT * FROM {}", quote_ident(session_table))) {
        Ok(r) => r,
        Err(_) => return,
    };
    let col_num = |row: &Value, col: Option<&str>| -> f64 { col.and_then(|c| get(row, c)).map_or(0.0, num) };

    let mut i = 0usize;
    for row in &rows {
        i += 1;
        let sid = match id_col.and_then(|c| get(row, c)) {
            Some(v) => js_str(v),
            None => i.to_string(),
        };
        if skip.map_or(false, |s| s.contains(&sid)) {
            continue;
        }

        let input_tokens = col_num(row, in_col);
        let mut output_tokens = col_num(row, out_col);
        let cache_read_tokens = col_num(row, cr_col);
        let cache_write_tokens = col_num(row, cw_col);
        let reasoning = col_num(row, reason_col);
        // Policy: always add reasoning_tokens as output
        if reasoning > 0.0 {
            output_tokens += reasoning;
        }

        if input_tokens + output_tokens + cache_read_tokens + cache_write_tokens <= 0.0 {
            continue;
        }
        if !sid.is_empty() {
            session_ids.push(sid.clone());
        }

        let mut model: Option<String> = model_col.and_then(|c| str_of(row, c)).map(|s| s.to_string());
        // Prefer concrete model from model_config when rollup label is a gateway alias
        if let Some(c) = model_config_col {
            if let Some(cfg_model) = config_model(row, c) {
                if !cfg_model.is_empty() && model.as_deref().map_or(true, |m| m.is_empty() || is_gateway_alias(m)) {
                    model = Some(cfg_model);
                }
            }
        }

        let timestamp = extract_timestamp(&[ts_col.and_then(|c| get(row, c)), Some(row)]);
        let workspace = cwd_col.and_then(|c| str_of(row, c)).map(|s| s.to_string());
        let cost = pick_hermes_cost(row);
        let api_calls = col_num(row, api_col);

        // The session table exposed cache columns => these rows measure cache, even
        // when the values are 0. Absent columns mean the provider never mentioned it.
        let cache_reported = cr_col.is_some() || cw_col.is_some();
        let in_s = js_num_to_string(input_tokens);
        let out_s = js_num_to_string(output_tokens);
        let base = base_event(
            stable_id(&["hermes", db_path, sid.as_str(), in_s.as_str(), out_s.as_str()]),
            model,
            workspace,
            db_path,
        );
        // Same session-summary shape as session_model_usage rows.
        let span = match (start_col, end_col) {
            (Some(sc), Some(ec)) if api_calls > 0.0 => resolve_span_ms(row.get(sc), row.get(ec)),
            _ => None,
        };
        emit_summary_row(
            out,
            base,
            [input_tokens, output_tokens, cache_read_tokens, cache_write_tokens],
            cost,
            api_calls,
            span,
            timestamp,
            cache_reported,
        );
    }
}

fn read_messages_usage(conn: &rusqlite::Connection, db_path: &str, msg_table: &str, out: &mut Vec<UsageEvent>) {
    let rows = match query_rows(conn, &format!("SELECT * FROM {} LIMIT 50000", quote_ident(msg_table))) {
        Ok(r) => r,
        Err(_) => return,
    };
    let mut i = 0usize;
    for row in &rows {
        i += 1;
        let Some(b) = extract_token_buckets(Some(row)) else { continue };
        let (i_s, in_s) = (i.to_string(), js_num_to_string(b.input_tokens));
        let mut ev = base_event(
            stable_id(&["hermes", db_path, "msg", i_s.as_str(), in_s.as_str()]),
            extract_model(&[Some(row)]),
            None,
            db_path,
        );
        ev.timestamp = extract_timestamp(&[Some(row)]);
        ev.input_tokens = b.input_tokens;
        ev.output_tokens = b.output_tokens;
        ev.cache_read_tokens = b.cache_read_tokens;
        ev.cache_write_tokens = b.cache_write_tokens;
        ev.cache_reported = b.cache_reported;
        out.push(apply_pricing(ev));
    }
}

// ---------------------------------------------------------------------------
// Light scan
// ---------------------------------------------------------------------------

/// Last light-scan fingerprint per root set. Missing until that home is read
/// once. Later ticks with the same files return no rows and the server keeps the
/// cached history. Keyed by roots so two homes do not erase each other.
static HERMES_LIGHT_STAMP_BY_ROOT: Lazy<Mutex<HashMap<String, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Session listing from the last light stamp. A quiet tick stats the directory
/// and the few session files that can be rewritten. It does not walk request
/// dumps again. A new file updates the directory mtime and drops this memo.
#[derive(Clone)]
struct HermesSessionMemo {
    dir_mtime: i64,
    subdirs: Vec<(String, i64)>,
    files: Vec<String>,
    sig: String,
    part: String,
}

static HERMES_SESSION_MEMO: Lazy<Mutex<HashMap<String, HermesSessionMemo>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// JS default `Array.prototype.sort()` order (UTF-16 code units).
fn sort_js(v: &mut [String]) {
    v.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// `Math.floor(stat.mtimeMs)`
fn mtime_floor(path: &str) -> Option<i64> {
    let m = std::fs::metadata(path).ok()?;
    Some(stamp_from_metadata(&m).mtime_ms.floor() as i64)
}

fn stamp_file_part(file: &str, parts: &mut Vec<String>) {
    if let Ok(m) = std::fs::metadata(file) {
        parts.push(format!("{}|{}", file, m.len()));
    }
}

fn hermes_session_subdirs(sessions_dir: &str) -> Vec<(String, i64)> {
    let flavor = PathFlavor::host();
    let Ok(rd) = std::fs::read_dir(sessions_dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let dir = flavor.join(&[sessions_dir, name.as_str()]);
        if let Some(mt) = mtime_floor(&dir) {
            out.push((dir, mt));
        }
    }
    out
}

fn stamp_hermes_session_files(files: &[String]) -> Option<(String, u64)> {
    let mut bits: Vec<String> = Vec::new();
    let mut bytes: u64 = 0;
    for file in files {
        let m = std::fs::metadata(file).ok()?;
        bits.push(format!("{}|{}", file, m.len()));
        bytes += m.len();
    }
    sort_js(&mut bits);
    Some((bits.join("\n"), bytes))
}

/// True when no session file was created or removed since the memo was stored.
fn hermes_session_shape_matches(sessions_dir: &str, memo: &HermesSessionMemo) -> bool {
    match mtime_floor(sessions_dir) {
        Some(m) if m == memo.dir_mtime => {}
        _ => return false,
    }
    for (dir, mtime) in &memo.subdirs {
        match mtime_floor(dir) {
            Some(m) if m == *mtime => {}
            _ => return false,
        }
    }
    true
}

fn append_hermes_sessions(root: &str, parts: &mut Vec<String>) {
    let flavor = PathFlavor::host();
    let sessions_dir = flavor.join(&[root, "sessions"]);
    if !path_exists_sync(&sessions_dir) {
        return;
    }
    let key = flavor.resolve(&[sessions_dir.as_str()]).to_lowercase();
    let memo = HERMES_SESSION_MEMO.lock().get(&key).cloned();
    if let Some(memo) = memo {
        if hermes_session_shape_matches(&sessions_dir, &memo) {
            if let Some((sig, bytes)) = stamp_hermes_session_files(&memo.files) {
                if sig == memo.sig {
                    parts.push(memo.part);
                    return;
                }
                let part = format!("sessions:{}|{}|{}", root, memo.files.len(), bytes);
                HERMES_SESSION_MEMO.lock().insert(key, HermesSessionMemo { sig, part: part.clone(), ..memo });
                parts.push(part);
                return;
            }
        }
    }

    let Some(dir_mtime) = mtime_floor(&sessions_dir) else { return };
    let files = walk_files_sync(&sessions_dir, &WalkOptions::new().max_depth(6).matching(|n, _| hermes_session_file(n)));
    let stamped = stamp_hermes_session_files(&files);
    let bytes = stamped.as_ref().map_or(0, |s| s.1);
    let part = format!("sessions:{}|{}|{}", root, files.len(), bytes);
    let subdirs = hermes_session_subdirs(&sessions_dir);
    HERMES_SESSION_MEMO.lock().insert(
        key,
        HermesSessionMemo {
            dir_mtime,
            subdirs,
            files,
            sig: stamped.map(|s| s.0).unwrap_or_default(),
            part: part.clone(),
        },
    );
    parts.push(part);
}

/// Fingerprint live Hermes inputs without reading them.
/// Includes the SQLite WAL size (writes often land there before state.db grows)
/// and session file sizes. Mtime is ignored: a read or a mirror touch rewrites
/// it without new usage. Skips -shm: opening the DB for read rewrites it.
fn hermes_source_stamp(roots: &[String]) -> String {
    let flavor = PathFlavor::host();
    let mut parts: Vec<String> = Vec::new();
    for root in roots {
        if !path_exists_sync(root) {
            continue;
        }
        for name in HERMES_DB_NAMES {
            let db = flavor.join(&[root.as_str(), name]);
            stamp_file_part(&db, &mut parts);
            stamp_file_part(&format!("{db}-wal"), &mut parts);
        }
        let profiles = flavor.join(&[root.as_str(), "profiles"]);
        if path_exists_sync(&profiles) {
            if let Ok(rd) = std::fs::read_dir(&profiles) {
                for entry in rd.flatten() {
                    if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        continue;
                    }
                    let entry_name = entry.file_name().to_string_lossy().to_string();
                    for name in HERMES_DB_NAMES {
                        let db = flavor.join(&[profiles.as_str(), entry_name.as_str(), name]);
                        stamp_file_part(&db, &mut parts);
                        stamp_file_part(&format!("{db}-wal"), &mut parts);
                    }
                }
            }
        }
        append_hermes_sessions(root, &mut parts);
    }
    sort_js(&mut parts);
    parts.join("\n")
}

async fn hermes_source_stamp_async(roots: &[String]) -> String {
    let roots = roots.to_vec();
    tokio::task::spawn_blocking(move || hermes_source_stamp(&roots)).await.unwrap_or_default()
}

/// Minute scan. Unchanged files return no rows so the server keeps the cached
/// history (including snapshot DBs already loaded by a full scan). A changed
/// DB or session file runs the full parser, which remains the complete read.
pub async fn parse_hermes_light(roots: Vec<String>) -> anyhow::Result<Vec<UsageEvent>> {
    let flavor = PathFlavor::host();
    let mut resolved: Vec<String> = roots.iter().map(|r| flavor.resolve(&[r.as_str()]).to_lowercase()).collect();
    sort_js(&mut resolved);
    let root_key = resolved.join("|");
    let stamp = hermes_source_stamp_async(&roots).await;
    if HERMES_LIGHT_STAMP_BY_ROOT.lock().get(&root_key) == Some(&stamp) {
        return Ok(Vec::new());
    }
    let events = parse_hermes(roots.clone()).await?;
    // Opening the DB can bump the WAL mtime. Store the stamp after that read
    // so the next quiet tick does not parse the same history again.
    let after = hermes_source_stamp_async(&roots).await;
    HERMES_LIGHT_STAMP_BY_ROOT.lock().insert(root_key, after);
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    const SCHEMA: &str = "
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, model TEXT, started_at TEXT, ended_at TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
        cache_write_tokens INTEGER, reasoning_tokens INTEGER, cwd TEXT,
        estimated_cost_usd REAL, actual_cost_usd REAL, api_call_count INTEGER
      );
      CREATE TABLE session_model_usage (
        session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        estimated_cost_usd REAL, actual_cost_usd REAL, api_call_count INTEGER,
        first_seen TEXT, last_seen TEXT
      );";

    fn make_db(path: &Path, sql: &str) {
        let c = rusqlite::Connection::open(path).unwrap();
        c.execute_batch(sql).unwrap();
    }

    fn root_str(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    fn sum(events: &[UsageEvent], f: impl Fn(&UsageEvent) -> f64) -> f64 {
        events.iter().map(f).sum()
    }

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "hermes");
        assert_eq!(a.label, "Hermes Agent");
        assert!(a.parse_light.is_some());
    }

    #[tokio::test]
    async fn prefers_session_model_usage_and_does_not_double_count() {
        let dir = tempfile::tempdir().unwrap();
        make_db(
            &dir.path().join("state.db"),
            &format!(
                "{SCHEMA}
                INSERT INTO sessions VALUES ('sess-1', 'XLab', '2026-07-20T10:00:00Z', '2026-07-20T11:00:00Z',
                  1000, 100, 500, 0, 50, 'C:\\Dev\\Demo', 0, 0, 3);
                INSERT INTO session_model_usage VALUES ('sess-1', 'claude-opus-4.8', 1200, 150, 500, 0, 50,
                  0.05, NULL, 3, '2026-07-20T10:00:00Z', '2026-07-20T11:00:00Z');
                INSERT INTO session_model_usage VALUES ('sess-1', 'Kimi-k3', 400, 80, 0, 0, 0,
                  NULL, NULL, 1, '2026-07-20T10:30:00Z', '2026-07-20T10:40:00Z');"
            ),
        );
        let events = parse_hermes(vec![root_str(dir.path())]).await.unwrap();
        let models: HashSet<Option<&str>> = events.iter().map(|e| e.model.as_deref()).collect();
        assert!(models.contains(&Some("claude-opus-4.8")));
        assert!(models.contains(&Some("Kimi-k3")));
        assert_eq!(sum(&events, |e| e.input_tokens), 1600.0);
        let opus: Vec<UsageEvent> =
            events.iter().filter(|e| e.model.as_deref() == Some("claude-opus-4.8")).cloned().collect();
        assert_eq!(opus.len(), 3);
        // reasoning 50 added on top of opus output 150, preserved across the split
        assert_eq!(sum(&opus, |e| e.output_tokens), 200.0);
        assert_eq!(sum(&opus, |e| e.cache_read_tokens), 500.0);
        assert!((sum(&opus, |e| e.estimated_cost.unwrap_or(0.0)) - 0.05).abs() < 1e-9);
        assert_eq!(sum(&opus, |e| e.request_count.unwrap_or(0.0)), 3.0);
        let times: HashSet<&str> = opus.iter().map(|e| e.timestamp.as_str()).collect();
        assert_eq!(times.len(), 3);
        assert!(opus.iter().all(|e| e.workspace.as_deref() == Some("C:\\Dev\\Demo")));
        assert!(opus.iter().all(|e| e.id.contains("-s")));
        assert!(events.iter().all(|e| e.agent == AgentId::Hermes && e.source_path.ends_with("state.db")));
    }

    #[tokio::test]
    async fn gap_fills_when_session_rollup_exceeds_smu() {
        let dir = tempfile::tempdir().unwrap();
        make_db(
            &dir.path().join("state.db"),
            &format!(
                "{SCHEMA}
                INSERT INTO sessions VALUES ('sess-gap', 'XLab', '2026-07-20T10:00:00Z', '2026-07-20T11:00:00Z',
                  10000, 500, 2000, 0, 100, NULL, 0, 0, 5);
                INSERT INTO session_model_usage VALUES ('sess-gap', 'Kimi-k3', 3000, 100, 500, 0, 0,
                  NULL, NULL, 2, '2026-07-20T10:00:00Z', '2026-07-20T10:30:00Z');"
            ),
        );
        let events = parse_hermes(vec![root_str(dir.path())]).await.unwrap();
        let gap: Vec<UsageEvent> = events.iter().filter(|e| e.estimated == Some(true)).cloned().collect();
        assert!(!gap.is_empty());
        assert_eq!(sum(&gap, |e| e.input_tokens), 7000.0);
        assert_eq!(sum(&gap, |e| e.output_tokens), 500.0);
        assert_eq!(sum(&gap, |e| e.cache_read_tokens), 1500.0);
        assert_eq!(sum(&gap, |e| e.request_count.unwrap_or(0.0)), 3.0);
        assert_eq!(sum(&events, |e| e.input_tokens), 10000.0);
    }

    #[tokio::test]
    async fn skips_snapshot_sessions_already_covered_by_live_db() {
        let dir = tempfile::tempdir().unwrap();
        make_db(
            &dir.path().join("state.db"),
            &format!(
                "{SCHEMA}
                INSERT INTO sessions VALUES ('shared-sess', 'kimi-k3', '2026-07-20T10:00:00Z', '2026-07-20T11:00:00Z',
                  1000, 100, 0, 0, 0, NULL, 0, 0, 1);
                INSERT INTO session_model_usage VALUES ('shared-sess', 'kimi-k3', 1000, 100, 0, 0, 0,
                  NULL, NULL, 1, '2026-07-20T10:00:00Z', '2026-07-20T11:00:00Z');"
            ),
        );
        let snap_dir = dir.path().join("state-snapshots").join("20260701-old");
        std::fs::create_dir_all(&snap_dir).unwrap();
        make_db(
            &snap_dir.join("state.db"),
            &format!(
                "{SCHEMA}
                INSERT INTO session_model_usage VALUES ('shared-sess', 'kimi-k3', 9999, 999, 0, 0, 0,
                  NULL, NULL, 9, '2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z');
                INSERT INTO session_model_usage VALUES ('only-in-snap', 'grok-4.5', 500, 50, 0, 0, 0,
                  NULL, NULL, 1, '2026-07-01T12:00:00Z', '2026-07-01T12:30:00Z');"
            ),
        );
        let events = parse_hermes(vec![root_str(dir.path())]).await.unwrap();
        let shared: Vec<&UsageEvent> =
            events.iter().filter(|e| e.input_tokens == 1000.0 || e.input_tokens == 9999.0).collect();
        assert_eq!(shared.len(), 1, "shared session must appear once (live wins)");
        assert_eq!(shared[0].input_tokens, 1000.0);
        let hist = events.iter().find(|e| e.model.as_deref() == Some("grok-4.5")).expect("snapshot history kept");
        assert_eq!(hist.input_tokens, 500.0);
        assert_eq!(sum(&events, |e| e.input_tokens), 1500.0);
    }

    #[tokio::test]
    async fn falls_back_to_sessions_when_smu_empty() {
        let dir = tempfile::tempdir().unwrap();
        make_db(
            &dir.path().join("state.db"),
            "CREATE TABLE sessions (
               id TEXT PRIMARY KEY, model TEXT, model_config TEXT, started_at TEXT,
               input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
               cache_write_tokens INTEGER, reasoning_tokens INTEGER, cwd TEXT,
               estimated_cost_usd REAL, actual_cost_usd REAL, api_call_count INTEGER
             );
             INSERT INTO sessions VALUES ('sess-2', 'XLab', '{\"model\":\"XLab\",\"provider\":\"9router\"}',
               '2026-07-21T10:00:00Z', 5000, 200, 1000, 0, 80, NULL, 0, 0, 2);",
        );
        let events = parse_hermes(vec![root_str(dir.path())]).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].input_tokens, 5000.0);
        // output 200 + reasoning 80 (over-count policy)
        assert_eq!(events[0].output_tokens, 280.0);
        assert_eq!(events[0].cache_read_tokens, 1000.0);
        assert_eq!(events[0].cache_reported, Some(true));
        assert_eq!(events[0].request_count, Some(2.0));
        assert_eq!(events[0].model.as_deref(), Some("XLab"));
    }

    #[tokio::test]
    async fn config_model_replaces_gateway_alias() {
        let dir = tempfile::tempdir().unwrap();
        make_db(
            &dir.path().join("state.db"),
            "CREATE TABLE sessions (id TEXT, model TEXT, model_config TEXT, started_at TEXT,
               input_tokens INTEGER, output_tokens INTEGER);
             INSERT INTO sessions VALUES ('s', 'XLab', '{\"model\":\"kimi-k3\"}', '2026-07-21T10:00:00Z', 5, 6);",
        );
        let events = parse_hermes(vec![root_str(dir.path())]).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].model.as_deref(), Some("kimi-k3"));
        // no cache columns => cache not reported
        assert_eq!(events[0].cache_reported, None);
    }

    #[tokio::test]
    async fn spreads_a_long_session_so_peak_rpm_is_not_the_session_total() {
        let dir = tempfile::tempdir().unwrap();
        make_db(
            &dir.path().join("state.db"),
            &format!(
                "{SCHEMA}
                INSERT INTO session_model_usage VALUES ('sess-long', 'Kimi-k3', 100000, 5000, 20000, 0, 0,
                  12.5, NULL, 3135, '2026-08-03T16:43:14Z', '2026-08-04T17:57:37Z');"
            ),
        );
        let events = parse_hermes(vec![root_str(dir.path())]).await.unwrap();
        assert_eq!(sum(&events, |e| e.request_count.unwrap_or(0.0)), 3135.0);
        assert_eq!(sum(&events, |e| e.input_tokens), 100000.0);
        assert_eq!(sum(&events, |e| e.output_tokens), 5000.0);
        assert!((sum(&events, |e| e.estimated_cost.unwrap_or(0.0)) - 12.5).abs() < 1e-6);
        let busiest = events.iter().map(|e| e.request_count.unwrap_or(0.0)).fold(0.0_f64, f64::max);
        assert!(busiest < 100.0, "busiest minute {busiest}");
        let days: HashSet<&str> = events.iter().map(|e| &e.timestamp[..10]).collect();
        assert!(days.contains("2026-08-03"));
        assert!(days.contains("2026-08-04"));
    }

    #[tokio::test]
    async fn reads_session_jsonl_and_light_scan_skips_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let file = sessions.join("session.jsonl");
        let line1 = r#"{"timestamp":"2026-10-03T01:00:00.000Z","model":"test-model","input_tokens":11,"output_tokens":4,"cwd":"/w"}"#;
        let line2 = r#"{"timestamp":"2026-10-03T02:00:00.000Z","model":"test-model","input_tokens":6,"output_tokens":1}"#;
        std::fs::write(&file, format!("{line1}\n")).unwrap();
        let roots = vec![root_str(dir.path())];

        let first = parse_hermes_light(roots.clone()).await.unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].input_tokens, 11.0);
        assert_eq!(first[0].output_tokens, 4.0);
        assert_eq!(first[0].total_tokens, 15.0);
        assert_eq!(first[0].model.as_deref(), Some("test-model"));
        assert_eq!(first[0].workspace.as_deref(), Some("/w"));
        assert_eq!(first[0].timestamp, "2026-10-03T01:00:00.000Z");
        assert_eq!(first[0].source_path, root_str(&file));

        let second = parse_hermes_light(roots.clone()).await.unwrap();
        assert!(second.is_empty());

        std::fs::write(&file, format!("{line1}\n{line2}\n")).unwrap();
        let third = parse_hermes_light(roots.clone()).await.unwrap();
        let mut ins: Vec<f64> = third.iter().map(|e| e.input_tokens).collect();
        ins.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(ins, vec![6.0, 11.0]);
    }

    #[tokio::test]
    async fn json_rows_with_nested_usage_and_flat_cache_keys() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let file = sessions.join("my-session.json");
        std::fs::write(
            &file,
            r#"[{"usage":{"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":0},"model":"m1","ts":1700000000},
                {"input_tokens":3,"cache_read_tokens":0},
                5,
                {"nothing":1}]"#,
        )
        .unwrap();
        let events = parse_hermes(vec![root_str(dir.path())]).await.unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].input_tokens, 10.0);
        assert_eq!(events[0].cache_reported, Some(true));
        assert_eq!(events[0].timestamp, "2023-11-14T22:13:20.000Z");
        assert_eq!(events[1].input_tokens, 3.0);
        assert_eq!(events[1].cache_reported, Some(true));
        // row index (1-based, counting skipped rows) feeds the stable id
        assert_eq!(events[1].id, stable_id(&["hermes", &root_str(&file), "2", "3", "0"]));
    }

    #[tokio::test]
    async fn messages_table_is_last_resort() {
        let dir = tempfile::tempdir().unwrap();
        make_db(
            &dir.path().join("hermes.db"),
            "CREATE TABLE messages (id INTEGER, model TEXT, input_tokens INTEGER, output_tokens INTEGER);
             INSERT INTO messages VALUES (1, 'm', 4, 5);
             INSERT INTO messages VALUES (2, 'm', 0, 0);",
        );
        let events = parse_hermes(vec![root_str(dir.path())]).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].input_tokens, 4.0);
        assert_eq!(events[0].output_tokens, 5.0);
        assert!(events[0].workspace.is_none());
    }

    #[test]
    fn helper_rules() {
        assert!(is_gateway_alias(" XLab "));
        assert!(!is_gateway_alias("kimi-k3"));
        assert!(is_snapshot_db_path("C:\\x\\State-Snapshots\\a\\state.db"));
        assert!(!is_snapshot_db_path("C:\\x\\profiles\\a\\state.db"));
        assert!(hermes_session_file("a.jsonl"));
        assert!(hermes_session_file("my-session.json"));
        assert!(!hermes_session_file("config.json"));
        assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
        let row = serde_json::json!({"actual_cost_usd": 0, "estimated_cost_usd": "0.25"});
        assert_eq!(pick_hermes_cost(&row), Some(0.25));
        assert_eq!(pick_hermes_cost(&serde_json::json!({"cost": -1})), None);
    }
}
