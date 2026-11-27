//! Agent: OpenAI Codex (port of `src/agents/codex/index.ts`).
//!
//! Deep Codex support: rollout JSONL trees, state SQLite threads, token_count /
//! token_usage_record rows, content estimates and a persisted light-scan index.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use anyhow::Result;
use indexmap::IndexMap;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::Value;

use crate::agents::shared::env::{path_env, unique};
use crate::agents::shared::usage_fields::{
    extract_model, extract_model_strs, extract_timestamp, extract_token_buckets,
};
use crate::agents::{parse_fn, AgentModule};
use crate::pricing::apply_pricing;
use crate::types::{AgentId, UsageEvent};
use crate::util::{
    app_data_dir, cached_events_for_file, env_nonempty, host_platform, js_date_parse, js_len, js_num_to_string,
    js_number_from_str, js_round, js_trim, local_parts, now_ms, path_exists, read_jsonl_cached, read_text,
    stable_id, stamp_file, to_iso_string, utc_parts, walk_files, EventCacheOpts, PathFlavor, WalkOptions,
};

/// Local data roots to scan on this machine.
pub fn roots() -> Vec<String> {
    let e = path_env();
    let mut r: Vec<String> = Vec::new();
    r.push(e.expand_home(&env_nonempty("CODEX_HOME").unwrap_or_else(|| e.j(&[&e.home, ".codex"]))));
    if let Some(v) = env_nonempty("ORCA_CODEX_HOME") {
        r.push(e.expand_home(&v));
    }
    r.push(e.j(&[&e.app_data, "orca", "codex-runtime-home", "home"]));
    r.push(e.j(&[&e.home, ".codex"]));
    r.push(e.j(&[&e.xdg_config, "codex"]));
    r.push(e.j(&[&e.app_data, "Codex"]));
    r.push(e.j(&[&e.local_app, "Codex"]));
    r.push(e.j(&[&e.local_app, "OpenAI", "Codex"]));
    r.push(e.j(&[&e.app_data, "OpenAI", "Codex"]));
    unique(r)
}

// ---------------------------------------------------------------------------
// JS-semantics helpers
// ---------------------------------------------------------------------------

fn is_win() -> bool {
    host_platform() == "win32"
}

/// `obj[key]` with `undefined`/`null` both mapped to `None` (what `??` skips).
fn gv<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match v {
        Some(Value::Object(o)) => match o.get(key) {
            Some(Value::Null) | None => None,
            Some(x) => Some(x),
        },
        _ => None,
    }
}

/// `v && typeof v === "object"` (objects and arrays).
fn obj_like(v: Option<&Value>) -> Option<&Value> {
    match v {
        Some(x @ Value::Object(_)) | Some(x @ Value::Array(_)) => Some(x),
        _ => None,
    }
}

fn js_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => {
            let f = n.as_f64().unwrap_or(0.0);
            f != 0.0 && !f.is_nan()
        }
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `String(v)`.
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_num_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|x| if x.is_null() { String::new() } else { js_string(x) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `String(v ?? "")`.
fn js_string_or_empty(v: Option<&Value>) -> String {
    v.map(js_string).unwrap_or_default()
}

fn js_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn js_sort(v: &mut [String]) {
    v.sort_by(|a, b| js_cmp(a, b));
}

fn norm_lower(s: &str) -> String {
    s.replace('\\', "/").to_lowercase()
}

/// Date -> ISO value usable as an `extractTimestamp` candidate.
fn mtime_value(mtime_ms: f64) -> Value {
    Value::String(to_iso_string(mtime_ms).unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()))
}

/// `extractModel(...candidates, fallbackModelString)`.
fn em(cands: &[Option<&Value>], fallback: Option<&str>) -> Option<String> {
    extract_model(cands).or_else(|| fallback.and_then(|m| extract_model_strs(&[Some(m)])))
}

