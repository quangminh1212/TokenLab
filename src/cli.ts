#!/usr/bin/env node
import { aggregate, costReport } from "./aggregate.js";
import { detectAgents, scanAll } from "./parsers/index.js";
import { startServer } from "./server/http.js";
import type { GroupBy } from "./types.js";
import { filterByPeriod, formatTokens, formatUsd } from "./util.js";
import { VERSION } from "./version.js";

function printHelp(): void {
  console.log(`xlab-token v${VERSION}

Local-first token API usage & cost tracker for AI agents on this machine.

Usage:
  xlab-token serve [--host 127.0.0.1] [--port 3737] [--no-ui]
  xlab-token stats [--since 24h|7d|30d] [--by agent|model|day] [--sort tokens|cost] [--json]
  xlab-token cost  [--since 7d] [--json]
  xlab-token scan  [--json]
  xlab-token doctors [--json]
  xlab-token --version
  xlab-token --help

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
    const host = getFlag(args, "--host") || undefined;
    const port = getFlag(args, "--port") ? Number(getFlag(args, "--port")) : undefined;
    const noUi = has(args, "--no-ui");
    const srv = await startServer({ host, port, noUi });
    console.log(`XLab Token v${VERSION}`);
    console.log(`API  http://${srv.host}:${srv.port}/api/health`);
    if (!noUi) console.log(`UI   http://${srv.host}:${srv.port}/`);
    console.log("Press Ctrl+C to stop");
    process.on("SIGINT", async () => {
      await srv.close();
      process.exit(0);
    });
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
    if (has(args, "--json")) {
      console.log(JSON.stringify({ agents }, null, 2));
      return;
    }
    console.log(`XLab Token doctors v${VERSION}\n`);
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
