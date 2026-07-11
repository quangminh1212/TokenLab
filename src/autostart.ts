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

/** VBS: run node cli serve with hidden window (0). */
async function writeWindowsLauncher(): Promise<string> {
  const { node, cli } = resolveServeInvocation();
  await mkdir(dataDir(), { recursive: true });
  const vbsPath = launcherPath();
  // ASCII-only comment to avoid encoding issues in cscript/wscript
  const content = [
    "' XLab Token autostart launcher (generated)",
    "Set sh = CreateObject(\"WScript.Shell\")",
    `sh.Run """${node.replace(/"/g, '""')}"" ""${cli.replace(/"/g, '""')}"" serve", 0, False`,
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
      "Autostart enabled. xlab-token serve will start when you log in to Windows (tray icon in notification area).",
    status,
  };
}

async function uninstallWindows(): Promise<AutostartResult> {
  const regRemoved = await regDeleteRun();

  // Remove launcher under LocalAppData
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
