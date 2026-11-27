//! Port of `src/agents/index.ts` and `src/agents/shared/types.ts`.
//!
//! Defines the agent contract ([`AgentModule`]), the registry ([`all_agents`]
//! in the exact TS order), root/path-spec discovery (including the Linux-home
//! remote snapshot variant), [`scan_all`], [`detect_agents`] and the
//! OpenClaw/Hermes mirror dedupe.

use crate::types::{AgentId, AgentStatus, UsageEvent};
use crate::util::{
    js_date_parse, js_num_to_string, js_trim, now_ms, path_exists, with_path_env_override, PathEnvOverride,
    PathFlavor,
};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub mod shared;

pub mod aider;
pub mod amazon_q;
pub mod amp;
pub mod antigravity;
pub mod blackbox;
pub mod claude_code;
pub mod cline;
pub mod codebuddy;
pub mod codebuff;
pub mod codewhale;
pub mod codex;
pub mod commandcode;
pub mod r#continue;
pub mod copilot;
pub mod crush;
pub mod cursor;
pub mod devin;
pub mod droid;
pub mod dsh;
pub mod forge;
pub mod gemini;
pub mod gjc;
pub mod goose;
pub mod grok;
pub mod hermes;
pub mod iflow;
pub mod jcode;
pub mod junie;
pub mod kilocode;
pub mod kimi;
pub mod kiro;
pub mod litellm;
pub mod mimocode;
pub mod mux;
pub mod nine_router;
pub mod ollama;
pub mod openclaw;
pub mod opencode;
pub mod opencodereview;
pub mod pi;
pub mod qoder;
pub mod qwen;
pub mod qwencoder;
pub mod roocode;
pub mod trae;
pub mod void;
pub mod warp;
pub mod windsurf;
pub mod workbuddy;
pub mod xlabrouter;
pub mod zcode;
pub mod zed;

// ---------------------------------------------------------------------------
// Contract (shared/types.ts)
// ---------------------------------------------------------------------------

/// Boxed future returned by an agent parser.
pub type ParseFuture = Pin<Box<dyn Future<Output = anyhow::Result<Vec<UsageEvent>>> + Send>>;

/// `(roots) => Promise<UsageEvent[]>`.
pub type ParseFn = Arc<dyn Fn(Vec<String>) -> ParseFuture + Send + Sync>;

/// Wrap an `async fn(Vec<String>) -> Result<Vec<UsageEvent>>` (or closure) as a [`ParseFn`].
pub fn parse_fn<F, Fut>(f: F) -> ParseFn
where
    F: Fn(Vec<String>) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = anyhow::Result<Vec<UsageEvent>>> + Send + 'static,
{
    Arc::new(move |roots| Box::pin(f(roots)) as ParseFuture)
}

/// A parser that finds nothing (used by agents whose port is still pending).
pub fn empty_parse() -> ParseFn {
    parse_fn(|_roots| async { Ok(Vec::new()) })
}

/// One agent: identity, data roots on this machine and its parsers.
#[derive(Clone)]
pub struct AgentModule {
    pub id: AgentId,
    pub label: &'static str,
    /// Local data roots to scan on this machine.
    pub roots: fn() -> Vec<String>,
    /// Parse usage events from existing roots.
    pub parse: ParseFn,
    /// Optional cheap parser for hot/recent data during the server's light tick.
    pub parse_light: Option<ParseFn>,
}

impl std::fmt::Debug for AgentModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentModule")
            .field("id", &self.id)
            .field("label", &self.label)
            .field("has_parse_light", &self.parse_light.is_some())
            .finish()
    }
}

/// `{ id, label, roots }` as exposed by `/api/paths` and remote snapshots.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPathSpec {
    pub id: AgentId,
    pub label: String,
    pub roots: Vec<String>,
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

