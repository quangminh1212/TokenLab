//! Agent: Windsurf (port of `src/agents/windsurf/index.ts`).
//!
//! Windsurf / Codeium
//! --------------------
//! Local roots:
//!   - ~/.codeium/windsurf  (cascade sessions, settings)
//!   - %APPDATA%/Windsurf   (VS Code-fork user data when IDE is installed)
//!
//! Cascade stores chats as AES-256-GCM encrypted .pb files. The key is a
//! hardcoded global constant inside language_server (same for every install):
//!   "safeCodeiumworldKeYsecretBalloon"
//! Layout: [12-byte nonce][ciphertext][16-byte GCM tag] -> CortexTrajectory protobuf.
//!
//! After decrypt we extract per-session model + Input/Output/Cached floats from
//! Token Usage blocks. Fallback: size heuristic (estimated:true) if decrypt fails.
//!
//! Ref: https://github.com/dayearleo/windsurf-local-user-data-decryption

use crate::agents::shared::env::{path_env, unique, vscode_global_storage};
use crate::agents::shared::usage_fields::{extract_model, extract_timestamp, extract_token_buckets};
use crate::agents::{parse_fn, AgentModule};
use crate::pricing::apply_pricing;
use crate::types::{AgentId, UsageEvent};
use crate::util::{
    js_num_to_string, js_round, js_trim, parse_jsonl, path_exists, read_text, stable_id, to_iso_string,
    walk_files, PathFlavor, WalkOptions,
};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use once_cell::sync::Lazy;
use serde_json::{Map, Value};
use std::collections::HashSet;

/// Hardcoded AES-256 key shipped in every Windsurf language_server binary.
const CASCADE_AES_KEY: &[u8; 32] = b"safeCodeiumworldKeYsecretBalloon";

/// Local data roots to scan on this machine.
pub fn roots() -> Vec<String> {
    let e = path_env();
    let mut r: Vec<String> = Vec::new();
    r.push(e.j(&[&e.home, ".codeium", "windsurf"]));
    r.push(e.j(&[&e.home, ".codeium"]));
    r.push(e.j(&[&e.home, ".windsurf"]));
    r.push(e.j(&[&e.app_data, "Windsurf"]));
    r.push(e.j(&[&e.app_data, "Windsurf", "User"]));
    r.push(e.j(&[&e.app_data, "Windsurf", "User", "globalStorage"]));
    r.push(e.j(&[&e.app_data, "Windsurf", "User", "workspaceStorage"]));
    r.push(e.j(&[&e.app_data, "Windsurf - Insiders"]));
    r.push(e.j(&[&e.local_app, "Windsurf"]));
    r.push(e.j(&[&e.local_app, "Programs", "Windsurf"]));
    r.push(e.j(&[&e.xdg_config, "Windsurf"]));
    r.push(e.j(&[&e.xdg_data, "Windsurf"]));
    r.push(e.j(&[&e.xdg_config, "Windsurf - Insiders"]));
    r.extend(vscode_global_storage(&["codeium.windsurf", "codeium.codeium"]));
    unique(r)
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Windsurf,
        label: "Windsurf",
        roots,
        parse: parse_fn(|roots| async move { parse_windsurf(roots).await }),
        parse_light: None,
    }
}

pub async fn parse_windsurf(roots: Vec<String>) -> anyhow::Result<Vec<UsageEvent>> {
    let mut events: Vec<UsageEvent> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for root in &roots {
        if !path_exists(root).await {
            continue;
        }

        // 1) Plain JSON / JSONL usage artifacts
        events.extend(parse_json_artifacts(root, &mut seen).await);

        // 2) VS Code-style SQLite (state.vscdb, etc.)
        events.extend(parse_sqlite_artifacts(root, &mut seen).await);

        // 3) Encrypted cascade sessions -> estimated usage
        events.extend(parse_cascade_sessions(root, &mut seen).await);
    }

    Ok(events)
}

/// `r[a] ?? r[b] ?? ... ?? fallback` (null and missing both fall through).
fn coalesce<'a>(r: &'a Map<String, Value>, keys: &[&str], fallback: &'a Value) -> &'a Value {
    for k in keys {
        match r.get(*k) {
            Some(Value::Null) | None => continue,
            Some(v) => return v,
        }
    }
    fallback
}

