//! Port of `tests/openclaw-parser.test.ts`.

use serde_json::json;
use tokenlab::agents::dedupe_mirrored_openclaw_events;
use tokenlab::agents::openclaw::parse_openclaw;
use tokenlab::types::{AgentId, PricingStatus, UsageEvent};

#[tokio::test]
async fn parse_openclaw_reads_per_response_usage_from_the_active_sqlite_transcript() {
    let root = tempfile::tempdir().unwrap();
    let agent_dir = root.path().join("agents").join("main").join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    {
        let db = rusqlite::Connection::open(agent_dir.join("openclaw-agent.sqlite")).unwrap();
        db.execute_batch(
            "CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, model_provider TEXT, model TEXT);
             CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER);
             INSERT INTO session_windows VALUES ('session-1', 'hermes', 'glm-5.3');",
        )
        .unwrap();
        let events = [
            (
                json!({"type": "model_change", "timestamp": "2026-09-20T08:04:17.356Z", "provider": "hermes", "modelId": "glm-5.3"}),
                1_789_891_457_356i64,
            ),
            (
                json!({"type": "message", "timestamp": "2026-09-20T08:04:24.280Z", "message": {"role": "assistant",
                    "usage": {"input": 36_869, "output": 33, "cacheRead": 0, "cacheWrite": 0, "total": 36_902}}}),
                1_789_891_464_280i64,
            ),
        ];
        for (i, (e, ts)) in events.iter().enumerate() {
            db.execute(
                "INSERT INTO transcript_events VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params!["session-1", i as i64 + 1, e.to_string(), ts],
            )
            .unwrap();
        }
    }
    let usage = parse_openclaw(vec![root.path().to_string_lossy().to_string()]).await.unwrap();
    assert_eq!(usage.len(), 1);
    assert_eq!(usage[0].agent, AgentId::Openclaw);
    assert_eq!(usage[0].model.as_deref(), Some("glm-5.3"));
    assert_eq!(usage[0].timestamp, "2026-09-20T08:04:24.280Z");
    assert_eq!(usage[0].input_tokens, 36_869.0);
    assert_eq!(usage[0].output_tokens, 33.0);
    assert_eq!(usage[0].total_tokens, 36_902.0);
}

fn make_event(id: &str, timestamp: &str) -> UsageEvent {
    UsageEvent {
        id: id.into(),
        agent: AgentId::Openclaw,
        model: Some("glm-5.3".into()),
        timestamp: timestamp.into(),
        input_tokens: 36_869.0,
        output_tokens: 33.0,
        cache_read_tokens: 0.0,
        cache_write_tokens: 0.0,
        total_tokens: 36_902.0,
        estimated_cost: Some(0.05),
        currency: "USD".into(),
        pricing_status: PricingStatus::Priced,
        workspace: None,
        source_path: "C:\\Users\\GHC\\.openclaw\\agents\\main\\agent\\openclaw-agent.sqlite".into(),
        ..Default::default()
    }
}

#[test]
fn scan_reconciliation_keeps_a_mirrored_openclaw_call_counted_once_under_hermes() {
    let mirror = make_event("openclaw-mirror", "2026-09-20T08:04:24.280Z");
    let unrelated = make_event("other-request", "2026-09-20T08:05:00.000Z");
    let hermes = UsageEvent {
        id: "hermes-source".into(),
        agent: AgentId::Hermes,
        timestamp: "2026-09-20T08:04:24.249Z".into(),
        input_tokens: 20_485.0,
        cache_read_tokens: 16_384.0,
        estimated_cost: Some(0.033),
        source_path: "C:\\Users\\GHC\\AppData\\Local\\hermes\\state.db".into(),
        ..mirror.clone()
    };

    let result = dedupe_mirrored_openclaw_events(&[mirror, unrelated], &[hermes]);
    let ids: Vec<&str> = result.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, vec!["other-request"]);
}
