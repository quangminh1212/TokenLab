//! Port of `src/cli.ts` (command dispatcher, help text and output formats).

use crate::aggregate::{aggregate, cost_report, SortBy};
use crate::agents::{detect_agents, scan_all, ScanAllOptions};
use crate::autostart::{
    disable_autostart, enable_autostart, get_autostart_status, write_stop_sentinel,
};
use crate::backup::{
    download_backup_from_gist, load_imported_events, load_scan_cache,
    merge_local_prefer_over_gist_rollups, migrate_legacy_data_dir,
    replace_fresh_agent_session_events, replace_fresh_agent_source_events,
    upload_backup_to_gist, UploadOpts,
};
use crate::config::get_config_sync;
use crate::process_guard::{install_process_guard, start_heartbeat, LogFn, ProcessGuardOptions};
use crate::server::{start_server, ServerOptions};
use crate::setup::{run_setup, SetupOptions};
use crate::tray::{start_tray, TrayOptions};
use crate::types::{jsnum, GroupBy, UsageEvent};
use crate::util::{
    cwd_string, env_nonempty, filter_by_period, format_tokens, format_usd, host_platform,
    js_num_to_string, js_number_from_str, js_to_fixed, open_browser,
};
use crate::version::VERSION;
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// logging: %LOCALAPPDATA%\tokenlab\server.txt

fn log_dir() -> PathBuf {
    let base = env_nonempty("LOCALAPPDATA")
        .or_else(|| env_nonempty("APPDATA"))
        .unwrap_or_else(cwd_string);
    PathBuf::from(base).join("tokenlab")
}

fn log(message: &str) {
    use std::io::Write;
    let line = format!(
        "[{}] {}",
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        message
    );
    let dir = log_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("server.txt"))
        .and_then(|mut f| f.write_all(format!("{line}\r\n").as_bytes()));
}

fn log_error(message: &str) {
    log(&format!("[ERROR] {message}"));
}

// ---------------------------------------------------------------------------
// helpers

fn print_help() {
    println!(
        "tokenlab v{VERSION}

Local-first token API usage & cost tracker for AI agents on this machine.

Usage:
  tokenlab serve [--host 127.0.0.1] [--port 3737] [--no-ui] [--open] [--no-tray]
  tokenlab setup [--open] [--no-autostart] [--no-desktop] [--no-serve] [--json]
  tokenlab stats [--since 24h|7d|30d] [--by agent|model|day] [--sort tokens|cost] [--json]
  tokenlab cost  [--since 7d] [--json]
  tokenlab scan  [--json]
  tokenlab doctors [--json]
  tokenlab autostart [on|off|status] [--json]
  tokenlab backup upload [--token <token>] [--gist <id>] [--public] [--save-token] [--json]
  tokenlab backup download [--token <token>] [--gist <id>] [--json]
  tokenlab backup status
  tokenlab --version
  tokenlab --help

Serve options:
  --open       Open dashboard in browser
  --no-ui      API only (no HTML UI)
  --no-tray    Do not show system tray icon (Windows)

Backup options:
  --token      GitHub personal access token
  --gist       Gist id to update/download
  --public     Make the Gist public (default: secret)
  --save-token Save the token to local config

Setup:
  Enables Windows login autostart, creates a Desktop shortcut, and starts the dashboard if not already running.
  --open          Open the dashboard in the browser (default: do not open)
  --no-autostart  Skip login autostart registration
  --no-desktop    Skip Desktop shortcut (TokenLab.lnk)
  --no-serve      Do not start the server

Autostart (Windows):
  on           Start tokenlab serve at Windows login (supervised, auto-restart)
  off          Remove login autostart
  status       Show whether autostart is enabled

Platforms: Windows, macOS, Linux

Inspired by tokscale / codeburn / ccusage feature sets — original implementation.
"
    );
}

/// `args[args.indexOf(name) + 1] ?? null`.
fn get_flag(args: &[String], name: &str) -> Option<String> {
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1).cloned()
}

