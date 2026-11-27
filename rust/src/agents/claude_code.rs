//! Agent: Claude Code (port of `src/agents/claude-code/index.ts`).
//!
//! `~/.claude/projects/<project>/<session>.jsonl`. One API response can be written
//! as several assistant rows (one per content block), all carrying the same
//! requestId/message.id and repeated usage; keep one logical request.

use std::collections::HashSet;
use std::sync::Arc;

use indexmap::{IndexMap, IndexSet};
use serde_json::Value;

use crate::agents::shared::env::{path_env, unique};
use crate::agents::shared::usage_fields::{extract_token_buckets, TokenBuckets};
use crate::agents::{parse_fn, AgentModule};
use crate::pricing::apply_pricing;
use crate::types::{AgentId, UsageEvent};
use crate::util::{
    cached_candidates_for_file, env_nonempty, js_date_parse, js_trim, now_ms, path_exists, pjoin, stable_id,
    stream_lines, to_iso_string, walk_files, CandidateOpts, PathFlavor, WalkOptions,
};

/// Local data roots to scan on this machine.
pub fn roots() -> Vec<String> {
    let e = path_env();
    let mut r: Vec<String> = Vec::new();
    r.push(e.expand_home(&env_nonempty("CLAUDE_CONFIG_DIR").unwrap_or_else(|| e.j(&[&e.home, ".claude"]))));
    if let Some(v) = env_nonempty("CLAUDE_CONFIG_DIRS") {
        for s in v.split(e.path.delimiter()) {
            r.push(e.expand_home(s));
        }
    }
    r.push(e.j(&[&e.home, ".config", "claude"]));
    unique(r)
}

#[derive(Debug, Clone)]
struct UsageCandidate {
    file: Arc<str>,
    /// Non-empty `row.uuid` (only the fields needed later are kept, not the whole row).
    uuid: Option<String>,
    model: Option<String>,
    /// Valid ISO timestamp from the row, if any (fallback to "now" is applied at event build).
    timestamp: Option<String>,
    buckets: TokenBuckets,
    request_key: String,
    row_index: usize,
}

/// `typeof value === "string" && value.trim() ? value : null`
fn non_empty_string<'a>(v: Option<&'a Value>) -> Option<&'a str> {
    match v {
        Some(Value::String(s)) if !js_trim(s).is_empty() => Some(s.as_str()),
        _ => None,
    }
}

fn request_key_for(file: &str, row: &Value, message: &Value, row_index: usize) -> String {
    let request_id = non_empty_string(row.get("requestId"))
        .or_else(|| non_empty_string(row.get("request_id")))
        .or_else(|| non_empty_string(message.get("requestId")))
        .or_else(|| non_empty_string(message.get("request_id")));
    if let Some(id) = request_id {
        return format!("request:{}", id);
    }
    let message_id = non_empty_string(message.get("id")).or_else(|| non_empty_string(row.get("message_id")));
    if let Some(id) = message_id {
        return format!("message:{}", id);
    }
    let uuid = non_empty_string(row.get("uuid"));
    match uuid {
        Some(u) => format!("row:{}:{}", file, u),
        None => format!("row:{}:{}", file, row_index),
    }
}

/// Rough heap footprint of one candidate (cache accounting).
fn candidate_bytes(c: &UsageCandidate) -> usize {
    std::mem::size_of::<UsageCandidate>()
        + c.uuid.as_ref().map_or(0, |s| s.len() + 16)
        + c.model.as_ref().map_or(0, |s| s.len() + 16)
        + c.timestamp.as_ref().map_or(0, |s| s.len() + 16)
        + c.request_key.len()
        + 16
}

/// Candidate at (file index, row index); the current file's list is not in `held` yet.
fn held_at<'a>(
    held: &'a [Arc<Vec<UsageCandidate>>],
    current: &'a Arc<Vec<UsageCandidate>>,
    current_idx: usize,
    fi: usize,
    ci: usize,
) -> &'a UsageCandidate {
    let list = if fi == current_idx { current } else { &held[fi] };
    &list[ci]
}

fn candidate_score(c: &UsageCandidate) -> f64 {
    let b = &c.buckets;
    b.input_tokens + b.output_tokens + b.cache_read_tokens + b.cache_write_tokens
}

fn is_richer_candidate(next: &UsageCandidate, previous: &UsageCandidate) -> bool {
    let next_output = next.buckets.output_tokens;
    let previous_output = previous.buckets.output_tokens;
    if next_output != previous_output {
        return next_output > previous_output;
    }
    let next_score = candidate_score(next);
    let previous_score = candidate_score(previous);
    if next_score != previous_score {
        return next_score > previous_score;
    }
    next.row_index > previous.row_index
}

