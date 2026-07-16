import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";
import { parseGrok, agent as grokAgent } from "../src/agents/grok/index.ts";
import { parseWindsurf, agent as wsAgent } from "../src/agents/windsurf/index.ts";

async function walkPb(dir, depth = 0, out = []) {
  if (depth > 10) return out;
  try {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walkPb(full, depth + 1, out);
      else if (ent.name.endsWith(".pb")) out.push(full);
    }
  } catch {
    /* ignore */
  }
  return out;
}

async function countGrokRaw(sessionsRoot) {
  let files = 0;
  let turns = 0;
  let cache = 0;
  let input = 0;
  let output = 0;
  let noUsageSessions = 0;

  async function walk(dir, depth = 0) {
    if (depth > 14) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(full, depth + 1);
      else if (ent.name === "updates.jsonl") {
        files++;
        let sessionTurns = 0;
        const rl = createInterface({
          input: createReadStream(full, { encoding: "utf8" }),
          crlfDelay: Infinity,
        });
        for await (const line of rl) {
          if (!line.includes("turn_completed")) continue;
          if (!line.includes("usage") && !line.includes("Usage")) continue;
          try {
            const row = JSON.parse(line);
            const u = row?.params?.update?.usage ?? row?.update?.usage;
            if (!u) continue;
            sessionTurns++;
            turns++;
            cache += Number(u.cachedReadTokens ?? u.cache_read_input_tokens ?? u.cacheReadTokens ?? 0);
            input += Number(u.inputTokens ?? u.input_tokens ?? 0);
            output += Number(u.outputTokens ?? u.output_tokens ?? 0);
          } catch {
            /* skip */
          }
        }
        if (sessionTurns === 0) noUsageSessions++;
      }
    }
  }

  if (sessionsRoot) await walk(sessionsRoot);
  return { files, turns, cache, input, output, noUsageSessions };
}

const grokRoots = grokAgent.roots();
const wsRoots = wsAgent.roots();
console.log("grok roots:", grokRoots);
console.log("windsurf roots:", wsRoots);

const grokEvents = await parseGrok(grokRoots);
const wsEvents = await parseWindsurf(wsRoots);

function summarize(label, events) {
  let cost = 0;
  let tok = 0;
  let cache = 0;
  for (const e of events) {
    cost += e.estimatedCost ?? 0;
    tok += e.totalTokens ?? 0;
    cache += (e.cacheReadTokens ?? 0) + (e.cacheWriteTokens ?? 0);
  }
  console.log(label, { events: events.length, cost: cost.toFixed(2), tokens: tok, cache });
}

summarize("PARSED grok ALL", grokEvents);
summarize("PARSED windsurf ALL", wsEvents);

const todayStart = new Date("2026-07-15T17:00:00.000Z");
const todayEnd = new Date("2026-07-16T17:00:00.000Z");
const inToday = (e) => {
  const t = new Date(e.timestamp);
  return t >= todayStart && t < todayEnd;
};
summarize("PARSED grok TODAY VN", grokEvents.filter(inToday));
summarize("PARSED windsurf TODAY VN", wsEvents.filter(inToday));

const sessionsRoot = path.join(os.homedir(), ".grok", "sessions");
const raw = await countGrokRaw(sessionsRoot);
console.log("RAW grok updates:", raw);
console.log("GROK gap turns:", raw.turns - grokEvents.length);

let pbTotal = 0;
const pbByRoot = {};
for (const r of wsRoots) {
  const pbs = await walkPb(r);
  pbByRoot[r] = pbs.length;
  pbTotal += pbs.length;
}
console.log("RAW windsurf .pb files by root:", pbByRoot, "total", pbTotal);
console.log("WINDSURF gap pb:", pbTotal - wsEvents.length);

const wsSources = {};
for (const e of wsEvents) {
  const tail = (e.sourcePath || "").includes("cascade")
    ? "cascade"
    : (e.sourcePath || "").includes("implicit")
      ? "implicit"
      : path.extname(e.sourcePath || "").slice(1) || "other";
  wsSources[tail] = (wsSources[tail] || 0) + 1;
}
console.log("windsurf parsed by source kind:", wsSources);