/// `getFlag(args, name) || undefined` (empty string counts as missing).
fn get_flag_nonempty(args: &[String], name: &str) -> Option<String> {
    get_flag(args, name).filter(|s| !s.is_empty())
}

fn has(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

/// `getFlag(args, "--port") ? Number(...) : undefined`, then the server's own
/// `opts.port || default` (NaN / 0 fall back to the default).
fn parse_port(args: &[String]) -> Result<Option<u16>, String> {
    let Some(raw) = get_flag_nonempty(args, "--port") else {
        return Ok(None);
    };
    let n = js_number_from_str(&raw);
    if n.is_nan() || n == 0.0 {
        return Ok(None);
    }
    if n.fract() != 0.0 || !(0.0..=65535.0).contains(&n) {
        return Err(format!("options.port should be >= 0 and < 65536. Received {raw}."));
    }
    Ok(Some(n as u16))
}

/// `String.prototype.padEnd` (UTF-16 length based).
fn pad_end(s: &str, width: usize) -> String {
    let len = s.encode_utf16().count();
    if len >= width {
        s.to_string()
    } else {
        format!("{s}{}", " ".repeat(width - len))
    }
}

/// `String.prototype.padStart` (UTF-16 length based).
fn pad_start(s: &str, width: usize) -> String {
    let len = s.encode_utf16().count();
    if len >= width {
        s.to_string()
    } else {
        format!("{}{s}", " ".repeat(width - len))
    }
}

fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

/// `JSON.stringify(value, null, 2)`.
fn to_json<T: Serialize>(value: &T) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_string())
}

/// Build the full event set for CLI commands (stats / cost / scan / doctors).
/// Mirrors the server's cache composition: scan-cache + imported-events (Gist
/// restore / multi-machine) unioned with a fresh local re-scan, so CLI totals
/// never drop below what the dashboard shows. Usage only grows.
async fn load_full_events() -> Vec<UsageEvent> {
    // Serialised (not joined) so peak memory stays low: cache + imports first,
    // then the fresh scan.
    let cached = load_scan_cache().await;
    let imported = load_imported_events().await;
    let scanned = scan_all(ScanAllOptions::default()).await;
    // Fresh Claude Code source rows replace pre-dedupe cache rows.
    let mut local = replace_fresh_agent_source_events(&scanned, &cached, "claude-code");
    local = replace_fresh_agent_session_events(&scanned, &local, "grok");
    // Then merge imported + drop same-machine Gist rollups when local covers key.
    merge_local_prefer_over_gist_rollups(&local, &imported, None)
}

// ---------------------------------------------------------------------------
// entry point

/// CLI entry point. `args` are the process arguments WITHOUT the program name
/// (`process.argv.slice(2)`). Returns the process exit code (`process.exitCode`).
pub async fn run(args: Vec<String>) -> anyhow::Result<i32> {
    let cmd = args.first().map(|s| s.as_str());

    match cmd {
        None | Some("--help") | Some("-h") | Some("help") => {
            print_help();
            return Ok(0);
        }
        Some("--version") | Some("-v") | Some("version") => {
            println!("{VERSION}");
            return Ok(0);
        }
        _ => {}
    }
    let cmd = cmd.unwrap_or_default();

    // One-time migration from pre-rename data dir so usage never silently drops
    // after the XLab Token -> TokenLab rename. Idempotent.
    migrate_legacy_data_dir().await;

    match cmd {
        "serve" => cmd_serve(&args).await,
        "setup" => cmd_setup(&args).await,
        "autostart" => cmd_autostart(&args).await,
        "backup" => cmd_backup(&args).await,
        "scan" => cmd_scan(&args).await,
        "doctors" | "doctor" => cmd_doctors(&args).await,
        "stats" => cmd_stats(&args).await,
        "cost" => cmd_cost(&args).await,
        _ => {
            eprintln!("Unknown command: {cmd}");
            print_help();
            Ok(1)
        }
    }
}

// ---------------------------------------------------------------------------
// serve

