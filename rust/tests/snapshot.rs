//! Binary boot snapshot (`scan-cache.snap`): codec round trip, corruption
//! handling and equivalence with the JSON load path.

use std::ffi::OsString;
use std::sync::Mutex;
use tokenlab::backup::*;
use tokenlab::config::reset_config_cache;
use tokenlab::types::{AgentId, EventId, IStr, PricingStatus, Ts, UsageEvent};
use tokenlab::util::snapshot::{self, SnapError, SourceStamp};

static ENV_LOCK: Mutex<()> = Mutex::new(());
const ENV_KEYS: [&str; 4] = ["XLAB_TOKEN_DATA_DIR", "TOKENLAB_DATA_DIR", "TOKENLAB_CONFIG", "TOKENLAB_NO_SNAPSHOT"];

struct Fixture {
    _dir: tempfile::TempDir,
    saved: Vec<(&'static str, Option<OsString>)>,
    _guard: std::sync::MutexGuard<'static, ()>,
}

impl Fixture {
    fn new() -> Fixture {
        let guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let saved = ENV_KEYS.iter().map(|k| (*k, std::env::var_os(k))).collect();
        let dir = tempfile::Builder::new().prefix("tokenlab-snap-").tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::env::remove_var("TOKENLAB_DATA_DIR");
        std::env::remove_var("TOKENLAB_NO_SNAPSHOT");
        std::env::set_var("XLAB_TOKEN_DATA_DIR", &data);
        std::env::set_var("TOKENLAB_CONFIG", dir.path().join("config.json"));
        reset_config_cache();
        Fixture { _dir: dir, saved, _guard: guard }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        reset_config_cache();
        for (k, v) in &self.saved {
            match v {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
        reset_config_cache();
    }
}

fn sample(n: usize) -> Vec<UsageEvent> {
    let mut v = Vec::new();
    for i in 0..n {
        let mut e = UsageEvent {
            id: EventId::new(&format!("{:024x}", 0xabcdef0123u64 + i as u64 * 7919)),
            agent: AgentId::ALL[i % AgentId::ALL.len()],
            model: if i % 3 == 0 { None } else { Some(IStr::new(&format!("model-{}", i % 5))) },
            timestamp: Ts::new(&format!("2026-07-{:02}T10:{:02}:{:02}.{:03}Z", 1 + i % 28, i % 60, (i * 7) % 60, i % 1000)),
            input_tokens: (i * 13) as f64,
            output_tokens: (i % 7) as f64,
            cache_read_tokens: if i % 4 == 0 { 123456789012.0 } else { 0.0 },
            cache_write_tokens: 0.5 * (i % 3) as f64,
            total_tokens: 0.0,
            estimated_cost: if i % 5 == 0 { None } else { Some(i as f64 * 0.000123) },
            currency: IStr::new("USD"),
            pricing_status: [PricingStatus::Priced, PricingStatus::UnknownModel, PricingStatus::ZeroRate, PricingStatus::Estimated][i % 4],
            workspace: if i % 2 == 0 { Some(IStr::new("C--Dev-Demo")) } else { None },
            source_path: IStr::new(&format!("C:/x/{}.jsonl", i % 11)),
            estimated: [None, Some(false), Some(true)][i % 3],
            cache_reported: if i % 6 == 0 { Some(true) } else { None },
            machine_scope: if i % 9 == 0 { Some(IStr::new("pc-1")) } else { None },
            request_count: if i % 8 == 0 { Some((i % 5 + 1) as f64) } else { None },
            cost_parity_gap: if i % 10 == 0 { Some(true) } else { None },
        };
        e.total_tokens = e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_write_tokens;
        match i % 13 {
            1 => e.id = EventId::new("not-a-hex-id-:-raw"),
            2 => e.id = EventId::Empty,
            3 => e.timestamp = Ts::new("2026-07-01T00:00:05Z"),
            4 => e.timestamp = Ts::new("garbage ts"),
            5 => e.timestamp = Ts::Empty,
            6 => e.input_tokens = 1.0e17,
            7 => e.output_tokens = -3.0,
            _ => {}
        }
        v.push(e);
    }
    v
}

fn write_snap(dir: &std::path::Path, events: &[UsageEvent]) -> (std::path::PathBuf, std::path::PathBuf, SourceStamp) {
    let src = dir.join("src.json");
    std::fs::write(&src, b"[{\"hello\":\"world\"}]").unwrap();
    let stamp = snapshot::stamp_of(&src).unwrap();
    let snap = dir.join("x.snap");
    let info = snapshot::write_body(std::fs::File::create(&snap).unwrap(), events).unwrap();
    snapshot::finalize_header(&snap, &info, &stamp).unwrap();
    (src, snap, stamp)
}

#[test]
fn agent_ids_fit_one_byte() {
    assert!(AgentId::ALL.len() < 256);
    for (i, a) in AgentId::ALL.iter().enumerate() {
        assert_eq!(*a as usize, i, "enum discriminant must equal ALL index");
    }
}

#[test]
fn round_trip_exact() {
    let dir = tempfile::tempdir().unwrap();
    let events = sample(5000);
    let (src, snap, _) = write_snap(dir.path(), &events);
    let back = snapshot::load(&snap, &src).unwrap();
    assert_eq!(back.len(), events.len());
    for (a, b) in events.iter().zip(back.iter()) {
        assert_eq!(a, b);
    }
    // Same shared allocations for interned strings.
    assert!(back[1].source_path == back[12].source_path);
}

#[test]
fn round_trip_empty_and_nonfinite() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = sample(1).remove(0);
    e.input_tokens = f64::NAN;
    e.output_tokens = f64::INFINITY;
    e.cache_read_tokens = -0.0;
    e.estimated_cost = Some(f64::NAN);
    e.request_count = Some(f64::INFINITY);
    let (src, snap, _) = write_snap(dir.path(), &[e]);
    let back = snapshot::load(&snap, &src).unwrap();
    // Same as a JSON round trip: non-finite -> 0 / None.
    assert_eq!(back[0].input_tokens, 0.0);
    assert_eq!(back[0].output_tokens, 0.0);
    assert!(back[0].cache_read_tokens.is_sign_positive());
    assert_eq!(back[0].estimated_cost, None);
    assert_eq!(back[0].request_count, None);
    let (src2, snap2, _) = write_snap(dir.path(), &[]);
    assert!(snapshot::load(&snap2, &src2).unwrap().is_empty());
}

#[test]
fn truncation_is_rejected_never_panics() {
    let dir = tempfile::tempdir().unwrap();
    let events = sample(300);
    let (src, snap, stamp) = write_snap(dir.path(), &events);
    let bytes = std::fs::read(&snap).unwrap();
    assert!(snapshot::decode(&bytes, &stamp).is_ok());
    let _ = src;
    for cut in (0..bytes.len()).step_by(37).chain([bytes.len() - 1, snapshot::HEADER_LEN, snapshot::HEADER_LEN + 1]) {
        assert!(snapshot::decode(&bytes[..cut], &stamp).is_err(), "cut at {cut} must fail");
    }
    let mut longer = bytes.clone();
    longer.push(0);
    assert!(snapshot::decode(&longer, &stamp).is_err());
}

#[test]
fn flipped_bytes_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let events = sample(300);
    let (_src, snap, stamp) = write_snap(dir.path(), &events);
    let bytes = std::fs::read(&snap).unwrap();
    let positions = (0..snapshot::HEADER_LEN).chain((snapshot::HEADER_LEN..bytes.len()).step_by(11));
    for pos in positions {
        for mask in [0x01u8, 0x80, 0xff] {
            let mut b = bytes.clone();
            b[pos] ^= mask;
            assert!(snapshot::decode(&b, &stamp).is_err(), "flip at {pos} mask {mask:#x} must fail");
        }
    }
}

#[test]
fn wrong_version_and_stale_source_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let events = sample(50);
    let (src, snap, stamp) = write_snap(dir.path(), &events);
    let bytes = std::fs::read(&snap).unwrap();

