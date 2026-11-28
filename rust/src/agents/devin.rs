//! Agent: Devin (port of `src/agents/devin/index.ts`).
//!
//! Devin Desktop (Cognition):
//! - `%APPDATA%/devin/cli/sessions.db` (message_nodes.chat_message JSON + metrics)
//! - `%APPDATA%/devin/User/**` (VS Code fork storage)
//! - `~/.devin`

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use rusqlite::types::ValueRef;
use serde_json::Value;

use crate::agents::shared::env::{path_env, unique};
use crate::agents::shared::generic_jsonl::{parse_generic_jsonl, GenericJsonlOptions};
use crate::agents::shared::usage_fields::{extract_model, extract_timestamp, extract_token_buckets};
use crate::agents::{parse_fn, AgentModule};
use crate::pricing::apply_pricing;
use crate::types::{AgentId, UsageEvent};
use crate::util::{
    js_num_to_string, js_trim, normalize_model_for_agent, now_ms, path_exists, pjoin, stable_id, to_iso_string,
    PathFlavor,
};

/// Local data roots to scan on this machine.
pub fn roots() -> Vec<String> {
    let e = path_env();
    let mut r: Vec<String> = Vec::new();
    r.push(e.j(&[&e.app_data, "devin"]));
    r.push(e.j(&[&e.home, ".devin"]));
    r.push(e.j(&[&e.local_app, "devin"]));
    r.push(e.j(&[&e.app_data, "Devin"]));
    unique(r)
}

pub async fn parse_devin(roots: &[String]) -> anyhow::Result<Vec<UsageEvent>> {
    let mut events: Vec<UsageEvent> = Vec::new();
    // Windows paths are case-insensitive - normalize to avoid double-counting
    // e.g. %APPDATA%/devin vs %APPDATA%/Devin
    let mut seen_db: HashSet<String> = HashSet::new();

    for root in roots {
        if !path_exists(root).await {
            continue;
        }

        let mut root_sqlite_events = 0usize;
        // SQLite sessions (canonical)
        for rel in ["cli/sessions.db", "sessions.db", "state.db"] {
            let db_path = pjoin(&[root.as_str(), rel]);
            let db_key = db_path.to_lowercase();
            if path_exists(&db_path).await && !seen_db.contains(&db_key) {
                seen_db.insert(db_key);
                let batch = parse_devin_sqlite(&db_path).await;
                root_sqlite_events += batch.len();
                events.extend(batch);
            }
        }

        // JSON/JSONL fallback only when this root had no SQLite rows -
        // exporting the same sessions as jsonl used to double-count cache tokens.
        if root_sqlite_events == 0 {
            let sep = PathFlavor::host().sep();
            let summaries = format!("{}summaries{}", sep, sep);
            let mut opts = GenericJsonlOptions::new(AgentId::Devin);
            opts.max_depth = Some(8);
            opts.match_fn = Some(Arc::new(move |n: &str, full: &str| {
                n.ends_with(".jsonl")
                    || (n.ends_with(".json")
                        && (n.contains("usage") || n.contains("session") || !full.contains(summaries.as_str())))
            }));
            events.extend(parse_generic_jsonl(std::slice::from_ref(root), &opts).await?);
        }
    }

    Ok(events)
}

async fn parse_devin_sqlite(db_path: &str) -> Vec<UsageEvent> {
    let db_path = db_path.to_string();
    tokio::task::spawn_blocking(move || {
        let mut events: Vec<UsageEvent> = Vec::new();
        // locked or unavailable -> whatever was gathered so far
        let _ = parse_devin_sqlite_blocking(&db_path, &mut events);
        events
    })
    .await
    .unwrap_or_default()
}