async fn parse_json_artifacts(root: &str, seen: &mut HashSet<String>) -> Vec<UsageEvent> {
    let mut events: Vec<UsageEvent> = Vec::new();
    let sep = PathFlavor::host().sep();
    let logs_seg = format!("{sep}logs{sep}");
    let files = walk_files(
        root,
        WalkOptions::new().max_depth(14).matching(move |name, full| {
            let lower = name.to_lowercase();
            let path_lower = full.to_lowercase();
            if lower.ends_with(".pb") || lower.ends_with(".lock") {
                return false;
            }
            if lower.ends_with(".jsonl") {
                return true;
            }
            if lower.contains("usage") && (lower.ends_with(".json") || lower.ends_with(".jsonl")) {
                return true;
            }
            if lower.contains("cascade") && lower.ends_with(".json") {
                return true;
            }
            if path_lower.contains(&logs_seg) && (lower.ends_with(".json") || lower.ends_with(".log")) {
                return true;
            }
            if lower.ends_with(".json")
                && (lower.contains("chat")
                    || lower.contains("transcript")
                    || lower.contains("session")
                    || lower.contains("token")
                    || lower.contains("billing")
                    || path_lower.contains("globalstorage")
                    || path_lower.contains("workspacestorage"))
            {
                return true;
            }
            false
        }),
    )
    .await;

    for file in files {
        if seen.contains(&file) {
            continue;
        }
        seen.insert(file.clone());
        let text = match read_text(&file).await {
            Some(t) if !t.is_empty() => t,
            _ => continue,
        };

        let rows: Vec<Value> = if file.ends_with(".jsonl") {
            parse_jsonl(&text)
        } else {
            match serde_json::from_str::<Value>(&text) {
                Ok(Value::Array(a)) => a,
                Ok(Value::Object(o)) => {
                    let pick = ["messages", "events", "usage", "sessions"]
                        .iter()
                        .find_map(|k| match o.get(*k) {
                            Some(Value::Array(a)) => Some(a.clone()),
                            _ => None,
                        });
                    match pick {
                        Some(a) => a,
                        None => vec![Value::Object(o)],
                    }
                }
                _ => Vec::new(),
            }
        };

        let mut idx: u64 = 0;
        for row in &rows {
            idx += 1;
            let r = match row {
                Value::Object(m) => m,
                _ => continue,
            };
            let usage = coalesce(r, &["usage", "tokenUsage", "token_usage", "credits", "token_count"], row);
            let buckets = match extract_token_buckets(Some(usage)) {
                Some(b) => b,
                None => continue,
            };

            let workspace = match r.get("cwd") {
                Some(Value::String(s)) => Some(s.clone()),
                _ => match r.get("workspace") {
                    Some(Value::String(s)) => Some(s.clone()),
                    _ => None,
                },
            };

            events.push(apply_pricing(UsageEvent {
                id: stable_id(&[
                    "windsurf",
                    file.as_str(),
                    idx.to_string().as_str(),
                    js_num_to_string(buckets.input_tokens).as_str(),
                    js_num_to_string(buckets.output_tokens).as_str(),
                ]),
                agent: AgentId::Windsurf,
                model: extract_model(&[Some(row), r.get("usage"), r.get("message")]),
                timestamp: extract_timestamp(&[Some(row), r.get("usage"), r.get("message")]),
                input_tokens: buckets.input_tokens,
                output_tokens: buckets.output_tokens,
                cache_read_tokens: buckets.cache_read_tokens,
                cache_write_tokens: buckets.cache_write_tokens,
                cache_reported: buckets.cache_reported,
                workspace,
                source_path: file.clone(),
                ..Default::default()
            }));
        }
    }

    events
}

async fn parse_sqlite_artifacts(root: &str, seen: &mut HashSet<String>) -> Vec<UsageEvent> {
    let mut events: Vec<UsageEvent> = Vec::new();
    let dbs = walk_files(
        root,
        WalkOptions::new().max_depth(10).matching(|n, _full| {
            n == "state.vscdb"
                || n.ends_with(".vscdb")
                || n == "state.db"
                || n == "storage.db"
                || (n.ends_with(".db") && !n.contains("lock"))
        }),
    )
    .await;

    for db_path in dbs {
        if seen.contains(&db_path) {
            continue;
        }
        seen.insert(db_path.clone());
        let p = db_path.clone();
        let parsed = tokio::task::spawn_blocking(move || parse_windsurf_sqlite(&p)).await.unwrap_or_default();
        events.extend(parsed);
    }
    events
}