static AGENTS: Lazy<Vec<AgentModule>> = Lazy::new(|| {
    vec![
        claude_code::agent(),
        codex::agent(),
        cursor::agent(),
        windsurf::agent(),
        grok::agent(),
        gemini::agent(),
        opencode::agent(),
        dsh::agent(),
        hermes::agent(),
        openclaw::agent(),
        copilot::agent(),
        pi::agent(),
        kimi::agent(),
        qwen::agent(),
        qwencoder::agent(),
        droid::agent(),
        amp::agent(),
        goose::agent(),
        cline::agent(),
        roocode::agent(),
        kilocode::agent(),
        antigravity::agent(),
        warp::agent(),
        trae::agent(),
        zed::agent(),
        codebuff::agent(),
        mux::agent(),
        crush::agent(),
        kiro::agent(),
        gjc::agent(),
        jcode::agent(),
        commandcode::agent(),
        junie::agent(),
        zcode::agent(),
        opencodereview::agent(),
        codebuddy::agent(),
        workbuddy::agent(),
        aider::agent(),
        r#continue::agent(),
        devin::agent(),
        ollama::agent(),
        codewhale::agent(),
        mimocode::agent(),
        qoder::agent(),
        iflow::agent(),
        blackbox::agent(),
        forge::agent(),
        void::agent(),
        amazon_q::agent(),
        nine_router::agent(),
        xlabrouter::agent(),
        litellm::agent(),
    ]
});

/// All agent modules (one file each under `src/agents/`), in the TS `AGENTS` order.
pub fn all_agents() -> &'static [AgentModule] {
    &AGENTS
}

/// Look up one agent module by id (`PARSERS[id]` in TS; `None` for `custom`).
pub fn find_agent(id: AgentId) -> Option<&'static AgentModule> {
    AGENTS.iter().find(|a| a.id == id)
}

/// `PARSERS[id]`: the full parser of an agent, `None` for `custom` / unknown.
pub fn parser_for(id: AgentId) -> Option<ParseFn> {
    find_agent(id).map(|a| a.parse.clone())
}

// ---------------------------------------------------------------------------
// Path specs
// ---------------------------------------------------------------------------

/// Roots of every agent on this machine.
pub fn agent_path_specs() -> Vec<AgentPathSpec> {
    all_agents()
        .iter()
        .map(|a| AgentPathSpec { id: a.id, label: a.label.to_string(), roots: (a.roots)() })
        .collect()
}

/// Discover the same parser roots using a Linux home, for remote snapshots.
pub fn agent_path_specs_for_linux_home(home: &str) -> Vec<AgentPathSpec> {
    let posix = PathFlavor::Posix;
    let normalized_home = posix.resolve(&[home]);
    let app_data = posix.join(&[normalized_home.as_str(), ".config"]);
    let local_app = posix.join(&[normalized_home.as_str(), ".local", "share"]);
    let cache = posix.join(&[normalized_home.as_str(), ".cache"]);
    let over = PathEnvOverride {
        platform: "linux".to_string(),
        home: normalized_home.clone(),
        app_data: app_data.clone(),
        local_app: local_app.clone(),
        cache: cache.clone(),
        xdg_data: local_app,
        xdg_config: app_data,
        xdg_cache: cache,
        path: posix,
    };
    let specs = with_path_env_override(over, agent_path_specs);

    specs
        .into_iter()
        .map(|mut spec| {
            spec.roots.retain(|root| keep_linux_root(&normalized_home, root));
            spec
        })
        .collect()
}

fn keep_linux_root(normalized_home: &str, root: &str) -> bool {
    let posix = PathFlavor::Posix;
    if !posix.is_absolute(root) {
        return false;
    }
    let relative = posix.relative(normalized_home, &posix.normalize(root));
    if relative.is_empty() || relative == "." || relative.starts_with("..") || posix.is_absolute(&relative) {
        return false;
    }
    let normalized_relative = relative.replace('\\', "/");
    if [".config", ".local", ".local/share", ".cache", "Dev", "Library"].contains(&normalized_relative.as_str()) {
        return false;
    }
    if normalized_relative.starts_with("Library/") {
        return false;
    }
    if normalized_relative.split('/').any(|s| s == "mirrors") {
        return false;
    }
    true
}

// ---------------------------------------------------------------------------
// scanAll
// ---------------------------------------------------------------------------

/// Extra source roots to parse under a separate machine provenance scope.
#[derive(Debug, Clone, Default)]
pub struct AdditionalRoots {
    pub roots: Vec<String>,
    pub machine_scope: String,
}

/// Passed to `on_agent_done` after each agent finishes.
#[derive(Debug, Clone)]
pub struct AgentDone {
    pub agent: AgentId,
    pub events: Vec<UsageEvent>,
    pub duration_ms: f64,
    pub error: Option<String>,
}

