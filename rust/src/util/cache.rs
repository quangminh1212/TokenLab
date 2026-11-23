//! Per-file parse / event / derived caches keyed by (size, mtimeMs).

use super::fsx::{stamp_file, FileStamp};
use super::js::js_len;
use crate::types::UsageEvent;
use anyhow::Result;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::any::Any;
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::sync::Arc;

/// Small LRU keyed by string: insertion order = recency (oldest first).
struct Lru<V> {
    map: HashMap<String, (V, u64)>,
    order: BTreeMap<u64, String>,
    tick: u64,
}

impl<V> Lru<V> {
    fn new() -> Self {
        Lru { map: HashMap::new(), order: BTreeMap::new(), tick: 0 }
    }
    fn len(&self) -> usize {
        self.map.len()
    }
    fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
    }
    fn peek(&self, k: &str) -> Option<&V> {
        self.map.get(k).map(|(v, _)| v)
    }
    fn touch(&mut self, k: &str) {
        if let Some((_, t)) = self.map.get_mut(k) {
            self.order.remove(t);
            self.tick += 1;
            *t = self.tick;
            self.order.insert(self.tick, k.to_string());
        }
    }
    fn remove(&mut self, k: &str) -> Option<V> {
        let (v, t) = self.map.remove(k)?;
        self.order.remove(&t);
        Some(v)
    }
    fn insert(&mut self, k: String, v: V) -> Option<V> {
        let prev = self.remove(&k);
        self.tick += 1;
        self.order.insert(self.tick, k.clone());
        self.map.insert(k, (v, self.tick));
        prev
    }
    fn pop_oldest(&mut self) -> Option<(String, V)> {
        let (&t, _) = self.order.iter().next()?;
        let k = self.order.remove(&t)?;
        let (v, _) = self.map.remove(&k)?;
        Some((k, v))
    }
}

// ---------------------------------------------------------------------------
// JSONL / JSON row cache
// ---------------------------------------------------------------------------

pub const JSONL_CACHE_MAX_ENTRIES: usize = 4_000;
pub const JSONL_CACHE_MAX_BYTES: usize = 96 * 1024 * 1024;

struct JsonlEntry {
    stamp: FileStamp,
    rows: Arc<Vec<serde_json::Value>>,
    bytes: usize,
}

struct JsonlCache {
    lru: Lru<JsonlEntry>,
    bytes: usize,
    hits: u64,
    misses: u64,
}

static JSONL_CACHE: Lazy<Mutex<JsonlCache>> =
    Lazy::new(|| Mutex::new(JsonlCache { lru: Lru::new(), bytes: 0, hits: 0, misses: 0 }));

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct JsonlCacheStats {
    pub entries: usize,
    pub bytes: usize,
    pub hits: u64,
    pub misses: u64,
}

pub fn jsonl_cache_stats() -> JsonlCacheStats {
    let c = JSONL_CACHE.lock();
    JsonlCacheStats { entries: c.lru.len(), bytes: c.bytes, hits: c.hits, misses: c.misses }
}

pub(crate) fn jsonl_cache_lookup(file: &str, stamp: &FileStamp) -> Option<Arc<Vec<serde_json::Value>>> {
    let mut c = JSONL_CACHE.lock();
    let hit = match c.lru.peek(file) {
        Some(e) if e.stamp.size == stamp.size && e.stamp.mtime_ms == stamp.mtime_ms => Some(e.rows.clone()),
        _ => None,
    };
    if hit.is_some() {
        c.hits += 1;
        c.lru.touch(file);
    }
    hit
}

pub(crate) fn jsonl_cache_miss() {
    JSONL_CACHE.lock().misses += 1;
}

pub(crate) fn jsonl_cache_store(file: &str, stamp: FileStamp, rows: Arc<Vec<serde_json::Value>>, text_len: usize) {
    let mut c = JSONL_CACHE.lock();
    if let Some(prev) = c.lru.insert(file.to_string(), JsonlEntry { stamp, rows, bytes: text_len }) {
        c.bytes = c.bytes.saturating_sub(prev.bytes);
    }
    c.bytes += text_len;
    while c.lru.len() > JSONL_CACHE_MAX_ENTRIES || c.bytes > JSONL_CACHE_MAX_BYTES {
        match c.lru.pop_oldest() {
            Some((_, e)) => c.bytes = c.bytes.saturating_sub(e.bytes),
            None => break,
        }
    }
}

// ---------------------------------------------------------------------------
// Event cache
// ---------------------------------------------------------------------------

