/**
 * Login autostart for tokenlab serve.
 * Windows (no admin): Startup folder + HKCU Run registry.
 * Other platforms: not implemented yet.
 */
import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile, unlink, access, copyFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { localAppDataDir } from "./util.js";

const execFileAsync = promisify(execFile);

// Simple file logger to %LOCALAPPDATA%\tokenlab\autostart.txt
const logDir = path.join(process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd(), "tokenlab");
const logFile = path.join(logDir, "autostart.txt");

function log(...args: unknown[]): void {
  const message = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`;
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    fs.appendFileSync(logFile, message + "\r\n");
  } catch {
    // ignore logging errors
  }
}

function logError(...args: unknown[]): void {
  log("[ERROR]", ...args);
}

/** HKCU Run value name (shows in Windows Startup apps) */
export const AUTOSTART_NAME = "XLabToken";

export interface AutostartStatus {
  platform: string;
  enabled: boolean;
  method?: string;
  detail?: string;
  command?: string;
}

export interface AutostartResult {
  ok: boolean;
  message: string;
  status: AutostartStatus;
}

/** Resolve node + CLI entry used for serve (global npm + local dist/tsx). */
export function resolveServeInvocation(): { node: string; cli: string; args: string[] } {
  const node = process.execPath;
  const cli = process.argv[1] ? path.resolve(process.argv[1]) : fileURLToPath(import.meta.url);
  log("Resolved serve invocation:", { node, cli });
  return { node, cli, args: [cli, "serve"] };
}

function dataDir(): string {
  return path.join(localAppDataDir(), "tokenlab");
}

function launcherPath(): string {
  return path.join(dataDir(), "autostart.vbs");
}

/** One-click desktop launcher (starts setup: server + tray + open dashboard). */
function desktopLauncherPath(): string {
  return path.join(dataDir(), "desktop-launch.vbs");
}

function desktopIconPath(): string {
  return path.join(dataDir(), "app.ico");
}

/** Resolve package favicon.ico next to dist CLI (installer/dist/server/assets). */
function resolvePackageIcon(): string | null {
  const { cli } = resolveServeInvocation();
  const candidates = [
    path.join(path.dirname(cli), "server", "assets", "favicon.ico"),
    path.join(path.dirname(cli), "assets", "favicon.ico"),
    path.join(path.dirname(fileURLToPath(import.meta.url)), "server", "assets", "favicon.ico"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function quoteCmd(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Sentinel file written by `serve` when the user quits via tray/SIGINT.
 *  The supervisor VBS checks this after the node process exits; if present,
 *  it stops restarting. Absent => crash/unexpected exit => restart. */
export function stopSentinelPath(): string {
  return path.join(dataDir(), "stop.flag");
}

export async function writeStopSentinel(): Promise<void> {
  log("Writing stop sentinel:", stopSentinelPath());
  try {
    await mkdir(dataDir(), { recursive: true });
    await writeFile(stopSentinelPath(), "stop", "utf8");
  } catch (err) {
    logError("Failed to write stop sentinel:", err instanceof Error ? err.message : err);
  }
}

export async function clearStopSentinel(): Promise<void> {
  log("Clearing stop sentinel:", stopSentinelPath());
  try {
    await unlink(stopSentinelPath());
  } catch (err) {
    logError("Failed to clear stop sentinel:", err instanceof Error ? err.message : err);
  }
}

/** Heartbeat file written by `serve` process-guard (ms timestamp on line 1). */
export function heartbeatPath(): string {
  return path.join(dataDir(), "heartbeat.txt");
}

function supervisorLogPath(): string {
  return path.join(dataDir(), "supervisor.txt");
}

/**
 * VBS supervisor: runs `node cli serve` hidden, restarts forever on crash/hang
 * (unless stop.flag from tray Quit). Uses WMI so we can poll heartbeat while
 * the child is running and kill a hung process.
 */
async function writeWindowsLauncher(): Promise<string> {
  const { node, cli } = resolveServeInvocation();
  await mkdir(dataDir(), { recursive: true });
  const vbsPath = launcherPath();
  const nodeQ = node.replace(/"/g, '""');
  const cliQ = cli.replace(/"/g, '""');
  const stopFile = stopSentinelPath().replace(/"/g, '""');
  const hbFile = heartbeatPath().replace(/"/g, '""');
  const logFile = supervisorLogPath().replace(/"/g, '""');
  // ASCII-only to avoid cscript/wscript encoding issues
  // Hang = no heartbeat refresh for 120s after grace 90s from start.
  // Never give up restarting (only stop.flag ends the loop).
  const content = [
    "' TokenLab autostart supervisor (generated) - anti-crash / anti-hang",
    "Set sh = CreateObject(\"WScript.Shell\")",
    "Set fso = CreateObject(\"Scripting.FileSystemObject\")",
    "On Error Resume Next",
    "Set wmi = GetObject(\"winmgmts:\\\\.\\root\\cimv2\")",
    "On Error Goto 0",
    `stopFile = "${stopFile}"`,
    `hbFile = "${hbFile}"`,
    `logFile = "${logFile}"`,
    `nodePath = "${nodeQ}"`,
    `cliPath = "${cliQ}"`,
    "If fso.FileExists(stopFile) Then fso.DeleteFile stopFile, True",
    "",
    "Sub LogLine(msg)",
    "  On Error Resume Next",
    "  Dim ts",
    "  Set ts = fso.OpenTextFile(logFile, 8, True)",
    "  ts.WriteLine Now & \" \" & msg",
    "  ts.Close",
    "  On Error Goto 0",
    "End Sub",
    "",
    "Function ProcessAlive(pid)",
    "  ProcessAlive = False",
    "  If pid <= 0 Then Exit Function",
    "  On Error Resume Next",
    "  Dim col, p",
    "  Set col = wmi.ExecQuery(\"SELECT ProcessId FROM Win32_Process WHERE ProcessId=\" & pid)",
    "  For Each p In col",
    "    ProcessAlive = True",
    "  Next",
    "  On Error Goto 0",
    "End Function",
    "",
    "Sub KillPid(pid)",
    "  If pid <= 0 Then Exit Sub",
    "  On Error Resume Next",
    "  sh.Run \"taskkill /F /PID \" & pid & \" /T\", 0, True",
    "  On Error Goto 0",
    "End Sub",
    "",
    "' Keep only the oldest wscript/cscript running THIS launcher (full path).",
    "' Do NOT match bare \"autostart.vbs\" — legacy xlab-token\\autostart.vbs would race and kill us.",
    "Sub EnsureSingleInstance()",
    "  On Error Resume Next",
    "  Dim col, p, cmd, minPid, n, selfKey",
    "  selfKey = LCase(WScript.ScriptFullName)",
    "  minPid = 0",
    "  n = 0",
    "  Set col = wmi.ExecQuery(\"SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='wscript.exe' OR Name='cscript.exe'\")",
    "  For Each p In col",
    "    cmd = LCase(p.CommandLine & \"\")",
    "    If InStr(cmd, selfKey) > 0 Then",
    "      n = n + 1",
    "      If minPid = 0 Or p.ProcessId < minPid Then minPid = p.ProcessId",
    "    End If",
    "  Next",
    "  If n <= 1 Or minPid = 0 Then Exit Sub",
    "  LogLine \"duplicate supervisors=\" & n & \" - keep pid=\" & minPid",
    "  For Each p In col",
    "    cmd = LCase(p.CommandLine & \"\")",
    "    If InStr(cmd, selfKey) > 0 Then",
    "      If p.ProcessId <> minPid Then",
    "        LogLine \"killing duplicate supervisor pid=\" & p.ProcessId",
    "        KillPid p.ProcessId",
    "      End If",
    "    End If",
    "  Next",
    "  WScript.Sleep 400",
    "  On Error Goto 0",
    "End Sub",
    "",
    "EnsureSingleInstance",
    "If fso.FileExists(stopFile) Then",
    "  LogLine \"stop.flag after single-instance check - exit\"",
    "  WScript.Quit 0",
    "End If",
    "",
    "Function FindExistingServe()",
    "  FindExistingServe = 0",
    "  On Error Resume Next",
    "  Dim col, p, cmd",
    "  Set col = wmi.ExecQuery(\"SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'\")",
    "  For Each p In col",
    "    cmd = LCase(p.CommandLine & \"\")",
    "    If InStr(cmd, \"cli.js\") > 0 Then",
    "      If InStr(cmd, \" serve\") > 0 Or Right(cmd, 5) = \"serve\" Then",
    "        FindExistingServe = p.ProcessId",
    "        Exit Function",
    "      End If",
    "    End If",
    "  Next",
    "  On Error Goto 0",
    "End Function",
    "",
    "Function StartServe()",
    "  StartServe = 0",
    "  On Error Resume Next",
    "  Dim startup, proc, ret, pid, existing",
    "  existing = FindExistingServe()",
    "  If existing > 0 Then",
    "    StartServe = existing",
    "    LogLine \"adopt existing serve pid=\" & existing",
    "    On Error Goto 0",
    "    Exit Function",
    "  End If",
    "  pid = 0",
    "  Set startup = wmi.Get(\"Win32_ProcessStartup\").SpawnInstance_()",
    "  startup.ShowWindow = 0",
    "  Set proc = wmi.Get(\"Win32_Process\")",
    "  ret = proc.Create(\"\"\"\" & nodePath & \"\"\" \"\"\" & cliPath & \"\"\" serve\", Null, startup, pid)",
    "  If ret = 0 And pid > 0 Then StartServe = pid",
    "  On Error Goto 0",
    "End Function",
    "",
    "Function HeartbeatAgeMs()",
    "  HeartbeatAgeMs = -1",
    "  On Error Resume Next",
    "  If Not fso.FileExists(hbFile) Then Exit Function",
    "  Dim ts, line, ms, nowMs",
    "  Set ts = fso.OpenTextFile(hbFile, 1, False)",
    "  line = Trim(ts.ReadLine)",
    "  ts.Close",
    "  If IsNumeric(line) Then",
    "    ms = CDbl(line)",
    "    nowMs = CDbl(DateDiff(\"s\", \"1/1/1970\", Now)) * 1000",
    "    ' DateDiff is local-time based; heartbeat is UTC epoch - compare file mtime instead",
    "  End If",
    "  HeartbeatAgeMs = DateDiff(\"s\", fso.GetFile(hbFile).DateLastModified, Now) * 1000",
    "  If HeartbeatAgeMs < 0 Then HeartbeatAgeMs = 0",
    "  On Error Goto 0",
    "End Function",
    "",
    "retries = 0",
    "LogLine \"supervisor started\"",
    "Do",
    "  EnsureSingleInstance",
    "  If fso.FileExists(stopFile) Then",
    "    LogLine \"stop.flag present - exit\"",
    "    Exit Do",
    "  End If",
    "  If fso.FileExists(hbFile) Then",
    "    On Error Resume Next",
    "    fso.DeleteFile hbFile, True",
    "    On Error Goto 0",
    "  End If",
    "  pid = StartServe()",
    "  If pid <= 0 Then",
    "    retries = retries + 1",
    "    LogLine \"failed to start serve (attempt \" & retries & \")\"",
    "    sleepMs = 5000",
    "    If retries > 5 Then sleepMs = 15000",
    "    If retries > 15 Then sleepMs = 60000",
    "    WScript.Sleep sleepMs",
    "  Else",
    "    LogLine \"serve started pid=\" & pid",
    "    startedAt = Timer",
    "    hung = False",
    "    Do",
    "      WScript.Sleep 5000",
    "      If fso.FileExists(stopFile) Then",
    "        ' Graceful quit (tray/Ctrl+C): wait for serve to flush scan-cache.",
    "        ' Immediate KillPid used to truncate usage and drop today's cost/tokens.",
    "        LogLine \"stop.flag - waiting graceful exit pid=\" & pid",
    "        grace = 0",
    "        Do While grace < 60",
    "          If Not ProcessAlive(pid) Then",
    "            LogLine \"serve exited after stop.flag pid=\" & pid",
    "            Exit Do",
    "          End If",
    "          WScript.Sleep 500",
    "          grace = grace + 1",
    "        Loop",
    "        If ProcessAlive(pid) Then",
    "          LogLine \"stop.flag - force kill after grace pid=\" & pid",
    "          KillPid pid",
    "        End If",
    "        Exit Do",
    "      End If",
    "      If Not ProcessAlive(pid) Then",
    "        LogLine \"serve exited pid=\" & pid",
    "        Exit Do",
    "      End If",
    "      ' Hang detection after 90s uptime: heartbeat older than 120s",
    "      uptimeSec = Timer - startedAt",
    "      If uptimeSec < 0 Then uptimeSec = uptimeSec + 86400",
    "      If uptimeSec >= 90 Then",
    "        age = HeartbeatAgeMs()",
    "        If age < 0 Or age > 120000 Then",
    "          LogLine \"hang detected pid=\" & pid & \" hbAgeMs=\" & age & \" - killing\"",
    "          KillPid pid",
    "          hung = True",
    "          Exit Do",
    "        End If",
    "      End If",
    "      ' Reset fast-restart counter after 60s healthy run",
    "      If uptimeSec >= 60 And retries > 0 Then retries = 0",
    "    Loop",
    "    If fso.FileExists(stopFile) Then",
    "      LogLine \"stop.flag - supervisor exit\"",
    "      Exit Do",
    "    End If",
    "    retries = retries + 1",
    "    sleepMs = 3000",
    "    If hung Then sleepMs = 5000",
    "    If retries > 5 Then sleepMs = 10000",
    "    If retries > 15 Then sleepMs = 30000",
    "    If retries > 30 Then sleepMs = 60000",
    "    LogLine \"restart in \" & sleepMs & \"ms (attempt \" & retries & \")\"",
    "    WScript.Sleep sleepMs",
    "  End If",
    "Loop",
    "LogLine \"supervisor stopped\"",
    "",
  ].join("\r\n");
  await writeFile(vbsPath, content, "utf8");
  log("Windows supervisor VBS written (anti-crash/hang):", vbsPath);
  return vbsPath;
}

async function regQueryRun(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", AUTOSTART_NAME],
      { windowsHide: true },
    );
    const m = stdout.match(/REG_SZ\s+(.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

async function regSetRun(command: string): Promise<void> {
  await execFileAsync(
    "reg",
    [
      "add",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/v",
      AUTOSTART_NAME,
      "/t",
      "REG_SZ",
      "/d",
      command,
      "/f",
    ],
    { windowsHide: true },
  );
}

async function regDeleteRun(): Promise<boolean> {
  try {
    await execFileAsync(
      "reg",
      ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", AUTOSTART_NAME, "/f"],
      { windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}

async function installWindows(): Promise<AutostartResult> {
  log("Installing Windows autostart");
  const vbs = await writeWindowsLauncher();
  const runCmd = `wscript.exe ${quoteCmd(vbs)}`;
  log("Launcher path:", vbs);
  log("Run command:", runCmd);

  // HKCU Run — no admin, shows in Windows Settings → Apps → Startup
  try {
    await regSetRun(runCmd);
    log("Registry Run key set successfully");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("Failed to write registry Run key:", msg);
    return {
      ok: false,
      message: `Failed to write registry Run key: ${msg}`,
      status: await getAutostartStatus(),
    };
  }

  const status = await getAutostartStatus();
  log("Autostart installed, status:", status);
  return {
    ok: true,
    message:
      "Autostart enabled (supervised). tokenlab serve starts at login, auto-restarts on crash/hang, and keeps a tray icon; use Quit to stop.",
    status,
  };
}

async function uninstallWindows(): Promise<AutostartResult> {
  log("Uninstalling Windows autostart");
  const regRemoved = await regDeleteRun();
  log("Registry removed:", regRemoved);

  // Signal any running supervisor to stop, then drop the launcher.
  await writeStopSentinel();
  const vbs = launcherPath();
  if (await pathExists(vbs)) {
    try {
      await unlink(vbs);
      log("Launcher removed:", vbs);
    } catch (err) {
      logError("Failed to remove launcher:", err instanceof Error ? err.message : err);
    }
  }

  // Clean leftover Startup-folder copy from older installs (if any)
  try {
    const legacy = path.join(
      process.env.APPDATA || "",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      "TokenLab.vbs",
    );
    if (legacy && (await pathExists(legacy))) {
      await unlink(legacy);
      log("Legacy startup shortcut removed:", legacy);
    }
  } catch (err) {
    logError("Failed to remove legacy shortcut:", err instanceof Error ? err.message : err);
  }

  const status = await getAutostartStatus();
  log("Autostart uninstalled, status:", status);
  if (!regRemoved && !status.enabled) {
    return { ok: true, message: "Autostart was already off.", status };
  }
  return {
    ok: true,
    message: "Autostart disabled (removed from Windows login startup).",
    status,
  };
}

export async function getAutostartStatus(): Promise<AutostartStatus> {
  log("Getting autostart status");
  const { node, cli } = resolveServeInvocation();
  const command = `${quoteCmd(node)} ${quoteCmd(cli)} serve`;

  if (process.platform !== "win32") {
    log("Autostart status: not Windows");
    return {
      platform: process.platform,
      enabled: false,
      detail: "Autostart is currently implemented for Windows only.",
      command,
    };
  }

  const reg = await regQueryRun();
  const enabled = Boolean(reg);
  const status = {
    platform: "win32",
    enabled,
    method: enabled ? "HKCU Run (Windows login)" : undefined,
    detail: enabled ? `Registry: ${reg}` : "Not registered for login startup.",
    command,
  };
  log("Autostart status:", status);
  return status;
}

export async function enableAutostart(): Promise<AutostartResult> {
  log("enableAutostart called");
  if (process.platform !== "win32") {
    logError("Autostart enable failed: not Windows");
    return {
      ok: false,
      message: "Autostart is currently supported on Windows only.",
      status: await getAutostartStatus(),
    };
  }
  return installWindows();
}

/** List PIDs of wscript/cscript hosting autostart.vbs. */
export async function listSupervisorPids(): Promise<number[]> {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='wscript.exe' OR Name='cscript.exe'\" | Where-Object { $_.CommandLine -match 'autostart\\.vbs' } | Select-Object -ExpandProperty ProcessId",
      ],
      { windowsHide: true, timeout: 8000 },
    );
    return String(stdout || "")
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch (err) {
    logError("listSupervisorPids failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** True when the login supervisor VBS is already running. */
export async function isSupervisorRunning(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const pids = await listSupervisorPids();
  return pids.length > 0;
}

/**
 * Kill all supervisor host processes (wscript/cscript autostart.vbs).
 * Does not write stop.flag — caller may clearStopSentinel + relaunch.
 */
export async function killAllSupervisors(): Promise<number> {
  if (process.platform !== "win32") return 0;
  const pids = await listSupervisorPids();
  if (pids.length === 0) return 0;
  log("Killing supervisors:", pids.join(","));
  for (const pid of pids) {
    try {
      await execFileAsync("taskkill", ["/F", "/PID", String(pid), "/T"], {
        windowsHide: true,
        timeout: 8000,
      });
    } catch (err) {
      logError("taskkill supervisor failed:", pid, err instanceof Error ? err.message : err);
    }
  }
  // Brief settle so process table / port release
  await new Promise((r) => setTimeout(r, 400));
  return pids.length;
}

/**
 * Start the Windows supervisor VBS now (same process as login autostart).
 * Keeps serve + tray alive and restarts on crash.
 * @param forceRestart when true, kill existing supervisors first then start fresh
 */
export async function launchSupervisorNow(opts?: {
  forceRestart?: boolean;
}): Promise<{ ok: boolean; message: string; already?: boolean }> {
  if (process.platform !== "win32") {
    return { ok: false, message: "Supervisor is Windows-only" };
  }
  try {
    // Always refresh launcher so anti-crash/hang improvements apply after upgrades
    await writeWindowsLauncher();
    const force = opts?.forceRestart === true;
    if (!force && (await isSupervisorRunning())) {
      // Collapse duplicates without dropping the primary instance
      const pids = await listSupervisorPids();
      if (pids.length > 1) {
        const keep = Math.min(...pids);
        log("Multiple supervisors; keeping", keep, "killing extras");
        for (const pid of pids) {
          if (pid === keep) continue;
          try {
            await execFileAsync("taskkill", ["/F", "/PID", String(pid), "/T"], {
              windowsHide: true,
              timeout: 8000,
            });
          } catch {
            // ignore
          }
        }
      }
      log("Supervisor already running (launcher refreshed on disk)");
      return { ok: true, message: "Supervisor already running", already: true };
    }
    if (force) {
      await killAllSupervisors();
    }
    await clearStopSentinel();
    const vbs = launcherPath();
    const child = spawn("wscript.exe", [vbs], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    log("Supervisor launched, pid:", child.pid, "vbs:", vbs, "force:", force);
    return { ok: true, message: `Supervisor started (pid ${child.pid ?? "?"})` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("launchSupervisorNow failed:", msg);
    return { ok: false, message: msg };
  }
}

export async function disableAutostart(): Promise<AutostartResult> {
  log("disableAutostart called");
  if (process.platform !== "win32") {
    logError("Autostart disable failed: not Windows");
    return {
      ok: false,
      message: "Autostart is currently supported on Windows only.",
      status: await getAutostartStatus(),
    };
  }
  return uninstallWindows();
}

/**
 * Write a hidden desktop launcher VBS:
 * runs `node cli setup` (start serve+tray if needed, open dashboard) without a console flash.
 */
async function writeDesktopLauncherVbs(): Promise<string> {
  const { node, cli } = resolveServeInvocation();
  await mkdir(dataDir(), { recursive: true });
  const vbsPath = desktopLauncherPath();
  const nodeQ = node.replace(/"/g, '""');
  const cliQ = cli.replace(/"/g, '""');
  // setup: ensure autostart, start supervised serve + tray, open browser (hidden console)
  const content = [
    "' TokenLab desktop launcher (generated)",
    "Set sh = CreateObject(\"WScript.Shell\")",
    `sh.Run """${nodeQ}"" ""${cliQ}"" setup", 0, False`,
    "",
  ].join("\r\n");
  await writeFile(vbsPath, content, "utf8");
  log("Desktop launcher written:", vbsPath);
  return vbsPath;
}

async function resolveWindowsDesktopDir(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Environment]::GetFolderPath('Desktop')",
      ],
      { windowsHide: true, timeout: 8000 },
    );
    const dir = String(stdout || "").trim();
    if (dir && fs.existsSync(dir)) return dir;
  } catch (err) {
    logError("GetFolderPath Desktop failed:", err instanceof Error ? err.message : err);
  }
  // Fallbacks (OneDrive Desktop is common on modern Windows)
  const candidates = [
    process.env.OneDrive ? path.join(process.env.OneDrive, "Desktop") : "",
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "Desktop") : "",
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "OneDrive", "Desktop") : "",
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, "Desktop")
    : path.join(osHomedirFallback(), "Desktop");
}

function osHomedirFallback(): string {
  return process.env.HOME || process.env.USERPROFILE || process.cwd();
}

/**
 * Create/refresh "TokenLab.lnk" on the user Desktop (Windows).
 * Called from setup / global npm postinstall so users can double-click to start the app.
 */
export async function installDesktopShortcut(): Promise<{
  ok: boolean;
  message: string;
  path?: string;
}> {
  log("installDesktopShortcut called");
  if (process.platform !== "win32") {
    // Best-effort Linux .desktop; macOS gets a simple .command launcher
    return installDesktopShortcutNonWindows();
  }

  try {
    const vbs = await writeDesktopLauncherVbs();
    // Stable icon under %LOCALAPPDATA% so the .lnk keeps working after package updates
    const iconSrc = resolvePackageIcon();
    let icon = desktopIconPath();
    if (iconSrc) {
      try {
        await copyFile(iconSrc, icon);
        log("Desktop icon copied:", iconSrc, "->", icon);
      } catch (err) {
        logError("Icon copy failed:", err instanceof Error ? err.message : err);
        icon = iconSrc;
      }
    } else {
      icon = "";
      log("Package icon not found; shortcut will use default icon");
    }

    const desktop = await resolveWindowsDesktopDir();
    await mkdir(desktop, { recursive: true });
    const lnkPath = path.join(desktop, "TokenLab.lnk");

    const ps = [
      "$ErrorActionPreference = 'Stop'",
      `$desktop = ${JSON.stringify(desktop)}`,
      `$lnkPath = ${JSON.stringify(lnkPath)}`,
      `$vbs = ${JSON.stringify(vbs)}`,
      `$icon = ${JSON.stringify(icon)}`,
      "$w = New-Object -ComObject WScript.Shell",
      "$s = $w.CreateShortcut($lnkPath)",
      "$s.TargetPath = 'wscript.exe'",
      "$s.Arguments = '\"' + $vbs + '\"'",
      "$s.WorkingDirectory = [IO.Path]::GetDirectoryName($vbs)",
      "$s.WindowStyle = 7",
      "$s.Description = 'TokenLab — start local usage dashboard'",
      "if ($icon -and (Test-Path -LiteralPath $icon)) { $s.IconLocation = $icon }",
      "$s.Save()",
      "Write-Output $lnkPath",
    ].join("; ");

    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-Command", ps],
      { windowsHide: true, timeout: 15000 },
    );
    const created = String(stdout || "").trim() || lnkPath;
    log("Desktop shortcut created:", created);
    return {
      ok: true,
      message: `Desktop shortcut: ${created}`,
      path: created,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("installDesktopShortcut failed:", msg);
    return { ok: false, message: `Desktop shortcut failed: ${msg}` };
  }
}

async function installDesktopShortcutNonWindows(): Promise<{
  ok: boolean;
  message: string;
  path?: string;
}> {
  try {
    const { node, cli } = resolveServeInvocation();
    const home = process.env.HOME || osHomedirFallback();
    const desktop = path.join(home, "Desktop");
    if (!fs.existsSync(desktop)) {
      return { ok: false, message: "Desktop folder not found" };
    }

    if (process.platform === "darwin") {
      const cmdPath = path.join(desktop, "TokenLab.command");
      const body = [
        "#!/bin/bash",
        `cd ${JSON.stringify(path.dirname(cli))}`,
        `exec ${JSON.stringify(node)} ${JSON.stringify(cli)} setup`,
        "",
      ].join("\n");
      await writeFile(cmdPath, body, { encoding: "utf8", mode: 0o755 });
      try {
        await execFileAsync("chmod", ["+x", cmdPath]);
      } catch {
        // ignore
      }
      return { ok: true, message: `Desktop launcher: ${cmdPath}`, path: cmdPath };
    }

    // Linux .desktop
    const desktopFile = path.join(desktop, "tokenlab.desktop");
    const iconSrc = resolvePackageIcon();
    const lines = [
      "[Desktop Entry]",
      "Type=Application",
      "Name=TokenLab",
      "Comment=Local AI token usage & cost dashboard",
      `Exec=${JSON.stringify(node)} ${JSON.stringify(cli)} setup`,
      "Terminal=false",
      "Categories=Utility;Development;",
      iconSrc ? `Icon=${iconSrc}` : "",
      "",
    ].filter(Boolean);
    await writeFile(desktopFile, lines.join("\n"), { encoding: "utf8", mode: 0o755 });
    return { ok: true, message: `Desktop launcher: ${desktopFile}`, path: desktopFile };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Desktop shortcut failed: ${msg}` };
  }
}
