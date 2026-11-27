//! Port of `src/tray.ts`.
//!
//! System tray icon while serve is running.
//! Windows: PowerShell NotifyIcon (no native dependencies).
//! Other platforms: no-op (returns `None`).

use crate::autostart::{icon_search_dirs, materialize_embedded_icon};
use crate::util::{env_nonempty, open_browser};
use chrono::{SecondsFormat, Utc};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::Notify;

/// Handle returned by [`start_tray`]; `stop()` is idempotent.
#[derive(Clone)]
pub struct TrayHandle {
    stop_fn: Arc<dyn Fn() + Send + Sync>,
}

impl TrayHandle {
    pub fn stop(&self) {
        (self.stop_fn)();
    }
}

pub struct TrayOptions {
    pub url: String,
    pub title: Option<String>,
    pub tooltip: Option<String>,
    pub on_quit: Arc<dyn Fn() + Send + Sync>,
}

// ---------------------------------------------------------------------------
// logging to %LOCALAPPDATA%\tokenlab\tray.txt

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
        .open(dir.join("tray.txt"))
        .and_then(|mut f| f.write_all(format!("{line}\r\n").as_bytes()));
}

fn log_error(message: &str) {
    log(&format!("[ERROR] {message}"));
}

// ---------------------------------------------------------------------------
// icon

fn resolve_icon_path() -> Option<String> {
    let names = ["favicon.ico", "logo.png", "favicon-32x32.png"];
    for dir in icon_search_dirs() {
        for name in names {
            let p = dir.join(name);
            if p.exists() {
                return Some(p.to_string_lossy().trim_start_matches("\\\\?\\").to_string());
            }
        }
    }
    // Not next to the binary: fall back to the icon bundled in the executable.
    materialize_embedded_icon()
}

// ---------------------------------------------------------------------------
// PowerShell script

const PS_TEMPLATE: &str = r##"
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$icon = New-Object System.Windows.Forms.NotifyIcon
$tip = '@@TOOLTIP@@'
if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
$icon.Text = $tip
$icon.Visible = $true

$iconPath = '@@ICON@@'.Trim()
$loadedIcon = $false
if ($iconPath -ne '' -and (Test-Path -LiteralPath $iconPath)) {
  try {
    if ($iconPath.ToLower().EndsWith('.ico')) {
      $icon.Icon = New-Object System.Drawing.Icon($iconPath)
    } else {
      $bmp = [System.Drawing.Image]::FromFile($iconPath)
      $h = (New-Object System.Drawing.Bitmap $bmp).GetHicon()
      $icon.Icon = [System.Drawing.Icon]::FromHandle($h)
    }
    $loadedIcon = $true
    [Console]::Out.WriteLine("icon-loaded:$iconPath")
  } catch {
    [Console]::Out.WriteLine("icon-error:" + $_.Exception.Message)
  }
} else {
  [Console]::Out.WriteLine("icon-missing:$iconPath")
}
if (-not $loadedIcon) {
  $icon.Icon = [System.Drawing.SystemIcons]::Application
}
$icon.Visible = $true
[Console]::Out.WriteLine("tray-visible")

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = New-Object System.Windows.Forms.ToolStripMenuItem('Open Dashboard')
$sep = New-Object System.Windows.Forms.ToolStripSeparator
$quitItem = New-Object System.Windows.Forms.ToolStripMenuItem('Quit')
[void]$menu.Items.Add($openItem)
[void]$menu.Items.Add($sep)
[void]$menu.Items.Add($quitItem)
$icon.ContextMenuStrip = $menu

function Emit-Open {
  [Console]::Out.WriteLine('open')
  [Console]::Out.Flush()
}
function Emit-Quit {
  try { $icon.Visible = $false; $icon.Dispose() } catch {}
  [Console]::Out.WriteLine('quit')
  [Console]::Out.Flush()
  [System.Windows.Forms.Application]::Exit()
}

$openItem.add_Click({ Emit-Open })
$icon.add_DoubleClick({ Emit-Open })
$icon.add_Click({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Emit-Open }
})
$quitItem.add_Click({ Emit-Quit })

