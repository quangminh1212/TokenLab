//! Port of `tests/grok-ghost-residual.test.ts`.

use std::collections::{HashMap, HashSet};

use tokenlab::backup::{
    collapse_source_path_rollups, drop_grok_stale_residuals, enforce_monotonic_agent_days,
    merge_events_by_id_prefer_richer, prefer_richer_event,
};
use tokenlab::types::{AgentId, UsageEvent};

struct Ev {
    id: &'static str,
    model: &'static str,
    input: f64,
    output: f64,
    cache_read: f64,
    estimated: bool,
    cost: Option<f64>,
    source_path: String,
    timestamp: &'static str,
}

impl Ev {
    fn new(id: &'static str, source_path: &str) -> Ev {
        Ev {
            id,
            model: "grok-4.5",
            input: 0.0,
            output: 0.0,
            cache_read: 0.0,
            estimated: false,
            cost: None,
            source_path: source_path.to_string(),
            timestamp: "2026-08-05T04:00:00.000Z",
        }
    }
    fn build(self) -> UsageEvent {
        UsageEvent {
            id: self.id.to_string().into(),
            agent: AgentId::Grok,
            model: Some(self.model.to_string().into()),
            timestamp: self.timestamp.to_string().into(),
            input_tokens: self.input,
            output_tokens: self.output,
            cache_read_tokens: self.cache_read,
            cache_write_tokens: 0.0,
            total_tokens: self.input + self.output + self.cache_read,
            estimated: Some(self.estimated),
            estimated_cost: self.cost,
            source_path: self.source_path.into(),
            ..Default::default()
        }
    }
}

fn norm(p: &str) -> String {
    p.replace('\\', "/").to_lowercase()
}

#[test]
fn collapse_source_path_rollups_drops_ghost_grok_residual_out0_when_real_usage_exists() {
    let path = "C:/Users/x/.grok/sessions/demo/sess-1/updates.jsonl";
    let mut real = Ev::new("real-tc-1", path);
    real.model = "grok-4.5-build";
    real.input = 4_500.0;
    real.output = 3_500.0;
    real.cache_read = 100_000.0;
    let mut real = real.build();
    real.total_tokens = 108_000.0;

    // Old unstable residual ids (peak baked into hash) - must not survive once real exists.
    let mut g1 = Ev::new("residual-peak-210316", path);
    g1.input = 210_316.0;
    g1.estimated = true;
    let g1 = g1.build();
    let mut g2 = Ev::new("residual-peak-263573", path);
    g2.input = 263_573.0;
    g2.estimated = true;
    let g2 = g2.build();
    // Live residual with estimated output from chunks - keep (multi-turn in progress).
    let mut live = Ev::new("live-residual", path);
    live.input = 50_000.0;
    live.output = 800.0;
    live.estimated = true;
    let live = live.build();
    // Other session still only residual - keep (in progress, no real yet).
    let mut other = Ev::new("other-residual", "C:/Users/x/.grok/sessions/demo/sess-2/updates.jsonl");
    other.input = 23_100.0;
    other.estimated = true;
    let other = other.build();

    let out = collapse_source_path_rollups(&[real, g1, g2, live, other]);
    let ids: HashSet<String> = out.iter().map(|e| e.id.to_string()).collect();
    assert!(ids.contains("real-tc-1"));
    assert!(ids.contains("live-residual"), "keep estimated residual with out>0");
    assert!(ids.contains("other-residual"), "keep residual when path has no real usage");
    assert!(!ids.contains("residual-peak-210316"));
    assert!(!ids.contains("residual-peak-263573"));
}

#[test]
fn prefer_richer_same_id_residual_then_real_usage_keeps_real_non_estimated() {
    let id = "shared-tc-id";
    let path = "C:/Users/x/.grok/sessions/demo/sess-3/updates.jsonl";
    let mut residual = Ev::new(id, path);
    residual.input = 23_100.0;
    residual.output = 100.0;
    residual.estimated = true;
    let residual = residual.build();
    let mut real = Ev::new(id, path);
    real.model = "grok-4.5-build";
    real.input = 25_000.0;
    real.output = 900.0;
    real.cache_read = 80_000.0;
    let real = real.build();

    let merged = merge_events_by_id_prefer_richer(&[&[residual], &[real]]);
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].estimated, Some(false));
    assert_eq!(merged[0].output_tokens, 900.0);
    assert_eq!(merged[0].model.as_deref(), Some("grok-4.5-build"));
}