async fn cmd_serve(args: &[String]) -> anyhow::Result<i32> {
    log("CLI serve command started");
    log(&format!("Args: {}", args.join(" ")));
    // Anti-crash: panic/log guard; heartbeat for hang watchdog.
    let log_fn: LogFn = Arc::new(|m: &str| log(m));
    let log_error_fn: LogFn = Arc::new(|m: &str| log_error(m));
    install_process_guard(Some(ProcessGuardOptions {
        log: Some(log_fn),
        log_error: Some(log_error_fn),
    }));
    let stop_heartbeat = start_heartbeat(15_000);

    let host = get_flag_nonempty(args, "--host");
    let no_ui = has(args, "--no-ui");
    let should_open = has(args, "--open") || env_nonempty("TOKENLAB_OPEN").as_deref() == Some("1");
    let no_tray = has(args, "--no-tray")
        || env_nonempty("TOKENLAB_NO_TRAY").as_deref() == Some("1")
        || no_ui;

    let port = match parse_port(args) {
        Ok(p) => p,
        Err(msg) => {
            stop_heartbeat();
            log_error(&format!("Failed to start server: {msg}"));
            eprintln!("{msg}");
            return Ok(1);
        }
    };

    log(&format!(
        "Starting server with host: {} port: {} noUi: {}",
        host.as_deref().unwrap_or("undefined"),
        port.map_or("undefined".to_string(), |p| p.to_string()),
        no_ui
    ));
    let srv = match start_server(ServerOptions { host, port, no_ui }).await {
        Ok(s) => s,
        Err(err) => {
            stop_heartbeat();
            let msg = err.to_string();
            log_error(&format!("Failed to start server: {msg}"));
            eprintln!("{msg}");
            return Ok(1);
        }
    };

    let ui_url = format!("http://{}:{}/", srv.host, srv.port);
    log(&format!("Server started at {}:{}", srv.host, srv.port));
    println!("TokenLab v{VERSION}  ({}/{})", host_platform(), node_arch());
    println!("API  http://{}:{}/api/health", srv.host, srv.port);
    if !no_ui {
        println!("UI   {ui_url}");
    }
    println!("Scanning agents in background…");
    println!("Press Ctrl+C to stop");
    if should_open && !no_ui {
        open_browser(&ui_url);
    }

    // Shutdown requests: signals and the tray "Quit" item all funnel here.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<&'static str>();
    spawn_signal_listeners(tx.clone());

    let mut tray_stop: Option<Box<dyn Fn() + Send + Sync>> = None;
    if !no_tray && !no_ui {
        let tray_tx = tx.clone();
        let started = start_tray(TrayOptions {
            url: ui_url.clone(),
            title: Some("TokenLab".to_string()),
            tooltip: Some(format!("TokenLab :{}", srv.port)),
            on_quit: Arc::new(move || {
                let _ = tray_tx.send("tray");
            }),
        })
        .await;
        if let Some(tray) = started {
            tray_stop = Some(Box::new(move || tray.stop()));
            log("Tray icon enabled (auto-restart on tray crash)");
            println!("Tray icon enabled (double-click or menu → Open Dashboard)");
        }
    }

    let signal = rx.recv().await.unwrap_or("SIGINT");
    log(&format!("Shutdown signal received: {signal}"));
    // Order matters on Windows supervised runs:
    // 1) stop.flag first so supervisor will not auto-restart
    // 2) flush scan-cache + close HTTP while heartbeat still ticks
    // 3) only then stop heartbeat / tray and exit
    // Skip stop.flag on SIGHUP (dev watch) so dev restarts keep working.
    // Bounded: a locked cache file / slow disk must never make Quit hang forever,
    // and a second signal forces an immediate exit.
    let graceful = async {
        if signal != "SIGHUP" {
            let _ = tokio::time::timeout(Duration::from_secs(3), write_stop_sentinel()).await;
        }
        srv.close().await;
    };
    // Persist usage BEFORE exit — tray Quit used to race the supervisor kill
    // and drop today's cost/token totals.
    // Independent OS-thread watchdog: a synchronous stall inside close() cannot
    // be interrupted by a tokio timeout, so force exit before the supervisor's
    // 30s grace expires and it taskkills us mid-write.
    let _ = std::thread::Builder::new()
        .name("tokenlab-shutdown-watchdog".into())
        .spawn(|| {
            std::thread::sleep(Duration::from_secs(20));
            log_error("Shutdown watchdog: close() did not finish in 20s - forcing exit");
            std::process::exit(0);
        });
    tokio::select! {
        r = tokio::time::timeout(Duration::from_secs(15), graceful) => {
            if r.is_err() {
                log_error("Server close timed out after 15s - exiting anyway");
            } else {
                log("Server closed (scan cache flushed)");
            }
        }
        _ = rx.recv() => log("Second shutdown signal - forcing exit"),
    }
    stop_heartbeat();
    if let Some(stop) = tray_stop {
        stop();
    }
    std::process::exit(0);
}