fn pick_string(obj: Option<&Value>, keys: &[&str]) -> Option<String> {
    let o = match obj {
        Some(Value::Object(o)) => o,
        _ => return None,
    };
    for k in keys {
        if let Some(Value::String(s)) = o.get(*k) {
            let t = js_trim(s);
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const CODEX_NOISE_MARKERS: &[&str] = &[
    "/.tmp/",
    "/fixtures/",
    "/fixture/",
    "/plugin-eval/",
    "/observed-usage/",
    "/__tests__/",
    "/testdata/",
    "/mocks/",
    "/vendor_imports/",
    "/node_modules/",
];

fn is_noise_path(full: &str) -> bool {
    let n = norm_lower(full);
    CODEX_NOISE_MARKERS.iter().any(|m| n.contains(m))
}

fn is_mirror_codex_root(full: &str) -> bool {
    norm_lower(full).contains("/codex-runtime-home/")
}

/// Strip a trailing `.zst`/`.zstd` (ASCII case-insensitive).
fn strip_zst_suffix(s: &str) -> Option<&str> {
    for suf in [".zstd", ".zst"] {
        if s.len() >= suf.len() {
            let at = s.len() - suf.len();
            if s.is_char_boundary(at) && s[at..].eq_ignore_ascii_case(suf) {
                return Some(&s[..at]);
            }
        }
    }
    None
}

fn ends_with_jsonl_ci(s: &str) -> bool {
    let suf = ".jsonl";
    s.len() >= suf.len() && s.is_char_boundary(s.len() - suf.len()) && s[s.len() - suf.len()..].eq_ignore_ascii_case(suf)
}

fn is_compressed_codex_rollout(file: &str) -> bool {
    strip_zst_suffix(file).map_or(false, ends_with_jsonl_ci)
}

fn codex_plain_rollout_sibling(file: &str) -> String {
    strip_zst_suffix(file).unwrap_or(file).to_string()
}

fn codex_rollout_identity(file: &str) -> String {
    let base = PathFlavor::host().basename(file).to_lowercase();
    strip_zst_suffix(&base).unwrap_or(&base).to_string()
}

async fn resolve_codex_rollout_path(candidate: &str) -> Option<String> {
    if ends_with_jsonl_ci(candidate) {
        if path_exists(candidate).await {
            return Some(candidate.to_string());
        }
        for suffix in [".zst", ".zstd"] {
            let c = format!("{}{}", candidate, suffix);
            if path_exists(&c).await {
                return Some(c);
            }
        }
        return None;
    }
    if is_compressed_codex_rollout(candidate) {
        let plain = codex_plain_rollout_sibling(candidate);
        if path_exists(&plain).await {
            return Some(plain);
        }
    }
    if path_exists(candidate).await {
        Some(candidate.to_string())
    } else {
        None
    }
}

fn remove_events_from_path(events: &mut Vec<UsageEvent>, file_path: &str) {
    if events.is_empty() {
        return;
    }
    let target = norm_lower(file_path);
    events.retain(|e| {
        let first = e.source_path.split(" \u{2190} ").next().unwrap_or("");
        norm_lower(first) != target
    });
}

#[derive(Clone)]
struct KnownCopy {
    path: String,
    size: i64,
}

/// True when `existing` should be kept and `candidate` skipped.
fn prefer_codex_copy(existing: &KnownCopy, candidate: &KnownCopy) -> bool {
    let em_ = is_mirror_codex_root(&existing.path);
    let cm = is_mirror_codex_root(&candidate.path);
    if em_ != cm {
        return !em_;
    }
    if existing.size != candidate.size {
        return existing.size > candidate.size;
    }
    true
}

// ---------------------------------------------------------------------------
// Light-scan state (module-global, like the TS Maps/Sets)
// ---------------------------------------------------------------------------

const CODEX_LIGHT_INDEX_VERSION: i64 = 1;
const CODEX_LIGHT_LOOKBACK_DAYS: usize = 2;

#[derive(Default)]
struct LightState {
    file_signatures: HashMap<String, String>,
    indexed_roots: HashSet<String>,
    hot_by_root: HashMap<String, Vec<String>>,
    indexes_by_path: HashMap<String, IndexMap<String, Vec<String>>>,
}

static LIGHT: Lazy<Mutex<LightState>> = Lazy::new(|| Mutex::new(LightState::default()));

fn codex_light_index_path() -> String {
    let configured = env_nonempty_trimmed("TOKENLAB_DATA_DIR").or_else(|| env_nonempty_trimmed("XLAB_TOKEN_DATA_DIR"));
    let flavor = PathFlavor::host();
    let base = configured.unwrap_or_else(|| flavor.join(&[app_data_dir().as_str(), "tokenlab"]));
    flavor.join(&[base.as_str(), "codex-light-index.json"])
}

/// `process.env.X?.trim() || undefined`.
fn env_nonempty_trimmed(name: &str) -> Option<String> {
    let v = std::env::var(name).ok()?;
    let t = js_trim(&v);
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

fn last_n(mut v: Vec<String>, n: usize) -> Vec<String> {
    if v.len() > n {
        v.drain(..v.len() - n);
    }
    v
}

/// Load (and memoize) the on-disk index for `index_path`.
async fn load_codex_light_index(index_path: &str) {
    if LIGHT.lock().indexes_by_path.contains_key(index_path) {
        return;
    }
    let mut roots: IndexMap<String, Vec<String>> = IndexMap::new();
    if let Ok(bytes) = tokio::fs::read(index_path).await {
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
            let version_ok = parsed.get("version").and_then(|v| v.as_f64()) == Some(CODEX_LIGHT_INDEX_VERSION as f64);
            if version_ok {
                if let Some(Value::Object(map)) = parsed.get("roots") {
                    for (root_key, files) in map {
                        if let Value::Array(arr) = files {
                            let strs: Vec<String> =
                                arr.iter().filter_map(|f| f.as_str().map(|s| s.to_string())).collect();
                            roots.insert(root_key.clone(), last_n(strs, 4));
                        }
                    }
                }
            }
        }
    }
    LIGHT.lock().indexes_by_path.entry(index_path.to_string()).or_insert(roots);
}

fn is_under_root(root: &str, file: &str) -> bool {
    let p = PathFlavor::host();
    let name = p.basename(file).to_lowercase();
    if !p.is_absolute(file) || !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
        return false;
    }
    let rel = p.relative(&p.resolve(&[root]), &p.resolve(&[file]));
    let sep = p.sep();
    rel != "" && rel != ".." && !rel.starts_with(&format!("..{}", sep)) && !p.is_absolute(&rel)
}

async fn load_codex_light_hot_files(root: &str, root_key: &str) {
    let index_path = codex_light_index_path();
    load_codex_light_index(&index_path).await;
    let mut st = LIGHT.lock();
    let files = match st.indexes_by_path.get(&index_path).and_then(|m| m.get(root_key)) {
        Some(f) => f.clone(),
        None => return,
    };
    let safe: Vec<String> = files.iter().filter(|f| is_under_root(root, f)).cloned().collect();
    if !files.is_empty() && safe.is_empty() {
        return;
    }
    st.hot_by_root.insert(root_key.to_string(), safe);
    st.indexed_roots.insert(root_key.to_string());
}

async fn save_codex_light_hot_files(root_key: &str, files: &[String]) {
    let index_path = codex_light_index_path();
    load_codex_light_index(&index_path).await;
    let payload = {
        let mut st = LIGHT.lock();
        let roots = match st.indexes_by_path.get_mut(&index_path) {
            Some(r) => r,
            None => return,
        };
        if let Some(prev) = roots.get(root_key) {
            if prev.as_slice() == files {
                return;
            }
        }
        roots.insert(root_key.to_string(), last_n(files.to_vec(), 4));
        let mut s = format!("{{\"version\":{},\"roots\":{{", CODEX_LIGHT_INDEX_VERSION);
        for (i, (k, v)) in roots.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push_str(&serde_json::to_string(k).unwrap_or_else(|_| "\"\"".into()));
            s.push(':');
            s.push_str(&serde_json::to_string(v).unwrap_or_else(|_| "[]".into()));
        }
        s.push_str("}}");
        s
    };
    if let Some(dir) = std::path::Path::new(&index_path).parent() {
        if tokio::fs::create_dir_all(dir).await.is_err() {
            return;
        }
    }
    let _ = tokio::fs::write(&index_path, payload).await;
}

fn codex_root_key(root: &str) -> String {
    let resolved = PathFlavor::host().resolve(&[root]);
    if is_win() {
        resolved.to_lowercase()
    } else {
        resolved
    }
}

/// Local and UTC session days, as `YYYY/MM/DD` segments.
fn recent_codex_day_rels(now: f64, day_count: usize) -> Vec<String> {
    let mut rels: Vec<String> = Vec::new();
    for offset in 0..day_count {
        let at = now - (offset as f64) * 24.0 * 60.0 * 60.0 * 1000.0;
        let (y, mo, d, ..) = local_parts(at);
        rels.push(format!("{}/{:02}/{:02}", y, mo + 1, d));
        let (y, mo, d, ..) = utc_parts(at);
        rels.push(format!("{}/{:02}/{:02}", y, mo + 1, d));
    }
    let mut seen = HashSet::new();
    rels.retain(|r| seen.insert(r.clone()));
    rels
}

fn is_under_recent_codex_day(root: &str, file: &str, now: f64) -> bool {
    let rel = norm_lower(&PathFlavor::host().relative(root, file));
    recent_codex_day_rels(now, 2).iter().any(|day| rel.contains(&format!("sessions/{}/", day)))
}

fn order_roots_canonical_first(roots: &[String]) -> Vec<String> {
    let mut canonical = Vec::new();
    let mut mirrors = Vec::new();
    for r in roots {
        if is_mirror_codex_root(r) {
            mirrors.push(r.clone());
        } else {
            canonical.push(r.clone());
        }
    }
    canonical.extend(mirrors);
    canonical
}

// ---------------------------------------------------------------------------
// Scan driver
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Default)]
struct ParseCodexOptions {
    recent_only: bool,
    recent_window_ms: Option<f64>,
}

struct Ctx {
    recent_only: bool,
    recent_cutoff_ms: f64,
    events: Vec<UsageEvent>,
    seen: HashSet<String>,
    seen_rollouts: HashSet<String>,
    seen_file_signatures: HashSet<String>,
    session_identity: HashMap<String, KnownCopy>,
    dropped_mirror_paths: HashSet<String>,
}

impl Ctx {
    fn remember_signature(&self, file: &str, signature: &str) {
        if !self.recent_only || signature.is_empty() {
            return;
        }
        let key = if is_win() { file.to_lowercase() } else { file.to_string() };
        LIGHT.lock().file_signatures.insert(key, signature.to_string());
    }