pub type OnAgentDone = Arc<dyn Fn(AgentDone) + Send + Sync>;

#[derive(Clone, Default)]
pub struct ScanAllOptions {
    /// `enabled[id] == Some(false)` skips an agent.
    pub enabled: Option<HashMap<AgentId, bool>>,
    /// Extra source roots to parse under a separate machine provenance scope.
    pub additional_roots: Option<HashMap<AgentId, AdditionalRoots>>,
    /// Max agents parsed at once (default 4, clamped 1..=8).
    pub concurrency: Option<usize>,
    /// Soft timeout per agent in ms. `None` = default 10 min; `<= 0` = no timeout.
    /// On timeout the agent contributes 0 events for this pass.
    pub timeout_ms: Option<f64>,
    /// Use an agent's optional recent/incremental parser when available.
    pub light: bool,
    /// Called after each agent finishes so the server can stream progressive totals.
    /// When set, `scan_all` returns an empty list (events are only delivered here).
    pub on_agent_done: Option<OnAgentDone>,
}

/// Default per-agent budget - large enough for multi-100MB Grok updates.jsonl.
pub const DEFAULT_PARSER_TIMEOUT_MS: f64 = 600_000.0;

/// Heavy parsers run last so light agents fill the UI first (less empty-state lag).
const HEAVY_AGENTS: &[&str] = &[
    "grok",
    "9router",
    "routerlab",
    "xlabrouter",
    "devin",
    "windsurf",
    "cursor",
    "claude-code",
    "hermes",
    "dsh",
    "copilot",
];

/// Mask of OpenClaw events to KEEP: drops rows mirrored by a Hermes row with the
/// same per-request totals within one second.
fn openclaw_keep_mask(openclaw: &[&UsageEvent], hermes: &[&UsageEvent]) -> Vec<bool> {
    struct Row<'a> {
        timestamp: f64,
        event: &'a UsageEvent,
    }
    fn scope_of(e: &UsageEvent) -> String {
        match &e.machine_scope {
            Some(s) if !s.is_empty() => s.clone().to_string(),
            _ => "local".to_string(),
        }
    }
    let mut hermes_by_model: HashMap<(String, String), Vec<Row>> = HashMap::new();
    for event in hermes {
        if event.request_count_or_1() != 1.0 {
            continue;
        }
        let model = match &event.model {
            Some(m) if !m.is_empty() => m,
            _ => continue,
        };
        let timestamp = js_date_parse(&event.timestamp);
        if !timestamp.is_finite() {
            continue;
        }
        let key = js_trim(model).to_lowercase();
        hermes_by_model.entry((scope_of(event), key)).or_default().push(Row { timestamp, event });
    }
    for rows in hermes_by_model.values_mut() {
        rows.sort_by(|a, b| a.timestamp.total_cmp(&b.timestamp));
    }

    openclaw
        .iter()
        .map(|event| {
            if event.request_count_or_1() != 1.0 {
                return true;
            }
            let model = match &event.model {
                Some(m) if !m.is_empty() => m,
                _ => return true,
            };
            let timestamp = js_date_parse(&event.timestamp);
            if !timestamp.is_finite() {
                return true;
            }
            let candidates = match hermes_by_model.get(&(scope_of(event), js_trim(model).to_lowercase())) {
                Some(c) => c,
                None => return true,
            };
            let full_input = event.input_tokens + event.cache_read_tokens + event.cache_write_tokens;
            let start = candidates.partition_point(|r| r.timestamp < timestamp - 1_000.0);
            !candidates[start..].iter().take_while(|r| r.timestamp <= timestamp + 1_000.0).any(|row| {
                let hermes = row.event;
                (timestamp - row.timestamp).abs() <= 1_000.0
                    && event.output_tokens == hermes.output_tokens
                    && event.total_tokens == hermes.total_tokens
                    && full_input == hermes.input_tokens + hermes.cache_read_tokens + hermes.cache_write_tokens
            })
        })
        .collect()
}

