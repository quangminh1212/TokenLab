/**
 * Keep long-running `serve` alive: catch fatal JS errors, write crash logs,
 * and emit a heartbeat file the Windows supervisor can use for hang detection.
 */
import fs from "node:fs";
import path from "node:path";
import { localAppDataDir } from "./util.js";

const dataDir = (): string => path.join(localAppDataDir(), "xlab-token");
const crashLogPath = (): string => path.join(dataDir(), "crash.txt");
export const heartbeatPath = (): string => path.join(dataDir(), "heartbeat.txt");

type LogFn = (...args: unknown[]) => void;

let installed = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastHeartbeatWrite = 0;

function ensureDataDir(): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
  } catch {
    // ignore
  }
}

function appendCrashLog(line: string): void {
  try {
    ensureDataDir();
    fs.appendFileSync(crashLogPath(), `[${new Date().toISOString()}] ${line}\r\n`);
  } catch {
    // ignore
  }
}

function formatReason(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack || reason.message || String(reason);
  }
  try {
    return typeof reason === "string" ? reason : JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

/** Write pid + wall-clock ms so the VBS supervisor can detect a hung process. */
export function writeHeartbeat(): void {
  try {
    ensureDataDir();
    const now = Date.now();
    // Avoid hammering disk if called very frequently
    if (now - lastHeartbeatWrite < 2_000) return;
    lastHeartbeatWrite = now;
    fs.writeFileSync(
      heartbeatPath(),
      `${now}\n${process.pid}\n${Math.floor(process.uptime())}\n`,
      "utf8",
    );
  } catch {
    // ignore
  }
}

export function startHeartbeat(intervalMs = 15_000): () => void {
  writeHeartbeat();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => writeHeartbeat(), intervalMs);
  heartbeatTimer.unref?.();
  return () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    try {
      fs.unlinkSync(heartbeatPath());
    } catch {
      // ignore
    }
  };
}

/**
 * Install once per process:
 * - unhandledRejection → log only (do not exit)
 * - uncaughtException → log crash, exit(1) so supervisor can restart cleanly
 */
export function installProcessGuard(opts?: { log?: LogFn; logError?: LogFn }): void {
  if (installed) return;
  installed = true;
  const logError: LogFn = opts?.logError || ((...a) => console.error("[xlab-token]", ...a));
  const log: LogFn = opts?.log || ((...a) => console.log("[xlab-token]", ...a));

  process.on("unhandledRejection", (reason) => {
    const msg = formatReason(reason);
    logError("unhandledRejection:", msg);
    appendCrashLog(`unhandledRejection: ${msg}`);
  });

  process.on("uncaughtException", (err) => {
    const msg = formatReason(err);
    logError("uncaughtException:", msg);
    appendCrashLog(`uncaughtException: ${msg}`);
    // Corrupted runtime state — exit so supervisor restarts a clean process.
    // Avoid double-exit storms.
    try {
      writeHeartbeat();
    } catch {
      // ignore
    }
    setTimeout(() => {
      log("exiting after uncaughtException for clean restart");
      process.exit(1);
    }, 250).unref?.();
  });

  // Surface OOM / fatal errors when available
  process.on("warning", (w) => {
    if (w && (w.name === "MaxListenersExceededWarning" || /heap|memory/i.test(String(w.message)))) {
      logError("process warning:", w.name, w.message);
      appendCrashLog(`warning: ${w.name}: ${w.message}`);
    }
  });

  log("process guard installed (anti-crash + heartbeat)");
}
