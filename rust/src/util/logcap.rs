//! Size cap for the append-only text logs under `%LOCALAPPDATA%\tokenlab`.

/// Max size of a log file before it is rotated to `<name>.1` (one generation kept).
pub const LOG_MAX_BYTES: u64 = 1024 * 1024;

/// Call before appending: when `path` exceeds [`LOG_MAX_BYTES`] it is renamed to
/// `<path>.1`, replacing the previous generation. Failures (file held open by
/// another process, permissions) are ignored; the append then simply continues.
pub fn rotate_log_if_big(path: &std::path::Path) {
    if let Ok(md) = std::fs::metadata(path) {
        if md.len() > LOG_MAX_BYTES {
            let mut rotated = path.as_os_str().to_owned();
            rotated.push(".1");
            let _ = std::fs::rename(path, std::path::PathBuf::from(rotated));
        }
    }
}
