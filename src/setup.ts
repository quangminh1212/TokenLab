/**
 * First-run bootstrap after global npm install:
 * enable Windows login autostart + start serve (detached) if not already up.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import {
  clearStopSentinel,
  enableAutostart,
  getAutostartStatus,
  installDesktopShortcut,
  launchSupervisorNow,
  resolveServeInvocation,
} from "./autostart.js";
import { openBrowser } from "./util.js";

export interface SetupOptions {
  /** Open dashboard in browser when starting or if already up (default true). */
  open?: boolean;
  /** Register login autostart on Windows (default true). */
  autostart?: boolean;
  /** Create/refresh Desktop shortcut to launch the app (default true). */
  desktop?: boolean;
  /** Start serve process if not running (default true). */
  serve?: boolean;
  host?: string;
  port?: number;
}

export interface SetupResult {
  ok: boolean;
  message: string;
  serverRunning: boolean;
  serverStarted: boolean;
  autostartEnabled?: boolean;
  desktopShortcut?: string;
  url: string;
  detail?: string;
}

function defaultHost(): string {
  return process.env.XLAB_TOKEN_HOST || "127.0.0.1";
}

function defaultPort(): number {
  return Number(process.env.XLAB_TOKEN_PORT || 3737);
}

export async function isServerReachable(host: string, port: number): Promise<boolean> {
  const url = `http://${host}:${port}/api/health`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      return res.ok;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

function startServeDetached(opts: { open: boolean; host: string; port: number }): void {
  const { node, cli } = resolveServeInvocation();
  const args = [cli, "serve", "--host", opts.host, "--port", String(opts.port)];
  if (opts.open) args.push("--open");

  const child = spawn(node, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env },
    cwd: path.dirname(cli),
  });
  child.unref();
}

/**
 * Enable autostart (Windows) and ensure local dashboard is running.
 * Safe to call repeatedly; never throws for expected platform limits.
 */
export async function runSetup(opts: SetupOptions = {}): Promise<SetupResult> {
  const open = opts.open !== false;
  const wantAutostart = opts.autostart !== false;
  const wantDesktop = opts.desktop !== false;
  const wantServe = opts.serve !== false;
  const host = opts.host || defaultHost();
  const port = opts.port ?? defaultPort();
  const url = `http://${host}:${port}/`;

  const parts: string[] = [];
  let autostartEnabled: boolean | undefined;
  let desktopShortcut: string | undefined;

  if (wantAutostart) {
    if (process.platform === "win32") {
      const result = await enableAutostart();
      autostartEnabled = result.status.enabled;
      parts.push(result.ok ? "autostart ON" : `autostart failed: ${result.message}`);
    } else {
      const st = await getAutostartStatus();
      autostartEnabled = false;
      parts.push(st.detail || "autostart not available on this platform");
    }
  }

  if (wantDesktop) {
    try {
      const desk = await installDesktopShortcut();
      if (desk.ok && desk.path) {
        desktopShortcut = desk.path;
        parts.push("desktop shortcut ready");
      } else if (desk.ok) {
        parts.push("desktop shortcut ready");
      } else {
        parts.push(desk.message);
      }
    } catch (err) {
      parts.push(
        `desktop shortcut skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let serverRunning = await isServerReachable(host, port);
  let serverStarted = false;

  async function waitForServer(ms: number): Promise<boolean> {
    const steps = Math.max(1, Math.ceil(ms / 250));
    for (let i = 0; i < steps; i++) {
      if (await isServerReachable(host, port)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return isServerReachable(host, port);
  }

  if (wantServe) {
    if (serverRunning) {
      parts.push("server already running");
      if (open) {
        try {
          openBrowser(url);
        } catch {
          // ignore
        }
      }
    } else {
      // Allow a fresh start even if user previously Quit (stop.flag present).
      await clearStopSentinel();
      // Windows: start the same supervised VBS used at login so serve + tray
      // stay alive and auto-restart. Plain detached node often dies with no tray.
      if (process.platform === "win32") {
        let sup = await launchSupervisorNow();
        parts.push(sup.ok ? sup.message : `supervisor: ${sup.message}`);
        // Supervisor may be stuck in a dual-instance crash loop — wait briefly,
        // then force a single clean supervisor if health never comes up.
        serverRunning = await waitForServer(12_000);
        if (!serverRunning) {
          // Dual/zombie supervisors can loop forever without binding :3737
          sup = await launchSupervisorNow({ forceRestart: true });
          parts.push(
            sup.ok
              ? "supervisor force-restarted"
              : `supervisor force-restart failed: ${sup.message}`,
          );
          if (!sup.ok) {
            startServeDetached({ open, host, port });
          }
          serverRunning = await waitForServer(15_000);
        }
      } else {
        startServeDetached({ open, host, port });
        serverRunning = await waitForServer(10_000);
      }
      serverStarted = true;
      parts.push(
        serverRunning
          ? `started server + tray at ${url}`
          : `started server in background (dashboard: ${url})`,
      );
      if (open && serverRunning) {
        try {
          openBrowser(url);
        } catch {
          // ignore
        }
      }
    }
  }

  return {
    ok: true,
    message: parts.join("; ") || "setup complete",
    serverRunning,
    serverStarted,
    autostartEnabled,
    desktopShortcut,
    url,
    detail: parts.join("; "),
  };
}