    // Wrong format version with a *valid* header CRC: must still be refused.
    for off in [8usize, 12, 16] {
        let mut b = bytes.clone();
        b[off] = b[off].wrapping_add(1);
        let c = snapshot::crc32(&b[..snapshot::HEADER_LEN - 4]);
        b[snapshot::HEADER_LEN - 4..snapshot::HEADER_LEN].copy_from_slice(&c.to_le_bytes());
        match snapshot::decode(&b, &stamp) {
            Err(SnapError::Invalid(m)) => assert_eq!(m, "version mismatch"),
            other => panic!("expected version mismatch, got {other:?}"),
        }
    }

    // Source changed (size / content / mtime) -> stale.
    std::fs::write(&src, b"[{\"hello\":\"world!\"}]").unwrap();
    assert!(snapshot::load(&snap, &src).is_err());
    let s2 = SourceStamp { mtime_ns: stamp.mtime_ns + 1, ..stamp };
    assert!(snapshot::decode(&bytes, &s2).is_err());
    let s3 = SourceStamp { edge: stamp.edge ^ 1, ..stamp };
    assert!(snapshot::decode(&bytes, &s3).is_err());
}

#[test]
fn implausible_counts_do_not_allocate() {
    // Valid CRCs but a huge claimed event count must be refused, not allocated.
    let dir = tempfile::tempdir().unwrap();
    let (_src, snap, stamp) = write_snap(dir.path(), &sample(10));
    let mut b = std::fs::read(&snap).unwrap();
    b[48..56].copy_from_slice(&(u64::MAX / 2).to_le_bytes());
    let c = snapshot::crc32(&b[..snapshot::HEADER_LEN - 4]);
    b[snapshot::HEADER_LEN - 4..snapshot::HEADER_LEN].copy_from_slice(&c.to_le_bytes());
    assert!(snapshot::decode(&b, &stamp).is_err());
}

