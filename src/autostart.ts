/**
 * Login autostart for xlab-token serve.
 * Windows (no admin): Startup folder + HKCU Run registry.
 * Other platforms: not implemented yet.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile, unlink, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { localAppDataDir } from "./util.js";

const execFileAsync = promisify(execFile);

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
  try {
    await mkdir(dataDir(), { recursive: true });
    await writeFile(stopSentinelPath(), "stop", "utf8");
  } catch {
    // best-effort: supervisor restart is a nicety, not critical
  }
}

export async function clearStopSentinel(): Promise<void> {
  try {
    await unlink(stopSentinelPath());
  } catch {
    // ignore (file may not exist)
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
  const vbs = await writeWindowsLauncher();
  const runCmd = `wscript.exe ${quoteCmd(vbs)}`;

  // HKCU Run — no admin, shows in Windows Settings → Apps → Startup
  try {
    await regSetRun(runCmd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `Failed to write registry Run key: ${msg}`,
      status: await getAutostartStatus(),
    };
  }

  const status = await getAutostartStatus();
  return {
    ok: true,
    message:
      "Autostart enabled (supervised). xlab-token serve will start when you log in to Windows and auto-restart if it crashes. Tray icon in notification area; use Quit to stop.",
    status,
  };
}

async function uninstallWindows(): Promise<AutostartResult> {
  const regRemoved = await regDeleteRun();

  // Signal any running supervisor to stop, then drop the launcher.
  await writeStopSentinel();
  const vbs = launcherPath();
  if (await pathExists(vbs)) {
    try {
      await unlink(vbs);
    } catch {
      // ignore
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
    if (legacy && (await pathExists(legacy))) await unlink(legacy);
  } catch {
    // ignore
  }

  const status = await getAutostartStatus();
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
  const { node, cli } = resolveServeInvocation();
  const command = `${quoteCmd(node)} ${quoteCmd(cli)} serve`;

  if (process.platform !== "win32") {
    return {
      platform: process.platform,
      enabled: false,
      detail: "Autostart is currently implemented for Windows only.",
      command,
    };
  }

  const reg = await regQueryRun();
  const enabled = Boolean(reg);
  return {
    platform: "win32",
    enabled,
    method: enabled ? "HKCU Run (Windows login)" : undefined,
    detail: enabled ? `Registry: ${reg}` : "Not registered for login startup.",
    command,
  };
}

export async function enableAutostart(): Promise<AutostartResult> {
  if (process.platform !== "win32") {
    return {
      ok: false,
      message: "Autostart is currently supported on Windows only.",
      status: await getAutostartStatus(),
    };
  }
  return installWindows();
}

export async function disableAutostart(): Promise<AutostartResult> {
  if (process.platform !== "win32") {
    return {
      ok: false,
      message: "Autostart is currently supported on Windows only.",
      status: await getAutostartStatus(),
    };
  }
  return uninstallWindows();
}
