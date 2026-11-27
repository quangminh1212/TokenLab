//! Port of `src/autostart.ts`.
//!
//! Login autostart for `tokenlab serve`.
//! Windows (no admin): HKCU Run registry + VBS supervisor (+ desktop shortcut).
//! Other platforms: autostart not implemented (status only), desktop launcher
//! best-effort.

use crate::util::{env_nonempty, host_platform, js_trim, local_app_data_dir, pjoin};
use chrono::{SecondsFormat, Utc};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

pub use crate::process_guard::heartbeat_path;

/// HKCU Run value name (shows in Windows Startup apps)
pub const AUTOSTART_NAME: &str = "XLabToken";

const RUN_KEY: &str = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/// Favicon bundled into the binary so the desktop shortcut / tray always have
/// an icon even when the web assets are not next to the executable.
const EMBEDDED_ICON: &[u8] = include_bytes!("../../web/public/assets/favicon.ico");

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    pub platform: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutostartResult {
    pub ok: bool,
    pub message: String,
    pub status: AutostartStatus,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopShortcutResult {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorLaunchResult {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub already: Option<bool>,
}

#[derive(Debug, Clone, Default)]
pub struct LaunchSupervisorOptions {
    pub force_restart: bool,
}

/// How to invoke `serve`: the Rust binary itself (replaces `node cli.js serve`).
#[derive(Debug, Clone, PartialEq)]
pub struct ServeInvocation {
    /// Absolute path of the running `tokenlab` executable.
    pub exe: String,
    /// Arguments after the executable (`["serve"]`).
    pub args: Vec<String>,
}

// ---------------------------------------------------------------------------
// logging to %LOCALAPPDATA%\tokenlab\autostart.txt

fn log_dir() -> PathBuf {
    let base = env_nonempty("LOCALAPPDATA")
        .or_else(|| env_nonempty("APPDATA"))
        .unwrap_or_else(crate::util::cwd_string);
    Path::new(&base).join("tokenlab")
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
        .open(dir.join("autostart.txt"))
        .and_then(|mut f| f.write_all(format!("{line}\r\n").as_bytes()));
}

fn log_error(message: &str) {
    log(&format!("[ERROR] {message}"));
}

// ---------------------------------------------------------------------------
// paths

fn data_dir() -> String {
    pjoin(&[local_app_data_dir().as_str(), "tokenlab"])
}

fn launcher_path() -> String {
    pjoin(&[data_dir().as_str(), "autostart.vbs"])
}

/// One-click desktop launcher (starts setup: server + tray + open dashboard).
fn desktop_launcher_path() -> String {
    pjoin(&[data_dir().as_str(), "desktop-launch.vbs"])
}

fn desktop_icon_path() -> String {
    pjoin(&[data_dir().as_str(), "app.ico"])
}

/// Sentinel file written by `serve` when the user quits via tray/SIGINT.
/// The supervisor VBS checks this after the serve process exits; if present,
/// it stops restarting. Absent => crash/unexpected exit => restart.
pub fn stop_sentinel_path() -> String {
    pjoin(&[data_dir().as_str(), "stop.flag"])
}

fn supervisor_log_path() -> String {
    pjoin(&[data_dir().as_str(), "supervisor.txt"])
}

fn strip_verbatim(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    s.strip_prefix("\\\\?\\").map(|x| x.to_string()).unwrap_or(s)
}

/// Resolve the executable used for `serve`. Replaces the Node CLI lookup: the
/// Rust build is a single binary, so this is the current executable.
pub fn resolve_serve_invocation() -> Result<ServeInvocation, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Cannot resolve the tokenlab executable path: {e}"))?;
    let exe = strip_verbatim(&exe);
    log(&format!(
        "Resolved serve invocation: {}",
        serde_json::json!({ "exe": exe })
    ));
    Ok(ServeInvocation {
        exe,
        args: vec!["serve".to_string()],
    })
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

/// Directories that may hold the packaged web assets (favicon/logo).
pub fn icon_search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(d) = exe_dir() {
        dirs.push(d.join("server").join("assets"));
        dirs.push(d.join("assets"));
        dirs.push(d.join("web").join("assets"));
        // dev layout: <repo>/rust/target/{debug,release}/tokenlab(.exe)
        for anc in d.ancestors().skip(1).take(4) {
            dirs.push(anc.join("web").join("public").join("assets"));
            dirs.push(anc.join("web").join("dist").join("assets"));
        }
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("web");
    dirs.push(manifest.join("public").join("assets"));
    dirs.push(manifest.join("dist").join("assets"));
    dirs
}

/// Resolve package favicon.ico on disk.
fn resolve_package_icon() -> Option<String> {
    icon_search_dirs()
        .into_iter()
        .map(|d| d.join("favicon.ico"))
        .find(|p| p.exists())
        .map(|p| strip_verbatim(&p))
}

/// Write the bundled favicon to `%LOCALAPPDATA%\tokenlab\app.ico` (stable
/// location) and return its path.
pub fn materialize_embedded_icon() -> Option<String> {
    let dest = desktop_icon_path();
    let _ = std::fs::create_dir_all(data_dir());
    match std::fs::read(&dest) {
        Ok(existing) if existing == EMBEDDED_ICON => return Some(dest),
        _ => {}
    }
    match std::fs::write(&dest, EMBEDDED_ICON) {
        Ok(()) => Some(dest),
        Err(e) => {
            log_error(&format!("Embedded icon write failed: {e}"));
            None
        }
    }
}

fn quote_cmd(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\\\""))
}