#[cfg(unix)]
fn spawn_signal_listeners(tx: tokio::sync::mpsc::UnboundedSender<&'static str>) {
    use tokio::signal::unix::{signal, SignalKind};
    let streams = [
        (SignalKind::interrupt(), "SIGINT"),
        (SignalKind::terminate(), "SIGTERM"),
        (SignalKind::hangup(), "SIGHUP"),
    ];
    for (kind, name) in streams {
        if let Ok(mut s) = signal(kind) {
            let tx = tx.clone();
            tokio::spawn(async move {
                while s.recv().await.is_some() {
                    let _ = tx.send(name);
                }
            });
        }
    }
}

#[cfg(windows)]
fn spawn_signal_listeners(tx: tokio::sync::mpsc::UnboundedSender<&'static str>) {
    // SIGHUP (console close) is intentionally not handled on Windows: in
    // production it must not tear down a healthy serve (see TS allowSighup).
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            while tokio::signal::ctrl_c().await.is_ok() {
                let _ = tx.send("SIGINT");
            }
        });
    }
    if let Ok(mut s) = tokio::signal::windows::ctrl_break() {
        let tx = tx.clone();
        tokio::spawn(async move {
            while s.recv().await.is_some() {
                let _ = tx.send("SIGTERM");
            }
        });
    }
    if let Ok(mut s) = tokio::signal::windows::ctrl_shutdown() {
        tokio::spawn(async move {
            while s.recv().await.is_some() {
                let _ = tx.send("SIGTERM");
            }
        });
    }
}

#[cfg(not(any(unix, windows)))]
fn spawn_signal_listeners(tx: tokio::sync::mpsc::UnboundedSender<&'static str>) {
    tokio::spawn(async move {
        while tokio::signal::ctrl_c().await.is_ok() {
            let _ = tx.send("SIGINT");
        }
    });
}

// ---------------------------------------------------------------------------
// setup

async fn cmd_setup(args: &[String]) -> anyhow::Result<i32> {
    let as_json = has(args, "--json");
    let from_postinstall = has(args, "--from-postinstall");
    let port = match parse_port(args) {
        Ok(p) => p,
        Err(msg) => {
            if from_postinstall {
                eprintln!("tokenlab: setup skipped ({msg})");
                return Ok(0);
            }
            eprintln!("{msg}");
            return Ok(1);
        }
    };
    let result = run_setup(SetupOptions {
        open: Some(has(args, "--open")),
        autostart: Some(!has(args, "--no-autostart")),
        desktop: Some(!has(args, "--no-desktop")),
        serve: Some(!has(args, "--no-serve")),
        host: get_flag_nonempty(args, "--host"),
        port,
    })
    .await;
    if as_json {
        println!("{}", to_json(&result));
    } else if from_postinstall {
        println!("tokenlab: {}", result.message);
        println!("tokenlab: dashboard {}", result.url);
        if let Some(d) = &result.desktop_shortcut {
            println!("tokenlab: desktop {d}");
        }
    } else {
        println!("{}", result.message);
        println!("Dashboard: {}", result.url);
        if let Some(enabled) = result.autostart_enabled {
            println!("Autostart: {}", if enabled { "ON" } else { "OFF" });
        }
        if let Some(d) = &result.desktop_shortcut {
            println!("Desktop: {d}");
        }
    }
    Ok(if result.ok { 0 } else { 1 })
}