#[tokio::test]
async fn snapshot_load_equals_json_load() {
    let fx = Fixture::new();
    let events = sample(3000);
    save_scan_cache(&events, SaveScanCacheOpts { mode: SaveMode::Full }).await.unwrap();
    let snap = std::path::PathBuf::from(scan_cache_snapshot_path());
    assert!(snap.exists(), "full save must publish a snapshot");
    let main = std::path::PathBuf::from(scan_cache_path());
    assert!(snapshot::load(&snap, &main).is_ok());

    let via_snap = load_scan_cache_main_only().await;
    std::env::set_var("TOKENLAB_NO_SNAPSHOT", "1");
    let via_json = load_scan_cache_main_only().await;
    std::env::remove_var("TOKENLAB_NO_SNAPSHOT");
    assert!(!via_json.is_empty());
    assert_eq!(via_snap.len(), via_json.len());
    assert!(via_snap == via_json, "snapshot load must equal JSON load");

    // Corrupt snapshot: silently falls back to JSON, same result.
    let mut bytes = std::fs::read(&snap).unwrap();
    let mid = bytes.len() / 2;
    bytes[mid] ^= 0xff;
    std::fs::write(&snap, &bytes).unwrap();
    assert!(load_scan_cache_main_only().await == via_json);
    // Truncated snapshot too.
    std::fs::write(&snap, &bytes[..bytes.len() / 3]).unwrap();
    assert!(load_scan_cache_main_only().await == via_json);
    // Garbage / empty snapshot.
    std::fs::write(&snap, b"").unwrap();
    assert!(load_scan_cache_main_only().await == via_json);
    drop(fx);
}

#[tokio::test]
async fn stale_snapshot_after_main_rewrite_is_ignored() {
    let _fx = Fixture::new();
    save_scan_cache(&sample(500), SaveScanCacheOpts { mode: SaveMode::Full }).await.unwrap();
    let snap = std::path::PathBuf::from(scan_cache_snapshot_path());
    let old_snap = std::fs::read(&snap).unwrap();

    // A newer save rewrites main + snapshot; restoring the OLD snapshot over it
    // must be detected as stale and the JSON result must win.
    let mut more = sample(700);
    more.truncate(700);
    save_scan_cache(&more, SaveScanCacheOpts { mode: SaveMode::Full }).await.unwrap();
    let fresh = load_scan_cache_main_only().await;
    std::fs::write(&snap, &old_snap).unwrap();
    let after = load_scan_cache_main_only().await;
    assert!(after == fresh);
    assert_eq!(after.len(), fresh.len());
    assert!(snapshot::load(&snap, std::path::Path::new(&scan_cache_path())).is_err());

    // Quick save also refreshes it.
    save_scan_cache(&sample(710), SaveScanCacheOpts { mode: SaveMode::Quick }).await.unwrap();
    assert!(snapshot::load(&snap, std::path::Path::new(&scan_cache_path())).is_ok());
}

/// Read-only check against a real data dir:
/// `TOKENLAB_REAL_DATA_DIR=<dir> cargo test --release --test snapshot real_data -- --ignored --nocapture`
#[tokio::test]
#[ignore]
async fn real_data_snapshot_equals_json_load() {
    let Some(dir) = std::env::var_os("TOKENLAB_REAL_DATA_DIR") else { return };
    let _fx = Fixture::new();
    std::env::set_var("XLAB_TOKEN_DATA_DIR", &dir);
    let t = std::time::Instant::now();
    let via_snap = load_scan_cache_main_only().await;
    let t_snap = t.elapsed();
    std::env::set_var("TOKENLAB_NO_SNAPSHOT", "1");
    let t = std::time::Instant::now();
    let via_json = load_scan_cache_main_only().await;
    let t_json = t.elapsed();
    std::env::remove_var("TOKENLAB_NO_SNAPSHOT");
    println!("snapshot {} events in {t_snap:?}; json {} events in {t_json:?}", via_snap.len(), via_json.len());
    assert!(!via_json.is_empty());
    assert_eq!(via_snap.len(), via_json.len());
    for (i, (a, b)) in via_snap.iter().zip(via_json.iter()).enumerate() {
        assert_eq!(a, b, "event {i} differs");
    }
}
