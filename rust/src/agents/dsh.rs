//! Agent: DeepSeek Harness (port of `src/agents/dsh/index.ts`).

use crate::agents::shared::env::{path_env, unique};
use crate::agents::shared::usage_fields::{extract_model, extract_timestamp, extract_token_buckets};
use crate::agents::{parse_fn, AgentModule};
use crate::pricing::apply_pricing;
use crate::types::{AgentId, UsageEvent};
use crate::util::{
    decompress_zstd_frames, js_date_parse, js_num_to_string, js_trim, now_ms, stable_id, stamp_file,
    walk_files, PathFlavor, WalkOptions,
};
use indexmap::IndexMap;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;

const LIGHT_HISTORY_MS: f64 = 30.0 * 24.0 * 60.0 * 60.0 * 1_000.0;

static SESSION_FILE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$").unwrap());

/// Unchanged session files are not decompressed again on the next minute tick.
static DSH_LIGHT_SIG: Lazy<Mutex<HashMap<String, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));
/// Session file list from the last light walk. A new session folder changes the shape.
static DSH_LIGHT_INDEX: Lazy<Mutex<HashMap<String, (String, Vec<String>)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Local data roots to scan on this machine.
pub fn roots() -> Vec<String> {
    let e = path_env();
    let configured = std::env::var("DSH_HOME").ok().map(|s| js_trim(&s).to_string()).unwrap_or_default();
    let dsh_home = e.expand_home(&if configured.is_empty() { e.j(&[&e.home, ".dsh"]) } else { configured });
    let mut r: Vec<String> = Vec::new();
    r.push(e.j(&[&dsh_home, "sessions"]));
    unique(r)
}

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

fn extract_stream_usage(stream: Option<&Value>) -> Option<&Value> {
    let arr = match stream {
        Some(Value::Array(a)) => a,
        _ => return None,
    };
    for record in arr.iter().rev() {
        if !matches!(record, Value::Object(_) | Value::Array(_)) {
            continue;
        }
        let item = Some(record);
        let chunk = obj_like(g(item, "chunk"));
        if matches!(g(chunk, "type"), Some(Value::String(s)) if s == "usage") {
            if let Some(u) = g(chunk, "usage") {
                return Some(u);
            }
        }
        if matches!(g(item, "type"), Some(Value::String(s)) if s == "usage") {
            if let Some(u) = g(item, "usage") {
                return Some(u);
            }
        }
    }
    None
}

/// Lines as `readline` (`crlfDelay: Infinity`) yields them: split on `\r\n`, `\n` or `\r`.
fn raw_lines(text: &str) -> Vec<&str> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < b.len() {
        if b[i] == b'\n' {
            out.push(&text[start..i]);
            i += 1;
            start = i;
        } else if b[i] == b'\r' {
            out.push(&text[start..i]);
            i += if i + 1 < b.len() && b[i + 1] == b'\n' { 2 } else { 1 };
            start = i;
        } else {
            i += 1;
        }
    }
    if start < b.len() {
        out.push(&text[start..]);
    }
    out
}

fn is_zstd(file: &str) -> bool {
    file.to_lowercase().ends_with(".zstd")
}

/// All lines of a session file; `Err` when the file cannot be read or a `.zstd` file is damaged.
fn read_session_lines(file: &str) -> Result<Vec<String>, ()> {
    let bytes = std::fs::read(file).map_err(|_| ())?;
    if !is_zstd(file) {
        let text = String::from_utf8_lossy(&bytes);
        return Ok(raw_lines(&text).into_iter().map(|s| s.to_string()).collect());
    }
    let frames = decompress_zstd_frames(&bytes).map_err(|_| ())?;
    let mut pending = String::new();
    let mut lines = Vec::new();
    for f in frames {
        pending.push_str(&String::from_utf8_lossy(&f));
        let mut parts: Vec<String> = pending.split('\n').map(|s| s.to_string()).collect();
        pending = parts.pop().unwrap_or_default();
        for line in parts {
            lines.push(line.strip_suffix('\r').map(|s| s.to_string()).unwrap_or(line));
        }
    }
    // A final non-newline-terminated fragment belongs to a torn append and is ignored.
    Ok(lines)
}

fn dsh_index_key(roots: &[String]) -> String {
    let flavor = PathFlavor::host();
    let mut v: Vec<String> = roots.iter().map(|r| flavor.resolve(&[r.as_str()]).to_lowercase()).collect();
    v.sort();
    v.join("|")
}

fn mtime_floor(m: &std::fs::Metadata) -> i64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| (d.as_secs_f64() * 1000.0).floor() as i64)
        .unwrap_or(0)
}

