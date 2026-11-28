//! Port of `tests/cache-reconciliation.test.ts`.

use tokenlab::backup::{
    drop_legacy_codex_proxy_attributions, replace_fresh_agent_session_events, replace_fresh_agent_source_events,
};
use tokenlab::types::{AgentId, PricingStatus, UsageEvent};

fn event(id: &str, source_path: &str) -> UsageEvent {
    UsageEvent {
        id: id.into(),
        source_path: source_path.into(),
        agent: AgentId::ClaudeCode,
        model: Some("openclaw".into()),
        timestamp: "2026-09-13T01:00:00.000Z".into(),
        input_tokens: 0.0,
        output_tokens: 0.0,
        cache_read_tokens: 0.0,
        cache_write_tokens: 0.0,
        total_tokens: 0.0,
        estimated_cost: Some(0.0),
        currency: "USD".into(),
        pricing_status: PricingStatus::Priced,
        workspace: Some("C--Dev-Demo".into()),
        estimated: Some(false),
        ..Default::default()
    }
}

#[test]
fn legacy_codex_proxy_attribution_is_removed_while_native_and_litellm_rows_remain() {
    let rows = vec![
        UsageEvent {
            agent: AgentId::Codex,
            workspace: Some("C--Dev-PresentLab".into()),
            ..event("codex-native", "C:/Users/GHC/.codex/sessions/rollout.jsonl")
        },
        UsageEvent {
            agent: AgentId::Codex,
            workspace: Some("C--Dev-PresentLab \u{b7} via:tokenrouter".into()),
            ..event(
                "codex-proxy-join",
                "C:/Users/GHC/.codex/sessions/rollout.jsonl \u{2190} C:/data/mirrors/litellm/usage-history.jsonl",
            )
        },
        UsageEvent {
            agent: AgentId::Litellm,
            workspace: Some("litellm".into()),
            ..event("litellm-source", "C:/data/mirrors/litellm/usage-history.jsonl")
        },
    ];
    let out = drop_legacy_codex_proxy_attributions(&rows);
    let ids: Vec<String> = out.iter().map(|r| r.id.to_string()).collect();
    assert_eq!(ids, vec!["codex-native", "litellm-source"]);
}

#[test]
fn fresh_claude_source_rows_replace_legacy_per_content_block_cache_rows() {
    let source = "C:/Users/GHC/.claude/projects/C--Dev-Demo/session.jsonl";
    let old_block1 = UsageEvent { input_tokens: 100.0, total_tokens: 100.0, ..event("legacy-block-1", source) };
    let old_block2 = UsageEvent { input_tokens: 100.0, total_tokens: 100.0, ..event("legacy-block-2", source) };
    let old_other_file = UsageEvent {
        input_tokens: 50.0,
        total_tokens: 50.0,
        ..event("other-file", "C:/Users/GHC/.claude/projects/C--Dev-Demo/other.jsonl")
    };
    let fresh = UsageEvent {
        input_tokens: 100.0,
        output_tokens: 20.0,
        total_tokens: 120.0,
        ..event("stable-request-id", source)
    };

    let out = replace_fresh_agent_source_events(&[fresh], &[old_block1, old_block2, old_other_file], "claude-code");
    assert_eq!(out.iter().filter(|r| r.source_path == source).count(), 1);
    assert!(out.iter().any(|r| r.id == "stable-request-id"));
    assert!(out.iter().any(|r| r.id == "other-file"));
    assert!(!out.iter().any(|r| r.id == "legacy-block-1"));
    assert!(!out.iter().any(|r| r.id == "legacy-block-2"));
}

#[test]
fn fresh_grok_updates_replace_a_persisted_usage_fallback_for_the_same_session() {
    let usage_path = "C:/Users/GHC/.grok/sessions/proj/sess-1/usage.json";
    let updates_path = "C:/Users/GHC/.grok/sessions/proj/sess-1/updates.jsonl";
    let old_persisted = UsageEvent {
        agent: AgentId::Grok,
        input_tokens: 100.0,
        output_tokens: 10.0,
        total_tokens: 110.0,
        ..event("persisted-turn-1", usage_path)
    };
    let fresh_update = UsageEvent {
        agent: AgentId::Grok,
        input_tokens: 100.0,
        output_tokens: 10.0,
        total_tokens: 110.0,
        ..event("update-turn-1", updates_path)
    };

    let out = replace_fresh_agent_session_events(&[fresh_update], &[old_persisted], "grok");
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].id, "update-turn-1");
}
