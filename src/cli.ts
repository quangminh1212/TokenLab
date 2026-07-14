#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { aggregate, costReport } from "./aggregate.js";
import { detectAgents, scanAll } from "./agents/index.js";
import {
  disableAutostart,
  enableAutostart,
  getAutostartStatus,
  writeStopSentinel,
} from "./autostart.js";
import { downloadBackupFromGist, uploadBackupToGist } from "./backup.js";
import { installProcessGuard, startHeartbeat } from "./process-guard.js";
import { startServer } from "./server/http.js";
import { runSetup } from "./setup.js";
import { startTray } from "./tray.js";
import type { GroupBy } from "./types.js";
import { filterByPeriod, formatTokens, formatUsd, openBrowser } from "./util.js";
import { VERSION } from "./version.js";

// Simple file logger to %LOCALAPPDATA%\xlab-token\server.txt
const logDir = path.join(process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd(), "xlab-token");
const logFile = path.join(logDir, "server.txt");

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

function printHelp(): void {
  console.log(`xlab-token v${VERSION}

Local-first token API usage & cost tracker for AI agents on this machine.

Usage:
  xlab-token serve [--host 127.0.0.1] [--port 3737] [--no-ui] [--open] [--no-tray]
  xlab-token setup [--no-open] [--no-autostart] [--no-desktop] [--no-serve] [--json]
  xlab-token stats [--since 24h|7d|30d] [--by agent|model|day] [--sort tokens|cost] [--json]
  xlab-token cost  [--since 7d] [--json]
  xlab-token scan  [--json]
  xlab-token doctors [--json]
  xlab-token autostart [on|off|status] [--json]
  xlab-token backup upload [--token <token>] [--gist <id>] [--public] [--save-token] [--json]
  xlab-token backup download [--token <token>] [--gist <id>] [--json]
  xlab-token backup status
  xlab-token --version
  xlab-token --help

Serve options:
  --open       Open dashboard in browser
  --no-ui      API only (no HTML UI)
  --no-tray    Do not show system tray icon (Windows)

Backup options:
  --token      GitHub personal access token
  --gist       Gist id to update/download
  --public     Make the Gist public (default: secret)
  --save-token Save the token to local config

Setup (also runs after global npm install):
  Enables Windows login autostart, creates a Desktop shortcut, and starts the dashboard if not already running.
  --no-open       Do not open the browser
  --no-autostart  Skip login autostart registration
  --no-desktop    Skip Desktop shortcut (XLab Token.lnk)
  --no-serve      Do not start the server

Autostart (Windows):
  on           Start xlab-token serve at Windows login (supervised, auto-restart)
  off          Remove login autostart
  status       Show whether autostart is enabled

Platforms: Windows, macOS, Linux (Node.js 20+)

Inspired by tokscale / codeburn / ccusage feature sets — original implementation.
`);
}

