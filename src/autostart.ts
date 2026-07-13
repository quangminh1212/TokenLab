/**
 * Login autostart for xlab-token serve.
 * Windows (no admin): Startup folder + HKCU Run registry.
 * Other platforms: not implemented yet.
 */
import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile, unlink, access } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { localAppDataDir } from "./util.js";

const execFileAsync = promisify(execFile);

// Simple file logger to %LOCALAPPDATA%\xlab-token\autostart.txt
const logDir = path.join(process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd(), "xlab-token");
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
  return path.join(localAppDataDir(), "xlab-token");
}

function launcherPath(): string {
  return path.join(dataDir(), "autostart.vbs");
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

/** VBS supervisor: runs `node cli serve` hidden, restarts on unexpected exit
 *  (up to maxRestarts times) with a backoff sleep. Stops when the stop
 *  sentinel appears (tray Quit / intentional shutdown). */
async function writeWindowsLauncher(): Promise<string> {
  const { node, cli } = resolveServeInvocation();
  await mkdir(dataDir(), { recursive: true });
  const vbsPath = launcherPath();
  const nodeQ = node.replace(/"/g, '""');
  const cliQ = cli.replace(/"/g, '""');
  const stopFile = stopSentinelPath().replace(/"/g, '""');
  // ASCII-only to avoid cscript/wscript encoding issues
  const content = [
    "' XLab Token autostart supervisor (generated)",
    "Set sh = CreateObject(\"WScript.Shell\")",
    "Set fso = CreateObject(\"Scripting.FileSystemObject\")",
    `stopFile = "${stopFile}"`,
    "If fso.FileExists(stopFile) Then fso.DeleteFile stopFile, True",
    "maxRestarts = 10",
    "retries = 0",
    "Do While retries < maxRestarts",
    `  exitCode = sh.Run("""${nodeQ}"" ""${cliQ}"" serve", 0, True)`,
    "  If fso.FileExists(stopFile) Then Exit Do",
    "  retries = retries + 1",
    "  WScript.Sleep 3000",
    "Loop",
    "",
  ].join("\r\n");
  await writeFile(vbsPath, content, "utf8");
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
      "Autostart enabled (supervised). xlab-token serve will start when you log in to Windows and auto-restart if it crashes. Tray icon in notification area; use Quit to stop.",
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
      "XLab Token.vbs",
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

/** True when the login supervisor VBS is already running. */
export async function isSupervisorRunning(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const vbs = launcherPath().toLowerCase().replace(/\//g, "\\");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='wscript.exe' OR Name='cscript.exe'\" | Select-Object -ExpandProperty CommandLine",
      ],
      { windowsHide: true, timeout: 8000 },
    );
    const hay = String(stdout || "").toLowerCase().replace(/\//g, "\\");
    return hay.includes("autostart.vbs") || (vbs.length > 8 && hay.includes(vbs));
  } catch (err) {
    logError("isSupervisorRunning failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Start the Windows supervisor VBS now (same process as login autostart).
 * Keeps serve + tray alive and restarts on crash. No-op if already running.
 */
export async function launchSupervisorNow(): Promise<{ ok: boolean; message: string; already?: boolean }> {
  if (process.platform !== "win32") {
    return { ok: false, message: "Supervisor is Windows-only" };
  }
  try {
    // Ensure launcher exists (setup may call this after enableAutostart, but be safe)
    if (!(await pathExists(launcherPath()))) {
      await writeWindowsLauncher();
    }
    if (await isSupervisorRunning()) {
      log("Supervisor already running");
      return { ok: true, message: "Supervisor already running", already: true };
    }
    await clearStopSentinel();
    const vbs = launcherPath();
    const child = spawn("wscript.exe", [vbs], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    log("Supervisor launched, pid:", child.pid, "vbs:", vbs);
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