/// One SQLite row: columns as JSON values (blobs become `null` there) plus the raw blobs.
struct SqlRow {
    map: Map<String, Value>,
    blobs: std::collections::HashMap<String, Vec<u8>>,
}

fn query_all(conn: &rusqlite::Connection, sql: &str) -> Option<Vec<SqlRow>> {
    use rusqlite::types::ValueRef;
    let mut stmt = conn.prepare(sql).ok()?;
    let cols: Vec<String> = stmt.column_names().into_iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.query([]).ok()?;
    let mut out = Vec::new();
    loop {
        match rows.next() {
            Ok(Some(row)) => {
                let mut map = Map::new();
                let mut blobs = std::collections::HashMap::new();
                for (i, c) in cols.iter().enumerate() {
                    let v = match row.get_ref(i) {
                        Ok(ValueRef::Null) | Err(_) => Value::Null,
                        Ok(ValueRef::Integer(n)) => Value::from(n),
                        Ok(ValueRef::Real(f)) => serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number),
                        Ok(ValueRef::Text(t)) => Value::String(String::from_utf8_lossy(t).into_owned()),
                        Ok(ValueRef::Blob(b)) => {
                            blobs.insert(c.clone(), b.to_vec());
                            Value::Null
                        }
                    };
                    map.insert(c.clone(), v);
                }
                out.push(SqlRow { map, blobs });
            }
            Ok(None) => break,
            Err(_) => return None,
        }
    }
    Some(out)
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn has_any(s: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| s.contains(n))
}

fn parse_windsurf_sqlite(db_path: &str) -> Vec<UsageEvent> {
    let mut events: Vec<UsageEvent> = Vec::new();
    let conn = match rusqlite::Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(c) => c,
        Err(_) => return events,
    };
    // Any error in the outer block aborts the rest (the TS try/catch keeps events so far).
    let _ = parse_windsurf_sqlite_inner(&conn, db_path, &mut events);
    events
}

fn parse_windsurf_sqlite_inner(
    conn: &rusqlite::Connection,
    db_path: &str,
    events: &mut Vec<UsageEvent>,
) -> Option<()> {
    let tables: Vec<String> = query_all(conn, "SELECT name FROM sqlite_master WHERE type='table'")?
        .into_iter()
        .map(|r| match r.map.get("name") {
            Some(Value::String(s)) => s.clone(),
            _ => String::new(),
        })
        .collect();

    // VS Code ItemTable key/value store
    if tables.iter().any(|t| t.to_lowercase() == "itemtable") {
        let rows = query_all(conn, "SELECT key, value FROM ItemTable")?;
        let mut i: u64 = 0;
        for row in &rows {
            i += 1;
            let key = match row.map.get("key") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Number(n)) => js_num_to_string(n.as_f64().unwrap_or(0.0)),
                _ => match row.blobs.get("key") {
                    Some(b) => b.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","),
                    None => String::new(),
                },
            };
            let key_lower = key.to_lowercase();
            if !has_any(&key_lower, &["usage", "token", "cascade", "chat", "billing", "credit", "model"]) {
                continue;
            }
            let value = match coerce_sqlite_value(row.map.get("value"), row.blobs.get("value")) {
                Some(v) => v,
                None => continue,
            };
            push_usage_from_unknown(events, &value, db_path, &format!("item:{}:{}", key, i));
        }
    }

    // Generic tables with token columns
    for table in &tables {
        if table.to_lowercase().contains("sqlite_") {
            continue;
        }
        // table variance: any failure skips just this table
        let _ = (|| -> Option<()> {
            let cols: Vec<String> =
                query_all(conn, &format!("PRAGMA table_info({})", quote_ident(table)))?
                    .into_iter()
                    .map(|r| match r.map.get("name") {
                        Some(Value::String(s)) => s.clone(),
                        _ => String::new(),
                    })
                    .collect();
            let colset: HashSet<String> = cols.iter().map(|c| c.to_lowercase()).collect();
            let has_tokens = colset.iter().any(|c| has_any(c, &["token", "usage", "credit", "cost"]))
                || (colset.contains("key") && colset.contains("value"));
            if !has_tokens {
                return Some(());
            }

            let sample = query_all(conn, &format!("SELECT * FROM {} LIMIT 5000", quote_ident(table)))?;
            let mut i: u64 = 0;
            for row in &sample {
                i += 1;
                let row_v = Value::Object(row.map.clone());
                if let Some(buckets) = extract_token_buckets(Some(&row_v)) {
                    events.push(apply_pricing(UsageEvent {
                        id: stable_id(&[
                            "windsurf",
                            db_path,
                            table.as_str(),
                            i.to_string().as_str(),
                            js_num_to_string(buckets.input_tokens).as_str(),
                        ]),
                        agent: AgentId::Windsurf,
                        model: extract_model(&[Some(&row_v)]),
                        timestamp: extract_timestamp(&[Some(&row_v)]),
                        input_tokens: buckets.input_tokens,
                        output_tokens: buckets.output_tokens,
                        cache_read_tokens: buckets.cache_read_tokens,
                        cache_write_tokens: buckets.cache_write_tokens,
                        cache_reported: buckets.cache_reported,
                        workspace: None,
                        source_path: db_path.to_string(),
                        ..Default::default()
                    }));
                    continue;
                }
                // key/value blob
                let has_value = row.blobs.contains_key("value")
                    || !matches!(row.map.get("value"), None | Some(Value::Null));
                if has_value {
                    if let Some(value) = coerce_sqlite_value(row.map.get("value"), row.blobs.get("value")) {
                        push_usage_from_unknown(events, &value, db_path, &format!("{}:{}", table, i));
                    }
                }
            }
            Some(())
        })();
    }
    Some(())
}