#[test]
fn merge_mono_collapse_unstable_residual_out0_stack_loses_to_one_residual_out_gt0() {
    let path = "C:/Users/x/.grok/sessions/C%3A%5CDev%5CAgentLab/019fcde5-aaaa-bbbb-cccc-ddddeeeeffff/updates.jsonl";
    let day = "2026-08-04T12:00:00.000Z";
    let mut ghosts: Vec<UsageEvent> = Vec::new();
    for i in 0..21 {
        let peak = 50_000.0 + (i as f64) * 10_000.0;
        let id: &'static str = Box::leak(format!("residual-peak-{}", peak as i64).into_boxed_str());
        let mut g = Ev::new(id, path);
        g.timestamp = day;
        g.input = peak;
        g.estimated = true;
        g.cost = Some(peak * 0.00001);
        ghosts.push(g.build());
    }
    let mut good = Ev::new("stable-tc-prompt-1", path);
    good.timestamp = day;
    good.input = 80_000.0;
    good.output = 37_900.0;
    good.estimated = true;
    good.cost = Some(0.5);
    let good = good.build();

    // Simulate mergeAgentScanLight: fresh authoritative for residual path drops prev est out=0.
    let fresh = vec![good];
    let fresh_paths: HashSet<String> = fresh.iter().map(|e| norm(&e.source_path)).collect();
    let prev_for_merge: Vec<UsageEvent> = ghosts
        .iter()
        .filter(|e| {
            if e.agent != AgentId::Grok || e.estimated != Some(true) {
                return true;
            }
            if e.output_tokens > 0.0 {
                return true;
            }
            let sp = norm(&e.source_path);
            if sp.ends_with("updates.jsonl") && fresh_paths.contains(&sp) {
                return false;
            }
            true
        })
        .cloned()
        .collect();
    let after_light = merge_events_by_id_prefer_richer(&[&fresh, &prev_for_merge]);
    assert_eq!(after_light.len(), 1);
    assert_eq!(after_light[0].output_tokens, 37_900.0);

    // Without ghost strip, mono would restore 21 ghosts (higher tok sum). Must not.
    let after_mono = enforce_monotonic_agent_days(&ghosts, &after_light);
    let after_collapse = collapse_source_path_rollups(&after_mono);
    let path_rows: Vec<&UsageEvent> =
        after_collapse.iter().filter(|e| norm(&e.source_path) == path.to_lowercase()).collect();
    assert!(!path_rows.is_empty(), "keep residual for session");
    assert!(
        path_rows.iter().all(|e| e.output_tokens > 0.0 || e.estimated != Some(true)),
        "no estimated out=0 ghosts remain"
    );
    assert!(path_rows.iter().any(|e| e.output_tokens >= 37_900.0), "correct residual out must survive mono");
    assert!(
        !path_rows.iter().any(|e| e.estimated == Some(true) && e.output_tokens == 0.0),
        "zero-out residual stack must be gone"
    );
    // dropGrokStaleResiduals alone collapses pure out=0 stack.
    let only_ghosts = drop_grok_stale_residuals(&ghosts);
    assert_eq!(only_ghosts.len(), 1, "pure out=0 stack collapses to 1");
}

#[test]
fn prefer_richer_residual_heavier_than_real_still_keeps_non_estimated_real() {
    let id = "heavy-residual-vs-real";
    let path = "C:/Users/x/.grok/sessions/demo/sess-4/updates.jsonl";
    let mut residual = Ev::new(id, path);
    residual.input = 263_573.0;
    residual.output = 5_000.0;
    residual.estimated = true;
    residual.cost = Some(9.99);
    let residual = residual.build();
    let mut real = Ev::new(id, path);
    real.model = "grok-4.5-build";
    real.input = 4_820.0;
    real.output = 3_415.0;
    real.cache_read = 1_040_256.0;
    real.cost = Some(0.15);
    let real = real.build();

    // Force weight > real by stuffing totalTokens only on the residual view.
    let mut residual_trap = residual.clone();
    residual_trap.total_tokens = 9_999_999.0;
    residual_trap.input_tokens = 9_999_999.0;
    let a = prefer_richer_event(&residual_trap, &real).clone();
    let b = prefer_richer_event(&real, &residual_trap).clone();
    assert_eq!(a.estimated, Some(false), "real wins when next is real");
    assert_eq!(b.estimated, Some(false), "real wins when prev is real");
    assert_eq!(a.output_tokens, 3_415.0);
    assert_eq!(b.output_tokens, 3_415.0);
    assert_eq!(a.model.as_deref(), Some("grok-4.5-build"));

    // collapse must not drop the real row when a heavier est out=0 also exists.
    let mut ghost = Ev::new("ghost-other-id", path);
    ghost.input = 200_000.0;
    ghost.estimated = true;
    let ghost = ghost.build();
    let collapsed = collapse_source_path_rollups(&[residual_trap, real, ghost]);
    let by_id: HashMap<String, &UsageEvent> = collapsed.iter().map(|e| (e.id.to_string(), e)).collect();
    assert!(by_id.contains_key(id), "real usage id must survive collapse");
    assert_eq!(by_id[id].estimated, Some(false));
    assert_eq!(by_id[id].output_tokens, 3_415.0);
    assert!(!by_id.contains_key("ghost-other-id"), "ghost out=0 dropped");
}
