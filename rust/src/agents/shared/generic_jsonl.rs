//! Port of `src/agents/shared/generic-jsonl.ts`: shared walker for agents that
//! store usage in JSON/JSONL trees.

use super::usage_fields::{extract_model, extract_timestamp, extract_token_buckets};
use crate::pricing::apply_pricing;
use crate::types::{AgentId, UsageEvent};
use crate::util::{
    js_num_to_string, path_exists, read_json_cached, read_jsonl_cached, stable_id, walk_files, WalkMatch,
    WalkOptions, ELECTRON_CACHE_DIRS,
};
use serde_json::Value;
use std::sync::Arc;

/// Skip individual JSONL logs larger than this (avoids multi-GB parse trees).
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone)]
pub struct GenericJsonlOptions {
    pub agent: AgentId,
    /// Default 10.
    pub max_depth: Option<usize>,
    /// `(name, fullPath) => boolean`; default matches `*.jsonl` / `*.json`.
    pub match_fn: Option<WalkMatch>,
}

impl GenericJsonlOptions {
    pub fn new(agent: AgentId) -> Self {
        GenericJsonlOptions { agent, max_depth: None, match_fn: None }
    }
}

/// `r[a] ?? r[b] ?? ...` over a JSON object (null and missing both fall through).
fn coalesce<'a>(r: &'a serde_json::Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    for k in keys {
        match r.get(*k) {
            Some(Value::Null) | None => continue,
            Some(v) => return Some(v),
        }
    }
    None
}

/// Shared walker for agents that store usage in JSON/JSONL trees.
pub async fn parse_generic_jsonl(roots: &[String], options: &GenericJsonlOptions) -> anyhow::Result<Vec<UsageEvent>> {
    let mut events: Vec<UsageEvent> = Vec::new();
    let matcher: WalkMatch = options
        .match_fn
        .clone()
        .unwrap_or_else(|| Arc::new(|name: &str, _full: &str| name.ends_with(".jsonl") || name.ends_with(".json")));

    for root in roots {
        if !path_exists(root).await {
            continue;
        }
        let files = walk_files(
            root,
            WalkOptions {
                max_depth: Some(options.max_depth.unwrap_or(10)),
                matcher: Some(matcher.clone()),
                skip_dirs: Some(ELECTRON_CACHE_DIRS),
            },
        )
        .await;

        for file in files {
            // Cached JSONL parse: unchanged files skip read + JSON.parse.
            let rows = if file.ends_with(".jsonl") {
                read_jsonl_cached(&file, Some(MAX_FILE_BYTES)).await?
            } else {
                read_json_cached(&file).await
            };
            let rows = match rows {
                Some(r) if !r.is_empty() => r,
                _ => continue,
            };

            let mut idx: u64 = 0;
            for row in rows.iter() {
                idx += 1;
                let r = match row {
                    Value::Object(m) => m,
                    _ => continue,
                };
                let usage = coalesce(r, &["usage", "token_usage", "tokenUsage", "token_count", "message"])
                    .unwrap_or(row);
                let buckets = match extract_token_buckets(Some(usage)) {
                    Some(b) => b,
                    None => continue,
                };

                let model = extract_model(&[Some(row), r.get("message")]);
                let timestamp = extract_timestamp(&[Some(row), r.get("message")]);
                let workspace = match r.get("cwd") {
                    Some(Value::String(s)) => Some(s.clone()),
                    _ => match r.get("workspace") {
                        Some(Value::String(s)) => Some(s.clone()),
                        _ => None,
                    },
                };

                events.push(apply_pricing(UsageEvent {
                    id: stable_id(&[
                        options.agent.as_str(),
                        file.as_str(),
                        idx.to_string().as_str(),
                        js_num_to_string(buckets.input_tokens).as_str(),
                        js_num_to_string(buckets.output_tokens).as_str(),
                    ]),
                    agent: options.agent,
                    model,
                    timestamp,
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
    }

    Ok(events)
}
