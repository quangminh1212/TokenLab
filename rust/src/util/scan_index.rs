//! Persistent per-file scan fingerprint index.
//!
//! A full scan re-reads every agent log on disk. Most files never change
//! between scans, so the index remembers, per `(agent, source file)`, the
//! file's `(size, mtime)` and a strict digest of the events the parser
//! produced for it. On the next full scan a file whose fingerprint is
//! unchanged is not read at all: its events are taken from the previous scan
//! result instead, but only when those events are *provably identical* to
//! what the parser originally produced (digest equality). Anything else is
//! re-parsed, so the result is always the same as a full re-parse.
//!
//! Safety rules, all of which fall back to a normal parse:
//! - index missing, corrupt, or written by another app/parser/pricing version;
//! - file stamp changed, or the stamp is "racy" (modified within 3s of the scan);
//! - the previous events for the file were changed by later pipeline stages
//!   (collapse, prune, high-water merge, ...): digest mismatch;
//! - the parser output depends on the wall clock (an event timestamp falls in
//!   the produce window), the file changed while parsing, or it yielded no
//!   events: nothing is recorded;
//! - the pricing inputs changed during the scan: the index is not persisted.
//!
//! Only agents whose per-file events are a pure function of the file contents
//! and its stamp call [`events_for_file`]; cross-file agents (SQLite, router
//! rollups, Claude Code request dedupe, OpenClaw/Hermes, Grok residuals) never
//! do and therefore always re-parse.

use crate::types::{AgentId, UsageEvent};
use crate::util::{now_ms, stamp_file_sync};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::io::Write;
use std::sync::Arc;

/// Bump when the on-disk layout changes.
pub const INDEX_FORMAT: u32 = 1;
/// Bump whenever any hooked parser changes what it emits for a given file.
pub const PARSER_VERSION: u32 = 1;
/// Files modified this recently are never recorded (mtime granularity race).
const RACY_MS: f64 = 3_000.0;
/// Slack around the produce window when detecting wall-clock timestamps.
const NOW_SLACK_MS: f64 = 2_000.0;

// ---------------------------------------------------------------------------
// Stable hashing (process- and version-independent, unlike DefaultHasher)
// ---------------------------------------------------------------------------

struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
    fn bytes(&mut self, b: &[u8]) {
        for &x in b {
            self.0 ^= x as u64;
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
        // field separator so ("ab","c") != ("a","bc")
        self.0 ^= 0xff;
        self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
    }
    fn str(&mut self, s: &str) {
        self.bytes(s.as_bytes());
    }
    fn opt_str(&mut self, s: Option<&str>) {
        match s {
            Some(v) => {
                self.bytes(&[1]);
                self.str(v);
            }
            None => self.bytes(&[0]),
        }
    }
    fn f64(&mut self, v: f64) {
        self.bytes(&v.to_bits().to_le_bytes());
    }
    fn opt_f64(&mut self, v: Option<f64>) {
        match v {
            Some(x) => {
                self.bytes(&[1]);
                self.f64(x);
            }
            None => self.bytes(&[0]),
        }
    }
    fn opt_bool(&mut self, v: Option<bool>) {
        self.bytes(&[match v {
            None => 0,
            Some(false) => 1,
            Some(true) => 2,
        }]);
    }
}

