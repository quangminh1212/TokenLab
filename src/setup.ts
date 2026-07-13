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
  launchSupervisorNow,
  resolveServeInvocation,
} from "./autostart.js";
import { openBrowser } from "./util.js";

export interface SetupOptions {
  /** Open dashboard in browser when starting or if already up (default true). */
  open?: boolean;
  /** Register login autostart on Windows (default true). */
  autostart?: boolean;
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
  const wantServe = opts.serve !== false;
  const host = opts.host || defaultHost();
  const port = opts.port ?? defaultPort();
  const url = `http://${host}:${port}/`;

  const parts: string[] = [];
  let autostartEnabled: boolean | undefined;

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

  let serverRunning = await isServerReachable(host, port);
  let serverStarted = false;

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
        const sup = await launchSupervisorNow();
        parts.push(sup.ok ? sup.message : `supervisor: ${sup.message}`);
        if (!sup.ok) {
          // Fallback: direct serve (no restart) if VBS cannot start
          startServeDetached({ open, host, port });
        }
      } else {
        startServeDetached({ open, host, port });
      }
      serverStarted = true;
      // Wait until listen (cold start can take a few seconds)
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (await isServerReachable(host, port)) {
          serverRunning = true;
          break;
        }
      }
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
    url,
    detail: parts.join("; "),
  };
}
