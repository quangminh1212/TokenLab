//! Port of `src/process-guard.ts`.
//!
//! Keep long-running `serve` alive: catch fatal errors (panics), write crash
//! logs, and emit a heartbeat file the Windows supervisor can use for hang
//! detection.

use crate::util::{local_app_data_dir, pjoin};
use chrono::{SecondsFormat, Utc};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Variadic JS log function collapsed to one pre-formatted message.
pub type LogFn = Arc<dyn Fn(&str) + Send + Sync>;

/// Name of the helper thread that runs user log callbacks after a panic. The
/// panic hook ignores panics raised on it (a broken stdout would otherwise
/// recurse forever).
const PANIC_LOG_THREAD: &str = "tokenlab-panic-log";

/// Process start reference for `process.uptime()`.
static PROCESS_START: Lazy<Instant> = Lazy::new(Instant::now);

fn data_dir() -> String {
    pjoin(&[local_app_data_dir().as_str(), "tokenlab"])
}

fn crash_log_path() -> String {
    pjoin(&[data_dir().as_str(), "crash.txt"])
}

/// `%LOCALAPPDATA%\tokenlab\heartbeat.txt`
pub fn heartbeat_path() -> String {
    pjoin(&[data_dir().as_str(), "heartbeat.txt"])
}

static INSTALLED: AtomicBool = AtomicBool::new(false);
static LAST_HEARTBEAT_WRITE: AtomicU64 = AtomicU64::new(0);
/// Sender half keeping the current heartbeat thread alive (TS `heartbeatTimer`).
static HEARTBEAT_STOP: Lazy<Mutex<Option<Sender<()>>>> = Lazy::new(|| Mutex::new(None));

fn ensure_data_dir() {
    let _ = std::fs::create_dir_all(data_dir());
}

fn iso_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn append_crash_log(line: &str) {
    ensure_data_dir();
    let result = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(crash_log_path())
        .and_then(|mut f| f.write_all(format!("[{}] {}\r\n", iso_now(), line).as_bytes()));
    let _ = result;
}

/// Non-panicking stderr line (a closed pipe must never take the process down).
fn safe_stderr(msg: &str) {
    let _ = writeln!(std::io::stderr(), "{msg}");
}

fn safe_stdout(msg: &str) {
    let _ = writeln!(std::io::stdout(), "{msg}");
}

/// Best-effort text for an arbitrary failure reason (TS `formatReason`).
pub fn format_reason(reason: &(dyn std::fmt::Display + '_)) -> String {
    reason.to_string()
}

fn now_ms_u64() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Write `<ms>\n<pid>\n<uptime-seconds>\n` so the VBS supervisor can detect a
/// hung process.
pub fn write_heartbeat() {
    Lazy::force(&PROCESS_START);
    ensure_data_dir();
    let now = now_ms_u64();
    // Avoid hammering disk if called very frequently
    let last = LAST_HEARTBEAT_WRITE.load(Ordering::Relaxed);
    if now.saturating_sub(last) < 2_000 && now >= last {
        return;
    }
    LAST_HEARTBEAT_WRITE.store(now, Ordering::Relaxed);
    let uptime = PROCESS_START.elapsed().as_secs();
    let body = format!("{}\n{}\n{}\n", now, std::process::id(), uptime);
    let _ = std::fs::write(heartbeat_path(), body);
}

/// Start the periodic heartbeat; the returned closure stops it and removes the
/// heartbeat file.
pub fn start_heartbeat(interval_ms: u64) -> Box<dyn Fn() + Send + Sync> {
    write_heartbeat();
    let (tx, rx) = mpsc::channel::<()>();
    {
        // Replacing the sender drops the old one, which ends the old thread.
        let mut slot = HEARTBEAT_STOP.lock();
        *slot = Some(tx);
    }
    let interval = Duration::from_millis(interval_ms.max(1));
    // Daemon-style thread (does not keep the process alive, like `.unref()`).
    let _ = std::thread::Builder::new()
        .name("tokenlab-heartbeat".into())
        .spawn(move || loop {
            match rx.recv_timeout(interval) {
                Err(RecvTimeoutError::Timeout) => write_heartbeat(),
                _ => break,
            }
        });
    Box::new(|| {
        HEARTBEAT_STOP.lock().take();
        let _ = std::fs::remove_file(heartbeat_path());
    })
}

/// Options for [`install_process_guard`].
#[derive(Default, Clone)]
pub struct ProcessGuardOptions {
    pub log: Option<LogFn>,
    pub log_error: Option<LogFn>,
}

fn default_log_error() -> LogFn {
    Arc::new(|m: &str| safe_stderr(&format!("[tokenlab] {m}")))
}

fn default_log() -> LogFn {
    Arc::new(|m: &str| safe_stdout(&format!("[tokenlab] {m}")))
}

static LOG_ERROR_FN: Lazy<Mutex<Option<LogFn>>> = Lazy::new(|| Mutex::new(None));

/// Equivalent of the `unhandledRejection` handler: log only, do not exit.
/// Call it for errors surfaced by detached async tasks.
pub fn report_unhandled_rejection(reason: &str) {
    let f = LOG_ERROR_FN.lock().clone().unwrap_or_else(default_log_error);
    f(&format!("unhandledRejection: {reason}"));
    append_crash_log(&format!("unhandledRejection: {reason}"));
}

fn is_broken_pipe_panic(msg: &str) -> bool {
    // println!/eprintln! panic with "failed printing to stdout/stderr: ..." when
    // the pipe is closed (EPIPE equivalent).
    msg.contains("failed printing to std") || msg.contains("Broken pipe") || msg.contains("os error 232")
}

fn panic_message(info: &std::panic::PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    let text = if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "panic".to_string()
    };
    match info.location() {
        Some(l) => format!("{text} at {}:{}:{}", l.file(), l.line(), l.column()),
        None => text,
    }
}