// ---------------------------------------------------------------------------
// autostart

async fn cmd_autostart(args: &[String]) -> anyhow::Result<i32> {
    log(&format!("Autostart command received: {}", args.join(" ")));
    let sub = args
        .get(1)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase())
        .unwrap_or_else(|| "status".to_string());
    let as_json = has(args, "--json");
    match sub.as_str() {
        "on" | "enable" | "install" => {
            let result = enable_autostart().await;
            if as_json {
                println!("{}", to_json(&result));
            } else {
                println!("{}", result.message);
                if let Some(detail) = result.status.detail.as_deref().filter(|d| !d.is_empty()) {
                    println!("{detail}");
                }
            }
            Ok(if result.ok { 0 } else { 1 })
        }
        "off" | "disable" | "uninstall" | "remove" => {
            let result = disable_autostart().await;
            if as_json {
                println!("{}", to_json(&result));
            } else {
                println!("{}", result.message);
            }
            Ok(if result.ok { 0 } else { 1 })
        }
        "status" | "show" => {
            let status = get_autostart_status().await;
            if as_json {
                println!("{}", to_json(&status));
            } else {
                println!(
                    "Autostart: {}  ({})",
                    if status.enabled { "ON" } else { "OFF" },
                    status.platform
                );
                if let Some(m) = status.method.as_deref().filter(|s| !s.is_empty()) {
                    println!("Method:  {m}");
                }
                if let Some(d) = status.detail.as_deref().filter(|s| !s.is_empty()) {
                    println!("Detail:  {d}");
                }
                if let Some(c) = status.command.as_deref().filter(|s| !s.is_empty()) {
                    println!("Command: {c}");
                }
            }
            Ok(0)
        }
        _ => {
            eprintln!("Unknown autostart subcommand: {sub}");
            eprintln!("Use: tokenlab autostart on|off|status");
            Ok(1)
        }
    }
}

