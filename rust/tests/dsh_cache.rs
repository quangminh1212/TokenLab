//! Port of `tests/dsh-cache.test.ts`.

use serde_json::{json, Value};
use tokenlab::agents::dsh::parse_dsh;
use tokenlab::pricing::{get_rate_for_model, price_cost_parts};

fn write_session(root: &std::path::Path, project: &str, name: &str, rows: &[Value]) -> std::path::PathBuf {
    let dir = root.join(project);
    std::fs::create_dir_all(&dir).unwrap();
    let text: String = rows.iter().map(|r| format!("{}\n", r)).collect();
    std::fs::write(dir.join(name), text).unwrap();
    dir
}

fn turn(seq: i64, usage: Value, model: &str) -> Vec<Value> {
    vec![
        json!({"type": "request/context", "seq": seq - 1, "cwd": "/work/demo", "data": {"model": model}}),
        json!({"type": "assistant/message", "seq": seq, "cwd": "/work/demo", "data": {"usage": usage}}),
    ]
}

fn root_of(d: &tempfile::TempDir) -> String {
    d.path().to_string_lossy().to_string()
}

#[tokio::test]
async fn parse_dsh_keeps_cache_reads_from_the_cache_aware_usage_shape() {
    let root = tempfile::tempdir().unwrap();
    write_session(
        root.path(),
        "demo",
        "session.jsonl",
        &turn(
            1,
            json!({"inputTokens": 535, "outputTokens": 181, "totalTokens": 98_764, "cacheReadTokens": 98_048}),
            "anthropic/claude-fable-5",
        ),
    );
    let events = parse_dsh(vec![root_of(&root)]).await.unwrap();
    assert_eq!(events.len(), 1);
    let e = &events[0];
    assert_eq!(e.cache_read_tokens, 98_048.0, "cache reads must survive parsing");
    assert_eq!(e.input_tokens, 535.0, "cache-aware inputTokens is passed through");
    assert_eq!(e.cache_reported, Some(true));
}

#[tokio::test]
async fn parse_dsh_follows_usage_precedence_for_messages_attempts_and_compaction() {
    let root = tempfile::tempdir().unwrap();
    let chunk = |i: i64, o: i64| {
        json!([{"type": "chunk", "chunk": {"type": "usage", "usage": {"inputTokens": i, "outputTokens": o}}}])
    };
    write_session(
        root.path(),
        "demo",
        "session.jsonl",
        &[
            json!({"type": "request/context", "seq": 0, "cwd": "/work/demo", "data": {"model": "anthropic/claude-fable-5"}}),
            json!({"type": "assistant/message", "seq": 1, "data": {"stream": [
                {"type": "chunk", "chunk": {"type": "usage", "usage": {"inputTokens": 10, "outputTokens": 2}}},
                {"type": "chunk", "chunk": {"type": "usage", "usage": {"inputTokens": 12, "outputTokens": 3}}},
            ]}}),
            json!({"type": "assistant/message", "seq": 2, "data": {
                "usage": {"inputTokens": 20, "outputTokens": 4}, "stream": chunk(200, 40)}}),
            json!({"type": "assistant/attempt", "seq": 3, "data": {
                "usage": {"inputTokens": 300, "outputTokens": 30}, "stream": chunk(30, 5)}}),
            json!({"type": "compaction/summary", "seq": 4, "data": {"usage": {"inputTokens": 40, "outputTokens": 6}}}),
        ],
    );
    let events = parse_dsh(vec![root_of(&root)]).await.unwrap();
    assert_eq!(events.len(), 4);
    let got: Vec<(f64, f64)> = events.iter().map(|e| (e.input_tokens, e.output_tokens)).collect();
    assert_eq!(got, vec![(12.0, 3.0), (20.0, 4.0), (30.0, 5.0), (40.0, 6.0)]);
}