fn push_usage_from_unknown(events: &mut Vec<UsageEvent>, value: &Value, source_path: &str, tag: &str) {
    let candidates: Vec<&Value> = match value {
        Value::Array(a) => a.iter().collect(),
        Value::Object(o) => {
            let pick = ["messages", "events", "usage"].iter().find_map(|k| match o.get(*k) {
                Some(Value::Array(a)) => Some(a),
                _ => None,
            });
            match pick {
                Some(a) => a.iter().collect(),
                None => vec![value],
            }
        }
        _ => return,
    };

    let mut i: u64 = 0;
    for c in candidates {
        i += 1;
        let r = match c {
            Value::Object(m) => m,
            _ => continue,
        };
        let usage = coalesce(r, &["usage", "tokenUsage", "token_usage"], c);
        let buckets = match extract_token_buckets(Some(usage)) {
            Some(b) => b,
            None => continue,
        };
        events.push(apply_pricing(UsageEvent {
            id: stable_id(&[
                "windsurf",
                source_path,
                tag,
                i.to_string().as_str(),
                js_num_to_string(buckets.input_tokens).as_str(),
            ]),
            agent: AgentId::Windsurf,
            model: extract_model(&[Some(c)]),
            timestamp: extract_timestamp(&[Some(c)]),
            input_tokens: buckets.input_tokens,
            output_tokens: buckets.output_tokens,
            cache_read_tokens: buckets.cache_read_tokens,
            cache_write_tokens: buckets.cache_write_tokens,
            cache_reported: buckets.cache_reported,
            workspace: None,
            source_path: source_path.to_string(),
            ..Default::default()
        }));
    }
}

fn bracketed(t: &str) -> bool {
    (t.starts_with('{') && t.ends_with('}')) || (t.starts_with('[') && t.ends_with(']'))
}

/// `coerceSqliteValue`: only JSON objects/arrays stored as text or blob survive.
fn coerce_sqlite_value(value: Option<&Value>, blob: Option<&Vec<u8>>) -> Option<Value> {
    if let Some(b) = blob {
        let text = String::from_utf8_lossy(b);
        let t = js_trim(&text);
        if bracketed(t) {
            return serde_json::from_str::<Value>(t).ok();
        }
        // The TS returns the raw Uint8Array here, which never yields usage downstream.
        return None;
    }
    match value {
        Some(Value::String(s)) => {
            let t = js_trim(s);
            if bracketed(t) {
                serde_json::from_str::<Value>(t).ok()
            } else {
                None
            }
        }
        _ => None,
    }
}

fn file_mtime_iso(meta: &std::fs::Metadata) -> Option<String> {
    let ms = match meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_millis() as f64,
        Err(e) => -(e.duration().as_millis() as f64),
    };
    to_iso_string(ms)
}