impl Write for Fnv {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        for &x in buf {
            self.0 ^= x as u64;
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn mix(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// Order-independent digest of a set of events: `(count, sum, xor-of-mixed)`.
/// Covers every field except `machine_scope`, which the scan pipeline applies
/// after the parser and which a reuse resets.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Digest {
    pub n: u32,
    pub a: u64,
    pub b: u64,
}

impl Digest {
    pub fn add(&mut self, e: &UsageEvent) {
        let mut h = Fnv::new();
        e.id.with_str(|s| h.str(s));
        h.str(e.agent.as_str());
        h.opt_str(e.model.as_deref());
        e.timestamp.with_str(|s| h.str(s));
        h.f64(e.input_tokens);
        h.f64(e.output_tokens);
        h.f64(e.cache_read_tokens);
        h.f64(e.cache_write_tokens);
        h.f64(e.total_tokens);
        h.opt_f64(e.estimated_cost);
        h.str(&e.currency);
        h.bytes(&[e.pricing_status as u8]);
        h.opt_str(e.workspace.as_deref());
        h.str(&e.source_path);
        h.opt_bool(e.estimated);
        h.opt_bool(e.cache_reported);
        h.opt_f64(e.request_count);
        h.opt_bool(e.cost_parity_gap);
        let v = h.0;
        self.n = self.n.wrapping_add(1);
        self.a = self.a.wrapping_add(v);
        self.b ^= mix(v);
    }
}

pub fn digest_of<'a>(events: impl IntoIterator<Item = &'a UsageEvent>) -> Digest {
    let mut d = Digest::default();
    for e in events {
        d.add(e);
    }
    d
}

/// Everything that can change an event's price: rate-table version, the
/// user's pricing config and the OpenRouter catalog content (not its fetch
/// time).
pub fn pricing_signature() -> String {
    let mut h = Fnv::new();
    h.str(&format!("{:?}", crate::pricing::RATES_VERSION));
    let cfg = crate::config::get_config_sync();
    let _ = serde_json::to_writer(&mut h, &cfg.pricing);
    h.bytes(&[0]);
    if let Some(or) = crate::openrouter_models::open_router_models_arc() {
        let _ = serde_json::to_writer(&mut h, &or.models);
    }
    format!("{:016x}", h.0)
}

// ---------------------------------------------------------------------------
// Index file
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct Entry {
    size: u64,
    /// mtime in microseconds since the epoch.
    mtime_us: i64,
    d: Digest,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct IndexFile {
    format: u32,
    app: String,
    parser: u32,
    pricing: String,
    /// agent -> file -> entry
    agents: BTreeMap<String, BTreeMap<String, Entry>>,
}

fn mtime_us(ms: f64) -> i64 {
    (ms * 1000.0).round() as i64
}

/// Index file location in the data directory.
pub fn index_path() -> String {
    crate::util::pjoin(&[crate::backup::data_root().as_str(), "scan-index.json"])
}

fn load_file(path: &str, pricing: &str) -> IndexFile {
    let f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return IndexFile::default(),
    };
    match serde_json::from_reader::<_, IndexFile>(std::io::BufReader::new(f)) {
        Ok(ix)
            if ix.format == INDEX_FORMAT
                && ix.parser == PARSER_VERSION
                && ix.app == env!("CARGO_PKG_VERSION")
                && ix.pricing == pricing =>
        {
            ix
        }
        _ => IndexFile::default(),
    }
}

// ---------------------------------------------------------------------------
// Scan session
// ---------------------------------------------------------------------------

type GroupKey = u64;

fn group_key(agent: &str, file: &str) -> GroupKey {
    let mut h = Fnv::new();
    h.str(agent);
    h.str(file);
    h.0
}

pub struct Session {
    path: String,
    pricing: String,
    old: HashMap<(String, String), Entry>,
    prev: Arc<Vec<UsageEvent>>,
    /// Indices into `prev` per `(agent, source_path)`, only for indexed files.
    groups: HashMap<GroupKey, Vec<u32>>,
    new: Mutex<BTreeMap<String, BTreeMap<String, Entry>>>,
    reused: std::sync::atomic::AtomicUsize,
    parsed: std::sync::atomic::AtomicUsize,
}

static ACTIVE: RwLock<Option<Arc<Session>>> = RwLock::new(None);

fn active() -> Option<Arc<Session>> {
    ACTIVE.read().clone()
}

impl Session {
    fn build(path: String, prev: Arc<Vec<UsageEvent>>) -> Session {
        let pricing = pricing_signature();
        let file = load_file(&path, &pricing);
        let mut old: HashMap<(String, String), Entry> = HashMap::new();
        let mut wanted: HashSet<GroupKey> = HashSet::new();
        for (agent, files) in file.agents {
            for (f, e) in files {
                wanted.insert(group_key(&agent, &f));
                old.insert((agent.clone(), f), e);
            }
        }
        let mut groups: HashMap<GroupKey, Vec<u32>> = HashMap::new();
        if !old.is_empty() {
            for (i, e) in prev.iter().enumerate() {
                let k = group_key(e.agent.as_str(), &e.source_path);
                if wanted.contains(&k) {
                    groups.entry(k).or_default().push(i as u32);
                }
            }
        }
        Session {
            path,
            pricing,
            old,
            prev,
            groups,
            new: Mutex::new(BTreeMap::new()),
            reused: Default::default(),
            parsed: Default::default(),
        }
    }

    /// Previous events for `(agent, file)` when they are provably what the
    /// parser emitted for the unchanged file.
    fn reuse(&self, agent: &str, file: &str, st: &crate::util::FileStamp) -> Option<Vec<UsageEvent>> {
        let e = self.old.get(&(agent.to_string(), file.to_string()))?;
        if e.size != st.size || e.mtime_us != mtime_us(st.mtime_ms) || e.d.n == 0 {
            return None;
        }
        let idx = self.groups.get(&group_key(agent, file))?;
        if idx.len() != e.d.n as usize {
            return None;
        }
        let mut d = Digest::default();
        for &i in idx {
            d.add(&self.prev[i as usize]);
        }
        if d != e.d {
            return None;
        }
        Some(
            idx.iter()
                .map(|&i| {
                    let mut ev = self.prev[i as usize].clone();
                    ev.machine_scope = None;
                    ev
                })
                .collect(),
        )
    }