    async fn consume(&mut self, root: &str, file: &str, hot: &HashSet<String>) -> Result<()> {
        if is_compressed_codex_rollout(file) && path_exists(&codex_plain_rollout_sibling(file)).await {
            self.seen.insert(file.to_string());
            return Ok(());
        }
        if self.seen.contains(file) || self.seen_rollouts.contains(&file.to_lowercase()) {
            return Ok(());
        }
        self.seen.insert(file.to_string());
        let mut file_mtime_ms = 0.0f64;
        let mut file_size: i64 = -1;
        if let Ok(md) = tokio::fs::metadata(file).await {
            let st = crate::util::stamp_from_metadata(&md);
            file_mtime_ms = st.mtime_ms.trunc();
            file_size = st.size as i64;
        }
        let flavor = PathFlavor::host();
        let mut signature = String::new();
        if file_size >= 0 {
            let mut relative = flavor.relative(root, file).replace('\\', "/");
            if is_win() {
                relative = relative.to_lowercase();
            }
            signature = format!("{}|{}", relative, file_size);
            let key = if is_win() { file.to_lowercase() } else { file.to_string() };
            let same = LIGHT.lock().file_signatures.get(&key).map(|s| s.as_str()) == Some(signature.as_str());
            if self.recent_only && same {
                return Ok(());
            }
        }
        if file_mtime_ms < self.recent_cutoff_ms && !hot.contains(file) {
            if is_under_recent_codex_day(root, file, now_ms()) {
                self.remember_signature(file, &signature);
            }
            return Ok(());
        }

        // Mirror-root dedupe by session identity, before any parse work.
        let identity = codex_rollout_identity(file);
        if let Some(known) = self.session_identity.get(&identity).cloned() {
            let keep_existing = prefer_codex_copy(&known, &KnownCopy { path: file.to_string(), size: file_size });
            if keep_existing {
                self.dropped_mirror_paths.insert(file.to_string());
                return Ok(());
            }
            self.dropped_mirror_paths.insert(known.path.clone());
            remove_events_from_path(&mut self.events, &known.path);
            self.seen_rollouts.remove(&known.path.to_lowercase());
        }
        if file_size >= 0 {
            self.session_identity.insert(identity, KnownCopy { path: file.to_string(), size: file_size });
        }

        if !signature.is_empty() {
            let pass = format!("{}|{}", signature, js_num_to_string(file_mtime_ms.trunc()));
            if !self.seen_file_signatures.insert(pass) {
                return Ok(());
            }
        }

        if file.ends_with(".json") && !file.ends_with(".jsonl") {
            let text = match read_text(file).await {
                Some(t) if !t.is_empty() => t,
                _ => return Ok(()),
            };
            if let Ok(data) = serde_json::from_str::<Value>(&text) {
                collect_from_json(&mut self.events, &data, file, file_mtime_ms);
            }
            self.remember_signature(file, &signature);
            return Ok(());
        }

        let f = file.to_string();
        let file_events = cached_events_for_file(
            file,
            move || async move {
                let mut produced = Vec::new();
                if let Some(rows) = read_jsonl_cached(&f, None).await? {
                    parse_jsonl_rows(&mut produced, &rows, &f, file_mtime_ms);
                }
                Ok(produced)
            },
            EventCacheOpts::default(),
        )
        .await?;
        self.events.extend(file_events);
        self.remember_signature(file, &signature);
        Ok(())
    }
}

fn walk_match_name(n: &str, full: &str) -> bool {
    if is_noise_path(full) {
        return false;
    }
    n.ends_with(".jsonl")
        || n.starts_with("rollout-")
        || (n.contains("session") && (n.ends_with(".json") || n.ends_with(".jsonl")))
}

async fn parse_codex_internal(roots: Vec<String>, options: ParseCodexOptions) -> Result<Vec<UsageEvent>> {
    let recent_cutoff_ms = if options.recent_only {
        now_ms() - options.recent_window_ms.unwrap_or(15.0 * 60_000.0)
    } else {
        f64::NEG_INFINITY
    };
    let mut ctx = Ctx {
        recent_only: options.recent_only,
        recent_cutoff_ms,
        events: Vec::new(),
        seen: HashSet::new(),
        seen_rollouts: HashSet::new(),
        seen_file_signatures: HashSet::new(),
        session_identity: HashMap::new(),
        dropped_mirror_paths: HashSet::new(),
    };
    let flavor = PathFlavor::host();

    for root in order_roots_canonical_first(&roots) {
        if !path_exists(&root).await {
            continue;
        }
        if options.recent_only && is_mirror_codex_root(&root) {
            let mut canonical = false;
            for other in &roots {
                if *other == root || is_mirror_codex_root(other) {
                    continue;
                }
                if path_exists(other).await {
                    canonical = true;
                    break;
                }
            }
            if canonical {
                continue;
            }
        }

        if !options.recent_only {
            let sqlite_events = parse_codex_sqlite_state(&root, &mut ctx.seen_rollouts).await;
            ctx.events.extend(sqlite_events);
        }

        let root_key = codex_root_key(&root);
        let already_indexed = LIGHT.lock().indexed_roots.contains(&root_key);
        if options.recent_only && !already_indexed {
            load_codex_light_hot_files(&root, &root_key).await;
        }
        let indexed = options.recent_only && LIGHT.lock().indexed_roots.contains(&root_key);
        let mut discovered_hot: Vec<String> = Vec::new();
        let sessions_root = flavor.join(&[root.as_str(), "sessions"]);

        let mut scan_roots: Vec<String>;
        if options.recent_only {
            scan_roots = vec![root.clone()];
            if path_exists(&sessions_root).await {
                for rel in recent_codex_day_rels(now_ms(), CODEX_LIGHT_LOOKBACK_DAYS) {
                    let mut parts: Vec<&str> = vec![sessions_root.as_str()];
                    parts.extend(rel.split('/'));
                    let dir = flavor.join(&parts);
                    if path_exists(&dir).await {
                        scan_roots.push(dir);
                    }
                }
            }
        } else {
            let preferred = [
                sessions_root.clone(),
                flavor.join(&[root.as_str(), "archived_sessions"]),
                flavor.join(&[root.as_str(), "session_index"]),
                flavor.join(&[root.as_str(), "history"]),
                flavor.join(&[root.as_str(), "logs"]),
            ];
            let mut existing = Vec::new();
            for p in preferred {
                if path_exists(&p).await {
                    existing.push(p);
                }
            }
            scan_roots = if !existing.is_empty() {
                existing.push(root.clone());
                existing
            } else {
                vec![root.clone()]
            };
        }

        for base in &scan_roots {
            if !path_exists(base).await {
                continue;
            }
            if is_noise_path(base) {
                continue;
            }
            let depth = if !options.recent_only {
                12
            } else if *base == root {
                1
            } else {
                2
            };
            let mut files = walk_files(base, WalkOptions::new().max_depth(depth).matching(walk_match_name)).await;
            if !options.recent_only && *base == root && scan_roots.len() > 1 {
                // Files under the preferred dirs were already consumed; skip the duplicate work.
                let prefixes: Vec<String> =
                    scan_roots.iter().filter(|b| **b != root && !is_noise_path(b)).map(|b| format!("{}{}", b, flavor.sep())).collect();
                files.retain(|f| !prefixes.iter().any(|p| f.starts_with(p.as_str())));
            }
            let hot_list: Vec<String> = if options.recent_only {
                let mut h: Vec<String> =
                    files.iter().filter(|f| flavor.basename(f).starts_with("rollout-")).cloned().collect();
                js_sort(&mut h);
                last_n(h, 4)
            } else {
                Vec::new()
            };
            let hot: HashSet<String> = hot_list.iter().cloned().collect();
            let under_sessions =
                *base == sessions_root || base.starts_with(&format!("{}{}", sessions_root, flavor.sep()));
            if under_sessions {
                discovered_hot.extend(hot_list.iter().cloned());
            }
            for file in &files {
                ctx.consume(&root, file, &hot).await?;
            }
        }

        if indexed {
            let remembered_list: Vec<String> = LIGHT.lock().hot_by_root.get(&root_key).cloned().unwrap_or_default();
            let remembered: HashSet<String> = remembered_list.iter().cloned().collect();
            let mut visited = HashSet::new();
            for file in &remembered_list {
                if !visited.insert(file.clone()) {
                    continue;
                }
                if ctx.seen.contains(file) || !path_exists(file).await {
                    continue;
                }
                ctx.consume(&root, file, &remembered).await?;
            }
        }
        if options.recent_only {
            let mut merged: Vec<String> = Vec::new();
            let mut dedupe = HashSet::new();
            let prior: Vec<String> = LIGHT.lock().hot_by_root.get(&root_key).cloned().unwrap_or_default();
            for f in prior.into_iter().chain(discovered_hot.into_iter()) {
                if dedupe.insert(f.clone()) {
                    merged.push(f);
                }
            }
            js_sort(&mut merged);
            let hot_files = last_n(merged, 4);
            {
                let mut st = LIGHT.lock();
                st.hot_by_root.insert(root_key.clone(), hot_files.clone());
                st.indexed_roots.insert(root_key.clone());
            }
            save_codex_light_hot_files(&root_key, &hot_files).await;
        }
    }

    Ok(ctx.events)
}