/// Root mtime plus each project folder mtime. An append does not change this.
fn dsh_tree_shape(roots: &[String]) -> String {
    let flavor = PathFlavor::host();
    let mut parts: Vec<String> = Vec::new();
    for root in roots {
        let st = match std::fs::metadata(root) {
            Ok(s) => s,
            Err(_) => {
                parts.push(format!("r|{root}|missing"));
                continue;
            }
        };
        parts.push(format!("r|{root}|{}", mtime_floor(&st)));
        let rd = match std::fs::read_dir(root) {
            Ok(r) => r,
            Err(_) => {
                parts.push(format!("r|{root}|missing"));
                continue;
            }
        };
        let mut dirs: Vec<String> = rd
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        dirs.sort();
        parts.push(format!("n|{root}|{}", dirs.len()));
        for name in dirs {
            match std::fs::metadata(flavor.join(&[root.as_str(), name.as_str()])) {
                Ok(c) => parts.push(format!("d|{root}|{name}|{}", mtime_floor(&c))),
                Err(_) => parts.push(format!("d|{root}|{name}|missing")),
            }
        }
    }
    parts.join("\n")
}

async fn dsh_light_files(roots: &[String], cutoff: f64) -> Vec<String> {
    let key = dsh_index_key(roots);
    let shape = {
        let r = roots.to_vec();
        tokio::task::spawn_blocking(move || dsh_tree_shape(&r)).await.unwrap_or_default()
    };
    {
        let idx = DSH_LIGHT_INDEX.lock();
        if let Some((s, files)) = idx.get(&key) {
            if *s == shape {
                return files.clone();
            }
        }
    }
    let files = latest_session_files(roots, Some(cutoff)).await;
    DSH_LIGHT_INDEX.lock().insert(key, (shape, files.clone()));
    files
}

fn dsh_sig_key(file: &str) -> String {
    if cfg!(windows) {
        file.to_lowercase()
    } else {
        file.to_string()
    }
}

async fn latest_session_files(roots: &[String], modified_after: Option<f64>) -> Vec<String> {
    struct Best {
        file: String,
        version: f64,
        raw: bool,
    }
    let flavor = PathFlavor::host();
    let mut latest: IndexMap<String, Best> = IndexMap::new();

    for root in roots {
        let files = walk_files(
            root,
            WalkOptions::new().max_depth(12).matching(|name, _| SESSION_FILE.is_match(name)),
        )
        .await;
        for file in files {
            let base = flavor.basename(&file);
            let caps = match SESSION_FILE.captures(&base) {
                Some(c) => c,
                None => continue,
            };
            let version = caps.get(1).map_or(0.0, |m| m.as_str().parse::<f64>().unwrap_or(0.0));
            let raw = !is_zstd(&file);
            let session_dir = flavor.resolve(&[flavor.dirname(&file)]);
            let replace = match latest.get(&session_dir) {
                None => true,
                Some(p) => version > p.version || (version == p.version && raw && !p.raw),
            };
            if replace {
                latest.insert(session_dir, Best { file, version, raw });
            }
        }
    }

    let files: Vec<String> = latest.into_values().map(|b| b.file).collect();
    let cutoff = match modified_after {
        None => return files,
        Some(c) => c,
    };
    let mut out = Vec::new();
    for file in files {
        if let Some(st) = stamp_file(&file).await {
            if st.mtime_ms >= cutoff {
                out.push(file);
            }
        }
    }
    out
}