fn path_exists(p: &str) -> bool {
    Path::new(p).exists()
}

// ---------------------------------------------------------------------------
// process helpers

/// `execFile` equivalent: Err on spawn failure, non-zero exit or timeout.
async fn exec_file(program: &str, args: &[String], timeout_ms: Option<u64>) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW (windowsHide)
    }
    let fut = cmd.output();
    let out = match timeout_ms {
        Some(ms) => match tokio::time::timeout(Duration::from_millis(ms), fut).await {
            Ok(r) => r,
            Err(_) => return Err(format!("Command timed out after {ms}ms: {program}")),
        },
        None => fut.await,
    }
    .map_err(|e| format!("spawn {program} failed: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "Command failed: {} {}\n{}",
            program,
            args.join(" "),
            stderr
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn svec(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

// ---------------------------------------------------------------------------
// stop sentinel

pub async fn write_stop_sentinel() {
    log(&format!("Writing stop sentinel: {}", stop_sentinel_path()));
    let r: std::io::Result<()> = async {
        tokio::fs::create_dir_all(data_dir()).await?;
        tokio::fs::write(stop_sentinel_path(), "stop").await
    }
    .await;
    if let Err(e) = r {
        log_error(&format!("Failed to write stop sentinel: {e}"));
    }
}

pub async fn clear_stop_sentinel() {
    log(&format!("Clearing stop sentinel: {}", stop_sentinel_path()));
    // NotFound is the normal case (no prior Quit; the supervisor also deletes it).
    for attempt in 0..3 {
        match tokio::fs::remove_file(stop_sentinel_path()).await {
            Ok(()) => return,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && attempt < 2 => {
                // Antivirus / supervisor may briefly hold the file on Windows.
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
            Err(e) => {
                log_error(&format!("Failed to clear stop sentinel: {e}"));
                return;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Windows VBS supervisor

/// Template for the supervisor. Placeholders: @@STOP@@ @@HB@@ @@LOG@@ @@EXE@@
/// @@EXENAME@@ (all pre-escaped for a VBS string literal). Identical to the TS
/// generated script except that it launches the Rust binary directly
/// (`"exe" serve`) instead of `"node" --expose-gc "cli.js" serve`.
const SUPERVISOR_TEMPLATE: &str = r##"' TokenLab autostart supervisor (generated) - anti-crash / anti-hang
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set wmi = Nothing
stopFile = "@@STOP@@"
hbFile = "@@HB@@"
logFile = "@@LOG@@"
exePath = "@@EXE@@"
exeName = "@@EXENAME@@"

' WMI may not be ready right after login: (re)acquire lazily, never give up.
Function EnsureWmi()
  EnsureWmi = False
  If IsObject(wmi) Then
    If Not wmi Is Nothing Then
      EnsureWmi = True
      Exit Function
    End If
  End If
  On Error Resume Next
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  If Err.Number <> 0 Then
    Err.Clear
    Set wmi = Nothing
  End If
  On Error Goto 0
  If IsObject(wmi) Then
    If Not wmi Is Nothing Then EnsureWmi = True
  End If
End Function

For wmiTry = 1 To 30
  If EnsureWmi() Then Exit For
  WScript.Sleep 1000
Next
If fso.FileExists(stopFile) Then fso.DeleteFile stopFile, True

Sub LogLine(msg)
  On Error Resume Next
  Dim ts
  Set ts = fso.OpenTextFile(logFile, 8, True)
  ts.WriteLine Now & " " & msg
  ts.Close
  On Error Goto 0
End Sub

Function ProcessAlive(pid)
  ProcessAlive = False
  If pid <= 0 Then Exit Function
  If Not EnsureWmi() Then Exit Function
  On Error Resume Next
  Dim col, p
  Set col = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & pid)
  For Each p In col
    ProcessAlive = True
  Next
  On Error Goto 0
End Function

Sub KillPid(pid)
  If pid <= 0 Then Exit Sub
  On Error Resume Next
  sh.Run "taskkill /F /PID " & pid & " /T", 0, True
  On Error Goto 0
End Sub

' Keep only the oldest wscript/cscript running THIS launcher (full path).
' Do NOT match bare "autostart.vbs" — legacy xlab-token\autostart.vbs would race and kill us.
Sub EnsureSingleInstance()
  If Not EnsureWmi() Then Exit Sub
  On Error Resume Next
  Dim col, p, cmd, minPid, n, selfKey
  selfKey = LCase(WScript.ScriptFullName)
  minPid = 0
  n = 0
  Set col = wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='wscript.exe' OR Name='cscript.exe'")
  For Each p In col
    cmd = LCase(p.CommandLine & "")
    If InStr(cmd, selfKey) > 0 Then
      n = n + 1
      If minPid = 0 Or p.ProcessId < minPid Then minPid = p.ProcessId
    End If
  Next
  If n <= 1 Or minPid = 0 Then Exit Sub
  LogLine "duplicate supervisors=" & n & " - keep pid=" & minPid
  For Each p In col
    cmd = LCase(p.CommandLine & "")
    If InStr(cmd, selfKey) > 0 Then
      If p.ProcessId <> minPid Then
        LogLine "killing duplicate supervisor pid=" & p.ProcessId
        KillPid p.ProcessId
      End If
    End If
  Next
  WScript.Sleep 400
  On Error Goto 0
End Sub

EnsureSingleInstance
If fso.FileExists(stopFile) Then
  LogLine "stop.flag after single-instance check - exit"
  WScript.Quit 0
End If

Function FindExistingServe()
  FindExistingServe = 0
  If Not EnsureWmi() Then Exit Function
  On Error Resume Next
  Dim col, p, cmd
  Set col = wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='" & exeName & "'")
  For Each p In col
    cmd = LCase(p.CommandLine & "")
    If InStr(cmd, LCase(exeName)) > 0 Then
      If InStr(cmd, " serve") > 0 Or Right(cmd, 5) = "serve" Then
        FindExistingServe = p.ProcessId
        Exit Function
      End If
    End If
  Next
  On Error Goto 0
End Function

Function StartServe()
  StartServe = 0
  If Not EnsureWmi() Then Exit Function
  On Error Resume Next
  Dim startup, proc, ret, pid, existing, cmdLine
  existing = FindExistingServe()
  If existing > 0 Then
    StartServe = existing
    LogLine "adopt existing serve pid=" & existing
    On Error Goto 0
    Exit Function
  End If
  pid = 0
  Set startup = wmi.Get("Win32_ProcessStartup").SpawnInstance_()
  startup.ShowWindow = 0
  Set proc = wmi.Get("Win32_Process")
  cmdLine = """" & exePath & """ serve"
  ret = proc.Create(cmdLine, Null, startup, pid)
  If ret = 0 And pid > 0 Then
    StartServe = pid
  Else
    LogLine "Create failed ret=" & ret & " pid=" & pid & " cmd=" & cmdLine
  End If
  On Error Goto 0
End Function

Function HeartbeatAgeMs()
  HeartbeatAgeMs = -1
  On Error Resume Next
  If Not fso.FileExists(hbFile) Then Exit Function
  Dim ts, line, ms, nowMs
  Set ts = fso.OpenTextFile(hbFile, 1, False)
  line = Trim(ts.ReadLine)
  ts.Close
  If IsNumeric(line) Then
    ms = CDbl(line)
    nowMs = CDbl(DateDiff("s", "1/1/1970", Now)) * 1000
    ' DateDiff is local-time based; heartbeat is UTC epoch - compare file mtime instead
  End If
  HeartbeatAgeMs = DateDiff("s", fso.GetFile(hbFile).DateLastModified, Now) * 1000
  If HeartbeatAgeMs < 0 Then HeartbeatAgeMs = 0
  On Error Goto 0
End Function

retries = 0
LogLine "supervisor started"
Do
  EnsureSingleInstance
  If fso.FileExists(stopFile) Then
    LogLine "stop.flag present - exit"
    Exit Do
  End If
  If fso.FileExists(hbFile) Then
    On Error Resume Next
    fso.DeleteFile hbFile, True
    On Error Goto 0
  End If
  pid = StartServe()
  If pid <= 0 Then
    retries = retries + 1
    LogLine "failed to start serve (attempt " & retries & ")"
    sleepMs = 5000
    If retries > 5 Then sleepMs = 15000
    If retries > 15 Then sleepMs = 60000
    WScript.Sleep sleepMs
  Else
    LogLine "serve started pid=" & pid
    startedAt = Timer
    hung = False
    Do
      WScript.Sleep 5000
      If fso.FileExists(stopFile) Then
        ' Graceful quit (tray/Ctrl+C): wait for serve to flush scan-cache.
        ' Immediate KillPid used to truncate usage and drop today's cost/tokens.
        LogLine "stop.flag - waiting graceful exit pid=" & pid
        grace = 0
        Do While grace < 60
          If Not ProcessAlive(pid) Then
            LogLine "serve exited after stop.flag pid=" & pid
            Exit Do
          End If
          WScript.Sleep 500
          grace = grace + 1
        Loop
        If ProcessAlive(pid) Then
          LogLine "stop.flag - force kill after grace pid=" & pid
          KillPid pid
        End If
        Exit Do
      End If
      If Not ProcessAlive(pid) Then
        LogLine "serve exited pid=" & pid
        Exit Do
      End If
      ' Hang detection after 90s uptime: heartbeat older than 120s
      uptimeSec = Timer - startedAt
      If uptimeSec < 0 Then uptimeSec = uptimeSec + 86400
      If uptimeSec >= 90 Then
        age = HeartbeatAgeMs()
        If age < 0 Or age > 120000 Then
          LogLine "hang detected pid=" & pid & " hbAgeMs=" & age & " - killing"
          KillPid pid
          hung = True
          Exit Do
        End If
      End If
      ' Reset fast-restart counter after 60s healthy run
      If uptimeSec >= 60 And retries > 0 Then retries = 0
    Loop
    If fso.FileExists(stopFile) Then
      LogLine "stop.flag - supervisor exit"
      Exit Do
    End If
    retries = retries + 1
    sleepMs = 3000
    If hung Then sleepMs = 5000
    If retries > 5 Then sleepMs = 10000
    If retries > 15 Then sleepMs = 30000
    If retries > 30 Then sleepMs = 60000
    LogLine "restart in " & sleepMs & "ms (attempt " & retries & ")"
    WScript.Sleep sleepMs
  End If
Loop
LogLine "supervisor stopped"
"##;

fn vbs_q(s: &str) -> String {
    s.replace('"', "\"\"")
}

fn build_supervisor_vbs(exe: &str) -> String {
    let exe_name = Path::new(exe)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| exe.to_string());
    let body = SUPERVISOR_TEMPLATE
        .replace("@@STOP@@", &vbs_q(&stop_sentinel_path()))
        .replace("@@HB@@", &vbs_q(&heartbeat_path()))
        .replace("@@LOG@@", &vbs_q(&supervisor_log_path()))
        .replace("@@EXE@@", &vbs_q(exe))
        .replace("@@EXENAME@@", &vbs_q(&exe_name));
    // ASCII-only to avoid cscript/wscript encoding issues; CRLF line endings
    // (the TS joins lines with \r\n and ends with a trailing newline).
    body.replace("\r\n", "\n").replace('\n', "\r\n")
}

/// VBS supervisor: runs `tokenlab serve` hidden, restarts forever on crash/hang
/// (unless stop.flag from tray Quit). Uses WMI so we can poll heartbeat while
/// the child is running and kill a hung process.
async fn write_windows_launcher() -> Result<String, String> {
    let inv = resolve_serve_invocation()?;
    tokio::fs::create_dir_all(data_dir())
        .await
        .map_err(|e| e.to_string())?;
    let vbs_path = launcher_path();
    let content = build_supervisor_vbs(&inv.exe);
    tokio::fs::write(&vbs_path, content)
        .await
        .map_err(|e| e.to_string())?;
    log(&format!(
        "Windows supervisor VBS written (anti-crash/hang): {vbs_path}"
    ));
    Ok(vbs_path)
}

// ---------------------------------------------------------------------------
// registry

static REG_SZ_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)REG_SZ\s+(.+)$").unwrap());

async fn reg_query_run() -> Option<String> {
    let out = exec_file(
        "reg",
        &svec(&["query", RUN_KEY, "/v", AUTOSTART_NAME]),
        Some(5000),
    )
    .await
    .ok()?;
    REG_SZ_RE
        .captures(&out)
        .map(|c| js_trim(c.get(1).map(|m| m.as_str()).unwrap_or("")).to_string())
}

async fn reg_set_run(command: &str) -> Result<(), String> {
    exec_file(
        "reg",
        &svec(&[
            "add",
            RUN_KEY,
            "/v",
            AUTOSTART_NAME,
            "/t",
            "REG_SZ",
            "/d",
            command,
            "/f",
        ]),
        Some(5000),
    )
    .await
    .map(|_| ())
}

async fn reg_delete_run() -> bool {
    exec_file(
        "reg",
        &svec(&["delete", RUN_KEY, "/v", AUTOSTART_NAME, "/f"]),
        Some(5000),
    )
    .await
    .is_ok()
}

// ---------------------------------------------------------------------------
// install / uninstall

async fn install_windows() -> AutostartResult {
    log("Installing Windows autostart");
    let vbs = match write_windows_launcher().await {
        Ok(v) => v,
        Err(msg) => {
            // TS: writeWindowsLauncher rejection propagates to the caller.
            log_error(&format!("Failed to write supervisor launcher: {msg}"));
            return AutostartResult {
                ok: false,
                message: format!("Failed to write supervisor launcher: {msg}"),
                status: get_autostart_status().await,
            };
        }
    };
    let run_cmd = format!("wscript.exe {}", quote_cmd(&vbs));
    log(&format!("Launcher path: {vbs}"));
    log(&format!("Run command: {run_cmd}"));

    // HKCU Run - no admin, shows in Windows Settings -> Apps -> Startup
    match reg_set_run(&run_cmd).await {
        Ok(()) => log("Registry Run key set successfully"),
        Err(msg) => {
            log_error(&format!("Failed to write registry Run key: {msg}"));
            return AutostartResult {
                ok: false,
                message: format!("Failed to write registry Run key: {msg}"),
                status: get_autostart_status().await,
            };
        }
    }

    // A running wscript has already loaded the old VBS into memory; rewriting
    // autostart.vbs alone does not refresh that process. Restart only the
    // supervisor so it adopts the current serve process (if any) with new paths.
    let supervisor = launch_supervisor_now(LaunchSupervisorOptions { force_restart: true }).await;
    if !supervisor.ok {
        log_error(&format!(
            "Autostart registered but supervisor refresh failed: {}",
            supervisor.message
        ));
        return AutostartResult {
            ok: false,
            message: format!(
                "Autostart was registered, but the supervisor could not be refreshed: {}",
                supervisor.message
            ),
            status: get_autostart_status().await,
        };
    }

    let status = get_autostart_status().await;
    log(&format!(
        "Autostart installed, status: {}",
        serde_json::to_string(&status).unwrap_or_default()
    ));
    AutostartResult {
        ok: true,
        message: "Autostart enabled (supervised). tokenlab serve starts at login, auto-restarts on crash/hang, and keeps a tray icon; use Quit to stop.".to_string(),
        status,
    }
}

async fn uninstall_windows() -> AutostartResult {
    log("Uninstalling Windows autostart");
    let reg_removed = reg_delete_run().await;
    log(&format!("Registry removed: {reg_removed}"));

    // Signal any running supervisor to stop, then drop the launcher.
    write_stop_sentinel().await;
    let vbs = launcher_path();
    if path_exists(&vbs) {
        match tokio::fs::remove_file(&vbs).await {
            Ok(()) => log(&format!("Launcher removed: {vbs}")),
            Err(e) => log_error(&format!("Failed to remove launcher: {e}")),
        }
    }

    // Clean leftover Startup-folder copy from older installs (if any)
    {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        let legacy = Path::new(&appdata)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("Startup")
            .join("TokenLab.vbs");
        if legacy.exists() {
            match tokio::fs::remove_file(&legacy).await {
                Ok(()) => log(&format!(
                    "Legacy startup shortcut removed: {}",
                    legacy.display()
                )),
                Err(e) => log_error(&format!("Failed to remove legacy shortcut: {e}")),
            }
        }
    }

    let status = get_autostart_status().await;
    log(&format!(
        "Autostart uninstalled, status: {}",
        serde_json::to_string(&status).unwrap_or_default()
    ));
    if !reg_removed && !status.enabled {
        return AutostartResult {
            ok: true,
            message: "Autostart was already off.".to_string(),
            status,
        };
    }
    AutostartResult {
        ok: true,
        message: "Autostart disabled (removed from Windows login startup).".to_string(),
        status,
    }
}

pub async fn get_autostart_status() -> AutostartStatus {
    log("Getting autostart status");
    let exe = match resolve_serve_invocation() {
        Ok(inv) => inv.exe,
        Err(e) => {
            log_error(&e);
            "tokenlab".to_string()
        }
    };
    let command = format!("{} serve", quote_cmd(&exe));

    if !cfg!(windows) {
        log("Autostart status: not Windows");
        return AutostartStatus {
            platform: host_platform().to_string(),
            enabled: false,
            method: None,
            detail: Some("Autostart is currently implemented for Windows only.".to_string()),
            command: Some(command),
        };
    }

    let reg = reg_query_run().await;
    let enabled = reg.as_deref().map_or(false, |s| !s.is_empty());
    let status = AutostartStatus {
        platform: "win32".to_string(),
        enabled,
        method: if enabled {
            Some("HKCU Run (Windows login)".to_string())
        } else {
            None
        },
        detail: Some(if enabled {
            format!("Registry: {}", reg.clone().unwrap_or_default())
        } else {
            "Not registered for login startup.".to_string()
        }),
        command: Some(command),
    };
    log(&format!(
        "Autostart status: {}",
        serde_json::to_string(&status).unwrap_or_default()
    ));
    status
}

pub async fn enable_autostart() -> AutostartResult {
    log("enableAutostart called");
    if !cfg!(windows) {
        log_error("Autostart enable failed: not Windows");
        return AutostartResult {
            ok: false,
            message: "Autostart is currently supported on Windows only.".to_string(),
            status: get_autostart_status().await,
        };
    }
    install_windows().await
}

pub async fn disable_autostart() -> AutostartResult {
    log("disableAutostart called");
    if !cfg!(windows) {
        log_error("Autostart disable failed: not Windows");
        return AutostartResult {
            ok: false,
            message: "Autostart is currently supported on Windows only.".to_string(),
            status: get_autostart_status().await,
        };
    }
    uninstall_windows().await
}

// ---------------------------------------------------------------------------
// supervisor process management

/// List PIDs of wscript/cscript hosting autostart.vbs.
pub async fn list_supervisor_pids() -> Vec<u32> {
    if !cfg!(windows) {
        return Vec::new();
    }
    // Anchor on OUR launcher's full path so another product's (or the legacy
    // xlab-token) autostart.vbs is never listed and taskkilled.
    let key = launcher_path().to_lowercase().replace('\'', "''");
    let script = format!(
        "Get-CimInstance Win32_Process -Filter \"Name='wscript.exe' OR Name='cscript.exe'\" | Where-Object {{ $_.CommandLine -and $_.CommandLine.ToLower().Contains('{key}') }} | Select-Object -ExpandProperty ProcessId"
    );
    let args = vec![
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-Command".to_string(),
        script,
    ];
    match exec_file("powershell.exe", &args, Some(8000)).await {
        Ok(stdout) => stdout
            .lines()
            .filter_map(|s| js_trim(s).parse::<u32>().ok())
            .filter(|n| *n > 0)
            .collect(),
        Err(e) => {
            log_error(&format!("listSupervisorPids failed: {e}"));
            Vec::new()
        }
    }
}

/// True when the login supervisor VBS is already running.
pub async fn is_supervisor_running() -> bool {
    if !cfg!(windows) {
        return false;
    }
    !list_supervisor_pids().await.is_empty()
}

async fn taskkill_tree(pid: u32) -> Result<(), String> {
    exec_file(
        "taskkill",
        &["/F".to_string(), "/PID".to_string(), pid.to_string(), "/T".to_string()],
        Some(8000),
    )
    .await
    .map(|_| ())
}

/// Kill all supervisor host processes (wscript/cscript autostart.vbs).
/// Does not write stop.flag - caller may clear_stop_sentinel + relaunch.
pub async fn kill_all_supervisors() -> usize {
    if !cfg!(windows) {
        return 0;
    }
    let pids = list_supervisor_pids().await;
    if pids.is_empty() {
        return 0;
    }
    log(&format!(
        "Killing supervisors: {}",
        pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",")
    ));
    for pid in &pids {
        if let Err(e) = taskkill_tree(*pid).await {
            log_error(&format!("taskkill supervisor failed: {pid} {e}"));
        }
    }
    // Brief settle so process table / port release
    tokio::time::sleep(Duration::from_millis(400)).await;
    pids.len()
}

fn spawn_detached_wscript(vbs: &str) -> std::io::Result<u32> {
    let mut cmd = std::process::Command::new("wscript.exe");
    cmd.arg(vbs)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP (Node `detached: true`)
        cmd.creation_flags(0x0000_0008 | 0x0000_0200);
    }
    let child = cmd.spawn()?;
    Ok(child.id())
}

/// Start the Windows supervisor VBS now (same process as login autostart).
/// Keeps serve + tray alive and restarts on crash.
/// `force_restart`: kill existing supervisors first then start fresh.
pub async fn launch_supervisor_now(opts: LaunchSupervisorOptions) -> SupervisorLaunchResult {
    if !cfg!(windows) {
        return SupervisorLaunchResult {
            ok: false,
            message: "Supervisor is Windows-only".to_string(),
            already: None,
        };
    }
    // Always refresh launcher so anti-crash/hang improvements apply after upgrades
    if let Err(msg) = write_windows_launcher().await {
        log_error(&format!("launchSupervisorNow failed: {msg}"));
        return SupervisorLaunchResult { ok: false, message: msg, already: None };
    }
    let force = opts.force_restart;
    if !force && is_supervisor_running().await {
        // Collapse duplicates without dropping the primary instance
        let pids = list_supervisor_pids().await;
        if pids.len() > 1 {
            let keep = *pids.iter().min().unwrap();
            log(&format!("Multiple supervisors; keeping {keep} killing extras"));
            for pid in pids {
                if pid == keep {
                    continue;
                }
                let _ = taskkill_tree(pid).await;
            }
        }
        log("Supervisor already running (launcher refreshed on disk)");
        return SupervisorLaunchResult {
            ok: true,
            message: "Supervisor already running".to_string(),
            already: Some(true),
        };
    }
    if force {
        kill_all_supervisors().await;
    }
    clear_stop_sentinel().await;
    let vbs = launcher_path();
    match spawn_detached_wscript(&vbs) {
        Ok(pid) => {
            log(&format!(
                "Supervisor launched, pid: {pid} vbs: {vbs} force: {force}"
            ));
            SupervisorLaunchResult {
                ok: true,
                message: format!("Supervisor started (pid {pid})"),
                already: None,
            }
        }
        Err(e) => {
            let msg = e.to_string();
            log_error(&format!("launchSupervisorNow failed: {msg}"));
            SupervisorLaunchResult { ok: false, message: msg, already: None }
        }
    }
}

// ---------------------------------------------------------------------------
// desktop shortcut

/// Write a hidden desktop launcher VBS:
/// runs `tokenlab setup --open` (start serve+tray if needed, open dashboard)
/// without a console flash.
async fn write_desktop_launcher_vbs() -> Result<String, String> {
    let inv = resolve_serve_invocation()?;
    tokio::fs::create_dir_all(data_dir())
        .await
        .map_err(|e| e.to_string())?;
    let vbs_path = desktop_launcher_path();
    let exe_q = vbs_q(&inv.exe);
    // setup: ensure autostart, start supervised serve + tray, open browser (hidden console)
    let content = [
        "' TokenLab desktop launcher (generated)".to_string(),
        "Set sh = CreateObject(\"WScript.Shell\")".to_string(),
        format!("sh.Run \"\"\"{exe_q}\"\" setup --open\", 0, False"),
        String::new(),
    ]
    .join("\r\n");
    tokio::fs::write(&vbs_path, content)
        .await
        .map_err(|e| e.to_string())?;
    log(&format!("Desktop launcher written: {vbs_path}"));
    Ok(vbs_path)
}

fn os_homedir_fallback() -> String {
    env_nonempty("HOME")
        .or_else(|| env_nonempty("USERPROFILE"))
        .unwrap_or_else(crate::util::cwd_string)
}

async fn resolve_windows_desktop_dir() -> String {
    let args = svec(&[
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Environment]::GetFolderPath('Desktop')",
    ]);
    match exec_file("powershell.exe", &args, Some(8000)).await {
        Ok(stdout) => {
            let dir = js_trim(&stdout).to_string();
            if !dir.is_empty() && Path::new(&dir).exists() {
                return dir;
            }
        }
        Err(e) => log_error(&format!("GetFolderPath Desktop failed: {e}")),
    }
    // Fallbacks (OneDrive Desktop is common on modern Windows)
    let one_drive = env_nonempty("OneDrive");
    let profile = env_nonempty("USERPROFILE");
    let candidates: Vec<PathBuf> = [
        one_drive.as_ref().map(|o| Path::new(o).join("Desktop")),
        profile.as_ref().map(|p| Path::new(p).join("Desktop")),
        profile.as_ref().map(|p| Path::new(p).join("OneDrive").join("Desktop")),
    ]
    .into_iter()
    .flatten()
    .collect();
    for c in candidates {
        if c.exists() {
            return c.to_string_lossy().to_string();
        }
    }
    match profile {
        Some(p) => Path::new(&p).join("Desktop").to_string_lossy().to_string(),
        None => Path::new(&os_homedir_fallback()).join("Desktop").to_string_lossy().to_string(),
    }
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

/// Create/refresh "TokenLab.lnk" on the user Desktop (Windows).
/// Called from setup so users can double-click to start the app.
pub async fn install_desktop_shortcut() -> DesktopShortcutResult {
    log("installDesktopShortcut called");
    if !cfg!(windows) {
        // Best-effort Linux .desktop; macOS gets a simple .command launcher
        return install_desktop_shortcut_non_windows().await;
    }

    let result: Result<String, String> = async {
        let vbs = write_desktop_launcher_vbs().await?;
        // Stable icon under %LOCALAPPDATA% so the .lnk keeps working after package updates
        let mut icon = desktop_icon_path();
        match resolve_package_icon() {
            Some(icon_src) => match std::fs::copy(&icon_src, &icon) {
                Ok(_) => log(&format!("Desktop icon copied: {icon_src} -> {icon}")),
                Err(e) => {
                    log_error(&format!("Icon copy failed: {e}"));
                    icon = icon_src;
                }
            },
            None => match materialize_embedded_icon() {
                Some(p) => {
                    icon = p;
                    log("Package icon not found on disk; using bundled icon");
                }
                None => {
                    icon = String::new();
                    log("Package icon not found; shortcut will use default icon");
                }
            },
        }

        let desktop = resolve_windows_desktop_dir().await;
        tokio::fs::create_dir_all(&desktop)
            .await
            .map_err(|e| e.to_string())?;
        let lnk_path = Path::new(&desktop)
            .join("TokenLab.lnk")
            .to_string_lossy()
            .to_string();

        let ps = [
            "$ErrorActionPreference = 'Stop'".to_string(),
            format!("$desktop = {}", json_str(&desktop)),
            format!("$lnkPath = {}", json_str(&lnk_path)),
            format!("$vbs = {}", json_str(&vbs)),
            format!("$icon = {}", json_str(&icon)),
            "$w = New-Object -ComObject WScript.Shell".to_string(),
            "$s = $w.CreateShortcut($lnkPath)".to_string(),
            "$s.TargetPath = 'wscript.exe'".to_string(),
            "$s.Arguments = '\"' + $vbs + '\"'".to_string(),
            "$s.WorkingDirectory = [IO.Path]::GetDirectoryName($vbs)".to_string(),
            "$s.WindowStyle = 7".to_string(),
            "$s.Description = 'TokenLab \u{2014} start local usage dashboard'".to_string(),
            "if ($icon -and (Test-Path -LiteralPath $icon)) { $s.IconLocation = $icon }".to_string(),
            "$s.Save()".to_string(),
            "Write-Output $lnkPath".to_string(),
        ]
        .join("; ");

        let stdout = exec_file(
            "powershell.exe",
            &svec(&["-NoProfile", "-NonInteractive", "-STA", "-Command", &ps]),
            Some(15000),
        )
        .await?;
        let trimmed = js_trim(&stdout).to_string();
        Ok(if trimmed.is_empty() { lnk_path } else { trimmed })
    }
    .await;

    match result {
        Ok(created) => {
            log(&format!("Desktop shortcut created: {created}"));
            DesktopShortcutResult {
                ok: true,
                message: format!("Desktop shortcut: {created}"),
                path: Some(created),
            }
        }
        Err(msg) => {
            log_error(&format!("installDesktopShortcut failed: {msg}"));
            DesktopShortcutResult {
                ok: false,
                message: format!("Desktop shortcut failed: {msg}"),
                path: None,
            }
        }
    }
}

#[cfg(unix)]
fn write_executable(path: &str, body: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o755)
        .open(path)?;
    f.write_all(body.as_bytes())
}

#[cfg(not(unix))]
fn write_executable(path: &str, body: &str) -> std::io::Result<()> {
    std::fs::write(path, body)
}

async fn install_desktop_shortcut_non_windows() -> DesktopShortcutResult {
    let fail = |msg: String| DesktopShortcutResult {
        ok: false,
        message: format!("Desktop shortcut failed: {msg}"),
        path: None,
    };
    let inv = match resolve_serve_invocation() {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let home = env_nonempty("HOME").unwrap_or_else(os_homedir_fallback);
    let desktop = Path::new(&home).join("Desktop");
    if !desktop.exists() {
        return DesktopShortcutResult {
            ok: false,
            message: "Desktop folder not found".to_string(),
            path: None,
        };
    }
    let exe_dir = Path::new(&inv.exe)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    if host_platform() == "darwin" {
        let cmd_path = desktop.join("TokenLab.command").to_string_lossy().to_string();
        let body = [
            "#!/bin/bash".to_string(),
            format!("cd {}", json_str(&exe_dir)),
            format!("exec {} setup", json_str(&inv.exe)),
            String::new(),
        ]
        .join("\n");
        if let Err(e) = write_executable(&cmd_path, &body) {
            return fail(e.to_string());
        }
        let _ = exec_file("chmod", &svec(&["+x", &cmd_path]), None).await;
        return DesktopShortcutResult {
            ok: true,
            message: format!("Desktop launcher: {cmd_path}"),
            path: Some(cmd_path),
        };
    }

    // Linux .desktop
    let desktop_file = desktop.join("tokenlab.desktop").to_string_lossy().to_string();
    let icon_src = resolve_package_icon().or_else(materialize_embedded_icon);
    let lines: Vec<String> = [
        "[Desktop Entry]".to_string(),
        "Type=Application".to_string(),
        "Name=TokenLab".to_string(),
        "Comment=Local AI token usage & cost dashboard".to_string(),
        format!("Exec={} setup", json_str(&inv.exe)),
        "Terminal=false".to_string(),
        "Categories=Utility;Development;".to_string(),
        icon_src.map(|i| format!("Icon={i}")).unwrap_or_default(),
        String::new(),
    ]
    .into_iter()
    .filter(|l| !l.is_empty())
    .collect();
    if let Err(e) = write_executable(&desktop_file, &lines.join("\n")) {
        return fail(e.to_string());
    }
    DesktopShortcutResult {
        ok: true,
        message: format!("Desktop launcher: {desktop_file}"),
        path: Some(desktop_file),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_cmd_escapes_quotes() {
        assert_eq!(quote_cmd("a\"b"), "\"a\\\"b\"");
    }

    #[test]
    fn supervisor_vbs_is_crlf_and_invokes_binary() {
        let vbs = build_supervisor_vbs("C:\\Program Files\\tokenlab\\tokenlab.exe");
        assert!(vbs.contains("exePath = \"C:\\Program Files\\tokenlab\\tokenlab.exe\"\r\n"));
        assert!(vbs.contains("exeName = \"tokenlab.exe\"\r\n"));
        assert!(vbs.contains("cmdLine = \"\"\"\" & exePath & \"\"\" serve\"\r\n"));
        assert!(vbs.contains("winmgmts:\\\\.\\root\\cimv2"));
        assert!(!vbs.contains("@@"));
        assert!(!vbs.contains("--expose-gc"));
        assert!(vbs.ends_with("LogLine \"supervisor stopped\"\r\n"));
        assert!(!vbs.replace("\r\n", "").contains('\n'));
    }

    #[test]
    fn status_serializes_camel_case_without_undefined() {
        let s = AutostartStatus {
            platform: "win32".into(),
            enabled: false,
            method: None,
            detail: Some("x".into()),
            command: Some("y".into()),
        };
        assert_eq!(
            serde_json::to_string(&s).unwrap(),
            r#"{"platform":"win32","enabled":false,"detail":"x","command":"y"}"#
        );
    }

    #[test]
    fn reg_sz_regex_extracts_value() {
        let out = "\r\nHKEY_CURRENT_USER\\...\\Run\r\n    XLabToken    REG_SZ    wscript.exe \"C:\\a b\\autostart.vbs\"\r\n\r\n";
        let m = REG_SZ_RE.captures(out).unwrap();
        assert_eq!(js_trim(&m[1]), "wscript.exe \"C:\\a b\\autostart.vbs\"");
    }
}
