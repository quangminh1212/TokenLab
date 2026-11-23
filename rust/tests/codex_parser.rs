//! Integration complement to `tests/codex-parser.test.ts`.
//!
//! Most cases of that file live as unit tests in `src/agents/codex.rs`. The first
//! one needs `TOKENLAB_DATA_DIR` (a LiteLLM mirror that must stay out of Codex),
//! which mutates process-wide env, so it lives here in its own test binary.

use serde_json::json;
use tokenlab::agents::codex;
use tokenlab::types::AgentId;

#[tokio::test]
async fn does_not_attribute_uncorrelated_litellm_history_to_codex() {
    let root_tmp = tempfile::tempdir().unwrap();
    let data_tmp = tempfile::tempdir().unwrap();
    let root = root_tmp.path();
    let sessions = root.join("sessions").join("2026").join("08").join("02");
    std::fs::create_dir_all(&sessions).unwrap();

    let lines = vec![
        json!({"timestamp":"2026-08-02T05:43:00.000Z","type":"session_meta","payload":{"session_id":"s1","cwd":"C:\\Dev\\CursorProxy","model_provider":"9router","model":"kimi-k3"}}),
        json!({"timestamp":"2026-08-02T05:43:01.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}),
        json!({"timestamp":"2026-08-02T05:43:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello world"}]}}),
        json!({"timestamp":"2026-08-02T05:43:05.000Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{}}}),
        json!({"timestamp":"2026-08-02T05:43:10.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi there"}]}}),
        json!({"timestamp":"2026-08-02T05:43:12.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1"}}),
    ];
    let text = lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n") + "\n";
    std::fs::write(sessions.join("rollout-test.jsonl"), text).unwrap();

    // A matching proxy row must stay out of Codex, even when model/time overlap.
    let mirror = data_tmp.path().join("mirrors").join("litellm");
    std::fs::create_dir_all(&mirror).unwrap();
    std::fs::write(
        mirror.join("usage-history.jsonl"),
        json!({
            "id": "req-codex-1",
            "timestamp": "2026-08-02T05:43:08.000Z",
            "model": "openai/Kimi-k3",
            "provider": "openai",
            "promptTokens": 1200,
            "completionTokens": 40,
            "cost": 0.012,
            "status": "success",
        })
        .to_string()
            + "\n",
    )
    .unwrap();

    let prev = std::env::var("TOKENLAB_DATA_DIR").ok();
    std::env::set_var("TOKENLAB_DATA_DIR", data_tmp.path());
    let result = (codex::agent().parse)(vec![root.to_string_lossy().to_string()]).await;
    match prev {
        Some(v) => std::env::set_var("TOKENLAB_DATA_DIR", v),
        None => std::env::remove_var("TOKENLAB_DATA_DIR"),
    }
    let events = result.unwrap();

    assert_eq!(events.len(), 1, "expected one content estimate, got {}", events.len());
    let e = &events[0];
    assert_eq!(e.agent, AgentId::Codex);
    assert_eq!(e.estimated, Some(true));
    assert_eq!(e.input_tokens, 3.0);
    assert_eq!(e.output_tokens, 2.0);
    // routerCost has no UsageEvent field in Rust; the proxy row's 0.012 cost must
    // not leak into the Codex estimate.
    assert_ne!(e.estimated_cost, Some(0.012));
    assert!(!e.source_path.contains('\u{2190}'));
    // A chars/4 content estimate never saw a cache field, so it must stay silent
    // rather than claim a measured cache of zero.
    assert_eq!(e.cache_reported, None);
}
