//! Incremental scan: skipping unchanged files must equal a full re-parse.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokenlab::agents::shared::generic_jsonl::{parse_generic_jsonl, GenericJsonlOptions};
use tokenlab::types::{AgentId, UsageEvent};
use tokenlab::util::scan_index;

fn write_old(path: &Path, rows: &[(i64, i64, &str)]) {
    let text: String = rows
        .iter()
        .map(|(i, o, ts)| {
            format!(
                "{}\n",
                serde_json::json!({"model": "gpt-4o", "timestamp": ts, "usage": {"input_tokens": i, "output_tokens": o}})
            )
        })
        .collect();
    std::fs::write(path, text).unwrap();
    let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    f.set_modified(SystemTime::now() - Duration::from_secs(3600)).unwrap();
}

async fn parse(root: &str) -> Vec<UsageEvent> {
    let opts = GenericJsonlOptions::new(AgentId::Copilot);
    let mut v = parse_generic_jsonl(&[root.to_string()], &opts).await.unwrap();
    v.sort_by(|a, b| a.id.cmp(&b.id));
    v
}

async fn parse_with_index(idx: &str, prev: &[UsageEvent], root: &str) -> (Vec<UsageEvent>, (usize, usize, bool)) {
    scan_index::begin_at(idx.to_string(), Arc::new(prev.to_vec()));
    let v = parse(root).await;
    (v, scan_index::finish())
}

#[tokio::test]
async fn skip_unchanged_equals_full_parse() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    std::fs::create_dir_all(&root).unwrap();
    let rootp = root.to_string_lossy().to_string();
    let idx = dir.path().join("scan-index.json").to_string_lossy().to_string();

    write_old(&root.join("a.jsonl"), &[(10, 1, "2026-01-01T00:00:00Z"), (20, 2, "2026-01-01T00:01:00Z")]);
    write_old(&root.join("b.jsonl"), &[(30, 3, "2026-01-02T00:00:00Z")]);
    write_old(&root.join("c.jsonl"), &[(40, 4, "2026-01-03T00:00:00Z")]);

    // Cold scan: everything parsed, index written.
    let (e1, (reused, parsed, saved)) = parse_with_index(&idx, &[], &rootp).await;
    assert_eq!((reused, parsed, saved), (0, 3, true));
    assert_eq!(e1.len(), 4);

    // Warm scan: every file skipped, identical result (prev in a different order).
    let mut prev = e1.clone();
    prev.reverse();
    for e in prev.iter_mut() {
        e.machine_scope = Some("local".into());
    }
    let (e2, (reused, parsed, _)) = parse_with_index(&idx, &prev, &rootp).await;
    assert_eq!((reused, parsed), (3, 0));
    let mut e2s = e2.clone();
    e2s.iter_mut().for_each(|e| e.machine_scope = None);
    assert_eq!(e2s, e1);

    // Changed, deleted and new files.
    write_old(&root.join("b.jsonl"), &[(30, 3, "2026-01-02T00:00:00Z"), (31, 3, "2026-01-02T00:05:00Z")]);
    std::fs::remove_file(root.join("c.jsonl")).unwrap();
    write_old(&root.join("d.jsonl"), &[(50, 5, "2026-01-04T00:00:00Z")]);
    let full = parse(&rootp).await;
    let (e3, (reused, parsed, _)) = parse_with_index(&idx, &e1, &rootp).await;
    assert_eq!((reused, parsed), (1, 2));
    assert_eq!(e3, full);
    assert_eq!(e3.len(), 5);

    // Previous events altered by a later pipeline stage -> re-parse, same result.
    let mut tampered = full.clone();
    tampered[0].estimated_cost = Some(123.0);
    let (e4, (reused, _, _)) = parse_with_index(&idx, &tampered, &rootp).await;
    assert_eq!(reused, 2);
    assert_eq!(e4, full);

    // Missing prev events for an indexed file -> re-parse.
    let (e5, (reused, parsed, _)) = parse_with_index(&idx, &[], &rootp).await;
    assert_eq!((reused, parsed), (0, 3));
    assert_eq!(e5, full);

    // Corrupt index is ignored and rebuilt.
    std::fs::write(&idx, "{ not json").unwrap();
    let (e6, (reused, parsed, saved)) = parse_with_index(&idx, &full, &rootp).await;
    assert_eq!((reused, parsed, saved), (0, 3, true));
    assert_eq!(e6, full);

    // Version-mismatched index is ignored.
    let text = std::fs::read_to_string(&idx).unwrap().replacen("\"parser\":1", "\"parser\":999", 1);
    std::fs::write(&idx, text).unwrap();
    let (e7, (reused, _, _)) = parse_with_index(&idx, &full, &rootp).await;
    assert_eq!(reused, 0);
    assert_eq!(e7, full);

    // Fresh files (mtime within the racy window) are never recorded.
    std::fs::write(
        root.join("fresh.jsonl"),
        "{\"model\":\"gpt-4o\",\"timestamp\":\"2026-01-05T00:00:00Z\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}\n",
    )
    .unwrap();
    let full2 = parse(&rootp).await;
    let (_, (reused, _, _)) = parse_with_index(&idx, &full2, &rootp).await;
    assert_eq!(reused, 3);
    let (_, (reused, parsed, _)) = parse_with_index(&idx, &full2, &rootp).await;
    assert_eq!((reused, parsed), (3, 1));
}