    fn record(&self, agent: &str, file: &str, st: &crate::util::FileStamp, d: Digest) {
        self.new
            .lock()
            .entry(agent.to_string())
            .or_default()
            .insert(file.to_string(), Entry { size: st.size, mtime_us: mtime_us(st.mtime_ms), d });
    }
}

/// Start a full-scan session using the data-dir index. `prev` is the event
/// list as it stood before the scan.
pub fn begin(prev: Arc<Vec<UsageEvent>>) {
    begin_at(index_path(), prev);
}

/// [`begin`] with an explicit index path (tests).
pub fn begin_at(path: String, prev: Arc<Vec<UsageEvent>>) {
    let s = Arc::new(Session::build(path, prev));
    *ACTIVE.write() = Some(s);
}

/// Drop the active session without persisting.
pub fn abort() {
    *ACTIVE.write() = None;
}

/// `(reused, parsed)` file counts for the active session.
pub fn stats() -> (usize, usize) {
    match active() {
        Some(s) => (
            s.reused.load(std::sync::atomic::Ordering::Relaxed),
            s.parsed.load(std::sync::atomic::Ordering::Relaxed),
        ),
        None => (0, 0),
    }
}

/// End the session and persist the index, unless the pricing inputs changed
/// while the scan ran (events may then carry mixed prices). Returns
/// `(reused, parsed, saved)`.
pub fn finish() -> (usize, usize, bool) {
    let s = match ACTIVE.write().take() {
        Some(s) => s,
        None => return (0, 0, false),
    };
    let reused = s.reused.load(std::sync::atomic::Ordering::Relaxed);
    let parsed = s.parsed.load(std::sync::atomic::Ordering::Relaxed);
    if pricing_signature() != s.pricing {
        return (reused, parsed, false);
    }
    let file = IndexFile {
        format: INDEX_FORMAT,
        parser: PARSER_VERSION,
        app: env!("CARGO_PKG_VERSION").to_string(),
        pricing: s.pricing.clone(),
        agents: std::mem::take(&mut *s.new.lock()),
    };
    (reused, parsed, save_file(&s.path, &file))
}

fn save_file(path: &str, file: &IndexFile) -> bool {
    let tmp = format!("{path}.tmp");
    let ok = (|| -> std::io::Result<()> {
        if let Some(dir) = std::path::Path::new(path).parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut w = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
        serde_json::to_writer(&mut w, file).map_err(std::io::Error::other)?;
        w.flush()?;
        drop(w);
        std::fs::rename(&tmp, path)
    })()
    .is_ok();
    if !ok {
        let _ = std::fs::remove_file(&tmp);
    }
    ok
}

/// Per-file events for a hooked agent: from the previous scan when the file is
/// unchanged and provably identical, otherwise from `produce`. Without an
/// active session this is exactly `produce()`.
pub async fn events_for_file<F, Fut>(agent: AgentId, file: &str, produce: F) -> anyhow::Result<Vec<UsageEvent>>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = anyhow::Result<Vec<UsageEvent>>>,
{
    let session = match active() {
        Some(s) => s,
        None => return produce().await,
    };
    let before = match stamp_file_sync(file) {
        Some(st) => st,
        None => return produce().await,
    };
    let agent_s = agent.as_str();
    if let Some(events) = session.reuse(agent_s, file, &before) {
        session.record(agent_s, file, &before, digest_of(events.iter()));
        session.reused.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        return Ok(events);
    }
    session.parsed.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let t0 = now_ms();
    let events = produce().await?;
    let t1 = now_ms();
    if events.is_empty() || t0 - before.mtime_ms < RACY_MS {
        return Ok(events);
    }
    // The file must not have changed while it was parsed.
    match stamp_file_sync(file) {
        Some(after) if after == before => {}
        _ => return Ok(events),
    }
    // Only plain per-file rows are recordable.
    if events.iter().any(|e| e.agent != agent || &*e.source_path != file) {
        return Ok(events);
    }
    // Wall-clock fallback timestamps make the output non-reproducible.
    let (lo, hi) = (t0 - NOW_SLACK_MS, t1 + NOW_SLACK_MS);
    if events.iter().any(|e| {
        let t = e.timestamp.js_ms();
        t >= lo && t <= hi
    }) {
        return Ok(events);
    }
    session.record(agent_s, file, &before, digest_of(events.iter()));
    Ok(events)
}