pub const EVENT_CACHE_MAX_ENTRIES: usize = 900_000;
const EVENT_BYTES_ESTIMATE: usize = 420;

struct EventEntry {
    stamp: FileStamp,
    events: Arc<Vec<UsageEvent>>,
    signature: Option<String>,
}

struct EventCache {
    lru: Lru<EventEntry>,
    count: usize,
    bytes: usize,
    hits: u64,
    misses: u64,
}

static EVENT_CACHE: Lazy<Mutex<EventCache>> =
    Lazy::new(|| Mutex::new(EventCache { lru: Lru::new(), count: 0, bytes: 0, hits: 0, misses: 0 }));

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct EventCacheStats {
    pub files: usize,
    pub events: usize,
    pub bytes: usize,
    pub hits: u64,
    pub misses: u64,
}

pub fn event_cache_stats() -> EventCacheStats {
    let c = EVENT_CACHE.lock();
    EventCacheStats { files: c.lru.len(), events: c.count, bytes: c.bytes, hits: c.hits, misses: c.misses }
}

pub fn clear_jsonl_cache() {
    {
        let mut c = JSONL_CACHE.lock();
        c.lru.clear();
        c.bytes = 0;
        c.hits = 0;
        c.misses = 0;
    }
    let mut e = EVENT_CACHE.lock();
    e.lru.clear();
    e.count = 0;
    e.bytes = 0;
    e.hits = 0;
    e.misses = 0;
}