// ---------------------------------------------------------------------------
// backup

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadBody {
    ok: bool,
    gist_id: String,
    html_url: String,
    scope: String,
    #[serde(with = "jsnum")]
    event_count: f64,
    updated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadBody {
    ok: bool,
    /// Quirk preserved from the TS CLI: this is `backup.exportedAt`.
    #[serde(skip_serializing_if = "Option::is_none")]
    gist_id: Option<serde_json::Value>,
    scope: String,
    #[serde(with = "jsnum")]
    event_count: f64,
    #[serde(with = "jsnum")]
    custom_rate_count: f64,
    #[serde(with = "jsnum")]
    mirrors_restored: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusBody {
    ok: bool,
    gist_id: Option<String>,
    gist_url: Option<String>,
    last_backup_at: Option<String>,
    github_token_saved: bool,
}

async fn cmd_backup(args: &[String]) -> anyhow::Result<i32> {
    let sub = args
        .get(1)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase())
        .unwrap_or_else(|| "status".to_string());
    let as_json = has(args, "--json");
    let token = get_flag_nonempty(args, "--token");
    let gist_id = get_flag_nonempty(args, "--gist");
    let is_public = has(args, "--public");
    let save_token = has(args, "--save-token");

    let outcome: anyhow::Result<i32> = async {
        match sub.as_str() {
            "upload" | "up" => {
                log("Backup upload requested");
                let events = load_full_events().await;
                let result = upload_backup_to_gist(UploadOpts {
                    token,
                    gist_id,
                    public: Some(is_public),
                    event_count_hint: None,
                    save_token,
                    events: Some(events),
                })
                .await?;
                let body = UploadBody {
                    ok: true,
                    gist_id: result.gist.id.clone(),
                    html_url: result.gist.html_url.clone(),
                    scope: result.scope.to_string(),
                    event_count: result.backup.events.as_ref().map_or(0, |e| e.len()) as f64,
                    updated: result.gist.updated,
                };
                if as_json {
                    println!("{}", to_json(&body));
                } else {
                    println!("Backup uploaded: {}", body.html_url);
                    println!(
                        "Scope: {} · Events: {}",
                        body.scope,
                        js_num_to_string(body.event_count)
                    );
                    println!("Gist ID: {}", body.gist_id);
                }
                Ok(0)
            }
            "download" | "down" | "restore" => {
                log("Backup download requested");
                let result = download_backup_from_gist(token.as_deref(), gist_id.as_deref()).await?;
                let body = DownloadBody {
                    ok: true,
                    gist_id: result.backup.get("exportedAt").cloned(),
                    scope: result.restored.scope.clone(),
                    event_count: result.restored.events.as_ref().map_or(0, |e| e.len()) as f64,
                    custom_rate_count: result.restored.custom_rate_count,
                    mirrors_restored: result.restored.mirrors_restored,
                };
                if as_json {
                    println!("{}", to_json(&body));
                } else {
                    println!("Backup downloaded and restored.");
                    println!(
                        "Scope: {} · Events: {} · Custom rates: {} · Mirrors: {}",
                        body.scope,
                        js_num_to_string(body.event_count),
                        js_num_to_string(body.custom_rate_count),
                        js_num_to_string(body.mirrors_restored)
                    );
                }
                Ok(0)
            }
            "status" | "show" => {
                let cfg = get_config_sync();
                let nonempty = |v: Option<&String>| v.filter(|s| !s.is_empty()).cloned();
                let b = cfg.backup.as_ref();
                let body = StatusBody {
                    ok: true,
                    gist_id: nonempty(b.and_then(|b| b.gist_id.as_ref())),
                    gist_url: nonempty(b.and_then(|b| b.gist_url.as_ref())),
                    last_backup_at: nonempty(b.and_then(|b| b.last_backup_at.as_ref())),
                    github_token_saved: nonempty(b.and_then(|b| b.github_token.as_ref())).is_some(),
                };
                if as_json {
                    println!("{}", to_json(&body));
                } else {
                    println!("Saved Gist ID: {}", body.gist_id.as_deref().unwrap_or("none"));
                    println!("Last backup: {}", body.last_backup_at.as_deref().unwrap_or("never"));
                    println!(
                        "GitHub token saved: {}",
                        if body.github_token_saved { "yes" } else { "no" }
                    );
                    if let Some(u) = &body.gist_url {
                        println!("URL: {u}");
                    }
                }
                Ok(0)
            }
            _ => {
                eprintln!("Unknown backup subcommand: {sub}");
                eprintln!("Use: tokenlab backup upload|download|status");
                Ok(1)
            }
        }
    }
    .await;

    match outcome {
        Ok(code) => Ok(code),
        Err(err) => {
            let msg = err.to_string();
            log_error(&format!("Backup command failed: {msg}"));
            eprintln!("{msg}");
            Ok(1)
        }
    }
}

// ---------------------------------------------------------------------------
// scan / doctors

async fn cmd_scan(args: &[String]) -> anyhow::Result<i32> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ScanBody {
        ok: bool,
        #[serde(with = "jsnum")]
        events_ingested: f64,
        #[serde(with = "jsnum")]
        duration_ms: f64,
    }
    let t0 = Instant::now();
    let events = load_full_events().await;
    let body = ScanBody {
        ok: true,
        events_ingested: events.len() as f64,
        duration_ms: t0.elapsed().as_millis() as f64,
    };
    if has(args, "--json") {
        println!("{}", to_json(&body));
    } else {
        println!("Scanned {} events in {}ms", events.len(), js_num_to_string(body.duration_ms));
    }
    Ok(0)
}

async fn cmd_doctors(args: &[String]) -> anyhow::Result<i32> {
    #[derive(Serialize)]
    struct DoctorsBody<'a> {
        platform: &'a str,
        arch: &'a str,
        /// The TS build reports the Node version; the native build has no Node.
        node: &'a str,
        agents: &'a [crate::types::AgentStatus],
    }
    let events = load_full_events().await;
    let agents = detect_agents(&events).await;
    let platform = host_platform();
    let arch = node_arch();
    if has(args, "--json") {
        println!(
            "{}",
            to_json(&DoctorsBody { platform, arch, node: "rust", agents: &agents })
        );
        return Ok(0);
    }
    println!("TokenLab doctors v{VERSION}  ({platform}/{arch} rust)\n");
    for a in &agents {
        let mark = if a.detected {
            if a.enabled {
                "OK "
            } else {
                "PATH"
            }
        } else {
            " -- "
        };
        println!(
            "[{mark}] {} events={}  {}",
            pad_end(&a.label, 16),
            pad_start(&js_num_to_string(a.event_count), 5),
            a.paths.first().filter(|p| !p.is_empty()).map_or("(not found)", |p| p.as_str())
        );
    }
    Ok(0)
}