function getFlag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return args[i + 1] ?? null;
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    return;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(VERSION);
    return;
  }

  if (cmd === "serve") {
    log("CLI serve command started");
    log("Args:", args.join(" "));
    // Anti-crash: catch unhandled rejections / uncaught exceptions; heartbeat for hang watchdog
    installProcessGuard({ log, logError });
    const stopHeartbeat = startHeartbeat(15_000);

    const host = getFlag(args, "--host") || undefined;
    const port = getFlag(args, "--port") ? Number(getFlag(args, "--port")) : undefined;
    const noUi = has(args, "--no-ui");
    const shouldOpen = has(args, "--open") || process.env.XLAB_TOKEN_OPEN === "1";
    const noTray =
      has(args, "--no-tray") ||
      process.env.XLAB_TOKEN_NO_TRAY === "1" ||
      noUi;
    try {
      log("Starting server with host:", host, "port:", port, "noUi:", noUi);
      const srv = await startServer({ host, port, noUi });
      const uiUrl = `http://${srv.host}:${srv.port}/`;
      log("Server started at", `${srv.host}:${srv.port}`);
      console.log(`XLab Token v${VERSION}  (${process.platform}/${process.arch})`);
      console.log(`API  http://${srv.host}:${srv.port}/api/health`);
      if (!noUi) console.log(`UI   ${uiUrl}`);
      console.log("Scanning agents in background…");
      console.log("Press Ctrl+C to stop");
      if (shouldOpen && !noUi) openBrowser(uiUrl);

      let shuttingDown = false;
      let trayStop: (() => void) | null = null;
      const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        log("Shutdown signal received:", signal);
        shuttingDown = true;
        try {
          stopHeartbeat();
        } catch {
          // ignore
        }
        // Tell the autostart supervisor (if any) not to restart us.
        // Skip on SIGHUP (tsx watch hot-reload) so dev restarts keep working.
        if (signal !== "SIGHUP") {
          try {
            await writeStopSentinel();
          } catch {
            // non-fatal
          }
        }
        try {
          trayStop?.();
        } catch {
          // ignore
        }
        try {
          await srv.close();
          log("Server closed");
        } catch {
          // ignore close errors on hot-reload restart
        }
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown("SIGINT"));
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
      // SIGHUP only for dev hot-reload (tsx watch). On Windows production, SIGHUP
      // has been observed killing a healthy serve — ignore unless explicitly enabled.
      const allowSighup =
        process.env.XLAB_TOKEN_DEV === "1" ||
        process.env.XLAB_TOKEN_WATCH === "1" ||
        process.platform !== "win32";
      if (allowSighup) {
        process.on("SIGHUP", () => void shutdown("SIGHUP"));
      }

      if (!noTray && !noUi) {
        try {
          const tray = await startTray({
            url: uiUrl,
            title: "XLab Token",
            tooltip: `XLab Token :${srv.port}`,
            onQuit: () => void shutdown("tray"),
          });
          if (tray) {
            trayStop = tray.stop;
            log("Tray icon enabled (auto-restart on tray crash)");
            console.log("Tray icon enabled (double-click or menu → Open Dashboard)");
          }
        } catch (err) {
          logError("Failed to start tray:", err instanceof Error ? err.message : err);
          // tray is optional
        }
      }
    } catch (err) {
      try {
        stopHeartbeat();
      } catch {
        // ignore
      }
      logError("Failed to start server:", err instanceof Error ? err.message : err);
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "setup") {
    const asJson = has(args, "--json");
    const fromPostinstall = has(args, "--from-postinstall");
    try {
      const result = await runSetup({
        open: !has(args, "--no-open"),
        autostart: !has(args, "--no-autostart"),
        desktop: !has(args, "--no-desktop"),
        serve: !has(args, "--no-serve"),
        host: getFlag(args, "--host") || undefined,
        port: getFlag(args, "--port") ? Number(getFlag(args, "--port")) : undefined,
      });
      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else if (fromPostinstall) {
        console.log(`xlab-token: ${result.message}`);
        console.log(`xlab-token: dashboard ${result.url}`);
        if (result.desktopShortcut) {
          console.log(`xlab-token: desktop ${result.desktopShortcut}`);
        }
      } else {
        console.log(result.message);
        console.log(`Dashboard: ${result.url}`);
        if (result.autostartEnabled !== undefined) {
          console.log(`Autostart: ${result.autostartEnabled ? "ON" : "OFF"}`);
        }
        if (result.desktopShortcut) {
          console.log(`Desktop: ${result.desktopShortcut}`);
        }
      }
      if (!result.ok) process.exitCode = 1;
    } catch (err) {
      // Never break npm install when invoked from postinstall
      const msg = err instanceof Error ? err.message : String(err);
      if (fromPostinstall) {
        console.warn(`xlab-token: setup skipped (${msg})`);
      } else {
        console.error(msg);
        process.exitCode = 1;
      }
    }
    return;
  }

  if (cmd === "autostart") {
    log("Autostart command received:", args.join(" "));
    const sub = (args[1] || "status").toLowerCase();
    const asJson = has(args, "--json");
    if (sub === "on" || sub === "enable" || sub === "install") {
      const result = await enableAutostart();
      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result.message);
        if (result.status.detail) console.log(result.status.detail);
      }
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (sub === "off" || sub === "disable" || sub === "uninstall" || sub === "remove") {
      const result = await disableAutostart();
      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result.message);
      }
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (sub === "status" || sub === "show") {
      const status = await getAutostartStatus();
      if (asJson) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log(`Autostart: ${status.enabled ? "ON" : "OFF"}  (${status.platform})`);
        if (status.method) console.log(`Method:  ${status.method}`);
        if (status.detail) console.log(`Detail:  ${status.detail}`);
        if (status.command) console.log(`Command: ${status.command}`);
      }
      return;
    }
    console.error(`Unknown autostart subcommand: ${sub}`);
    console.error("Use: xlab-token autostart on|off|status");
    process.exitCode = 1;
    return;
  }

  if (cmd === "backup") {
    const sub = (args[1] || "status").toLowerCase();
    const asJson = has(args, "--json");
    const token = getFlag(args, "--token") || null;
    const gistId = getFlag(args, "--gist") || null;
    const isPublic = has(args, "--public");
    const saveToken = has(args, "--save-token");

    try {
      if (sub === "upload" || sub === "up") {
        log("Backup upload requested");
        const events = await scanAll();
        const result = await uploadBackupToGist({
          token,
          gistId,
          public: isPublic,
          saveToken,
          events,
        });
        const body = {
          ok: true,
          gistId: result.gist.id,
          htmlUrl: result.gist.htmlUrl,
          scope: result.scope,
          eventCount: result.backup.events?.length ?? 0,
          updated: result.gist.updated,
        };
        if (asJson) {
          console.log(JSON.stringify(body, null, 2));
        } else {
          console.log(`Backup uploaded: ${body.htmlUrl}`);
          console.log(`Scope: ${body.scope} · Events: ${body.eventCount}`);
          console.log(`Gist ID: ${body.gistId}`);
        }
      } else if (sub === "download" || sub === "down" || sub === "restore") {
        log("Backup download requested");
        const result = await downloadBackupFromGist({ token, gistId });
        const body = {
          ok: true,
          gistId: result.backup.exportedAt,
          scope: result.restored.scope,
          eventCount: result.restored.events?.length ?? 0,
          customRateCount: result.restored.customRateCount,
          mirrorsRestored: result.restored.mirrorsRestored,
        };
        if (asJson) {
          console.log(JSON.stringify(body, null, 2));
        } else {
          console.log("Backup downloaded and restored.");
          console.log(`Scope: ${body.scope} · Events: ${body.eventCount} · Custom rates: ${body.customRateCount} · Mirrors: ${body.mirrorsRestored}`);
        }
      } else if (sub === "status" || sub === "show") {
        const { getConfigSync } = await import("./config.js");
        const cfg = getConfigSync();
        const body = {
          ok: true,
          gistId: cfg.backup?.gistId || null,
          gistUrl: cfg.backup?.gistUrl || null,
          lastBackupAt: cfg.backup?.lastBackupAt || null,
          githubTokenSaved: Boolean(cfg.backup?.githubToken),
        };
        if (asJson) {
          console.log(JSON.stringify(body, null, 2));
        } else {
          console.log(`Saved Gist ID: ${body.gistId || "none"}`);
          console.log(`Last backup: ${body.lastBackupAt || "never"}`);
          console.log(`GitHub token saved: ${body.githubTokenSaved ? "yes" : "no"}`);
          if (body.gistUrl) console.log(`URL: ${body.gistUrl}`);
        }
      } else {
        console.error(`Unknown backup subcommand: ${sub}`);
        console.error("Use: xlab-token backup upload|download|status");
        process.exitCode = 1;
      }
    } catch (err) {
      logError("Backup command failed:", err instanceof Error ? err.message : err);
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "scan") {
    const t0 = Date.now();
    const events = await scanAll();
    const body = { ok: true, eventsIngested: events.length, durationMs: Date.now() - t0 };
    if (has(args, "--json")) console.log(JSON.stringify(body, null, 2));
    else console.log(`Scanned ${events.length} events in ${body.durationMs}ms`);
    return;
  }

  if (cmd === "doctors" || cmd === "doctor") {
    const events = await scanAll();
    const agents = await detectAgents(events);
    const meta = { platform: process.platform, arch: process.arch, node: process.version };
    if (has(args, "--json")) {
      console.log(JSON.stringify({ ...meta, agents }, null, 2));
      return;
    }
    console.log(`XLab Token doctors v${VERSION}  (${meta.platform}/${meta.arch} ${meta.node})\n`);
    for (const a of agents) {
      const mark = a.detected ? (a.enabled ? "OK " : "PATH") : " -- ";
      console.log(
        `[${mark}] ${a.label.padEnd(16)} events=${String(a.eventCount).padStart(5)}  ${
          a.paths[0] || "(not found)"
        }`,
      );
    }
    return;
  }

  if (cmd === "stats") {
    const since = getFlag(args, "--since");
    const until = getFlag(args, "--until");
    const by = (getFlag(args, "--by") || "agent") as GroupBy;
    const sort = (getFlag(args, "--sort") || "cost") as "tokens" | "cost";
    const events = filterByPeriod(await scanAll(), since, until);
    const stats = aggregate(events, by, sort, since, until);
    if (has(args, "--json")) {
      console.log(JSON.stringify(stats, null, 2));
      return;
    }
    const t = stats.totals;
    console.log(`XLab Token stats  (groupBy=${by}, sort=${sort})`);
    if (since || until) console.log(`Period: since=${since || "-"} until=${until || "-"}`);
    console.log(
      `TOTAL  tokens=${formatTokens(t.totalTokens)}  in=${formatTokens(t.inputTokens)}  out=${formatTokens(t.outputTokens)}  cost=${formatUsd(t.estimatedCost)}  events=${t.eventCount}`,
    );
    console.log("");
    for (const g of stats.groups) {
      console.log(
        `${g.key.padEnd(24)} tokens=${formatTokens(g.totalTokens).padStart(8)}  cost=${formatUsd(g.estimatedCost).padStart(10)}  events=${g.eventCount}`,
      );
    }
    return;
  }

  if (cmd === "cost") {
    const since = getFlag(args, "--since") || "30d";
    const until = getFlag(args, "--until");
    const events = filterByPeriod(await scanAll(), since, until);
    const report = costReport(events, since, until);
    if (has(args, "--json")) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`XLab Token cost  since=${since}`);
    console.log(`TOTAL estimated: ${formatUsd(report.totalEstimatedCost)} ${report.currency}`);
    console.log("\nBy agent:");
    for (const row of report.byAgent) {
      console.log(
        `  ${row.agent.padEnd(16)} ${formatUsd(row.estimatedCost).padStart(10)}  (${(row.share * 100).toFixed(1)}%)  tokens=${formatTokens(row.totalTokens)}`,
      );
    }
    console.log("\nBy model:");
    for (const row of report.byModel.slice(0, 15)) {
      console.log(
        `  ${row.model.padEnd(28)} ${formatUsd(row.estimatedCost).padStart(10)}  tokens=${formatTokens(row.totalTokens)}`,
      );
    }
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