/// OpenClaw can mirror a response already recorded by Hermes. Keep the Hermes
/// row when per-request totals match within one second; it carries the cache
/// token split needed for accurate pricing.
pub fn dedupe_mirrored_openclaw_events(openclaw_events: &[UsageEvent], hermes_events: &[UsageEvent]) -> Vec<UsageEvent> {
    let o: Vec<&UsageEvent> = openclaw_events.iter().collect();
    let h: Vec<&UsageEvent> = hermes_events.iter().collect();
    let mask = openclaw_keep_mask(&o, &h);
    openclaw_events
        .iter()
        .zip(mask)
        .filter(|(_, keep)| *keep)
        .map(|(e, _)| e.clone())
        .collect()
}

struct Job {
    id: AgentId,
    roots: Vec<String>,
    remote_roots: Vec<String>,
    machine_scope: Option<String>,
    parse: ParseFn,
}

fn apply_machine_scope(job: &Job, parsed: Vec<UsageEvent>) -> Vec<UsageEvent> {
    let scope = match &job.machine_scope {
        Some(s) if !s.is_empty() && !job.remote_roots.is_empty() => s,
        _ => return parsed,
    };
    let flavor = PathFlavor::host();
    let resolved_roots: Vec<String> = job.remote_roots.iter().map(|r| flavor.resolve(&[r.as_str()])).collect();
    let dotdot_sep = format!("..{}", flavor.sep());
    let mut inside_cache: HashMap<String, bool> = HashMap::new();
    parsed
        .into_iter()
        .map(|mut event| {
            let inside = match inside_cache.get(event.source_path.as_str()) {
                Some(v) => *v,
                None => {
                    let src = flavor.resolve(&[event.source_path.as_str()]);
                    let v = resolved_roots.iter().any(|root| {
                        let rel = flavor.relative(root, &src);
                        rel.is_empty() || (rel != ".." && !rel.starts_with(&dotdot_sep) && !flavor.is_absolute(&rel))
                    });
                    inside_cache.insert(event.source_path.clone().to_string(), v);
                    v
                }
            };
            if inside {
                event.machine_scope = Some(scope.clone().into());
            }
            event
        })
        .collect()
}

async fn probe_roots(roots: &[String]) -> Vec<String> {
    let checks = futures::future::join_all(roots.iter().map(|r| async move {
        if path_exists(r).await {
            r.clone()
        } else {
            String::new()
        }
    }))
    .await;
    checks
}