/// Decrypt + parse ALL trajectory .pb under the windsurf data root.
///
/// Policy: prefer over-count over missing usage.
/// - cascade + implicit + any other *.pb (except settings) are all counted
/// - real Token Usage when decrypt works; else size heuristic for non-tiny files
/// - cascade vs implicit with different UUIDs are both kept (independent sessions)
/// - same path never counted twice (`seen`)
async fn parse_cascade_sessions(root: &str, seen: &mut HashSet<String>) -> Vec<UsageEvent> {
    let mut events: Vec<UsageEvent> = Vec::new();
    let flavor = PathFlavor::host();

    // Prefer known trajectory dirs first, then any leftover .pb under root
    let preferred_dirs = [
        flavor.join(&[root, "cascade"]),
        flavor.join(&[root, "windsurf", "cascade"]),
        flavor.join(&[root, "implicit"]),
        flavor.join(&[root, "windsurf", "implicit"]),
    ];

    let mut files: Vec<String> = Vec::new();
    for dir in &preferred_dirs {
        if !path_exists(dir).await {
            continue;
        }
        files.extend(
            walk_files(dir, WalkOptions::new().max_depth(6).matching(|n, _| n.ends_with(".pb"))).await,
        );
    }
    // Catch trajectories in unexpected subfolders (never drop a .pb quietly)
    if path_exists(root).await {
        files.extend(
            walk_files(
                root,
                WalkOptions::new().max_depth(8).matching(|n, _full| {
                    if !n.ends_with(".pb") {
                        return false;
                    }
                    let base = n.to_lowercase();
                    // settings / config blobs - not session usage
                    if base.contains("user_settings") || base.contains("settings") || base.contains("config") {
                        return false;
                    }
                    true
                }),
            )
            .await,
        );
    }

    for file in files {
        if seen.contains(&file) {
            continue;
        }
        seen.insert(file.clone());

        let meta = match tokio::fs::metadata(&file).await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size = meta.len();
        // Absolute empty stubs only
        if size < 64 {
            continue;
        }

        let session_id = flavor.basename_ext(&file, Some(".pb"));
        let timestamp = match file_mtime_iso(&meta) {
            Some(t) => t,
            None => continue, // `toISOString()` would throw on an invalid date
        };
        let kind = trajectory_kind(&file);
        let real = try_parse_encrypted_trajectory(&file).await;
        let has_real = real
            .as_ref()
            .map_or(false, |r| r.input_tokens > 0.0 || r.output_tokens > 0.0 || r.cache_read_tokens > 0.0);

        // Over-count policy: any non-trivial .pb without labels still gets size heuristic
        // (only skip tiny encrypted stubs < 256B with no metrics).
        if !has_real && size < 256 {
            continue;
        }

        // denser heuristic for small files so short sessions are not under-estimated
        let size_f = size as f64;
        let total_est = js_round(size_f / if size < 50_000 { 8.0 } else { 12.0 }).max(1.0);
        let (input_tokens, output_tokens, cache_read_tokens) = match (&real, has_real) {
            (Some(r), true) => (r.input_tokens, r.output_tokens, r.cache_read_tokens),
            _ => {
                let input = js_round(total_est * 0.65);
                (input, (total_est - input).max(1.0), 0.0)
            }
        };
        let model = real
            .as_ref()
            .map(|r| r.model.clone())
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| "windsurf-cascade".to_string());
        // Only the decrypted-trajectory branch measures cache; the size heuristic
        // never saw a cache number and must stay silent.
        let cache_reported = has_real
            && real.as_ref().map_or(false, |r| r.cache_reported || r.cache_read_tokens > 0.0);

        // One event per trajectory file - id must not change when tokens grow mid-session.
        events.push(apply_pricing(UsageEvent {
            id: stable_id(&["windsurf", kind, session_id.as_str(), file.as_str()]),
            agent: AgentId::Windsurf,
            model: Some(model),
            timestamp,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens: 0.0,
            workspace: None,
            source_path: file.clone(),
            estimated: Some(!has_real),
            cache_reported: if cache_reported { Some(true) } else { None },
            ..Default::default()
        }));
    }

    events
}

fn trajectory_kind(file: &str) -> &'static str {
    let lower = file.replace('\\', "/").to_lowercase();
    if lower.contains("/cascade/") {
        "cascade"
    } else if lower.contains("/implicit/") {
        "implicit"
    } else {
        "pb"
    }
}