# Hidden form hosts the WinForms message loop (required for NotifyIcon)
$form = New-Object System.Windows.Forms.Form
$form.Text = '@@TITLE@@'
$form.WindowState = 'Minimized'
$form.ShowInTaskbar = $false
$form.Opacity = 0
$form.ShowIcon = $false
$form.FormBorderStyle = 'FixedToolWindow'
$form.Size = New-Object System.Drawing.Size(1, 1)
$form.add_Load({
  $icon.Visible = $true
  try {
    $icon.ShowBalloonTip(5000, '@@TITLE@@', 'TokenLab is running. Click the tray icon to open the dashboard.', [System.Windows.Forms.ToolTipIcon]::Info)
  } catch {}
  [Console]::Out.WriteLine('form-loaded')
  [Console]::Out.Flush()
})
$form.add_FormClosing({
  try { $icon.Visible = $false; $icon.Dispose() } catch {}
})
$form.add_Shown({ $form.Hide() })

# Exit when the server process is gone (panic exit / taskkill leave no other signal)
$parentPid = @@PPID@@
$watch = New-Object System.Windows.Forms.Timer
$watch.Interval = 3000
$watch.add_Tick({
  if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) {
    try { $icon.Visible = $false; $icon.Dispose() } catch {}
    [System.Windows.Forms.Application]::Exit()
  }
})
$watch.Start()

[System.Windows.Forms.Application]::Run($form)
"##;

/// Build a compact PowerShell script that hosts a NotifyIcon with context menu.
/// Communicates via stdout lines: open | quit
fn build_ps_script(_url: &str, title: &str, tooltip: &str, icon_path: Option<&str>) -> String {
    let esc = |s: &str| s.replace('\'', "''");
    let title = esc(title);
    let tooltip = esc(tooltip);
    let icon = icon_path.map(esc).unwrap_or_default();
    // Order matters: user-controlled values are substituted last-to-first so a
    // value containing a later placeholder cannot be re-expanded.
    PS_TEMPLATE
        .replace("@@PPID@@", &std::process::id().to_string())
        .replace("@@TITLE@@", "\u{0}TITLE\u{0}")
        .replace("@@ICON@@", "\u{0}ICON\u{0}")
        .replace("@@TOOLTIP@@", "\u{0}TOOLTIP\u{0}")
        .replace("\u{0}TOOLTIP\u{0}", &tooltip)
        .replace("\u{0}ICON\u{0}", &icon)
        .replace("\u{0}TITLE\u{0}", &title)
        .trim()
        .to_string()
}

// ---------------------------------------------------------------------------
// supervisor loop

const MAX_TRAY_RESTARTS: u32 = 20;

/// Write the tray script with a UTF-8 BOM: Windows PowerShell 5.1 decodes a
/// BOM-less `.ps1` with the ANSI code page (mojibake / broken non-ASCII paths).
fn write_script_file(path: &str, script: &str) -> std::io::Result<()> {
    let mut bytes: Vec<u8> = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(script.as_bytes());
    std::fs::write(path, bytes)
}

/// Best-effort removal of `tray-*.ps1` files left by crashed/killed runs.
fn sweep_stale_scripts(dir: &Path, keep: &Path) {
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for ent in rd.flatten() {
        let p = ent.path();
        if p == keep {
            continue;
        }
        let name = ent.file_name().to_string_lossy().to_string();
        if !(name.starts_with("tray-") && name.ends_with(".ps1")) {
            continue;
        }
        let old = ent
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|d| d > Duration::from_secs(24 * 3600))
            .unwrap_or(false);
        if old {
            let _ = std::fs::remove_file(&p);
        }
    }
}

struct TrayState {
    url: String,
    on_quit: Arc<dyn Fn() + Send + Sync>,
    script_path: String,
    script: String,
    child_pid: AtomicU32,
    stopped: AtomicBool,
    user_quit: AtomicBool,
    restart_attempts: AtomicU32,
    child_alive: AtomicBool,
    wake: Notify,
}

impl TrayState {
    fn cleanup_script(&self) {
        if !self.script_path.is_empty() {
            let _ = std::fs::remove_file(&self.script_path);
        }
    }

    fn should_stop(&self) -> bool {
        self.stopped.load(Ordering::SeqCst) || self.user_quit.load(Ordering::SeqCst)
    }

    fn stop(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        // Wakes the supervisor loop: it kills the child / cancels a pending restart.
        self.wake.notify_one();
        self.cleanup_script();
    }

