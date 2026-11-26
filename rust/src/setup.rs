//! Port of `src/setup.ts`.
//!
//! First-run bootstrap: enable Windows login autostart + start serve
//! (detached) if not already up. The browser is opened only when `open` is
//! requested (`--open`); the desktop launcher passes `--open`.

use crate::autostart::{
    clear_stop_sentinel, enable_autostart, get_autostart_status, install_desktop_shortcut,
    launch_supervisor_now, resolve_serve_invocation, LaunchSupervisorOptions,
};
use crate::util::{env_nonempty, open_browser};
use serde::Serialize;
use std::process::Stdio;
use std::time::Duration;

#[derive(Debug, Clone, Default)]
pub struct SetupOptions {
    /// Open dashboard in browser when starting or if already up (default false).
    pub open: Option<bool>,
    /// Register login autostart on Windows (default true).
    pub autostart: Option<bool>,
    /// Create/refresh Desktop shortcut to launch the app (default true).
    pub desktop: Option<bool>,
    /// Start serve process if not running (default true).
    pub serve: Option<bool>,
    pub host: Option<String>,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SetupResult {
    pub ok: bool,
    pub message: String,
    pub server_running: bool,
    pub server_started: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub autostart_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desktop_shortcut: Option<String>,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

fn default_host() -> String {
    env_nonempty("TOKENLAB_HOST").unwrap_or_else(|| "127.0.0.1".to_string())
}

fn default_port() -> u16 {
    env_nonempty("TOKENLAB_PORT")
        .and_then(|p| p.trim().parse::<u16>().ok())
        .unwrap_or(3737)
}

pub async fn is_server_reachable(host: &str, port: u16) -> bool {
    let url = format!("http://{host}:{port}/api/health");
    let client = match reqwest::Client::builder().no_proxy().build() {
        Ok(c) => c,
        Err(_) => return false,
    };
    match tokio::time::timeout(Duration::from_millis(1500), client.get(&url).send()).await {
        Ok(Ok(res)) => res.status().is_success(),
        _ => false,
    }
}

fn start_serve_detached(open: bool, host: &str, port: u16) {
    let inv = match resolve_serve_invocation() {
        Ok(i) => i,
        Err(_) => return,
    };
    let mut args: Vec<String> = inv.args.clone();
    args.extend([
        "--host".to_string(),
        host.to_string(),
        "--port".to_string(),
        port.to_string(),
    ]);
    if open {
        args.push("--open".to_string());
    }
    let mut cmd = std::process::Command::new(&inv.exe);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(dir) = std::path::Path::new(&inv.exe).parent() {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP (Node `detached: true`)
        cmd.creation_flags(0x0000_0008 | 0x0000_0200);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    // spawn and forget
    let _ = cmd.spawn();
}

async fn wait_for_server(host: &str, port: u16, ms: u64) -> bool {
    let steps = std::cmp::max(1, (ms + 249) / 250);
    for _ in 0..steps {
        if is_server_reachable(host, port).await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    is_server_reachable(host, port).await
}

/// Enable autostart (Windows) and ensure local dashboard is running.
/// Safe to call repeatedly; never fails for expected platform limits.
pub async fn run_setup(opts: SetupOptions) -> SetupResult {
    let open = opts.open == Some(true);
    let want_autostart = opts.autostart != Some(false);
    let want_desktop = opts.desktop != Some(false);
    let want_serve = opts.serve != Some(false);
    let host = opts
        .host
        .filter(|h| !h.is_empty())
        .unwrap_or_else(default_host);
    let port = opts.port.unwrap_or_else(default_port);
    let url = format!("http://{host}:{port}/");

    // Fast path: server already up -> open the dashboard immediately, before the
    // (slow) autostart/shortcut refresh below.
    let mut opened_early = false;
    if open && want_serve && is_server_reachable(&host, port).await {
        open_browser(&url);
        opened_early = true;
    }

    let mut parts: Vec<String> = Vec::new();
    let mut autostart_enabled: Option<bool> = None;
    let mut desktop_shortcut: Option<String> = None;

    if want_autostart {
        // Already running + autostart registered: don't kill/restart the supervisor
        // on every click (the launcher VBS is refreshed on the next real start).
        let skip_refresh = opened_early && cfg!(windows) && get_autostart_status().await.enabled;
        if skip_refresh {
            autostart_enabled = Some(true);
            parts.push("autostart ON".to_string());
        } else if cfg!(windows) {
            let result = enable_autostart().await;
            autostart_enabled = Some(result.status.enabled);
            parts.push(if result.ok {
                "autostart ON".to_string()
            } else {
                format!("autostart failed: {}", result.message)
            });
        } else {
            let st = get_autostart_status().await;
            autostart_enabled = Some(false);
            parts.push(
                st.detail
                    .filter(|d| !d.is_empty())
                    .unwrap_or_else(|| "autostart not available on this platform".to_string()),
            );
        }
    }

    if want_desktop {
        let desk = install_desktop_shortcut().await;
        if desk.ok {
            if let Some(p) = desk.path.filter(|p| !p.is_empty()) {
                desktop_shortcut = Some(p);
            }
            parts.push("desktop shortcut ready".to_string());
        } else {
            parts.push(desk.message);
        }
    }

    let mut server_running = is_server_reachable(&host, port).await;
    let mut server_started = false;

    if want_serve {
        if server_running {
            parts.push("server already running".to_string());
            if open && !opened_early {
                open_browser(&url);
            }
        } else {
            // Allow a fresh start even if user previously Quit (stop.flag present).
            clear_stop_sentinel().await;
            // Windows: start the same supervised VBS used at login so serve + tray
            // stay alive and auto-restart. Plain detached serve often dies with no tray.
            if cfg!(windows) {
                let mut sup = launch_supervisor_now(LaunchSupervisorOptions::default()).await;
                parts.push(if sup.ok {
                    sup.message.clone()
                } else {
                    format!("supervisor: {}", sup.message)
                });
                // Supervisor may be stuck in a dual-instance crash loop - wait briefly,
                // then force a single clean supervisor if health never comes up.
                server_running = wait_for_server(&host, port, 12_000).await;
                if !server_running {
                    // Dual/zombie supervisors can loop forever without binding :3737
                    sup = launch_supervisor_now(LaunchSupervisorOptions { force_restart: true })
                        .await;
                    parts.push(if sup.ok {
                        "supervisor force-restarted".to_string()
                    } else {
                        format!("supervisor force-restart failed: {}", sup.message)
                    });
                    if !sup.ok {
                        start_serve_detached(open, &host, port);
                    }
                    server_running = wait_for_server(&host, port, 15_000).await;
                }
            } else {
                start_serve_detached(open, &host, port);
                server_running = wait_for_server(&host, port, 10_000).await;
            }
            server_started = true;
            parts.push(if server_running {
                format!("started server + tray at {url}")
            } else {
                format!("started server in background (dashboard: {url})")
            });
            if open && server_running {
                open_browser(&url);
            }
        }
    }

    let joined = parts.join("; ");
    SetupResult {
        ok: true,
        message: if joined.is_empty() {
            "setup complete".to_string()
        } else {
            joined.clone()
        },
        server_running,
        server_started,
        autostart_enabled,
        desktop_shortcut,
        url,
        detail: Some(joined),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn result_serializes_like_ts() {
        let r = SetupResult {
            ok: true,
            message: "m".into(),
            server_running: false,
            server_started: false,
            autostart_enabled: None,
            desktop_shortcut: None,
            url: "http://127.0.0.1:3737/".into(),
            detail: Some(String::new()),
        };
        assert_eq!(
            serde_json::to_string(&r).unwrap(),
            r#"{"ok":true,"message":"m","serverRunning":false,"serverStarted":false,"url":"http://127.0.0.1:3737/","detail":""}"#
        );
    }
}