/// Parse one session file. `None` when the file is damaged (TS: thrown, caller ignores it).
fn parse_session_file_sync(file: &str) -> Option<Vec<UsageEvent>> {
    let mut events: Vec<UsageEvent> = Vec::new();
    let mut workspace: Option<String> = None;
    let mut current_model: Option<String> = None;
    let mut line_number: f64 = 0.0;

    for line in read_session_lines(file).ok()? {
        line_number += 1.0;
        let parsed: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // `null.type` throws in JS, which discards the whole file.
        if parsed.is_null() {
            return None;
        }
        let p = Some(&parsed);
        let ptype: Option<&str> = match g(p, "type") {
            Some(Value::String(s)) => Some(s.as_str()),
            _ => None,
        };

        if ptype == Some("session") {
            if let Some(Value::String(c)) = g(p, "cwd") {
                workspace = Some(c.clone());
            }
            continue;
        }

        let data = match obj_like(g(p, "data")) {
            Some(d) => d,
            None => continue,
        };
        let data_o = Some(data);

        if ptype == Some("request/context") {
            current_model = extract_model(&[data_o]).or(current_model);
            continue;
        }

        // `compaction/summary` is a real model call too.
        let is_summary = ptype == Some("compaction/summary");
        if ptype != Some("assistant/message") && ptype != Some("assistant/attempt") && !is_summary {
            continue;
        }

        let message = obj_like(g(data_o, "message"));
        let explicit_usage = g(data_o, "usage").or_else(|| g(message, "usage"));
        let stream_usage = extract_stream_usage(g(data_o, "stream"));
        let usage = if ptype == Some("assistant/message") {
            explicit_usage.or(stream_usage)
        } else if ptype == Some("assistant/attempt") {
            stream_usage.or(explicit_usage)
        } else {
            explicit_usage
        };
        let buckets = match extract_token_buckets(usage) {
            Some(b) => b,
            None => continue,
        };

        let source = obj_like(g(message, "source"));
        let model = extract_model(&[source, data_o]).or_else(|| current_model.clone());
        if model.is_some() {
            current_model = model.clone();
        }

        // Unknown cache read is reported as zero and the prompt counted as fresh input.
        let reported = buckets.input_includes_cache == Some(true) || buckets.cache_read_tokens > 0.0;
        let (input_tokens, cache_read_tokens) = if reported {
            (buckets.input_tokens, buckets.cache_read_tokens)
        } else {
            (buckets.input_tokens.max(0.0), 0.0)
        };

        let seq = match g(p, "seq") {
            Some(v) => js_string(v),
            None => js_num_to_string(line_number),
        };

        events.push(apply_pricing(UsageEvent {
            id: stable_id(&["dsh", file, seq.as_str()]),
            agent: AgentId::Dsh,
            model: model.map(Into::into),
            timestamp: extract_timestamp(&[p, message]),
            input_tokens,
            output_tokens: buckets.output_tokens,
            cache_read_tokens,
            cache_write_tokens: buckets.cache_write_tokens,
            request_count: Some(1.0),
            workspace: workspace.clone().map(Into::into),
            source_path: file.to_string().into(),
            cache_reported: Some(reported),
            ..Default::default()
        }));
    }
    Some(events)
}

async fn parse_session_file(file: String) -> Option<Vec<UsageEvent>> {
    tokio::task::spawn_blocking(move || parse_session_file_sync(&file)).await.ok().flatten()
}

async fn parse_dsh_files(roots: &[String], modified_after: Option<f64>) -> Vec<UsageEvent> {
    let files = latest_session_files(roots, modified_after).await;
    let mut events = Vec::new();
    for file in files {
        // Ignore a damaged or partially written session and keep the other history.
        if let Some(mut e) = parse_session_file(file).await {
            events.append(&mut e);
        }
    }
    events
}

pub async fn parse_dsh(roots: Vec<String>) -> anyhow::Result<Vec<UsageEvent>> {
    Ok(parse_dsh_files(&roots, None).await)
}

