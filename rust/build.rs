//! Build script: make sure the Astro UI (`../web/dist`) is built before the
//! release binary is compiled, because `rust-embed` bakes `web/dist` into
//! `tokenlab.exe` at compile time.
//!
//! * Runs only for release builds (`cargo build --release`) so `cargo check`,
//!   `cargo test` and debug builds never touch the Node toolchain. Set
//!   `TOKENLAB_BUILD_WEB=1` to force it for any profile.
//! * `TOKENLAB_SKIP_WEB_BUILD=1` skips it entirely (e.g. CI that prebuilds `web/dist`).
//! * The Astro build is skipped when `web/dist/index.html` is newer than every
//!   file under `web/src`, `web/public` and the Astro/npm config files.
//! * `TOKENLAB_REQUIRE_WEB=1` turns a failed/unavailable UI build into a hard
//!   error; otherwise a warning is printed and the binary serves the API only.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

fn newest_mtime(path: &Path) -> Option<SystemTime> {
    let meta = std::fs::metadata(path).ok()?;
    let mut newest = meta.modified().ok();
    if meta.is_dir() {
        if let Ok(rd) = std::fs::read_dir(path) {
            for entry in rd.flatten() {
                if let Some(t) = newest_mtime(&entry.path()) {
                    newest = Some(match newest {
                        Some(n) if n >= t => n,
                        _ => t,
                    });
                }
            }
        }
    }
    newest
}

fn npm(web: &Path, args: &[&str]) -> bool {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg("npm");
        c
    } else {
        Command::new("npm")
    };
    cmd.args(args).current_dir(web);
    match cmd.status() {
        Ok(s) => s.success(),
        Err(_) => false,
    }
}

fn fail(msg: &str) {
    if std::env::var("TOKENLAB_REQUIRE_WEB").map_or(false, |v| v == "1") {
        panic!("{msg}");
    }
    println!("cargo:warning={msg}");
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into()));
    let web: PathBuf = manifest.join("..").join("web");
    let dist = web.join("dist");

    println!("cargo:rerun-if-env-changed=TOKENLAB_SKIP_WEB_BUILD");
    println!("cargo:rerun-if-env-changed=TOKENLAB_BUILD_WEB");
    println!("cargo:rerun-if-env-changed=TOKENLAB_REQUIRE_WEB");
    println!("cargo:rerun-if-changed=build.rs");
    for p in ["src", "public", "package.json", "package-lock.json", "astro.config.mjs", "tsconfig.json"] {
        println!("cargo:rerun-if-changed=../web/{p}");
    }

    if std::env::var("TOKENLAB_SKIP_WEB_BUILD").map_or(false, |v| v == "1") {
        return;
    }
    let release = std::env::var("PROFILE").map_or(false, |p| p == "release");
    let forced = std::env::var("TOKENLAB_BUILD_WEB").map_or(false, |v| v == "1");
    if !release && !forced {
        return;
    }
    if !web.join("package.json").exists() {
        fail("web/package.json not found; skipping UI build (binary will serve the API only)");
        return;
    }

    let index = dist.join("index.html");
    let dist_time = std::fs::metadata(&index).ok().and_then(|m| m.modified().ok());
    let mut src_time: Option<SystemTime> = None;
    for p in ["src", "public", "package.json", "package-lock.json", "astro.config.mjs", "tsconfig.json"] {
        if let Some(t) = newest_mtime(&web.join(p)) {
            src_time = Some(match src_time {
                Some(n) if n >= t => n,
                _ => t,
            });
        }
    }
    let up_to_date = match (dist_time, src_time) {
        (Some(d), Some(s)) => d >= s,
        (Some(_), None) => true,
        _ => false,
    };
    if up_to_date && !forced {
        return;
    }

    if !web.join("node_modules").exists() {
        let ok = if web.join("package-lock.json").exists() {
            npm(&web, &["ci"])
        } else {
            npm(&web, &["install"])
        };
        if !ok {
            let _ = std::fs::create_dir_all(&dist);
            fail("`npm install` failed in web/; UI is not embedded (binary will serve the API only)");
            return;
        }
    }
    if !npm(&web, &["run", "build"]) {
        let _ = std::fs::create_dir_all(&dist);
        fail("`npm run build` failed in web/; UI may be missing from the binary");
    }
}
