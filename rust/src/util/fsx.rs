//! Filesystem helpers (port of pathExists / walkFiles / readText / stampFile).

use super::pathx::PathFlavor;
use std::sync::Arc;

pub async fn path_exists(p: &str) -> bool {
    tokio::fs::metadata(p).await.is_ok()
}

pub fn path_exists_sync(p: &str) -> bool {
    std::fs::metadata(p).is_ok()
}

/// Predicate over (file name, full path).
pub type WalkMatch = Arc<dyn Fn(&str, &str) -> bool + Send + Sync>;

#[derive(Clone, Default)]
pub struct WalkOptions {
    /// Default 8.
    pub max_depth: Option<usize>,
    pub matcher: Option<WalkMatch>,
    /// Extra directory names (exact, case-insensitive) to prune in addition to the built-in list.
    pub skip_dirs: Option<&'static [&'static str]>,
}

/// Chromium/Electron cache directories that never hold agent usage logs.
pub const ELECTRON_CACHE_DIRS: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnCache",
    "GrShaderCache",
    "ShaderCache",
    "CachedData",
    "CachedExtensionVSIXs",
    "Crashpad",
    "IndexedDB",
    "Service Worker",
    "blob_storage",
    "Session Storage",
    "Local Storage",
    "component_crx_cache",
];

impl WalkOptions {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn max_depth(mut self, d: usize) -> Self {
        self.max_depth = Some(d);
        self
    }
    pub fn skipping(mut self, dirs: &'static [&'static str]) -> Self {
        self.skip_dirs = Some(dirs);
        self
    }
    pub fn matching(mut self, f: impl Fn(&str, &str) -> bool + Send + Sync + 'static) -> Self {
        self.matcher = Some(Arc::new(f));
        self
    }
}

fn skip_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | ".git" | ".tmp" | "tmp" | "fixtures" | "__tests__" | "testdata" | "mocks"
    )
}

fn walk_sync(
    dir: &str,
    depth: usize,
    max_depth: usize,
    m: &Option<WalkMatch>,
    extra_skip: Option<&'static [&'static str]>,
    out: &mut Vec<String>,
) {
    if depth > max_depth {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    let flavor = PathFlavor::host();
    let mut subdirs: Vec<String> = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let full = flavor.join(&[dir, name.as_str()]);
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            if skip_dir(&name) || extra_skip.map_or(false, |l| l.iter().any(|s| s.eq_ignore_ascii_case(&name))) {
                continue;
            }
            subdirs.push(full);
        } else if ft.is_file() {
            if m.as_ref().map_or(true, |f| f(&name, &full)) {
                out.push(full);
            }
        }
    }
    for d in subdirs {
        walk_sync(&d, depth + 1, max_depth, m, extra_skip, out);
    }
}

/// Recursively list files below `root` (skips VCS / deps / fixture trees).
pub async fn walk_files(root: &str, options: WalkOptions) -> Vec<String> {
    let root = root.to_string();
    tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        if !path_exists_sync(&root) {
            return out;
        }
        walk_sync(&root, 0, options.max_depth.unwrap_or(8), &options.matcher, options.skip_dirs, &mut out);
        out
    })
    .await
    .unwrap_or_default()
}

/// Blocking variant of [`walk_files`].
pub fn walk_files_sync(root: &str, options: &WalkOptions) -> Vec<String> {
    let mut out = Vec::new();
    if !path_exists_sync(root) {
        return out;
    }
    walk_sync(root, 0, options.max_depth.unwrap_or(8), &options.matcher, options.skip_dirs, &mut out);
    out
}

/// V8 / Node `buffer.constants.MAX_STRING_LENGTH` on 64-bit builds. The TS reader decodes with
/// `readFile(file, "utf8")`, which fails (and `readText` maps to null) once the decoded string would
/// exceed this many UTF-16 code units, so a rollout log larger than about 512 MiB is treated as
/// unreadable. Mirrored here so both builds attribute those sessions identically.
pub const JS_MAX_STRING_LENGTH: usize = 0x1fff_ffe8;

/// Decode like `buffer.toString("utf8")`: lossy, and None when the result exceeds the V8 string limit.
pub fn decode_utf8_js(bytes: Vec<u8>) -> Option<String> {
    let text = match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    };
    if text.len() > JS_MAX_STRING_LENGTH && super::js::js_len(&text) > JS_MAX_STRING_LENGTH {
        return None;
    }
    Some(text)
}

/// `readFile(file, "utf8")` returning None on any failure.
pub async fn read_text(file: &str) -> Option<String> {
    let bytes = tokio::fs::read(file).await.ok()?;
    decode_utf8_js(bytes)
}

pub fn read_text_sync(file: &str) -> Option<String> {
    let bytes = std::fs::read(file).ok()?;
    decode_utf8_js(bytes)
}

/// Cheap file identity for cache invalidation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FileStamp {
    pub size: u64,
    pub mtime_ms: f64,
}

pub fn stamp_from_metadata(m: &std::fs::Metadata) -> FileStamp {
    let mtime_ms = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as f64 * 1000.0 + d.subsec_nanos() as f64 / 1e6)
        .unwrap_or(0.0);
    FileStamp { size: m.len(), mtime_ms }
}

/// Stat a file for cache keying; None when missing/unreadable/not a file.
pub async fn stamp_file(file: &str) -> Option<FileStamp> {
    let m = tokio::fs::metadata(file).await.ok()?;
    if !m.is_file() {
        return None;
    }
    Some(stamp_from_metadata(&m))
}

pub fn stamp_file_sync(file: &str) -> Option<FileStamp> {
    let m = std::fs::metadata(file).ok()?;
    if !m.is_file() {
        return None;
    }
    Some(stamp_from_metadata(&m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn walk_skips_noise_dirs_and_matches() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        std::fs::create_dir_all(dir.path().join("a/b")).unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/x")).unwrap();
        std::fs::write(dir.path().join("a/one.jsonl"), "{}").unwrap();
        std::fs::write(dir.path().join("a/b/two.jsonl"), "{}").unwrap();
        std::fs::write(dir.path().join("a/b/skip.txt"), "x").unwrap();
        std::fs::write(dir.path().join("node_modules/x/no.jsonl"), "{}").unwrap();
        let mut files = walk_files(&root, WalkOptions::new().matching(|n, _| n.ends_with(".jsonl"))).await;
        files.sort();
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|f| f.ends_with("one.jsonl")));
        assert!(path_exists(&root).await);
        assert!(stamp_file(&files[0]).await.is_some());
        assert!(stamp_file(&root).await.is_none());
        assert!(read_text("/definitely/missing").await.is_none());
    }

    #[tokio::test]
    async fn walk_respects_depth() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        std::fs::create_dir_all(dir.path().join("a/b")).unwrap();
        std::fs::write(dir.path().join("a/b/deep.txt"), "x").unwrap();
        let shallow = walk_files(&root, WalkOptions::new().max_depth(1)).await;
        assert!(shallow.is_empty());
        let deep = walk_files(&root, WalkOptions::new().max_depth(2)).await;
        assert_eq!(deep.len(), 1);
    }
}