/// AES-256-GCM unwrap of a cascade/implicit .pb file.
pub fn decrypt_cascade_pb(ciphertext: &[u8]) -> Option<Vec<u8>> {
    if ciphertext.len() < 12 + 16 {
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(CASCADE_AES_KEY).ok()?;
    let nonce = Nonce::try_from(&ciphertext[..12]).ok()?;
    // aes-gcm expects the 16-byte tag appended to the ciphertext, which is this layout.
    cipher.decrypt(&nonce, &ciphertext[12..]).ok()
}

/// Token Usage metric layout in CortexTrajectory protobuf (UI stats):
///   ... "Input tokens" 0x15 <float32 LE> ...
/// Field 2 wire-type 5 (fixed32) holds the value; omitted when zero.
pub fn extract_labeled_floats(plaintext: &[u8], label: &str) -> Vec<f64> {
    let needle = label.as_bytes();
    let mut out: Vec<f64> = Vec::new();
    if needle.is_empty() {
        return out;
    }
    let mut idx = 0usize;
    while idx <= plaintext.len() {
        let found = match find_bytes(&plaintext[idx..], needle) {
            Some(p) => idx + p,
            None => break,
        };
        let base = found + needle.len();
        // Wire type 5 (fixed32) tag is usually 0x15 immediately after the label;
        // also scan a few skip bytes for protobuf padding / field headers.
        for off in 0..=6usize {
            let pos = base + off;
            if pos + 5 > plaintext.len() {
                break;
            }
            if plaintext[pos] != 0x15 {
                continue;
            }
            let f = f32::from_le_bytes([plaintext[pos + 1], plaintext[pos + 2], plaintext[pos + 3], plaintext[pos + 4]])
                as f64;
            if f.is_finite() && f >= 0.0 && f < 50_000_000.0 {
                out.push(f);
                break;
            }
        }
        idx = base;
    }
    out
}

fn find_bytes(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

static MODEL_RE: Lazy<regex::bytes::Regex> = Lazy::new(|| {
    // ASCII-only `\b` and case-insensitivity, matched over raw bytes (== latin1 chars).
    regex::bytes::Regex::new(r"(?i-u)\b((?:claude|gpt|gemini|swe|glm|kimi|deepseek|minimax|qwen|o[1-9]|cascade)[-a-z0-9]{2,40})\b")
        .expect("valid model regex")
});

/// Dominant model slug from decrypted trajectory (glm-5-2, kimi-k2-7, swe-1-6, ...).
pub fn extract_dominant_model(plaintext: &[u8]) -> Option<String> {
    // Insertion-ordered counts: the first slug to reach the max wins ties.
    let mut counts: Vec<(String, usize)> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for m in MODEL_RE.captures_iter(plaintext) {
        let raw = match m.get(1) {
            Some(g) => g.as_bytes(),
            None => continue,
        };
        let s = String::from_utf8_lossy(raw).to_lowercase();
        if s.len() < 5 || s.len() > 36 {
            continue;
        }
        if s.chars().any(|c| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')) {
            continue;
        }
        if matches!(s.as_str(), "claude" | "gpt" | "gemini" | "swe" | "glm" | "kimi") {
            continue;
        }
        match index.get(&s) {
            Some(&i) => counts[i].1 += 1,
            None => {
                index.insert(s.clone(), counts.len());
                counts.push((s, 1));
            }
        }
    }
    let mut best: Option<&str> = None;
    let mut best_n = 0usize;
    for (k, n) in &counts {
        if *n > best_n {
            best = Some(k.as_str());
            best_n = *n;
        }
    }
    best.map(|s| s.to_string())
}

#[derive(Debug, Clone, PartialEq)]
pub struct CascadeUsage {
    pub model: Option<String>,
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cache_read_tokens: f64,
    /// True when a cache label was present (even at 0), so the number is measured.
    pub cache_reported: bool,
}

pub fn extract_cascade_usage(plaintext: &[u8]) -> CascadeUsage {
    let sum = |xs: &[f64]| xs.iter().fold(0.0, |a, b| a + js_round(*b));
    // First matching label family only (avoid double-summing variants)
    let pick_vals = |labels: &[&str]| -> Option<Vec<f64>> {
        for label in labels {
            let vals = extract_labeled_floats(plaintext, label);
            if !vals.is_empty() {
                return Some(vals);
            }
        }
        None
    };
    let cache_vals =
        pick_vals(&["Cached input tokens", "Cached tokens", "Cache read tokens", "cached input tokens"]);
    CascadeUsage {
        model: extract_dominant_model(plaintext),
        input_tokens: sum(&pick_vals(&["Input tokens", "input tokens", "Prompt tokens"]).unwrap_or_default()),
        output_tokens: sum(&pick_vals(&["Output tokens", "output tokens", "Completion tokens"]).unwrap_or_default()),
        cache_read_tokens: sum(cache_vals.as_deref().unwrap_or(&[])),
        cache_reported: cache_vals.is_some(),
    }
}

struct EncryptedTrajectory {
    model: String,
    input_tokens: f64,
    output_tokens: f64,
    cache_read_tokens: f64,
    cache_reported: bool,
}

async fn try_parse_encrypted_trajectory(file: &str) -> Option<EncryptedTrajectory> {
    let raw = tokio::fs::read(file).await.ok()?;
    let plain = decrypt_cascade_pb(&raw)?;
    let usage = extract_cascade_usage(&plain);
    Some(EncryptedTrajectory {
        model: usage.model.filter(|m| !m.is_empty()).unwrap_or_else(|| "windsurf-cascade".to_string()),
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_reported: usage.cache_reported,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encrypt_cascade(plaintext: &[u8]) -> Vec<u8> {
        let cipher = Aes256Gcm::new_from_slice(CASCADE_AES_KEY).unwrap();
        let nonce_bytes = [3u8; 12];
        let nonce = Nonce::try_from(&nonce_bytes[..]).unwrap();
        let body_and_tag = cipher.encrypt(&nonce, plaintext).unwrap();
        let mut out = nonce_bytes.to_vec();
        out.extend(body_and_tag);
        out
    }

    fn push_label_float(parts: &mut Vec<u8>, label: &str, value: f32) {
        parts.extend_from_slice(label.as_bytes());
        parts.push(0x15);
        parts.extend_from_slice(&value.to_le_bytes());
    }

    fn build_fake_trajectory() -> Vec<u8> {
        let mut p: Vec<u8> = b"model slug glm-5-2 appears often glm-5-2 glm-5-2 ".to_vec();
        push_label_float(&mut p, "Input tokens", 14231.0);
        push_label_float(&mut p, "Output tokens", 1151.0);
        push_label_float(&mut p, "Cached input tokens", 134023.0);
        push_label_float(&mut p, "Input tokens", 1000.0);
        push_label_float(&mut p, "Output tokens", 200.0);
        push_label_float(&mut p, "Cached input tokens", 500.0);
        p
    }

    fn rounded(v: Vec<f64>) -> Vec<f64> {
        v.into_iter().map(js_round).collect()
    }

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "windsurf");
        assert_eq!(a.label, "Windsurf");
    }

    #[test]
    fn decrypt_unwraps_aes_gcm_cascade_layout() {
        let ct = encrypt_cascade(b"hello cascade trajectory");
        let out = decrypt_cascade_pb(&ct).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), "hello cascade trajectory");
    }

    #[test]
    fn decrypt_rejects_garbage() {
        assert!(decrypt_cascade_pb(&[7u8; 40]).is_none());
        assert!(decrypt_cascade_pb(&[0u8; 10]).is_none());
    }

    #[test]
    fn labeled_floats_read_after_0x15_tag() {
        let plain = build_fake_trajectory();
        assert_eq!(rounded(extract_labeled_floats(&plain, "Input tokens")), vec![14231.0, 1000.0]);
        assert_eq!(rounded(extract_labeled_floats(&plain, "Output tokens")), vec![1151.0, 200.0]);
        assert_eq!(rounded(extract_labeled_floats(&plain, "Cached input tokens")), vec![134023.0, 500.0]);
    }

    #[test]
    fn dominant_model_picks_most_frequent_slug() {
        assert_eq!(extract_dominant_model(&build_fake_trajectory()).as_deref(), Some("glm-5-2"));
    }

    #[test]
    fn cascade_usage_sums_metrics_and_model() {
        let u = extract_cascade_usage(&build_fake_trajectory());
        assert_eq!(u.model.as_deref(), Some("glm-5-2"));
        assert_eq!(u.input_tokens, 15231.0);
        assert_eq!(u.output_tokens, 1351.0);
        assert_eq!(u.cache_read_tokens, 134523.0);
        assert!(u.cache_reported);
    }

    #[test]
    fn round_trip_encrypt_decrypt_extract() {
        let ct = encrypt_cascade(&build_fake_trajectory());
        let dec = decrypt_cascade_pb(&ct).unwrap();
        let u = extract_cascade_usage(&dec);
        assert_eq!(u.model.as_deref(), Some("glm-5-2"));
        assert_eq!(u.input_tokens, 15231.0);
        assert_eq!(u.cache_read_tokens, 134523.0);
    }

    fn build_plain(model: &str, input: f32, output: f32, cache: f32) -> Vec<u8> {
        let mut p: Vec<u8> = format!("model {model} {model} {model} ").into_bytes();
        push_label_float(&mut p, "Input tokens", input);
        push_label_float(&mut p, "Output tokens", output);
        push_label_float(&mut p, "Cached input tokens", cache);
        p.extend(std::iter::repeat(0x61u8).take(600));
        p
    }

    #[tokio::test]
    async fn parse_counts_both_cascade_and_independent_implicit_sessions() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        std::fs::create_dir_all(root.join("cascade")).unwrap();
        std::fs::create_dir_all(root.join("implicit")).unwrap();
        std::fs::write(root.join("cascade").join("sess-a.pb"), encrypt_cascade(&build_plain("glm-5-2", 1000.0, 100.0, 500.0)))
            .unwrap();
        std::fs::write(
            root.join("implicit").join("sess-b.pb"),
            encrypt_cascade(&build_plain("kimi-k2-7", 2000.0, 200.0, 800.0)),
        )
        .unwrap();

        let events = parse_windsurf(vec![root.to_string_lossy().to_string()]).await.unwrap();
        assert_eq!(events.len(), 2);
        let cascade = events.iter().find(|e| e.source_path.contains("cascade")).unwrap();
        let implicit = events.iter().find(|e| e.source_path.contains("implicit")).unwrap();
        assert_eq!(cascade.input_tokens, 1000.0);
        assert_eq!(cascade.cache_read_tokens, 500.0);
        assert_eq!(cascade.estimated, Some(false));
        assert_eq!(cascade.cache_reported, Some(true));
        assert_eq!(implicit.input_tokens, 2000.0);
        assert_eq!(implicit.model.as_deref(), Some("kimi-k2-7"));
    }

    #[tokio::test]
    async fn undecryptable_pb_uses_size_heuristic() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        std::fs::write(root.join("junk.pb"), vec![9u8; 800]).unwrap();
        std::fs::write(root.join("tiny.pb"), vec![9u8; 100]).unwrap();
        let events = parse_windsurf(vec![root.to_string_lossy().to_string()]).await.unwrap();
        assert_eq!(events.len(), 1);
        let e = &events[0];
        // 800 / 8 = 100 total; input = round(65), output = 35
        assert_eq!(e.input_tokens, 65.0);
        assert_eq!(e.output_tokens, 35.0);
        assert_eq!(e.model.as_deref(), Some("windsurf-cascade"));
        assert_eq!(e.estimated, Some(true));
        assert_eq!(e.cache_reported, None);
    }

    #[tokio::test]
    async fn json_artifacts_are_parsed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        std::fs::write(
            root.join("usage.json"),
            r#"{"events":[{"model":"gpt-5","cwd":"/w","timestamp":"2024-01-02T03:04:05Z","usage":{"input_tokens":10,"output_tokens":5}},{"x":1}]}"#,
        )
        .unwrap();
        let events = parse_windsurf(vec![root.to_string_lossy().to_string()]).await.unwrap();
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.input_tokens, 10.0);
        assert_eq!(e.output_tokens, 5.0);
        assert_eq!(e.workspace.as_deref(), Some("/w"));
        assert_eq!(e.timestamp, "2024-01-02T03:04:05.000Z");
    }

    #[tokio::test]
    async fn sqlite_item_table_is_parsed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let db = root.join("state.vscdb");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE ItemTable (key TEXT, value BLOB);
                 INSERT INTO ItemTable VALUES ('chat.usage', '[{\"usage\":{\"input_tokens\":7,\"output_tokens\":3}}]');
                 INSERT INTO ItemTable VALUES ('other', '[{\"usage\":{\"input_tokens\":99}}]');",
            )
            .unwrap();
        }
        let events = parse_windsurf(vec![root.to_string_lossy().to_string()]).await.unwrap();
        // ItemTable has key+value columns, so the key-filtered pass yields 1 row and the
        // generic key/value pass then yields both rows (same as the TS, which double counts).
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].input_tokens, 7.0);
        assert_eq!(events[0].output_tokens, 3.0);
        assert!(events[0].id.len() == 24);
    }
}