#[tokio::test]
async fn parse_dsh_does_not_invent_a_cache_read_for_legacy_rows() {
    let root = tempfile::tempdir().unwrap();
    write_session(
        root.path(),
        "demo",
        "session.jsonl",
        &[
            json!({"type": "request/context", "seq": 0, "cwd": "/work/demo", "data": {"model": "anthropic/claude-fable-5"}}),
            json!({"type": "assistant/message", "seq": 1, "cwd": "/work/demo", "data": {"usage": {"inputTokens": 165_056, "outputTokens": 512, "totalTokens": 165_568}}}),
            json!({"type": "assistant/message", "seq": 2, "cwd": "/work/demo", "data": {"usage": {"inputTokens": 168_204, "outputTokens": 120, "totalTokens": 168_324}}}),
            json!({"type": "assistant/message", "seq": 3, "cwd": "/work/demo", "data": {"usage": {"inputTokens": 169_110, "outputTokens": 88, "totalTokens": 169_198}}}),
        ],
    );
    let events = parse_dsh(vec![root_of(&root)]).await.unwrap();
    assert_eq!(events.len(), 3);
    for (e, prompt) in events.iter().zip([165_056.0, 168_204.0, 169_110.0]) {
        assert_eq!(e.cache_read_tokens, 0.0, "no cache number may be fabricated");
        assert_eq!(e.input_tokens, prompt, "the whole prompt counts as fresh input");
        assert_eq!(e.cache_reported, Some(false), "a guessed split must not claim to be measured");
        assert_eq!(e.input_tokens + e.cache_read_tokens, prompt, "split must preserve the prompt total");
    }
}

#[tokio::test]
async fn legacy_reconstruction_leaves_the_billed_total_identical_to_the_providers_formula() {
    let root = tempfile::tempdir().unwrap();
    write_session(
        root.path(),
        "demo",
        "session.jsonl",
        &[
            json!({"type": "request/context", "seq": 0, "cwd": "/work/demo", "data": {"model": "anthropic/claude-fable-5"}}),
            json!({"type": "assistant/message", "seq": 1, "cwd": "/work/demo", "data": {"usage": {"inputTokens": 100_000, "outputTokens": 1_000, "totalTokens": 101_000}}}),
            json!({"type": "assistant/message", "seq": 2, "cwd": "/work/demo", "data": {"usage": {"inputTokens": 120_000, "outputTokens": 1_000, "totalTokens": 121_000}}}),
        ],
    );
    let events = parse_dsh(vec![root_of(&root)]).await.unwrap();
    assert_eq!(events.len(), 2);

    let priced: f64 = events
        .iter()
        .map(|e| {
            price_cost_parts(
                e.model.as_deref(),
                e.input_tokens,
                e.output_tokens,
                e.cache_read_tokens,
                e.cache_write_tokens,
                None,
            )
            .table_total
        })
        .sum();
    let expected = (100_000.0 / 1e6) * 10.0 + (1_000.0 / 1e6) * 50.0 + (120_000.0 / 1e6) * 10.0 + (1_000.0 / 1e6) * 50.0;
    assert!((priced - expected).abs() < 1e-9, "billed total drifted: got {priced}, expected {expected}");

    let e1 = &events[1];
    let parts = price_cost_parts(
        e1.model.as_deref(),
        e1.input_tokens,
        e1.output_tokens,
        e1.cache_read_tokens,
        e1.cache_write_tokens,
        None,
    );
    assert!(
        (parts.input_cost + parts.cache_cost + parts.output_cost - parts.table_total).abs() < 1e-9,
        "Input $ + Cache $ + Output $ must equal Total $"
    );
}

#[test]
fn cache_reads_on_these_gateways_bill_at_the_input_rate_not_a_discount() {
    let rate = get_rate_for_model(Some("claude-fable-5"));
    assert_eq!(rate.rate.input_per_1m, 10.0);
    assert_eq!(rate.rate.output_per_1m, 50.0);
    assert_eq!(
        rate.rate.cache_read_per_1m,
        Some(rate.rate.input_per_1m),
        "a cache read is billed like fresh input on this gateway"
    );

    let parts = price_cost_parts(Some("claude-fable-5"), 1_000_000.0, 1_000_000.0, 1_000_000.0, 0.0, None);
    assert_eq!(parts.input_cost, 10.0);
    assert_eq!(parts.cache_cost, 10.0);
    assert_eq!(parts.output_cost, 50.0);
}

#[test]
fn every_claude_model_the_router_bills_prices_cache_like_input() {
    for model in ["claude-fable-5", "claude-fable", "claude-opus-5", "claude-opus-5.5", "claude-sonnet-5.5"] {
        let r = get_rate_for_model(Some(model)).rate;
        assert_eq!(
            r.cache_read_per_1m,
            Some(r.input_per_1m),
            "{model} must bill cache reads at the input rate"
        );
    }
}
