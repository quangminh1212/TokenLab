//! Agent: Cursor (port of `src/agents/cursor/index.ts`).
//!
//! Prefers JSON/JSONL usage caches under Application Support.

use serde_json::{Map, Value};

use crate::agents::shared::env::{path_env, unique};
use crate::agents::{parse_fn, AgentModule};
use crate::pricing::apply_pricing;
use crate::types::{AgentId, UsageEvent};
use crate::util::{
    js_num_to_string, now_ms, num_opt, parse_jsonl, path_exists, read_text, stable_id, stamp_file, to_iso_string,
    walk_files, WalkOptions, ELECTRON_CACHE_DIRS,
};

/// Skip individual files larger than this.
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;

/// Local data roots to scan on this machine.
pub fn roots() -> Vec<String> {
    let e = path_env();
    let mut r: Vec<String> = Vec::new();
    r.push(e.j(&[&e.app_data, "Cursor"]));
    r.push(e.j(&[&e.app_data, "Cursor - Nightly"]));
    r.push(e.j(&[&e.home, ".cursor"]));
    r.push(e.j(&[&e.local_app, "Cursor"]));
    r.push(e.j(&[&e.xdg_config, "Cursor"]));
    r.push(e.j(&[&e.xdg_data, "Cursor"]));
    r.push(e.j(&[&e.home, "Library", "Application Support", "Cursor"]));
    unique(r)
}

pub async fn parse_cursor(roots: &[String]) -> anyhow::Result<Vec<UsageEvent>> {
    let mut events: Vec<UsageEvent> = Vec::new();

    for root in roots {
        if !path_exists(root).await {
            continue;
        }
        let candidates = walk_files(
            root,
            WalkOptions::new().max_depth(10).skipping(ELECTRON_CACHE_DIRS).matching(|name: &str, full: &str| {
                let lower = name.to_lowercase();
                if lower.ends_with(".jsonl") {
                    return true;
                }
                if lower.contains("usage") && lower.ends_with(".json") {
                    return true;
                }
                if lower.contains("token") && lower.ends_with(".json") {
                    return true;
                }
                // composer / aichat logs
                if full.contains("anysphere") && lower.ends_with(".json") {
                    return true;
                }
                false
            }),
        )
        .await;

        for file in candidates {
            // Never slurp pathological files (multi-hundred-MB) into memory.
            match stamp_file(&file).await {
                Some(s) if s.size <= MAX_FILE_BYTES => {}
                _ => continue,
            }
            let text = match read_text(&file).await {
                Some(t) if !t.is_empty() => t,
                _ => continue,
            };

            if file.ends_with(".jsonl") {
                let mut idx = 0usize;
                for row in parse_jsonl(&text) {
                    idx += 1;
                    push_from_object(&mut events, &row, &file, idx);
                }
                continue;
            }

            let data: Value = match serde_json::from_str(&text) {
                Ok(d) => d,
                Err(_) => continue,
            };
            match &data {
                Value::Array(a) => {
                    for (i, row) in a.iter().enumerate() {
                        push_from_object(&mut events, row, &file, i + 1);
                    }
                }
                Value::Object(o) => {
                    if let Some(Value::Array(a)) = o.get("usage") {
                        for (i, row) in a.iter().enumerate() {
                            push_from_object(&mut events, row, &file, i + 1);
                        }
                    } else {
                        push_from_object(&mut events, &data, &file, 1);
                    }
                }
                _ => {}
            }
        }
    }

    Ok(events)
}

/// `o[a] ?? o[b] ?? ...`
fn coalesce<'a>(o: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    for k in keys {
        match o.get(*k) {
            Some(Value::Null) | None => continue,
            Some(v) => return Some(v),
        }
    }
    None
}

fn nonempty_str(o: &Map<String, Value>, key: &str) -> Option<String> {
    match o.get(key) {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

fn push_from_object(events: &mut Vec<UsageEvent>, row: &Value, file: &str, idx: usize) {
    // Arrays pass the JS `typeof === "object"` gate but carry no usage fields.
    let r = match row {
        Value::Object(r) => r,
        _ => return,
    };
    let usage: &Map<String, Value> = match coalesce(r, &["usage", "tokenUsage", "token_usage"]) {
        Some(Value::Object(u)) => u,
        Some(_) => return, // primitive/array usage: every field reads as 0
        None => r,
    };

    let input = num_opt(
        coalesce(usage, &["input_tokens", "inputTokens", "promptTokens", "prompt_tokens"])
            .or_else(|| coalesce(r, &["inputTokens"])),
    );
    let output = num_opt(
        coalesce(usage, &["output_tokens", "outputTokens", "completionTokens", "completion_tokens"])
            .or_else(|| coalesce(r, &["outputTokens"])),
    );
    let cache_read = num_opt(coalesce(usage, &["cache_read_tokens", "cacheReadTokens", "cacheRead"]));
    let cache_write = num_opt(coalesce(usage, &["cache_write_tokens", "cacheWriteTokens", "cacheWrite"]));
    let cache_reported = usage.keys().any(|k| k.to_lowercase().contains("cach"));

    if input + output + cache_read + cache_write <= 0.0 {
        return;
    }

    let model = nonempty_str(r, "model").or_else(|| nonempty_str(usage, "model"));
    let ts = nonempty_str(r, "timestamp")
        .or_else(|| nonempty_str(r, "createdAt"))
        .or_else(|| nonempty_str(r, "date"))
        .unwrap_or_else(|| to_iso_string(now_ms()).unwrap_or_default());

    events.push(apply_pricing(UsageEvent {
        id: stable_id(&[
            "cursor",
            file,
            idx.to_string().as_str(),
            js_num_to_string(input).as_str(),
            js_num_to_string(output).as_str(),
        ]),
        agent: AgentId::Cursor,
        model,
        timestamp: ts,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
        cache_reported: if cache_reported { Some(true) } else { None },
        workspace: match r.get("workspace") {
            Some(Value::String(s)) => Some(s.clone()),
            _ => None,
        },
        source_path: file.to_string(),
        ..Default::default()
    }));
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Cursor,
        label: "Cursor",
        roots,
        parse: parse_fn(|roots: Vec<String>| async move { parse_cursor(&roots).await }),
        parse_light: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "cursor");
        assert_eq!(a.label, "Cursor");
    }

    #[tokio::test]
    async fn parses_jsonl_and_usage_json() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let jl = root.join("log.jsonl");
        std::fs::write(
            &jl,
            "{\"model\":\"gpt-5\",\"timestamp\":\"2026-02-01T00:00:00.000Z\",\"workspace\":\"w\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"cacheRead\":0}}\nnot json\n{\"inputTokens\":0}\n",
        )
        .unwrap();
        let uj = root.join("my-usage.json");
        std::fs::write(&uj, r#"{"usage":[{"inputTokens":3,"outputTokens":4,"date":"2026-02-02T00:00:00.000Z"}]}"#)
            .unwrap();
        let events = parse_cursor(&[root.to_string_lossy().to_string()]).await.unwrap();
        assert_eq!(events.len(), 2);
        let a = events.iter().find(|e| e.source_path == jl.to_string_lossy()).unwrap();
        assert_eq!(a.total_tokens, 15.0);
        assert_eq!(a.cache_reported, Some(true));
        assert_eq!(a.workspace.as_deref(), Some("w"));
        let b = events.iter().find(|e| e.source_path == uj.to_string_lossy()).unwrap();
        assert_eq!(b.total_tokens, 7.0);
        assert_eq!(b.cache_reported, None);
        assert_eq!(b.timestamp, "2026-02-02T00:00:00.000Z");
    }
}