/// A SQLite cell as the JS `node:sqlite` driver would hand it back, reduced to
/// what the Devin parser reads.
enum Cell {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

fn cell(v: ValueRef<'_>) -> Cell {
    match v {
        ValueRef::Null => Cell::Null,
        ValueRef::Integer(i) => Cell::Int(i),
        ValueRef::Real(f) => Cell::Real(f),
        ValueRef::Text(t) => Cell::Text(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Cell::Blob(b.to_vec()),
    }
}

/// `String(cell)` for number/text cells (null -> None).
fn cell_string(c: &Cell) -> Option<String> {
    match c {
        Cell::Null => None,
        Cell::Int(i) => Some(i.to_string()),
        Cell::Real(f) => Some(js_num_to_string(*f)),
        Cell::Text(s) => Some(s.clone()),
        Cell::Blob(b) => Some(b.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")),
    }
}

fn parse_devin_sqlite_blocking(db_path: &str, events: &mut Vec<UsageEvent>) -> rusqlite::Result<()> {
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;

    let mut session_models: HashMap<String, Option<String>> = HashMap::new();
    // schema variance: ignore failures
    let _ = (|| -> rusqlite::Result<()> {
        let mut stmt = conn.prepare("SELECT id, model, working_directory FROM sessions")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let id = cell(row.get_ref(0)?);
            let model = cell(row.get_ref(1)?);
            let m = match &model {
                Cell::Text(s) => js_trim(s).to_string(),
                _ => String::new(),
            };
            session_models.insert(
                cell_string(&id).unwrap_or_else(|| "null".to_string()),
                if m.is_empty() { None } else { Some(m) },
            );
        }
        Ok(())
    })();

    // Prefer newest rows first so a high LIMIT never drops last-night / this-morning usage
    // when the DB grows past the cap (rowid order alone is oldest-first).
    let mut stmt = conn.prepare(
        "SELECT row_id, session_id, chat_message, created_at, metadata
           FROM message_nodes
           WHERE chat_message IS NOT NULL
           ORDER BY row_id DESC
           LIMIT 200000",
    )?;
    let mut rows = stmt.query([])?;
    let db_key = db_path.to_lowercase();

    while let Some(row) = rows.next()? {
        let row_id = cell(row.get_ref(0)?);
        let session_id = cell(row.get_ref(1)?);
        let chat_message = cell(row.get_ref(2)?);
        let created_at = cell(row.get_ref(3)?);

        let raw: String = match &chat_message {
            Cell::Text(s) => s.clone(),
            Cell::Blob(b) => String::from_utf8_lossy(b).into_owned(),
            _ => continue,
        };
        if raw.is_empty() {
            continue;
        }
        // Cheap reject before JSON parse - most chat_message rows have no usage.
        if !raw.contains("token") && !raw.contains("Token") && !raw.contains("usage") && !raw.contains("Usage") {
            continue;
        }
        let msg: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let buckets = match extract_token_buckets(Some(&msg)) {
            Some(b) => b,
            None => continue,
        };

        let sid = cell_string(&session_id).unwrap_or_default();
        let session_model: Option<&String> = session_models.get(&sid).and_then(|m| m.as_ref());
        let session_model_val = session_model.map(|s| Value::String(s.clone()));
        let metadata = msg.get("metadata");
        // Some Devin sessions leave model empty in sessions table (legacy / adaptive routing)
        let extracted = extract_model(&[Some(&msg), metadata, session_model_val.as_ref()]);
        let model = normalize_model_for_agent(
            extracted.as_deref().or(session_model.map(|s| s.as_str())),
            Some("devin"),
        );

        let created_fallback: Option<String> = match &created_at {
            Cell::Text(s) => Some(s.clone()),
            Cell::Int(_) | Cell::Real(_) => {
                let f = match &created_at {
                    Cell::Int(i) => *i as f64,
                    Cell::Real(f) => *f,
                    _ => 0.0,
                };
                if f.is_finite() && f > 0.0 {
                    if f > 1e12 {
                        match to_iso_string(f) {
                            Some(s) => Some(s),
                            None => return Ok(()), // JS RangeError aborts the whole parse
                        }
                    } else if f > 1e9 {
                        match to_iso_string(f * 1000.0) {
                            Some(s) => Some(s),
                            None => return Ok(()),
                        }
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
            _ => None,
        };
        let created_fallback_val = created_fallback.as_ref().map(|s| Value::String(s.clone()));
        let created_at_val: Option<Value> = match &created_at {
            Cell::Text(s) => Some(Value::String(s.clone())),
            Cell::Int(i) => Some(Value::from(*i)),
            Cell::Real(f) => serde_json::Number::from_f64(*f).map(Value::Number),
            _ => None,
        };
        let mut ts = extract_timestamp(&[
            Some(&msg),
            metadata,
            created_fallback_val.as_ref(),
            created_at_val.as_ref(),
        ]);
        if ts.is_empty() {
            ts = match created_fallback {
                Some(s) if !s.is_empty() => s,
                _ => to_iso_string(now_ms()).unwrap_or_default(),
            };
        }

        let row_id_str = cell_string(&row_id).unwrap_or_else(|| "undefined".to_string());
        events.push(apply_pricing(UsageEvent {
            // stable across path casing so remounts don't duplicate.
            // row_id alone is enough - hashing tokens re-created ids when
            // cache fields were refined and double-counted cache usage.
            id: stable_id(&["devin", db_key.as_str(), sid.as_str(), row_id_str.as_str()]).into(),
            agent: AgentId::Devin,
            model: model.map(Into::into),
            timestamp: ts.into(),
            input_tokens: buckets.input_tokens,
            output_tokens: buckets.output_tokens,
            cache_read_tokens: buckets.cache_read_tokens,
            cache_write_tokens: buckets.cache_write_tokens,
            cache_reported: buckets.cache_reported,
            workspace: None,
            source_path: db_path.to_string().into(),
            ..Default::default()
        }));
    }
    Ok(())
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Devin,
        label: "Devin",
        roots,
        parse: parse_fn(|roots: Vec<String>| async move { parse_devin(&roots).await }),
        parse_light: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "devin");
        assert_eq!(a.label, "Devin");
    }

    #[tokio::test]
    async fn parses_sqlite_message_nodes() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("cli");
        std::fs::create_dir_all(&cli).unwrap();
        let db = cli.join("sessions.db");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE sessions (id TEXT, model TEXT, working_directory TEXT);
                 CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY, session_id TEXT, chat_message TEXT, created_at TEXT, metadata TEXT);
                 INSERT INTO sessions VALUES ('s1', 'swe-1.6', '/w');
                 INSERT INTO message_nodes VALUES (1, 's1', '{\"usage\":{\"input_tokens\":10,\"output_tokens\":4}}', '2026-03-01T00:00:00.000Z', NULL);
                 INSERT INTO message_nodes VALUES (2, 's1', '{\"text\":\"hello\"}', '2026-03-01T00:00:01.000Z', NULL);",
            )
            .unwrap();
        }
        let events = parse_devin(&[dir.path().to_string_lossy().to_string()]).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].input_tokens, 10.0);
        assert_eq!(events[0].output_tokens, 4.0);
        assert_eq!(events[0].timestamp, "2026-03-01T00:00:00.000Z");
        assert_eq!(events[0].source_path, db.to_string_lossy());
        assert!(events[0].model.is_some());
    }
}