// ---------------------------------------------------------------------------
// SQLite thread state
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
enum SqlVal {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

struct ThreadRows {
    names: Vec<String>,
    rows: Vec<Vec<SqlVal>>,
}

impl ThreadRows {
    /// `row[key] ?? undefined` (null -> None); last column with that exact name wins.
    fn get<'a>(&self, row: &'a [SqlVal], key: &str) -> Option<&'a SqlVal> {
        let idx = self.names.iter().rposition(|n| n == key)?;
        match row.get(idx) {
            Some(SqlVal::Null) | None => None,
            Some(v) => Some(v),
        }
    }
}

fn sql_to_number(v: Option<&SqlVal>) -> f64 {
    match v {
        None => 0.0,
        Some(SqlVal::Null) => 0.0,
        Some(SqlVal::Int(i)) => *i as f64,
        Some(SqlVal::Real(f)) => *f,
        Some(SqlVal::Text(s)) => js_number_from_str(s),
        Some(SqlVal::Blob(b)) => match b.len() {
            0 => 0.0,
            1 => b[0] as f64,
            _ => f64::NAN,
        },
    }
}

fn sql_to_string(v: Option<&SqlVal>) -> String {
    match v {
        None | Some(SqlVal::Null) => String::new(),
        Some(SqlVal::Int(i)) => i.to_string(),
        Some(SqlVal::Real(f)) => js_num_to_string(*f),
        Some(SqlVal::Text(s)) => s.clone(),
        Some(SqlVal::Blob(b)) => b.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","),
    }
}

fn sql_text(v: Option<&SqlVal>) -> Option<&str> {
    match v {
        Some(SqlVal::Text(s)) if !s.is_empty() => Some(s.as_str()),
        _ => None,
    }
}

/// Read the thread rows of one state DB. `None` means: skip this DB (any error / no thread table).
fn read_thread_rows(db_path: &str) -> Option<(ThreadRows, ThreadCols)> {
    use rusqlite::types::ValueRef;
    use rusqlite::{Connection, OpenFlags};

    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let tables: Vec<String> = {
        let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").ok()?;
        let it = stmt.query_map([], |r| r.get::<_, String>(0)).ok()?;
        let mut out = Vec::new();
        for t in it {
            out.push(t.ok()?);
        }
        out
    };
    let thread_table = tables
        .iter()
        .find(|t| t.as_str() == "threads")
        .or_else(|| {
            tables.iter().find(|t| {
                let l = t.to_lowercase();
                l.contains("thread")
                    && !(l.contains("catalog") || l.contains("edge") || l.contains("goal") || l.contains("tool"))
            })
        })?
        .clone();

    let cols: Vec<String> = {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", thread_table)).ok()?;
        let it = stmt.query_map([], |r| r.get::<_, String>(1)).ok()?;
        let mut out = Vec::new();
        for c in it {
            out.push(c.ok()?);
        }
        out
    };
    let col_set: HashSet<String> = cols.iter().map(|c| c.to_lowercase()).collect();
    if !col_set.contains("tokens_used")
        && !col_set.contains("tokensused")
        && !col_set.contains("rollout_path")
        && !col_set.contains("rolloutpath")
    {
        return None;
    }
    let token_col: Option<String> = if col_set.contains("tokens_used") {
        Some("tokens_used".into())
    } else if col_set.contains("tokensused") {
        Some("tokensUsed".into())
    } else {
        None
    };
    let id_col: String = if col_set.contains("id") { "id".into() } else { cols.first()?.clone() };
    let model_col: Option<String> = col_set.contains("model").then(|| "model".to_string());
    let cwd_col: Option<String> = col_set.contains("cwd").then(|| "cwd".to_string());
    let rollout_col: Option<String> = if col_set.contains("rollout_path") {
        Some("rollout_path".into())
    } else if col_set.contains("rolloutpath") {
        Some("rolloutPath".into())
    } else {
        None
    };
    let created_col: Option<String> = ["created_at_ms", "created_at", "updated_at_ms", "updated_at"]
        .iter()
        .find(|c| col_set.contains(**c))
        .map(|c| c.to_string());
    let updated_col: Option<String> = if col_set.contains("updated_at_ms") {
        Some("updated_at_ms".into())
    } else if col_set.contains("updated_at") {
        Some("updated_at".into())
    } else {
        created_col.clone()
    };

    let select_cols: Vec<String> = [
        Some(id_col.clone()),
        token_col.clone(),
        model_col.clone(),
        cwd_col.clone(),
        rollout_col.clone(),
        created_col.clone(),
        updated_col.clone(),
    ]
    .into_iter()
    .flatten()
    .filter(|s| !s.is_empty())
    .collect();
    let order_col = updated_col.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| id_col.clone());
    let sql = format!(
        "SELECT {} FROM {}\n             ORDER BY {} DESC\n             LIMIT 50000",
        select_cols.join(", "),
        thread_table,
        order_col
    );
    let mut stmt = conn.prepare(&sql).ok()?;
    let names: Vec<String> = stmt.column_names().into_iter().map(|s| s.to_string()).collect();
    let ncols = names.len();
    let mut rows_out: Vec<Vec<SqlVal>> = Vec::new();
    let mut rows = stmt.query([]).ok()?;
    loop {
        let row = match rows.next() {
            Ok(Some(r)) => r,
            Ok(None) => break,
            Err(_) => return None,
        };
        let mut vals = Vec::with_capacity(ncols);
        for i in 0..ncols {
            let v = match row.get_ref(i).ok()? {
                ValueRef::Null => SqlVal::Null,
                ValueRef::Integer(n) => SqlVal::Int(n),
                ValueRef::Real(f) => SqlVal::Real(f),
                ValueRef::Text(t) => SqlVal::Text(String::from_utf8_lossy(t).into_owned()),
                ValueRef::Blob(b) => SqlVal::Blob(b.to_vec()),
            };
            vals.push(v);
        }
        rows_out.push(vals);
    }
    Some((
        ThreadRows { names, rows: rows_out },
        ThreadCols { id_col, token_col, model_col, cwd_col, rollout_col, created_col, updated_col },
    ))
}

struct ThreadCols {
    id_col: String,
    token_col: Option<String>,
    model_col: Option<String>,
    cwd_col: Option<String>,
    rollout_col: Option<String>,
    created_col: Option<String>,
    updated_col: Option<String>,
}

/// `coerceSqliteTime`; `None` models the RangeError that `toISOString` throws.
fn coerce_sqlite_time(v: Option<&SqlVal>) -> Option<String> {
    match v {
        Some(SqlVal::Text(s)) if !js_trim(s).is_empty() => {
            let ms = js_date_parse(s);
            if !ms.is_nan() {
                return to_iso_string(ms);
            }
        }
        Some(SqlVal::Int(_)) | Some(SqlVal::Real(_)) => {
            let n = sql_to_number(v);
            if n.is_finite() && n > 0.0 {
                let ms = if n > 1e12 {
                    n
                } else if n > 1e9 {
                    n * 1000.0
                } else if n > 1e8 {
                    n * 1000.0
                } else {
                    f64::NAN
                };
                if ms.is_finite() {
                    return to_iso_string(ms);
                }
            }
        }
        _ => {}
    }
    to_iso_string(now_ms())
}

