//! Cheap boot-phase timing: `phase("label")` logs wall ms since process start and
//! process CPU ms so far to stdout (same sink as `slog`).

use std::sync::OnceLock;
use std::time::Instant;

static START: OnceLock<Instant> = OnceLock::new();

pub fn phase_init() {
    let _ = START.get_or_init(Instant::now);
}

#[cfg(windows)]
fn cpu_ms() -> u64 {
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct FileTime {
        lo: u32,
        hi: u32,
    }
    extern "system" {
        fn GetCurrentProcess() -> *mut core::ffi::c_void;
        fn GetProcessTimes(h: *mut core::ffi::c_void, c: *mut FileTime, e: *mut FileTime, k: *mut FileTime, u: *mut FileTime) -> i32;
    }
    let (mut c, mut e, mut k, mut u) = (FileTime::default(), FileTime::default(), FileTime::default(), FileTime::default());
    unsafe {
        if GetProcessTimes(GetCurrentProcess(), &mut c, &mut e, &mut k, &mut u) == 0 {
            return 0;
        }
    }
    let t = |f: FileTime| ((f.hi as u64) << 32) | f.lo as u64;
    (t(k) + t(u)) / 10_000
}

#[cfg(not(windows))]
fn cpu_ms() -> u64 {
    0
}

/// Phase logs are only emitted when `TOKENLAB_TRACE=1` (checked once).
fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var("TOKENLAB_TRACE").map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false))
}

pub fn phase(label: &str) {
    use std::io::Write;
    if !enabled() {
        return;
    }
    let wall = START.get_or_init(Instant::now).elapsed().as_millis();
    let _ = writeln!(std::io::stdout(), "[phase +{wall}ms cpu={}ms] {label}", cpu_ms());
}