/// Install once per process:
/// - failures in background tasks -> log only (see [`report_unhandled_rejection`])
/// - panic on the main thread -> log crash, exit(1) so the supervisor restarts
///   a clean process; EPIPE-like panics (closed stdout/stderr) are ignored
/// - panics in worker threads / spawned tasks are logged and contained
pub fn install_process_guard(opts: Option<ProcessGuardOptions>) {
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    Lazy::force(&PROCESS_START);
    let opts = opts.unwrap_or_default();
    let log_error: LogFn = opts.log_error.unwrap_or_else(default_log_error);
    let log: LogFn = opts.log.unwrap_or_else(default_log);
    *LOG_ERROR_FN.lock() = Some(log_error.clone());

    let hook_log_error = log_error.clone();
    let hook_log = log.clone();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let tname = thread.name().unwrap_or("").to_string();
        if tname == PANIC_LOG_THREAD {
            // A user log callback panicked (e.g. closed stdout); never recurse.
            return;
        }
        let msg = format!(
            "{}\n{}",
            panic_message(info),
            std::backtrace::Backtrace::force_capture()
        );
        let broken_pipe = is_broken_pipe_panic(&msg);
        let is_main = tname == "main";

        if broken_pipe {
            // EPIPE during console output is common when supervisor/tray closes
            // the pipe - restarting here caused multi-minute scan lag loops.
            append_crash_log(&format!("uncaughtException ignored EPIPE: {msg}"));
            let le = hook_log_error.clone();
            let _ = std::thread::Builder::new().name(PANIC_LOG_THREAD.into()).spawn(move || {
                le("uncaughtException EPIPE/EOF ignored: broken pipe");
            });
            return;
        }

        if !is_main {
            // A spawned task / worker thread panicked: contained by its runtime,
            // equivalent to an unhandled rejection (log only).
            append_crash_log(&format!("unhandledRejection: thread '{tname}' panicked: {msg}"));
            let le = hook_log_error.clone();
            let _ = std::thread::Builder::new().name(PANIC_LOG_THREAD.into()).spawn(move || {
                le(&format!("unhandledRejection: thread '{tname}' panicked: {msg}"));
            });
            return;
        }

        append_crash_log(&format!("uncaughtException: {msg}"));
        safe_stderr(&format!("[tokenlab] uncaughtException: {msg}"));
        // Corrupted runtime state - exit so the supervisor restarts a clean process.
        write_heartbeat();
        // Run the user log callbacks off-hook (they may touch a closed stdout),
        // give them a short window, then exit(1) without waiting for unwinding.
        let (tx, rx) = mpsc::channel::<()>();
        let le = hook_log_error.clone();
        let lg = hook_log.clone();
        let _ = std::thread::Builder::new().name(PANIC_LOG_THREAD.into()).spawn(move || {
            le(&format!("uncaughtException: {msg}"));
            lg("exiting after uncaughtException for clean restart");
            let _ = tx.send(());
        });
        let _ = rx.recv_timeout(Duration::from_millis(250));
        std::process::exit(1);
    }));

    log("process guard installed (anti-crash + heartbeat)");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heartbeat_path_is_in_tokenlab_dir() {
        let p = heartbeat_path();
        assert!(p.ends_with("heartbeat.txt"));
        assert!(p.contains("tokenlab"));
    }

    #[test]
    fn broken_pipe_detection() {
        assert!(is_broken_pipe_panic("failed printing to stdout: Broken pipe (os error 32)"));
        assert!(!is_broken_pipe_panic("index out of bounds"));
    }
}