async fn parse_codex_sqlite_state(root: &str, seen_rollouts: &mut HashSet<String>) -> Vec<UsageEvent> {
    let flavor = PathFlavor::host();
    let mut events: Vec<UsageEvent> = Vec::new();
    let mut candidates: Vec<String> = Vec::new();

    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            let is_file = e.file_type().map(|t| t.is_file()).unwrap_or(false);
            if !is_file {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            let n = name.to_lowercase();
            if (n.starts_with("state_") && n.ends_with(".sqlite"))
                || n == "state.sqlite"
                || n == "sessions.db"
                || (n.contains("state") && n.ends_with(".db"))
            {
                candidates.push(flavor.join(&[root, name.as_str()]));
            }
        }
    }
    let sqlite_dir = flavor.join(&[root, "sqlite"]);
    if path_exists(&sqlite_dir).await {
        if let Ok(rd) = std::fs::read_dir(&sqlite_dir) {
            for e in rd.flatten() {
                let is_file = e.file_type().map(|t| t.is_file()).unwrap_or(false);
                if !is_file {
                    continue;
                }
                let name = e.file_name().to_string_lossy().to_string();
                let n = name.to_lowercase();
                if n.ends_with(".sqlite") || n.ends_with(".db") {
                    candidates.push(flavor.join(&[sqlite_dir.as_str(), name.as_str()]));
                }
            }
        }
    }

    for db_path in candidates {
        if is_noise_path(&db_path) {
            continue;
        }
        let p = db_path.clone();
        let loaded = tokio::task::spawn_blocking(move || read_thread_rows(&p)).await.ok().flatten();
        let (tr, cols) = match loaded {
            Some(x) => x,
            None => continue,
        };
        let updated_key = cols.updated_col.clone().unwrap_or_default();
        let created_key = cols.created_col.clone().unwrap_or_default();
        for row in &tr.rows {
            let tokens = match &cols.token_col {
                Some(c) => sql_to_number(tr.get(row, c)),
                None => 0.0,
            };
            let tid = sql_to_string(tr.get(row, &cols.id_col));
            let model = cols
                .model_col
                .as_ref()
                .and_then(|c| sql_text(tr.get(row, c)))
                .map(|s| s.to_string())
                .unwrap_or_else(|| "codex".to_string());
            let cwd = cols.cwd_col.as_ref().and_then(|c| sql_text(tr.get(row, c))).map(|s| s.to_string());
            let time_src = tr.get(row, &updated_key).or_else(|| tr.get(row, &created_key));
            let ts = match coerce_sqlite_time(time_src) {
                Some(t) => t,
                None => break, // RangeError aborts this DB; earlier events are kept
            };
            let summary_id = stable_id(&[
                "codex",
                db_path.to_lowercase().as_str(),
                "thread",
                tid.as_str(),
                js_num_to_string(tokens).as_str(),
            ]);

            if tokens.is_finite() && tokens > 0.0 {
                events.push(apply_pricing(UsageEvent {
                    id: summary_id.clone(),
                    agent: AgentId::Codex,
                    model: Some(model),
                    timestamp: ts,
                    input_tokens: js_round(tokens),
                    output_tokens: 0.0,
                    cache_read_tokens: 0.0,
                    cache_write_tokens: 0.0,
                    workspace: cwd,
                    source_path: db_path.clone(),
                    estimated: Some(true),
                    ..Default::default()
                }));
            }

            let rp = match cols.rollout_col.as_ref().and_then(|c| tr.get(row, c)) {
                Some(SqlVal::Text(s)) => js_trim(s).to_string(),
                _ => String::new(),
            };
            let candidate = rp.strip_prefix("\\\\?\\").unwrap_or(&rp).to_string();
            let rollout_path = if candidate.is_empty() { None } else { resolve_codex_rollout_path(&candidate).await };
            if let Some(rollout_path) = rollout_path {
                if !is_noise_path(&rollout_path) {
                    let key = rollout_path.to_lowercase();
                    if seen_rollouts.insert(key) {
                        if let Some(stamp) = stamp_file(&rollout_path).await {
                            let mtime = stamp.mtime_ms.trunc();
                            let before = events.len();
                            let rp2 = rollout_path.clone();
                            let res = cached_events_for_file(
                                &rollout_path,
                                move || async move {
                                    let mut produced = Vec::new();
                                    if let Some(rows) = read_jsonl_cached(&rp2, None).await? {
                                        parse_jsonl_rows(&mut produced, &rows, &rp2, mtime);
                                    }
                                    Ok(produced)
                                },
                                EventCacheOpts::default(),
                            )
                            .await;
                            if let Ok(file_events) = res {
                                events.extend(file_events);
                                if events.len() > before && tokens.is_finite() && tokens > 0.0 {
                                    if let Some(i) = events.iter().position(|e| e.id == summary_id) {
                                        events.remove(i);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    events
}

// ---------------------------------------------------------------------------
// JSONL rows
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct CBuckets {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    cache_reported: bool,
}

fn codex_buckets(usage: Option<&Value>) -> Option<CBuckets> {
    let b = extract_token_buckets(usage)?;
    let input = b.input_tokens - if b.input_includes_cache == Some(true) { b.cache_read_tokens } else { 0.0 };
    Some(CBuckets {
        input: input.max(0.0),
        output: b.output_tokens.max(0.0),
        cache_read: b.cache_read_tokens.max(0.0),
        cache_write: b.cache_write_tokens.max(0.0),
        cache_reported: b.cache_reported == Some(true),
    })
}

fn codex_bucket_key(b: &CBuckets) -> String {
    [b.input, b.output, b.cache_read, b.cache_write].iter().map(|n| js_num_to_string(*n)).collect::<Vec<_>>().join(":")
}

fn same_buckets(a: &CBuckets, b: &CBuckets) -> bool {
    a.input == b.input && a.output == b.output && a.cache_read == b.cache_read && a.cache_write == b.cache_write
}

fn is_token_usage_record(t: &str, pt: &str) -> bool {
    t == "token_usage_record" || pt == "token_usage_record"
}

struct TurnBucket {
    start_ms: f64,
    end_ms: f64,
    user_chars: f64,
    asst_chars: f64,
    reason_chars: f64,
    tool_out_chars: f64,
    model: Option<String>,
}

fn row_type(r: &Value) -> String {
    let v = gv(Some(r), "type").or_else(|| gv(Some(r), "event_type")).or_else(|| gv(Some(r), "kind"));
    js_string_or_empty(v)
}

fn find_usage_object<'a>(r: &'a Value, ty: &str) -> Option<(&'a Value, bool)> {
    let payload = obj_like(gv(Some(r), "payload"));
    let info = obj_like(gv(payload, "info"));
    let response = obj_like(gv(payload, "response")).or_else(|| obj_like(gv(Some(r), "response")));
    let direct = ty == "token_usage_record";
    let hint = ty.contains("token") || ty.contains("usage");

    let candidates: Vec<(Option<&Value>, bool)> = vec![
        (gv(Some(r), "usage"), direct),
        (gv(Some(r), "token_count"), false),
        (gv(Some(r), "tokenCount"), false),
        (gv(payload, "usage"), direct),
        (gv(payload, "token_count"), false),
        (gv(payload, "tokenCount"), false),
        (gv(info, "usage"), false),
        (gv(info, "token_count"), false),
        (gv(info, "last_token_usage"), true),
        (gv(info, "total_token_usage"), false),
        (gv(response, "usage"), false),
        (if hint { payload } else { None }, false),
        (if hint { Some(r) } else { None }, false),
    ];
    for (val, per_call) in candidates {
        if let Some(v) = obj_like(val) {
            if extract_token_buckets(Some(v)).is_some() {
                return Some((v, per_call));
            }
        }
    }
    if info.is_some() {
        for key in ["total_token_usage", "last_token_usage", "token_usage"] {
            if let Some(n) = obj_like(gv(info, key)) {
                if extract_token_buckets(Some(n)).is_some() {
                    return Some((n, key == "last_token_usage"));
                }
            }
        }
    }
    None
}

fn content_char_len(content: Option<&Value>) -> f64 {
    let c = match content {
        None | Some(Value::Null) => return 0.0,
        Some(c) => c,
    };
    let obj_len = |o: &Value| -> f64 {
        let v = gv(Some(o), "text").or_else(|| gv(Some(o), "input_text")).or_else(|| gv(Some(o), "content"));
        js_len(&js_string_or_empty(v)) as f64
    };
    match c {
        Value::String(s) => js_len(s) as f64,
        Value::Array(a) => {
            let mut n = 0.0;
            for x in a {
                match x {
                    Value::String(s) => n += js_len(s) as f64,
                    Value::Object(_) | Value::Array(_) => n += obj_len(x),
                    _ => {}
                }
            }
            n
        }
        Value::Object(_) => obj_len(c),
        other => js_len(&js_string(other)) as f64,
    }
}

fn chars_to_tokens(chars: f64) -> f64 {
    if !chars.is_finite() || chars <= 0.0 {
        return 0.0;
    }
    (chars / 4.0).ceil().max(1.0)
}

struct RecordEntry {
    ts_ms: f64,
    buckets: CBuckets,
}

const RECORD_WINDOW_MS: f64 = 2000.0;

fn record_window(ts_ms: f64) -> i64 {
    (ts_ms / RECORD_WINDOW_MS).floor() as i64
}

fn parse_jsonl_rows(events: &mut Vec<UsageEvent>, rows: &[Value], file: &str, file_mtime_ms: f64) {
    let mtime_val = mtime_value(file_mtime_ms);
    let mtime_c: Option<&Value> = Some(&mtime_val);

    let mut record_counts: HashMap<String, i64> = HashMap::new();
    let mut records_by_window: HashMap<i64, Vec<RecordEntry>> = HashMap::new();
    let mut record_count: i64 = 0;
    for row in rows {
        if obj_like(Some(row)).is_none() {
            continue;
        }
        let ty = row_type(row);
        let payload = obj_like(gv(Some(row), "payload"));
        let payload_type = payload.map(|p| js_string_or_empty(gv(Some(p), "type"))).unwrap_or_default();
        if !is_token_usage_record(&ty, &payload_type) {
            continue;
        }
        let found = find_usage_object(row, &ty);
        let usage = gv(payload, "usage")
            .or_else(|| gv(Some(row), "usage"))
            .or_else(|| gv(payload, "token_usage"))
            .or_else(|| gv(Some(row), "token_usage"))
            .or(found.map(|f| f.0));
        let buckets = match codex_buckets(usage) {
            Some(b) => b,
            None => continue,
        };
        let key = codex_bucket_key(&buckets);
        *record_counts.entry(key).or_insert(0) += 1;
        let ts = extract_timestamp(&[Some(row), gv(Some(row), "payload"), usage, mtime_c]);
        let ts_ms = js_date_parse(&ts);
        if ts_ms.is_finite() {
            records_by_window.entry(record_window(ts_ms)).or_default().push(RecordEntry { ts_ms, buckets });
        }
        record_count += 1;
    }
    let mut consumed: HashMap<String, i64> = HashMap::new();

    let mut idx: i64 = 0;
    let (mut last_in, mut last_out, mut last_cr, mut last_cw) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let mut model: Option<String> = None;
    let mut workspace: Option<String> = None;
    let mut cumulative_mode: Option<bool> = None;
    let mut real_token_events = 0;
    let mut turns: Vec<TurnBucket> = Vec::new();
    let mut cur_turn: Option<TurnBucket> = None;
    let mut session_end_ms = file_mtime_ms;

    for row in rows {
        idx += 1;
        if obj_like(Some(row)).is_none() {
            continue;
        }
        let r = row;
        let ty = row_type(r);
        let payload = obj_like(gv(Some(r), "payload"));
        let payload_type = payload.map(|p| js_string_or_empty(gv(Some(p), "type"))).unwrap_or_default();
        let info = obj_like(gv(payload, "info"));
        let row_ts = extract_timestamp(&[Some(r), gv(Some(r), "payload"), mtime_c]);
        let row_ms = js_date_parse(&row_ts);
        if row_ms.is_finite() && row_ms > session_end_ms {
            session_end_ms = row_ms;
        }

        let nm = em(&[Some(r), gv(Some(r), "payload"), gv(Some(r), "message")], model.as_deref());
        if nm.is_some() {
            model = nm;
        }
        workspace = pick_string(Some(r), &["cwd", "workdir", "workspace", "project"])
            .or_else(|| pick_string(gv(Some(r), "payload"), &["cwd", "workdir", "workspace"]))
            .or(workspace);

        if ty == "model_change" || ty == "session_meta" {
            let nm = em(&[Some(r), gv(Some(r), "payload")], model.as_deref());
            if nm.is_some() {
                model = nm;
            }
            if ty == "session_meta" && payload.is_some() {
                let m = em(&[payload, gv(payload, "model")], model.as_deref());
                if m.is_some() {
                    model = m;
                }
            }
            continue;
        }

        if ty == "turn_context" && payload.is_some() {
            let nm = em(&[payload], model.as_deref());
            if nm.is_some() {
                model = nm;
            }
        }

        if ty == "event_msg" && payload_type == "task_started" && row_ms.is_finite() {
            cur_turn = Some(TurnBucket {
                start_ms: row_ms,
                end_ms: row_ms,
                user_chars: 0.0,
                asst_chars: 0.0,
                reason_chars: 0.0,
                tool_out_chars: 0.0,
                model: model.clone(),
            });
        }
        if let Some(turn) = cur_turn.as_mut() {
            if ty == "response_item" && payload.is_some() {
                let pt = js_string_or_empty(gv(payload, "type"));
                if pt == "message" {
                    let text_len = content_char_len(gv(payload, "content"));
                    let role = js_string_or_empty(gv(payload, "role"));
                    if role == "user" {
                        turn.user_chars += text_len;
                    } else if role == "assistant" {
                        turn.asst_chars += text_len;
                    }
                } else if pt == "reasoning" {
                    turn.reason_chars += content_char_len(gv(payload, "summary").or_else(|| gv(payload, "content")));
                } else if pt == "function_call_output" {
                    turn.tool_out_chars += js_len(&js_string_or_empty(gv(payload, "output"))) as f64;
                }
            }
            if ty == "event_msg" && payload_type == "task_complete" && row_ms.is_finite() {
                turn.end_ms = row_ms;
                if model.is_some() {
                    turn.model = model.clone();
                }
                if let Some(done) = cur_turn.take() {
                    turns.push(done);
                }
            }
        }

        let token_record = is_token_usage_record(&ty, &payload_type);
        let token_count_snapshot = ty == "event_msg" && payload_type == "token_count";
        let usage_result = find_usage_object(r, &ty);
        let mut per_call = usage_result.map(|u| u.1).unwrap_or(token_record);
        let mut usage_obj: Option<&Value> = usage_result.map(|u| u.0);

        if token_count_snapshot {
            let last_usage = gv(info, "last_token_usage");
            let last_buckets = codex_buckets(last_usage);
            if record_count > 0 && last_buckets.is_some() {
                let key = codex_bucket_key(last_buckets.as_ref().unwrap());
                let matched = consumed.get(&key).copied().unwrap_or(0);
                let available = record_counts.get(&key).copied().unwrap_or(0);
                if matched < available {
                    consumed.insert(key, matched + 1);
                    continue;
                }
                usage_obj = last_usage;
                per_call = true;
            } else if record_count > 0 {
                continue;
            } else if last_buckets.is_some() && !js_truthy(gv(info, "total_token_usage")) {
                usage_obj = last_usage;
                per_call = true;
            }
        }

        let usage_obj = match usage_obj {
            Some(u) => u,
            None => continue,
        };
        let buckets = match codex_buckets(Some(usage_obj)) {
            Some(b) => b,
            None => continue,
        };

        let is_mirror = payload_type == "token_count"
            && js_truthy(gv(info, "last_token_usage"))
            && js_truthy(gv(info, "total_token_usage"));
        if is_mirror && row_ms.is_finite() {
            let first_win = record_window(row_ms - RECORD_WINDOW_MS);
            let last_win = record_window(row_ms + RECORD_WINDOW_MS);
            let mut mirrored = false;
            let mut w = first_win;
            while w <= last_win && !mirrored {
                if let Some(bucket) = records_by_window.get(&w) {
                    for c in bucket {
                        if (c.ts_ms - row_ms).abs() <= RECORD_WINDOW_MS && same_buckets(&c.buckets, &buckets) {
                            mirrored = true;
                            break;
                        }
                    }
                }
                w += 1;
            }
            if mirrored {
                continue;
            }
        }

        let (mut input, mut output, mut cache_read, mut cache_write) =
            (buckets.input, buckets.output, buckets.cache_read, buckets.cache_write);

        if !per_call {
            let looks_cumulative = cumulative_mode == Some(true)
                || (input >= last_in
                    && output >= last_out
                    && (input > last_in || output > last_out)
                    && (last_in > 0.0 || last_out > 0.0 || ty.contains("token")));
            if looks_cumulative && (input >= last_in || output >= last_out) {
                cumulative_mode = Some(true);
                let d_in = (input - last_in).max(0.0);
                let d_out = (output - last_out).max(0.0);
                let d_cr = (cache_read - last_cr).max(0.0);
                let d_cw = (cache_write - last_cw).max(0.0);
                last_in = input;
                last_out = output;
                last_cr = cache_read;
                last_cw = cache_write;
                input = d_in;
                output = d_out;
                cache_read = d_cr;
                cache_write = d_cw;
            } else if cumulative_mode != Some(true) {
                last_in = 0.0;
                last_out = 0.0;
                last_cr = 0.0;
                last_cw = 0.0;
            }
        }

        if input + output + cache_read + cache_write <= 0.0 {
            continue;
        }

        let ts = extract_timestamp(&[Some(r), gv(Some(r), "payload"), Some(usage_obj), mtime_c]);
        let row_model = em(&[Some(r), gv(Some(r), "payload"), Some(usage_obj)], model.as_deref());

        real_token_events += 1;
        events.push(apply_pricing(UsageEvent {
            id: stable_id(&[
                "codex",
                file,
                idx.to_string().as_str(),
                js_num_to_string(input).as_str(),
                js_num_to_string(output).as_str(),
            ]),
            agent: AgentId::Codex,
            model: row_model,
            timestamp: ts,
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cache_read,
            cache_write_tokens: cache_write,
            workspace: workspace.clone(),
            source_path: file.to_string(),
            cache_reported: if buckets.cache_reported { Some(true) } else { None },
            ..Default::default()
        }));
    }

    if real_token_events == 0 {
        emit_content_estimates(events, file, model.as_deref(), workspace.as_deref(), &turns, session_end_ms, file_mtime_ms);
    }
}

fn emit_content_estimates(
    events: &mut Vec<UsageEvent>,
    file: &str,
    model: Option<&str>,
    workspace: Option<&str>,
    turns: &[TurnBucket],
    session_end_ms: f64,
    file_mtime_ms: f64,
) {
    if turns.is_empty() {
        return;
    }
    let mut i = 0;
    for t in turns {
        i += 1;
        let input = chars_to_tokens(t.user_chars + t.tool_out_chars);
        let output = chars_to_tokens(t.asst_chars + t.reason_chars);
        if input + output <= 0.0 {
            continue;
        }
        let _ = t.start_ms;
        let ts = if t.end_ms.is_finite() {
            to_iso_string(t.end_ms)
        } else if session_end_ms.is_finite() {
            to_iso_string(session_end_ms)
        } else {
            to_iso_string(file_mtime_ms)
        }
        .unwrap_or_default();
        let m = t
            .model
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| model.filter(|s| !s.is_empty()).map(|s| s.to_string()))
            .unwrap_or_else(|| "codex".to_string());
        events.push(apply_pricing(UsageEvent {
            id: stable_id(&[
                "codex",
                file,
                "est",
                i.to_string().as_str(),
                js_num_to_string(input).as_str(),
                js_num_to_string(output).as_str(),
            ]),
            agent: AgentId::Codex,
            model: Some(m),
            timestamp: ts,
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: 0.0,
            cache_write_tokens: 0.0,
            workspace: workspace.map(|s| s.to_string()),
            source_path: file.to_string(),
            estimated: Some(true),
            ..Default::default()
        }));
    }
}

fn collect_from_json(events: &mut Vec<UsageEvent>, data: &Value, file: &str, file_mtime_ms: f64) {
    match data {
        Value::Array(arr) => {
            let mtime_val = mtime_value(file_mtime_ms);
            for (i, row) in arr.iter().enumerate() {
                if obj_like(Some(row)).is_none() {
                    continue;
                }
                let usage = gv(Some(row), "usage").or_else(|| gv(Some(row), "token_count")).unwrap_or(row);
                let b = match codex_buckets(Some(usage)) {
                    Some(b) => b,
                    None => continue,
                };
                events.push(apply_pricing(UsageEvent {
                    id: stable_id(&["codex", file, "json", i.to_string().as_str(), js_num_to_string(b.input).as_str()]),
                    agent: AgentId::Codex,
                    model: extract_model(&[Some(row)]),
                    timestamp: extract_timestamp(&[Some(row), Some(&mtime_val)]),
                    input_tokens: b.input,
                    output_tokens: b.output,
                    cache_read_tokens: b.cache_read,
                    cache_write_tokens: b.cache_write,
                    workspace: pick_string(Some(row), &["cwd", "workspace"]),
                    source_path: file.to_string(),
                    cache_reported: if b.cache_reported { Some(true) } else { None },
                    ..Default::default()
                }));
            }
        }
        Value::Object(o) => {
            if let Some(v @ Value::Array(_)) = o.get("events") {
                collect_from_json(events, v, file, file_mtime_ms);
            }
            if let Some(v @ Value::Array(_)) = o.get("sessions") {
                collect_from_json(events, v, file, file_mtime_ms);
            }
        }
        _ => {}
    }
}

pub fn agent() -> AgentModule {
    AgentModule {
        id: AgentId::Codex,
        label: "OpenAI Codex",
        roots,
        parse: parse_fn(|roots| async move { parse_codex_internal(roots, ParseCodexOptions::default()).await }),
        parse_light: Some(parse_fn(|roots| async move {
            parse_codex_internal(
                roots,
                ParseCodexOptions { recent_only: true, recent_window_ms: Some(15.0 * 60_000.0) },
            )
            .await
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write_lines(path: &std::path::Path, lines: &[Value]) {
        let mut s = lines.iter().map(|o| o.to_string()).collect::<Vec<_>>().join("\n");
        s.push('\n');
        std::fs::write(path, s).unwrap();
    }

    /// Single raw-block Zstandard frame (valid frame, no compression).
    fn zstd_raw_frame(data: &[u8]) -> Vec<u8> {
        let mut out = vec![0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x50];
        let hdr = ((data.len() as u32) << 3) | 1;
        out.extend_from_slice(&hdr.to_le_bytes()[..3]);
        out.extend_from_slice(data);
        out
    }

    async fn parse(root: &std::path::Path) -> Vec<UsageEvent> {
        parse_codex_internal(vec![root.to_string_lossy().to_string()], ParseCodexOptions::default()).await.unwrap()
    }

    #[test]
    fn identity() {
        let a = agent();
        assert_eq!(a.id.as_str(), "codex");
        assert_eq!(a.label, "OpenAI Codex");
        assert!(a.parse_light.is_some());
    }

    #[test]
    fn path_helpers() {
        assert!(is_compressed_codex_rollout("/x/rollout-1.JSONL.ZST"));
        assert!(is_compressed_codex_rollout("/x/rollout-1.jsonl.zstd"));
        assert!(!is_compressed_codex_rollout("/x/rollout-1.jsonl"));
        assert_eq!(codex_plain_rollout_sibling("/x/a.jsonl.zst"), "/x/a.jsonl");
        assert_eq!(codex_rollout_identity("/x/Rollout-A.jsonl.zstd"), "rollout-a.jsonl");
        assert!(is_noise_path("C:\\a\\Fixtures\\b.jsonl"));
        assert!(is_mirror_codex_root("C:\\x\\codex-runtime-home\\home"));
        assert_eq!(recent_codex_day_rels(1_785_646_980_000.0, 1).iter().any(|d| d == "2026/08/02"), true);
    }

    #[tokio::test]
    async fn null_info_content_estimate() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
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
        write_lines(&sessions.join("rollout-test.jsonl"), &lines);
        let events = parse(root).await;
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.agent, AgentId::Codex);
        assert_eq!(e.estimated, Some(true));
        assert_eq!(e.input_tokens, 3.0);
        assert_eq!(e.output_tokens, 2.0);
        assert!(!e.source_path.contains('\u{2190}'));
        assert_eq!(e.cache_reported, None);
        assert_eq!(e.workspace.as_deref(), Some("C:\\Dev\\CursorProxy"));
        assert_eq!(e.timestamp, "2026-08-02T05:43:12.000Z");
    }

    #[tokio::test]
    async fn estimates_when_info_is_null() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("sessions")).unwrap();
        let lines = vec![
            json!({"timestamp":"2026-08-02T01:00:00.000Z","type":"session_meta","payload":{"session_id":"s2","model":"gpt-test","cwd":"C:\\Dev"}}),
            json!({"timestamp":"2026-08-02T01:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}),
            json!({"timestamp":"2026-08-02T01:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"u".repeat(40)}]}}),
            json!({"timestamp":"2026-08-02T01:00:03.000Z","type":"event_msg","payload":{"type":"token_count","info":null}}),
            json!({"timestamp":"2026-08-02T01:00:04.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":"a".repeat(20)}]}}),
            json!({"timestamp":"2026-08-02T01:00:05.000Z","type":"event_msg","payload":{"type":"task_complete"}}),
        ];
        write_lines(&root.join("sessions").join("rollout-est.jsonl"), &lines);
        let events = parse(root).await;
        assert!(!events.is_empty());
        let e = &events[0];
        assert_eq!(e.estimated, Some(true));
        assert_eq!(e.input_tokens, 10.0);
        assert_eq!(e.output_tokens, 5.0);
    }

    #[tokio::test]
    async fn real_token_count_info() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("sessions")).unwrap();
        let row = json!({"timestamp":"2026-08-02T02:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":25}}}});
        write_lines(&root.join("sessions").join("rollout-real.jsonl"), &[row]);
        let events = parse(root).await;
        assert!(events.iter().any(|e| e.input_tokens == 100.0 && e.output_tokens == 25.0));
        assert!(events.iter().all(|e| e.estimated != Some(true) || e.input_tokens == 100.0));
    }

    #[tokio::test]
    async fn orca_records_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("sessions")).unwrap();
        let first = json!({"input_tokens":1000,"cached_input_tokens":400,"output_tokens":20,"cache_write_input_tokens":5,"total_tokens":1020});
        let second = json!({"input_tokens":1300,"cached_input_tokens":800,"output_tokens":30,"cache_write_input_tokens":0,"total_tokens":1330});
        let lines = vec![
            json!({"timestamp":"2026-08-02T03:00:00.000Z","type":"token_usage_record","payload":{"type":"token_usage_record","usage":first}}),
            json!({"timestamp":"2026-08-02T03:00:00.100Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":first,"last_token_usage":first}}}),
            json!({"timestamp":"2026-08-02T03:00:01.000Z","type":"token_usage_record","payload":{"type":"token_usage_record","usage":second}}),
            json!({"timestamp":"2026-08-02T03:00:01.100Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2300,"cached_input_tokens":1200,"output_tokens":50,"cache_write_input_tokens":5},"last_token_usage":second}}}),
        ];
        write_lines(&root.join("sessions").join("rollout-orca.jsonl"), &lines);
        let events = parse(root).await;
        assert_eq!(events.len(), 2);
        let got: Vec<(f64, f64, f64, f64)> = events
            .iter()
            .map(|e| (e.input_tokens, e.output_tokens, e.cache_read_tokens, e.cache_write_tokens))
            .collect();
        assert_eq!(got, vec![(600.0, 20.0, 400.0, 5.0), (500.0, 30.0, 800.0, 0.0)]);
        let total: f64 = events.iter().map(|e| e.total_tokens).sum();
        assert_eq!(total, 2355.0);
    }

    #[tokio::test]
    async fn concatenated_zstd_frames() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let sessions = root.join("sessions").join("2026").join("08").join("02");
        std::fs::create_dir_all(&sessions).unwrap();
        let meta = format!(
            "{}\n",
            json!({"timestamp":"2026-08-02T03:00:00.000Z","type":"session_meta","payload":{"session_id":"compressed","model":"gpt-5","cwd":"/work/demo"}})
        );
        let tc = format!(
            "{}\n",
            json!({"timestamp":"2026-08-02T03:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":25}}}})
        );
        let mut bytes = zstd_raw_frame(meta.as_bytes());
        bytes.extend(zstd_raw_frame(tc.as_bytes()));
        std::fs::write(sessions.join("rollout-zstd.jsonl.zst"), bytes).unwrap();
        let events = parse(root).await;
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].input_tokens, 100.0);
        assert_eq!(events[0].output_tokens, 25.0);
        assert_eq!(events[0].estimated, None);
    }

    #[tokio::test]
    async fn plain_rollout_wins_over_compressed_sibling() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let sessions = root.join("sessions").join("2026").join("08").join("02");
        std::fs::create_dir_all(&sessions).unwrap();
        let row = |input: u32| {
            format!(
                "{}\n",
                json!({"timestamp":"2026-08-02T03:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":input,"output_tokens":25}}}})
            )
        };
        std::fs::write(sessions.join("rollout-sibling.jsonl"), row(100)).unwrap();
        std::fs::write(sessions.join("rollout-sibling.jsonl.zst"), zstd_raw_frame(row(200).as_bytes())).unwrap();
        let events = parse(root).await;
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].input_tokens, 100.0);
    }

    #[tokio::test]
    async fn cache_fields_and_record_mirror() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("sessions")).unwrap();
        let usage = json!({"input_tokens":1000,"cached_input_tokens":800,"cache_write_input_tokens":120,"output_tokens":25});
        let lines = vec![
            json!({"timestamp":"2026-08-02T03:00:00.000Z","type":"token_usage_record","payload":{"usage":usage}}),
            json!({"timestamp":"2026-08-02T03:00:00.500Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":usage,"total_token_usage":usage}}}),
        ];
        write_lines(&root.join("sessions").join("rollout-cache.jsonl"), &lines);
        let events = parse(root).await;
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!((e.input_tokens, e.output_tokens, e.cache_read_tokens, e.cache_write_tokens), (200.0, 25.0, 800.0, 120.0));
        assert_eq!(e.cache_reported, Some(true));
    }

    #[tokio::test]
    async fn sqlite_thread_summary_and_rollout_follow() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let db = root.join("state_5.sqlite");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE threads (id TEXT, rollout_path TEXT, model TEXT, tokens_used INTEGER, cwd TEXT, created_at INTEGER, updated_at INTEGER);
                 INSERT INTO threads VALUES ('t1', '', 'gpt-5', 1234, '/w', 1780000000, 1780000100);",
            )
            .unwrap();
        }
        let events = parse(root).await;
        let summary = events.iter().find(|e| e.estimated == Some(true)).expect("summary event");
        assert_eq!(summary.input_tokens, 1234.0);
        assert_eq!(summary.workspace.as_deref(), Some("/w"));
        assert_eq!(summary.model.as_deref(), Some("gpt-5"));
        assert_eq!(summary.source_path, db.to_string_lossy());
    }
}