fn timestamp_opt_from_row(row: &Value, message: &Value) -> Option<String> {
    let candidates = [row.get("timestamp"), row.get("ts"), message.get("timestamp"), message.get("ts")];
    for value in candidates.into_iter().flatten() {
        match value {
            Value::String(s) if !js_trim(s).is_empty() => {
                let ms = js_date_parse(s);
                if !ms.is_nan() {
                    if let Some(iso) = to_iso_string(ms) {
                        return Some(iso);
                    }
                }
            }
            Value::Number(n) => {
                if let Some(f) = n.as_f64() {
                    if f.is_finite() && f > 0.0 {
                        let ms = if f > 1e12 { f } else { f * 1000.0 };
                        if let Some(iso) = to_iso_string(ms) {
                            return Some(iso);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    None
}

fn workspace_from_file(file: &str, roots: &[String]) -> Option<String> {
    let flavor = PathFlavor::host();
    let sep = flavor.sep();
    for root in roots {
        let relative = flavor.relative(root, file);
        if relative.is_empty()
            || relative == ".."
            || relative.starts_with(&format!("..{}", sep))
            || flavor.is_absolute(&relative)
        {
            continue;
        }
        let parts: Vec<&str> = relative.split(sep).collect();
        if parts.len() < 2 {
            continue;
        }
        let first = parts[0];
        if !first.is_empty() {
            return Some(first.to_string());
        }
    }
    None
}

fn as_plain_object(v: Option<&Value>) -> Option<&Value> {
    match v {
        Some(x @ Value::Object(_)) => Some(x),
        _ => None,
    }
}

pub async fn parse_claude_code(roots: &[String]) -> anyhow::Result<Vec<UsageEvent>> {
    let mut files: IndexSet<String> = IndexSet::new();

    let is_jsonl = |n: &str, _full: &str| {
        let b = n.as_bytes();
        b.len() >= 6 && b[b.len() - 6..].eq_ignore_ascii_case(b".jsonl")
    };
    for root in roots {
        if !path_exists(root).await {
            continue;
        }
        let projects = pjoin(&[root.as_str(), "projects"]);
        let transcripts = pjoin(&[root.as_str(), "transcripts"]);
        for dir in [projects, transcripts] {
            for file in walk_files(&dir, WalkOptions::new().matching(is_jsonl)).await {
                files.insert(file);
            }
        }
    }

    let all_roots: Vec<String> = roots
        .iter()
        .flat_map(|root| [pjoin(&[root.as_str(), "projects"]), pjoin(&[root.as_str(), "transcripts"])])
        .collect();
    // (index into `held`, index into that file's candidates) of the winning candidate per request.
    let mut by_request: IndexMap<String, (usize, usize)> = IndexMap::new();
    let mut held: Vec<Arc<Vec<UsageCandidate>>> = Vec::new();
    let mut seen_uuids: HashSet<String> = HashSet::new();

    for file in files.iter() {
        let file_owned: Arc<str> = Arc::from(file.as_str());
        let file_candidates = cached_candidates_for_file(
            file,
            || async move {
                let file = file_owned;
                let f2 = file.clone();
                // Stream the file line by line; only lines mentioning "usage" are decoded into a
                // `Value` (user / tool-result lines are the large majority). Every valid JSON line
                // still advances `row_index` exactly like the whole-file parse did.
                let state = (Vec::<UsageCandidate>::new(), HashSet::<String>::new(), 0usize);
                let streamed = stream_lines(&f2, state, move |st, line| {
                    let (local, local_uuids, row_index) = st;
                    if !line.contains("usage") {
                        if serde_json::from_str::<serde::de::IgnoredAny>(line).is_ok() {
                            *row_index += 1;
                        }
                        return;
                    }
                    let row: Value = match serde_json::from_str(line) {
                        Ok(v) => v,
                        Err(_) => return,
                    };
                    *row_index += 1;
                    let row_index = *row_index;
                    if !matches!(row, Value::Object(_)) {
                        return;
                    }
                    let row = &row;
                    let uuid = non_empty_string(row.get("uuid"));
                    if let Some(u) = uuid {
                        if local_uuids.contains(u) {
                            return;
                        }
                    }
                    let message: &Value = match as_plain_object(row.get("message")) {
                        Some(m) => m,
                        None => row,
                    };
                    let row_type = non_empty_string(row.get("type"));
                    let message_role = non_empty_string(message.get("role"));
                    if (row_type.is_some() && row_type != Some("assistant"))
                        || (row_type.is_none() && message_role.is_some() && message_role != Some("assistant"))
                    {
                        return;
                    }
                    let usage = as_plain_object(message.get("usage")).or_else(|| as_plain_object(row.get("usage")));
                    let buckets = match extract_token_buckets(usage) {
                        Some(b) => b,
                        None => return,
                    };
                    if let Some(u) = uuid {
                        local_uuids.insert(u.to_string());
                    }
                    local.push(UsageCandidate {
                        file: file.clone(),
                        uuid: uuid.map(str::to_string),
                        model: match message.get("model") {
                            Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
                            _ => match row.get("model") {
                                Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
                                _ => None,
                            },
                        },
                        timestamp: timestamp_opt_from_row(row, message),
                        buckets,
                        request_key: request_key_for(&file, row, message, row_index),
                        row_index,
                    });
                })
                .await;
                match streamed {
                    Some(((mut local, _, _), _)) => {
                        local.shrink_to_fit();
                        Ok(local)
                    }
                    None => Ok(Vec::new()),
                }
            },
            CandidateOpts { max_bytes: None, estimate_bytes: Some(candidate_bytes) },
        )
        .await?;

        let fi = held.len();
        for (ci, candidate) in file_candidates.iter().enumerate() {
            if let Some(uuid) = candidate.uuid.as_deref() {
                if seen_uuids.contains(uuid) {
                    continue;
                }
                seen_uuids.insert(uuid.to_string());
            }
            let replace = match by_request.get(&candidate.request_key) {
                None => true,
                Some(&(pf, pc)) => is_richer_candidate(candidate, held_at(&held, &file_candidates, fi, pf, pc)),
            };
            if replace {
                by_request.insert(candidate.request_key.clone(), (fi, ci));
            }
        }
        held.push(file_candidates);
    }
    drop(seen_uuids);

    let mut events: Vec<UsageEvent> = Vec::new();
    for &(fi, ci) in by_request.values() {
        let candidate = &held[fi][ci];
        let b = &candidate.buckets;
        let input_tokens = if b.input_includes_cache == Some(true) {
            (b.input_tokens - b.cache_read_tokens).max(0.0)
        } else {
            b.input_tokens
        };
        let model = candidate.model.clone();
        events.push(apply_pricing(UsageEvent {
            id: stable_id(&["claude-code", candidate.request_key.as_str()]),
            agent: AgentId::ClaudeCode,
            model: model.map(Into::into),
            timestamp: candidate
                .timestamp
                .clone()
                .unwrap_or_else(|| to_iso_string(now_ms()).unwrap_or_default()),
            input_tokens,
            output_tokens: b.output_tokens,
            cache_read_tokens: b.cache_read_tokens,
            cache_write_tokens: b.cache_write_tokens,
            workspace: (workspace_from_file(&candidate.file, &all_roots)).map(Into::into),
            source_path: candidate.file.to_string().into(),
            estimated: Some(false),
            // Claude Code always writes the cache buckets, so a zero here is a real
            // measurement rather than a missing field.
            cache_reported: Some(true),
            ..Default::default()
        }));
    }
    Ok(events)
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::ClaudeCode,
        label: "Claude Code",
        roots,
        parse: parse_fn(|roots: Vec<String>| async move { parse_claude_code(&roots).await }),
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
        assert_eq!(a.id.as_str(), "claude-code");
        assert_eq!(a.label, "Claude Code");
    }

    #[tokio::test]
    async fn deduplicates_repeated_content_blocks_and_keeps_full_usage() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let project_dir = dir.path().join("projects").join("C--Dev-Demo");
        std::fs::create_dir_all(&project_dir).unwrap();

        let repeated = "msg_ce_repeated_blocks";
        let second = "msg_cb_second_request";
        let usage_a = json!({
            "input_tokens": 100, "output_tokens": 20,
            "cache_read_input_tokens": 50, "cache_creation_input_tokens": 0,
            "cache_creation": {
                "ephemeral_5m_input_tokens": 4, "ephemeral_1h_input_tokens": 6, "input_tokens": 10
            }
        });
        let mut rows = vec![json!({
            "type": "user", "uuid": "user-1",
            "message": {"role": "user", "usage": {"input_tokens": 999999, "output_tokens": 999999}}
        })];
        for (i, ts) in ["2026-09-13T01:00:00.000Z", "2026-09-13T01:00:00.001Z", "2026-09-13T01:00:00.002Z"]
            .iter()
            .enumerate()
        {
            rows.push(json!({
                "type": "assistant", "uuid": format!("assistant-{}", i + 1), "timestamp": ts,
                "apiBlockIndex": i,
                "message": {"id": repeated, "role": "assistant", "model": "openclaw", "usage": usage_a}
            }));
        }
        for i in 0..2 {
            rows.push(json!({
                "type": "assistant", "uuid": format!("assistant-{}", i + 4), "requestId": "request-2",
                "apiBlockIndex": i,
                "message": {"id": second, "role": "assistant", "model": "glm-5.3",
                            "usage": {"input_tokens": 7, "output_tokens": 9}}
            }));
        }
        let file = project_dir.join("session.jsonl");
        let text: String = rows.iter().map(|r| r.to_string()).collect::<Vec<_>>().join("\n") + "\n";
        std::fs::write(&file, text).unwrap();

        let events = parse_claude_code(&[root]).await.unwrap();
        assert_eq!(events.len(), 2);
        let first = events.iter().find(|e| e.model.as_deref() == Some("openclaw")).unwrap();
        assert_eq!(first.input_tokens, 100.0);
        assert_eq!(first.output_tokens, 20.0);
        assert_eq!(first.cache_read_tokens, 50.0);
        assert_eq!(first.cache_write_tokens, 10.0);
        assert_eq!(first.total_tokens, 180.0);
        assert_eq!(first.workspace.as_deref(), Some("C--Dev-Demo"));
        assert_eq!(first.estimated, Some(false));
        assert_eq!(first.source_path, file.to_string_lossy());
        let sec = events.iter().find(|e| e.model.as_deref() == Some("glm-5.3")).unwrap();
        assert_eq!(sec.total_tokens, 16.0);
    }
}