    /// Synchronously kill the PowerShell tray host (used right before
    /// `process::exit`, when the async kill in `tray_loop` would never run).
    fn kill_child_blocking(&self) {
        let pid = self.child_pid.load(Ordering::SeqCst);
        if pid == 0 {
            return;
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(0x0800_0000)
                .status();
        }
    }

    /// Make sure the script exists (Temp cleanup / AV may have removed it).
    fn ensure_script(&self) {
        if !std::path::Path::new(&self.script_path).exists() {
            if let Err(e) = write_script_file(&self.script_path, &self.script) {
                log_error(&format!("Failed to rewrite tray script: {e}"));
            }
        }
    }

    /// Sleep for `delay`, returning early (true) when stop was requested.
    async fn interruptible_sleep(&self, delay: Duration) -> bool {
        if self.should_stop() {
            return true;
        }
        tokio::select! {
            _ = tokio::time::sleep(delay) => self.should_stop(),
            _ = self.wake.notified() => true,
        }
    }
}

async fn pump_lines<R: AsyncRead + Unpin>(reader: R, state: Arc<TrayState>, is_stdout: bool) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(raw)) = lines.next_line().await {
        let line = raw.trim().to_string();
        if line.is_empty() {
            continue;
        }
        if !is_stdout {
            log_error(&format!("Tray stderr: {line}"));
            continue;
        }
        log(&format!("Tray stdout: {line}"));
        if line == "open" {
            open_browser(&state.url);
        } else if line == "quit" {
            state.user_quit.store(true, Ordering::SeqCst);
            state.stop();
            (state.on_quit)();
        }
    }
}

fn spawn_powershell(script_path: &str) -> std::io::Result<tokio::process::Child> {
    // -STA is required for WinForms NotifyIcon message pump
    let mut cmd = tokio::process::Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        script_path,
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW (windowsHide)
    }
    cmd.spawn()
}

async fn tray_loop(state: Arc<TrayState>) {
    loop {
        if state.should_stop() {
            return;
        }
        state.ensure_script();
        match spawn_powershell(&state.script_path) {
            Err(e) => {
                log_error(&format!("Failed to spawn PowerShell tray: {e}"));
                let attempts = state.restart_attempts.load(Ordering::SeqCst);
                if !state.should_stop() && attempts < MAX_TRAY_RESTARTS {
                    let attempts = attempts + 1;
                    state.restart_attempts.store(attempts, Ordering::SeqCst);
                    let delay = std::cmp::min(30_000u64, 2_000 * attempts as u64);
                    if state.interruptible_sleep(Duration::from_millis(delay)).await {
                        return;
                    }
                    continue;
                }
                state.cleanup_script();
                return;
            }
            Ok(mut child) => {
                log(&format!("PowerShell child spawned, pid: {}", child.id().unwrap_or(0)));
                state.child_alive.store(true, Ordering::SeqCst);
                state.child_pid.store(child.id().unwrap_or(0), Ordering::SeqCst);
                // After a successful spawn, slowly decay restart counter
                {
                    let st = state.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(60)).await;
                        if !st.stopped.load(Ordering::SeqCst)
                            && st.child_alive.load(Ordering::SeqCst)
                        {
                            let cur = st.restart_attempts.load(Ordering::SeqCst);
                            if cur > 0 {
                                st.restart_attempts.store(cur - 1, Ordering::SeqCst);
                            }
                        }
                    });
                }
                let mut readers = Vec::new();
                if let Some(out) = child.stdout.take() {
                    readers.push(tokio::spawn(pump_lines(out, state.clone(), true)));
                }
                if let Some(err) = child.stderr.take() {
                    readers.push(tokio::spawn(pump_lines(err, state.clone(), false)));
                }

                let code: Option<i32> = tokio::select! {
                    status = child.wait() => match status {
                        Ok(s) => s.code(),
                        Err(e) => {
                            log_error(&format!("Tray child error: {e}"));
                            None
                        }
                    },
                    _ = state.wake.notified() => {
                        let _ = child.start_kill();
                        let _ = child.wait().await;
                        None
                    }
                };
                state.child_alive.store(false, Ordering::SeqCst);
                state.child_pid.store(0, Ordering::SeqCst);
                // Drain remaining stdout so a final "quit"/"open" line is not lost.
                for r in readers {
                    let _ = tokio::time::timeout(Duration::from_millis(500), r).await;
                }
                log(&format!(
                    "Tray child exited with code: {} userQuit: {} stopped: {}",
                    code.map(|c| c.to_string()).unwrap_or_else(|| "null".to_string()),
                    state.user_quit.load(Ordering::SeqCst),
                    state.stopped.load(Ordering::SeqCst)
                ));
                if state.should_stop() {
                    state.cleanup_script();
                    return;
                }
                // Unexpected exit (Explorer crash, PowerShell killed, etc.) - revive tray
                let attempts = state.restart_attempts.load(Ordering::SeqCst);
                if attempts >= MAX_TRAY_RESTARTS {
                    log_error("Tray restart limit reached; server keeps running without tray");
                    state.cleanup_script();
                    return;
                }
                let attempts = attempts + 1;
                state.restart_attempts.store(attempts, Ordering::SeqCst);
                let delay = std::cmp::min(30_000u64, 1_500 * attempts as u64);
                log(&format!(
                    "Tray unexpected exit - restarting in {delay}ms (attempt {attempts}/{MAX_TRAY_RESTARTS})"
                ));
                if state.interruptible_sleep(Duration::from_millis(delay)).await {
                    return;
                }
            }
        }
    }
}