/// Scan all enabled agents. Runs parsers in parallel (bounded concurrency) so a
/// single heavy agent (9router/devin) does not block the rest for tens of seconds.
/// Does not sort the full list (callers that need newest-first sort a slice).
pub async fn scan_all(opts: ScanAllOptions) -> Vec<UsageEvent> {
    let concurrency = opts.concurrency.unwrap_or(4).clamp(1, 8);
    // Prefer completeness: never default to a short timeout that drops Grok/Devin history
    let timeout_ms = opts.timeout_ms.unwrap_or(DEFAULT_PARSER_TIMEOUT_MS);
    let on_agent_done = opts.on_agent_done.clone();

    // Probe agent roots in parallel so scan setup is not N sequential disk checks
    let opts_ref = &opts;
    let probed = futures::future::join_all(all_agents().iter().map(|m| async move {
        if let Some(en) = &opts_ref.enabled {
            if en.get(&m.id) == Some(&false) {
                return None;
            }
        }
        let parse = if opts_ref.light && m.parse_light.is_some() {
            m.parse_light.clone().unwrap()
        } else {
            m.parse.clone()
        };
        let candidate_roots: Vec<String> = (m.roots)().into_iter().filter(|r| !r.is_empty()).collect();
        let extra = opts_ref.additional_roots.as_ref().and_then(|a| a.get(&m.id));
        let remote_candidates: Vec<String> = extra
            .map(|e| e.roots.iter().filter(|r| !r.is_empty()).cloned().collect())
            .unwrap_or_default();
        let (checks, remote_checks) = futures::future::join(probe_roots(&candidate_roots), probe_roots(&remote_candidates)).await;
        let roots: Vec<String> = checks.iter().chain(remote_checks.iter()).filter(|r| !r.is_empty()).cloned().collect();
        if roots.is_empty() {
            return None;
        }
        Some(Job {
            id: m.id,
            roots,
            remote_roots: remote_checks.into_iter().filter(|r| !r.is_empty()).collect(),
            machine_scope: extra.map(|e| e.machine_scope.clone()),
            parse,
        })
    }))
    .await;
    let mut jobs: Vec<Job> = probed.into_iter().flatten().collect();

    // Light agents first -> progressive UI fills sooner; heavy (Grok/9router) last.
    jobs.sort_by(|a, b| {
        let ha = HEAVY_AGENTS.contains(&a.id.as_str());
        let hb = HEAVY_AGENTS.contains(&b.id.as_str());
        ha.cmp(&hb).then_with(|| a.id.as_str().cmp(b.id.as_str()))
    });

    // When caller streams via on_agent_done (server rescan), skip giant combined array
    // to avoid holding ~2x events in RAM (batch lists + `all`).
    let collect_all = on_agent_done.is_none();
    let jobs = Arc::new(jobs);
    let cursor = Arc::new(AtomicUsize::new(0));
    let all: Arc<parking_lot::Mutex<Vec<UsageEvent>>> = Arc::new(parking_lot::Mutex::new(Vec::new()));

    let worker_count = concurrency.min(jobs.len().max(1));
    let mut handles = Vec::with_capacity(worker_count);
    for _ in 0..worker_count {
        let jobs = jobs.clone();
        let cursor = cursor.clone();
        let all = all.clone();
        let on_done = on_agent_done.clone();
        handles.push(tokio::spawn(async move {
            loop {
                let i = cursor.fetch_add(1, Ordering::SeqCst);
                if i >= jobs.len() {
                    break;
                }
                let job = &jobs[i];
                let t0 = now_ms();
                let fut = (job.parse)(job.roots.clone());
                // Run the parser as its own task so a panic is reported like a thrown error.
                let task = tokio::spawn(async move {
                    if timeout_ms > 0.0 {
                        match tokio::time::timeout(Duration::from_millis(timeout_ms as u64), fut).await {
                            Ok(r) => r,
                            Err(_) => Err(anyhow::anyhow!("timed out")),
                        }
                    } else {
                        fut.await
                    }
                });
                let result: Result<Vec<UsageEvent>, String> = match task.await {
                    Ok(Ok(v)) => Ok(v),
                    Ok(Err(e)) => {
                        let msg = e.to_string();
                        if msg == "timed out" {
                            Err(format!("parser {} timed out after {}ms", job.id, js_num_to_string(timeout_ms)))
                        } else {
                            Err(msg)
                        }
                    }
                    Err(join) => Err(format!("parser {} panicked: {}", job.id, join)),
                };
                match result {
                    Ok(parsed) => {
                        let batch = apply_machine_scope(job, parsed);
                        match &on_done {
                            Some(cb) => {
                                if collect_all {
                                    all.lock().extend(batch.iter().cloned());
                                }
                                cb(AgentDone { agent: job.id, events: batch, duration_ms: now_ms() - t0, error: None });
                            }
                            None => {
                                if collect_all {
                                    all.lock().extend(batch);
                                }
                            }
                        }
                    }
                    Err(msg) => {
                        eprintln!("[tokenlab] parser {} failed: {}", job.id, msg);
                        if let Some(cb) = &on_done {
                            cb(AgentDone { agent: job.id, events: Vec::new(), duration_ms: now_ms() - t0, error: Some(msg) });
                        }
                    }
                }
                // Let HTTP/SSE/heartbeat run between heavy parsers (reduces UI freeze).
                tokio::task::yield_now().await;
            }
        }));
    }
    futures::future::join_all(handles).await;

    if !collect_all {
        return Vec::new();
    }
    let mut all = std::mem::take(&mut *all.lock());
    // LiteLLM is an independent source of truth and is added as-is; only the
    // OpenClaw rows mirrored by Hermes are dropped.
    let openclaw: Vec<&UsageEvent> = all.iter().filter(|e| e.agent == AgentId::Openclaw).collect();
    let hermes: Vec<&UsageEvent> = all.iter().filter(|e| e.agent == AgentId::Hermes).collect();
    let mask = openclaw_keep_mask(&openclaw, &hermes);
    let mut keep = mask.into_iter();
    all.retain(|e| {
        if e.agent == AgentId::Openclaw {
            keep.next().unwrap_or(true)
        } else {
            true
        }
    });
    all.shrink_to_fit();
    all
}

