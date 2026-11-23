//! Port of `src/agents/shared/router-light.ts`: minute scan for 9router,
//! LiteLLM and RouterLab that skips unchanged inputs.

use super::router_usage::{parse_router_usage, RouterUsageOptions};
use crate::types::{AgentId, UsageEvent};
use crate::util::{js_num_to_string, PathFlavor};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;

/// Files a light router scan can read. SQLite writes often land in the WAL
/// before the database file's mtime moves, so the WAL is part of the stamp.
const ROUTER_STAMP_FILES: [&str; 12] = [
    "db/data.sqlite",
    "data.sqlite",
    "db.sqlite",
    "usage.json",
    "db.json",
    "usageData.json",
    "usage-daily.json",
    "request-details.json",
    "request-details.jsonl",
    "usage-history.json",
    "usageHistory.json",
    "usage-history.jsonl",
];

/// Unchanged router inputs are not opened again on the next minute tick.
static ROUTER_LIGHT_STAMP: Lazy<Mutex<HashMap<String, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));

async fn stamp_one(file: &str, parts: &mut Vec<String>) {
    if let Ok(st) = tokio::fs::metadata(file).await {
        // VPS mirror syncs can rewrite a file without changing its byte length.
        // Include mtime so those updates trigger the light parser.
        let mtime_ms = st
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        parts.push(format!("{}|{}|{}", file, js_num_to_string(st.len() as f64), js_num_to_string(mtime_ms)));
    }
}

/// JS default `Array.prototype.sort()` order (UTF-16 code units).
fn sort_js(v: &mut [String]) {
    v.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

async fn router_source_stamp(roots: &[String]) -> String {
    let flavor = PathFlavor::host();
    let mut parts: Vec<String> = Vec::new();
    for root in roots {
        for rel in ROUTER_STAMP_FILES {
            let file = flavor.join(&[root.as_str(), rel]);
            stamp_one(&file, &mut parts).await;
            if rel.ends_with(".sqlite") {
                stamp_one(&format!("{file}-wal"), &mut parts).await;
            }
        }
    }
    sort_js(&mut parts);
    parts.join("\n")
}

/// Minute scan for 9router, LiteLLM, and RouterLab.
/// The same size and mtime returns no rows, so the server keeps the cached history.
/// A changed file still runs the full recent parser.
pub async fn parse_router_usage_light(roots: &[String], agent: AgentId) -> anyhow::Result<Vec<UsageEvent>> {
    let flavor = PathFlavor::host();
    let mut resolved: Vec<String> = roots.iter().map(|r| flavor.resolve(&[r.as_str()]).to_lowercase()).collect();
    sort_js(&mut resolved);
    let key = format!("{}|{}", agent.as_str(), resolved.join("|"));
    let stamp = router_source_stamp(roots).await;
    if ROUTER_LIGHT_STAMP.lock().get(&key) == Some(&stamp) {
        return Ok(Vec::new());
    }
    let events = parse_router_usage(roots, agent, RouterUsageOptions { recent_only: true }).await?;
    // A sqlite read can bump the WAL mtime. Store the stamp after the read so
    // the next quiet tick does not open those files again.
    let after = router_source_stamp(roots).await;
    ROUTER_LIGHT_STAMP.lock().insert(key, after);
    Ok(events)
}