pub async fn start_tray(opts: TrayOptions) -> Option<TrayHandle> {
    log("startTray called");
    if !cfg!(windows) {
        log("Tray disabled: not Windows");
        return None;
    }
    if std::env::var("TOKENLAB_NO_TRAY").as_deref() == Ok("1") {
        log("Tray disabled: TOKENLAB_NO_TRAY=1");
        return None;
    }

    let title = opts
        .title
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "TokenLab".to_string());
    let tooltip = opts
        .tooltip
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "TokenLab \u{2014} click to open dashboard".to_string());
    let icon_path = resolve_icon_path();
    log(&format!(
        "Resolved icon path: {}",
        icon_path.clone().unwrap_or_else(|| "null".to_string())
    ));
    let script = build_ps_script(&opts.url, &title, &tooltip, icon_path.as_deref());

    // Write script to a temp .ps1 - more reliable than -Command with long scripts
    let script_path = {
        let dir = std::env::temp_dir().join("tokenlab");
        let res = std::fs::create_dir_all(&dir).and_then(|_| {
            let p = dir.join(format!("tray-{}.ps1", std::process::id()));
            sweep_stale_scripts(&dir, &p);
            write_script_file(&p.to_string_lossy(), &script).map(|_| p)
        });
        match res {
            Ok(p) => {
                let p = p.to_string_lossy().to_string();
                log(&format!("Tray script written: {} bytes: {}", p, script.encode_utf16().count()));
                p
            }
            Err(e) => {
                log_error(&format!("Failed to write tray script: {e}"));
                return None;
            }
        }
    };

    let state = Arc::new(TrayState {
        url: opts.url,
        on_quit: opts.on_quit,
        script_path,
        script,
        child_pid: AtomicU32::new(0),
        stopped: AtomicBool::new(false),
        user_quit: AtomicBool::new(false),
        restart_attempts: AtomicU32::new(0),
        child_alive: AtomicBool::new(false),
        wake: Notify::new(),
    });

    tokio::spawn(tray_loop(state.clone()));

    let st = state.clone();
    Some(TrayHandle {
        stop_fn: Arc::new(move || {
            st.stop();
            st.kill_child_blocking();
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ps_script_escapes_and_substitutes() {
        let s = build_ps_script("http://x/", "Tok'en", "tip", Some("C:\\a'b\\favicon.ico"));
        assert!(s.starts_with("$ErrorActionPreference = 'Continue'"));
        assert!(s.contains("$tip = 'tip'"));
        assert!(s.contains("$form.Text = 'Tok''en'"));
        assert!(s.contains("$iconPath = 'C:\\a''b\\favicon.ico'.Trim()"));
        assert!(!s.contains("@@"));
        assert!(s.ends_with("[System.Windows.Forms.Application]::Run($form)"));
    }

    #[test]
    fn ps_script_without_icon() {
        let s = build_ps_script("u", "T", "t", None);
        assert!(s.contains("$iconPath = ''.Trim()"));
    }
}