// ---------------------------------------------------------------------------
// stats / cost

async fn cmd_stats(args: &[String]) -> anyhow::Result<i32> {
    let since = get_flag(args, "--since");
    let until = get_flag(args, "--until");
    let by_raw = get_flag_nonempty(args, "--by").unwrap_or_else(|| "agent".to_string());
    let sort_raw = get_flag_nonempty(args, "--sort").unwrap_or_else(|| "cost".to_string());
    // Unknown `--by` values fall through to hourly buckets, like the TS groupKey.
    let by = GroupBy::parse(&by_raw).unwrap_or(GroupBy::Hour);
    let sort = SortBy::from(sort_raw.as_str());
    let since_ref = since.as_deref().filter(|s| !s.is_empty());
    let until_ref = until.as_deref().filter(|s| !s.is_empty());

    let all = load_full_events().await;
    let events = filter_by_period(&all, since_ref, until_ref, None);
    let stats = aggregate(&events, by, sort, since_ref, until_ref, None, false);
    if has(args, "--json") {
        println!("{}", to_json(&stats));
        return Ok(0);
    }
    let t = &stats.totals;
    println!("TokenLab stats  (groupBy={by_raw}, sort={sort_raw})");
    if since_ref.is_some() || until_ref.is_some() {
        println!(
            "Period: since={} until={}",
            since_ref.unwrap_or("-"),
            until_ref.unwrap_or("-")
        );
    }
    println!(
        "TOTAL  tokens={}  in={}  out={}  cost={}  events={}",
        format_tokens(t.total_tokens),
        format_tokens(t.input_tokens),
        format_tokens(t.output_tokens),
        format_usd(t.estimated_cost, 2),
        js_num_to_string(t.event_count)
    );
    println!();
    for g in &stats.groups {
        println!(
            "{} tokens={}  cost={}  events={}",
            pad_end(&g.key, 24),
            pad_start(&format_tokens(g.totals.total_tokens), 8),
            pad_start(&format_usd(g.totals.estimated_cost, 2), 10),
            js_num_to_string(g.totals.event_count)
        );
    }
    Ok(0)
}

async fn cmd_cost(args: &[String]) -> anyhow::Result<i32> {
    let since = get_flag_nonempty(args, "--since").unwrap_or_else(|| "30d".to_string());
    let until = get_flag(args, "--until");
    let until_ref = until.as_deref().filter(|s| !s.is_empty());

    let all = load_full_events().await;
    let events = filter_by_period(&all, Some(&since), until_ref, None);
    let report = cost_report(&events, Some(&since), until_ref);
    if has(args, "--json") {
        println!("{}", to_json(&report));
        return Ok(0);
    }
    println!("TokenLab cost  since={since}");
    println!(
        "TOTAL estimated: {} {}",
        format_usd(report.total_estimated_cost, 2),
        report.currency
    );
    println!("\nBy agent:");
    for row in &report.by_agent {
        println!(
            "  {} {}  ({}%)  tokens={}",
            pad_end(&row.agent, 16),
            pad_start(&format_usd(row.estimated_cost, 2), 10),
            js_to_fixed(row.share * 100.0, 1),
            format_tokens(row.total_tokens)
        );
    }
    println!("\nBy model:");
    for row in report.by_model.iter().take(15) {
        println!(
            "  {} {}  tokens={}",
            pad_end(&row.model, 28),
            pad_start(&format_usd(row.estimated_cost, 2), 10),
            format_tokens(row.total_tokens)
        );
    }
    Ok(0)
}
