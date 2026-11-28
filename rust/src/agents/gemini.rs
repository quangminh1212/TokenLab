//! Agent: Gemini CLI (port of `src/agents/gemini/index.ts`).
//!
//! `~/.gemini/tmp/<project>/chats/session-*.json`.

use serde_json::{Map, Value};

use crate::agents::shared::env::{path_env, unique};
use crate::agents::{parse_fn, AgentModule};
use crate::pricing::apply_pricing;
use crate::types::{AgentId, UsageEvent};
use crate::util::{
    env_nonempty, js_num_to_string, now_ms, num_opt, path_exists, read_text, stable_id, to_iso_string, walk_files,
    WalkOptions,
};

/// Local data roots to scan on this machine.
pub fn roots() -> Vec<String> {
    let e = path_env();
    let mut r: Vec<String> = Vec::new();
    r.push(e.expand_home(&env_nonempty("GEMINI_CLI_HOME").unwrap_or_else(|| e.j(&[&e.home, ".gemini"]))));
    r.push(e.j(&[&e.home, ".gemini"]));
    unique(r)
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

pub async fn parse_gemini(roots: &[String]) -> anyhow::Result<Vec<UsageEvent>> {
    let mut events: Vec<UsageEvent> = Vec::new();

    for root in roots {
        if !path_exists(root).await {
            continue;
        }
        let files = walk_files(
            root,
            WalkOptions::new()
                .max_depth(8)
                .matching(|n: &str, _full: &str| n.starts_with("session-") && n.ends_with(".json")),
        )
        .await;

        for file in files {
            // Unchanged sessions are served from the previous scan (scan_index).
            let mut file_events = crate::util::scan_index::events_for_file(AgentId::Gemini, &file, || async {
            let mut events: Vec<UsageEvent> = Vec::new();
            let text = match read_text(&file).await {
                Some(t) if !t.is_empty() => t,
                _ => return Ok(events),
            };
            let data: Value = match serde_json::from_str(&text) {
                Ok(d) => d,
                Err(_) => return Ok(events),
            };
            let single;
            let messages: &[Value] = match &data {
                Value::Array(a) => a.as_slice(),
                Value::Object(o) => match o.get("messages") {
                    Some(Value::Array(a)) => a.as_slice(),
                    _ => {
                        single = [data.clone()];
                        &single
                    }
                },
                _ => {
                    single = [data.clone()];
                    &single
                }
            };

            let mut idx = 0usize;
            for msg in messages {
                idx += 1;
                let m = match msg {
                    Value::Object(m) => m,
                    _ => continue,
                };
                let usage_val = coalesce(m, &["usage", "tokenUsage"]);
                let usage: &Map<String, Value> = match usage_val {
                    Some(Value::Object(u)) => u,
                    Some(_) => continue, // non-object usage yields all-zero fields
                    None => m,
                };
                let mut input = num_opt(coalesce(usage, &["input_tokens", "inputTokens", "promptTokenCount"]));
                let output = num_opt(coalesce(usage, &["output_tokens", "outputTokens", "candidatesTokenCount"]));
                let cache_read =
                    num_opt(coalesce(usage, &["cached_content_token_count", "cacheReadTokens", "cached"]));
                // Gemini often includes cache in input - avoid double charge when possible
                if cache_read > 0.0 && input >= cache_read {
                    input -= cache_read;
                }
                if input + output + cache_read <= 0.0 {
                    continue;
                }
                let cache_reported = coalesce(usage, &["cached_content_token_count", "cacheReadTokens", "cached"])
                    .is_some();

                let model = nonempty_str(m, "model");
                let ts = nonempty_str(m, "timestamp")
                    .or_else(|| nonempty_str(m, "createdAt"))
                    .unwrap_or_else(|| to_iso_string(now_ms()).unwrap_or_default());

                events.push(apply_pricing(UsageEvent {
                    id: stable_id(&[
                        "gemini",
                        file.as_str(),
                        idx.to_string().as_str(),
                        js_num_to_string(input).as_str(),
                        js_num_to_string(output).as_str(),
                    ]).into(),
                    agent: AgentId::Gemini,
                    model: model.map(Into::into),
                    timestamp: ts.into(),
                    input_tokens: input,
                    output_tokens: output,
                    cache_read_tokens: cache_read,
                    cache_write_tokens: 0.0,
                    workspace: None,
                    source_path: file.clone().into(),
                    cache_reported: if cache_reported { Some(true) } else { None },
                    ..Default::default()
                }));
            }
            Ok::<_, anyhow::Error>(events)
            })
            .await?;
            events.append(&mut file_events);
        }
    }

    Ok(events)
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Gemini,
        label: "Gemini CLI",
        roots,
        parse: parse_fn(|roots: Vec<String>| async move { parse_gemini(&roots).await }),
        parse_light: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "gemini");
        assert_eq!(a.label, "Gemini CLI");
    }

    #[tokio::test]
    async fn parses_session_messages_and_subtracts_cache() {
        let dir = tempfile::tempdir().unwrap();
        let chats = dir.path().join("proj").join("chats");
        std::fs::create_dir_all(&chats).unwrap();
        let file = chats.join("session-1.json");
        std::fs::write(
            &file,
            r#"{"messages":[
              {"model":"gemini-2.5-pro","timestamp":"2026-01-01T00:00:00.000Z",
               "tokenUsage":{"input_tokens":100,"output_tokens":10,"cached_content_token_count":40}},
              {"type":"user"},
              {"model":"gemini-2.5-pro","timestamp":"2026-01-01T00:01:00.000Z","inputTokens":5,"outputTokens":2}
            ]}"#,
        )
        .unwrap();
        let events = parse_gemini(&[dir.path().to_string_lossy().to_string()]).await.unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].input_tokens, 60.0);
        assert_eq!(events[0].cache_read_tokens, 40.0);
        assert_eq!(events[0].cache_reported, Some(true));
        assert_eq!(events[0].total_tokens, 110.0);
        assert_eq!(events[1].input_tokens, 5.0);
        assert_eq!(events[1].cache_reported, None);
        assert_eq!(events[1].source_path, file.to_string_lossy());
    }
}