/// `scanAll(enabledMap)` convenience form.
pub async fn scan_all_enabled(enabled: Option<HashMap<AgentId, bool>>) -> Vec<UsageEvent> {
    scan_all(ScanAllOptions { enabled, ..Default::default() }).await
}

/// Per-agent status (detected paths, last event, event count).
pub async fn detect_agents(events: &[UsageEvent]) -> Vec<AgentStatus> {
    // O(n) counts + last timestamp - avoid storing 100k+ event arrays per agent
    let mut counts: HashMap<AgentId, f64> = HashMap::new();
    let mut last_at: HashMap<AgentId, &str> = HashMap::new();
    for e in events {
        *counts.entry(e.agent).or_insert(0.0) += 1.0;
        match last_at.get(&e.agent) {
            Some(prev) if e.timestamp.as_str() <= *prev => {}
            _ => {
                last_at.insert(e.agent, e.timestamp.as_str());
            }
        }
    }
    let counts = &counts;
    let last_at = &last_at;

    // Parallel path checks across all agents.
    futures::future::join_all(all_agents().iter().map(|m| async move {
        let roots: Vec<String> = (m.roots)().into_iter().filter(|r| !r.is_empty()).collect();
        let checks = probe_roots(&roots).await;
        let paths: Vec<String> = checks.into_iter().filter(|r| !r.is_empty()).collect();
        let count = counts.get(&m.id).copied().unwrap_or(0.0);
        AgentStatus {
            id: m.id,
            label: m.label.to_string(),
            detected: !paths.is_empty() || count > 0.0,
            enabled: true,
            paths,
            last_event_at: last_at.get(&m.id).map(|s| s.to_string()),
            event_count: count,
        }
    }))
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_order_and_uniqueness() {
        let agents = all_agents();
        assert_eq!(agents.len(), 52);
        assert_eq!(agents[0].id, AgentId::ClaudeCode);
        assert_eq!(agents[1].id, AgentId::Codex);
        assert_eq!(agents[50].id, AgentId::Routerlab);
        assert_eq!(agents[51].id, AgentId::Litellm);
        let mut ids: Vec<&str> = agents.iter().map(|a| a.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 52);
        assert!(parser_for(AgentId::Custom).is_none());
        assert!(parser_for(AgentId::Codex).is_some());
    }

    #[test]
    fn every_agent_has_roots() {
        for a in all_agents() {
            assert!(!(a.roots)().is_empty() || a.id == AgentId::Roocode, "{} has no roots", a.id);
        }
    }

    #[test]
    fn linux_home_specs_are_filtered() {
        let specs = agent_path_specs_for_linux_home("/home/tester");
        assert_eq!(specs.len(), 52);
        let claude = specs.iter().find(|s| s.id == AgentId::ClaudeCode).unwrap();
        assert!(claude.roots.contains(&"/home/tester/.claude".to_string()));
        for s in &specs {
            for r in &s.roots {
                assert!(r.starts_with("/home/tester/"), "{r}");
                assert!(!r.split('/').any(|seg| seg == "mirrors"), "{r}");
            }
        }
    }

    fn ev(agent: AgentId, ts: &str, out: f64) -> UsageEvent {
        UsageEvent {
            agent,
            model: Some("M-1".into()),
            timestamp: ts.into(),
            input_tokens: 10.0,
            output_tokens: out,
            total_tokens: 10.0 + out,
            ..Default::default()
        }
    }

    #[test]
    fn openclaw_mirror_is_dropped_when_hermes_matches() {
        let h = vec![ev(AgentId::Hermes, "2026-01-01T00:00:00.000Z", 5.0)];
        let o = vec![
            ev(AgentId::Openclaw, "2026-01-01T00:00:00.500Z", 5.0),
            ev(AgentId::Openclaw, "2026-01-01T00:00:05.000Z", 5.0),
            ev(AgentId::Openclaw, "2026-01-01T00:00:00.000Z", 6.0),
        ];
        let kept = dedupe_mirrored_openclaw_events(&o, &h);
        assert_eq!(kept.len(), 2);
    }

    #[tokio::test]
    async fn scan_all_runs_with_stubs() {
        let events = scan_all(ScanAllOptions { light: true, ..Default::default() }).await;
        // stubs parse nothing; the point is that it completes without panicking
        let _ = events;
        let statuses = detect_agents(&[]).await;
        assert_eq!(statuses.len(), 52);
    }
}