fn event_store(c: &mut EventCache, file: &str, entry: EventEntry) {
    let n = entry.events.len();
    if let Some(prev) = c.lru.insert(file.to_string(), entry) {
        c.count = c.count.saturating_sub(prev.events.len());
        c.bytes = c.bytes.saturating_sub(prev.events.len() * EVENT_BYTES_ESTIMATE);
    }
    c.count += n;
    c.bytes += n * EVENT_BYTES_ESTIMATE;
    while c.count > EVENT_CACHE_MAX_ENTRIES && c.lru.len() > 1 {
        match c.lru.pop_oldest() {
            Some((_, e)) => {
                c.count = c.count.saturating_sub(e.events.len());
                c.bytes = c.bytes.saturating_sub(e.events.len() * EVENT_BYTES_ESTIMATE);
            }
            None => break,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct EventCacheOpts {
    pub max_bytes: Option<u64>,
    pub signature: Option<String>,
}

/// Return cached events for `file` when its stamp is unchanged, otherwise call
/// `produce` and memoize the result. With `opts.signature` the stat is skipped
/// and the caller-managed signature decides freshness.
pub async fn cached_events_for_file<F, Fut>(file: &str, produce: F, opts: EventCacheOpts) -> Result<Vec<UsageEvent>>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Vec<UsageEvent>>>,
{
    if let Some(signature) = opts.signature.clone() {
        {
            let mut c = EVENT_CACHE.lock();
            let hit = match c.lru.peek(file) {
                Some(e) if e.signature.as_deref() == Some(signature.as_str()) => Some(e.events.clone()),
                _ => None,
            };
            if let Some(ev) = hit {
                c.hits += 1;
                c.lru.touch(file);
                return Ok((*ev).clone());
            }
            c.misses += 1;
        }
        let events = produce().await?;
        let mut c = EVENT_CACHE.lock();
        event_store(
            &mut c,
            file,
            EventEntry {
                stamp: FileStamp { size: 0, mtime_ms: 0.0 },
                events: Arc::new(events.clone()),
                signature: Some(signature),
            },
        );
        return Ok(events);
    }

    let stamp = match stamp_file(file).await {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };
    if let Some(max) = opts.max_bytes {
        if stamp.size > max {
            EVENT_CACHE.lock().misses += 1;
            return produce().await;
        }
    }
    {
        let mut c = EVENT_CACHE.lock();
        let hit = match c.lru.peek(file) {
            Some(e) if e.stamp.size == stamp.size && e.stamp.mtime_ms == stamp.mtime_ms && e.signature.is_none() => {
                Some(e.events.clone())
            }
            _ => None,
        };
        if let Some(ev) = hit {
            c.hits += 1;
            c.lru.touch(file);
            return Ok((*ev).clone());
        }
        c.misses += 1;
    }
    let events = produce().await?;
    let mut c = EVENT_CACHE.lock();
    event_store(&mut c, file, EventEntry { stamp, events: Arc::new(events.clone()), signature: None });
    Ok(events)
}

// ---------------------------------------------------------------------------
// Derived (candidate) cache
// ---------------------------------------------------------------------------

const DERIVED_CACHE_MAX_BYTES: usize = 256 * 1024 * 1024;

struct DerivedEntry {
    stamp: FileStamp,
    value: Arc<dyn Any + Send + Sync>,
    size: usize,
}

struct DerivedCache {
    lru: Lru<DerivedEntry>,
    bytes: usize,
}

static DERIVED_CACHE: Lazy<Mutex<DerivedCache>> = Lazy::new(|| Mutex::new(DerivedCache { lru: Lru::new(), bytes: 0 }));

#[derive(Default)]
pub struct CandidateOpts<T> {
    pub max_bytes: Option<u64>,
    pub estimate_bytes: Option<fn(&T) -> usize>,
}

/// Generic per-file memo of an arbitrary derived list, keyed by the file stamp.
/// Callers must treat the returned list as read-only (later hits share it).
pub async fn cached_candidates_for_file<T, F, Fut>(
    file: &str,
    produce: F,
    opts: CandidateOpts<T>,
) -> Result<Arc<Vec<T>>>
where
    T: Send + Sync + 'static,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Vec<T>>>,
{
    let stamp = match stamp_file(file).await {
        Some(s) => s,
        None => return Ok(Arc::new(Vec::new())),
    };
    if let Some(max) = opts.max_bytes {
        if stamp.size > max {
            return Ok(Arc::new(produce().await?));
        }
    }
    {
        let mut ec = EVENT_CACHE.lock();
        let mut dc = DERIVED_CACHE.lock();
        let hit = match dc.lru.peek(file) {
            Some(e) if e.stamp.size == stamp.size && e.stamp.mtime_ms == stamp.mtime_ms => {
                e.value.clone().downcast::<Vec<T>>().ok()
            }
            _ => None,
        };
        if let Some(v) = hit {
            ec.hits += 1;
            dc.lru.touch(file);
            return Ok(v);
        }
        ec.misses += 1;
    }
    let value = Arc::new(produce().await?);
    let size = match opts.estimate_bytes {
        Some(f) => value.iter().map(f).sum(),
        None => value.len() * EVENT_BYTES_ESTIMATE,
    };
    let mut dc = DERIVED_CACHE.lock();
    if let Some(prev) = dc.lru.insert(
        file.to_string(),
        DerivedEntry { stamp, value: value.clone() as Arc<dyn Any + Send + Sync>, size },
    ) {
        dc.bytes = dc.bytes.saturating_sub(prev.size);
    }
    dc.bytes += size;
    while dc.bytes > DERIVED_CACHE_MAX_BYTES && dc.lru.len() > 1 {
        match dc.lru.pop_oldest() {
            Some((_, e)) => dc.bytes = dc.bytes.saturating_sub(e.size),
            None => break,
        }
    }
    Ok(value)
}

#[allow(dead_code)]
fn _len_used(s: &str) -> usize {
    js_len(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lru_orders_by_recency() {
        let mut l: Lru<i32> = Lru::new();
        l.insert("a".into(), 1);
        l.insert("b".into(), 2);
        l.touch("a");
        assert_eq!(l.pop_oldest().unwrap().0, "b");
        assert_eq!(l.pop_oldest().unwrap().0, "a");
        assert!(l.pop_oldest().is_none());
    }

    #[tokio::test]
    async fn event_cache_hits_on_same_stamp() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("x.jsonl");
        std::fs::write(&f, "{}").unwrap();
        let path = f.to_string_lossy().to_string();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        for _ in 0..2 {
            let c = calls.clone();
            let ev = cached_events_for_file(
                &path,
                || async move {
                    c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(vec![UsageEvent::default()])
                },
                EventCacheOpts::default(),
            )
            .await
            .unwrap();
            assert_eq!(ev.len(), 1);
        }
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        // missing file -> empty without producing
        let ev = cached_events_for_file(
            "/no/such/file",
            || async { Ok(vec![UsageEvent::default()]) },
            EventCacheOpts::default(),
        )
        .await
        .unwrap();
        assert!(ev.is_empty());
    }

    #[tokio::test]
    async fn candidates_cache_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("c.txt");
        std::fs::write(&f, "abc").unwrap();
        let path = f.to_string_lossy().to_string();
        let a = cached_candidates_for_file(&path, || async { Ok(vec![1u32, 2, 3]) }, CandidateOpts::default())
            .await
            .unwrap();
        let b = cached_candidates_for_file::<u32, _, _>(
            &path,
            || async { Ok(vec![9u32]) },
            CandidateOpts::default(),
        )
        .await
        .unwrap();
        assert_eq!(*a, vec![1, 2, 3]);
        assert_eq!(*b, vec![1, 2, 3]);
    }
}