async fn parse_dsh_light(roots: Vec<String>) -> anyhow::Result<Vec<UsageEvent>> {
    let cutoff = now_ms() - LIGHT_HISTORY_MS;
    let files = dsh_light_files(&roots, cutoff).await;
    let mut changed: Vec<(String, String, String)> = Vec::new();
    for file in files {
        let sig = match stamp_file(&file).await {
            Some(st) => st.size.to_string(),
            None => continue,
        };
        let key = dsh_sig_key(&file);
        let same = DSH_LIGHT_SIG.lock().get(&key) == Some(&sig);
        if same {
            continue;
        }
        changed.push((file, key, sig));
    }
    if changed.is_empty() {
        return Ok(Vec::new());
    }

    let mut events = Vec::new();
    for (file, key, sig) in changed {
        if let Some(mut e) = parse_session_file(file.clone()).await {
            events.append(&mut e);
            let stored = match stamp_file(&file).await {
                Some(after) => after.size.to_string(),
                None => sig,
            };
            DSH_LIGHT_SIG.lock().insert(key, stored);
        }
    }
    Ok(events.into_iter().filter(|e| js_date_parse(&e.timestamp) >= cutoff).collect())
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Dsh,
        label: "DeepSeek Harness",
        roots,
        parse: parse_fn(parse_dsh),
        parse_light: Some(parse_fn(parse_dsh_light)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write_session(root: &std::path::Path, project: &str, name: &str, rows: &[Value]) {
        let dir = root.join(project);
        std::fs::create_dir_all(&dir).unwrap();
        let text: String = rows.iter().map(|r| format!("{r}\n")).collect();
        std::fs::write(dir.join(name), text).unwrap();
    }

    fn root_of(d: &tempfile::TempDir) -> String {
        d.path().to_string_lossy().to_string()
    }

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "dsh");
        assert_eq!(a.label, "DeepSeek Harness");
    }

    #[tokio::test]
    async fn keeps_cache_reads_from_cache_aware_shape() {
        let d = tempfile::tempdir().unwrap();
        write_session(
            d.path(),
            "demo",
            "session.jsonl",
            &[
                json!({"type":"request/context","seq":0,"cwd":"/work/demo","data":{"model":"anthropic/claude-fable-5"}}),
                json!({"type":"assistant/message","seq":1,"cwd":"/work/demo","data":{"usage":{
                    "inputTokens":535,"outputTokens":181,"totalTokens":98764,"cacheReadTokens":98048}}}),
            ],
        );
        let ev = parse_dsh(vec![root_of(&d)]).await.unwrap();
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].cache_read_tokens, 98048.0);
        assert_eq!(ev[0].input_tokens, 535.0);
        assert_eq!(ev[0].cache_reported, Some(true));
    }

    #[tokio::test]
    async fn usage_precedence_for_messages_attempts_and_compaction() {
        let d = tempfile::tempdir().unwrap();
        let chunk = |i: u32, o: u32| {
            json!([{"type":"chunk","chunk":{"type":"usage","usage":{"inputTokens":i,"outputTokens":o}}}])
        };
        write_session(
            d.path(),
            "demo",
            "session.jsonl",
            &[
                json!({"type":"request/context","seq":0,"cwd":"/work/demo","data":{"model":"anthropic/claude-fable-5"}}),
                json!({"type":"assistant/message","seq":1,"data":{"stream":[
                    {"type":"chunk","chunk":{"type":"usage","usage":{"inputTokens":10,"outputTokens":2}}},
                    {"type":"chunk","chunk":{"type":"usage","usage":{"inputTokens":12,"outputTokens":3}}}]}}),
                json!({"type":"assistant/message","seq":2,"data":{"usage":{"inputTokens":20,"outputTokens":4},"stream":chunk(200,40)}}),
                json!({"type":"assistant/attempt","seq":3,"data":{"usage":{"inputTokens":300,"outputTokens":30},"stream":chunk(30,5)}}),
                json!({"type":"compaction/summary","seq":4,"data":{"usage":{"inputTokens":40,"outputTokens":6}}}),
            ],
        );
        let ev = parse_dsh(vec![root_of(&d)]).await.unwrap();
        let got: Vec<(f64, f64)> = ev.iter().map(|e| (e.input_tokens, e.output_tokens)).collect();
        assert_eq!(got, vec![(12.0, 3.0), (20.0, 4.0), (30.0, 5.0), (40.0, 6.0)]);
    }

    #[tokio::test]
    async fn legacy_rows_do_not_invent_cache() {
        let d = tempfile::tempdir().unwrap();
        write_session(
            d.path(),
            "demo",
            "session.jsonl",
            &[
                json!({"type":"request/context","seq":0,"cwd":"/work/demo","data":{"model":"anthropic/claude-fable-5"}}),
                json!({"type":"assistant/message","seq":1,"cwd":"/work/demo","data":{"usage":{"inputTokens":165056,"outputTokens":512,"totalTokens":165568}}}),
                json!({"type":"assistant/message","seq":2,"cwd":"/work/demo","data":{"usage":{"inputTokens":168204,"outputTokens":120,"totalTokens":168324}}}),
            ],
        );
        let ev = parse_dsh(vec![root_of(&d)]).await.unwrap();
        assert_eq!(ev.len(), 2);
        for (e, prompt) in ev.iter().zip([165056.0, 168204.0]) {
            assert_eq!(e.cache_read_tokens, 0.0);
            assert_eq!(e.input_tokens, prompt);
            assert_eq!(e.cache_reported, Some(false));
            assert_eq!(e.request_count, Some(1.0));
        }
    }

    #[tokio::test]
    async fn newest_session_version_wins_per_folder_and_session_cwd_sets_workspace() {
        let d = tempfile::tempdir().unwrap();
        let row = |n: u32| json!({"type":"assistant/message","seq":1,"data":{"usage":{"inputTokens":n,"outputTokens":1}}});
        write_session(d.path(), "demo", "session.jsonl", &[row(1)]);
        write_session(d.path(), "demo", "session.v2.jsonl", &[json!({"type":"session","cwd":"/w"}), row(2)]);
        let ev = parse_dsh(vec![root_of(&d)]).await.unwrap();
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].input_tokens, 2.0);
        assert_eq!(ev[0].workspace.as_deref(), Some("/w"));
    }

    #[test]
    fn readline_line_splitting() {
        assert_eq!(raw_lines("a\r\nb\nc\rd"), vec!["a", "b", "c", "d"]);
        assert_eq!(raw_lines("a\n"), vec!["a"]);
        assert_eq!(raw_lines("a\n\nb"), vec!["a", "", "b"]);
    }
}
