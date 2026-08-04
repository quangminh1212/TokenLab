/**
 * One-shot audit: Hermes state.db vs TokenLab parseHermes (double-count / gaps).
 * Run: node --experimental-sqlite --import tsx scripts/_audit_hermes_usage.mjs
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { parseHermes } from "../src/agents/hermes/index.ts";
import { applyPricing, getRateForModel, resolveModelKey } from "../src/pricing.ts";
import { filterByPeriod } from "../src/util.ts";

const root = path.join(process.env.LOCALAPPDATA, "hermes");
const live = path.join(root, "state.db");

function sumSmu(db) {
  return db
    .prepare(
      `SELECT COUNT(*) n,
        COALESCE(SUM(input_tokens),0) i,
        COALESCE(SUM(output_tokens),0) o,
        COALESCE(SUM(cache_read_tokens),0) cr,
        COALESCE(SUM(reasoning_tokens),0) reas,
        COALESCE(SUM(api_call_count),0) api
       FROM session_model_usage`,
    )
    .get();
}

const db = new DatabaseSync(live, { readOnly: true });
const liveSmu = sumSmu(db);
const liveSids = new Set(
  db.prepare("SELECT DISTINCT session_id AS s FROM session_model_usage").all().map((r) => r.s),
);
console.log("=== LIVE state.db SMU ===");
console.log(liveSmu);

const sessions = db
  .prepare(
    `SELECT COUNT(*) n,
      COALESCE(SUM(input_tokens),0) i,
      COALESCE(SUM(output_tokens),0) o,
      COALESCE(SUM(cache_read_tokens),0) cr,
      COALESCE(SUM(reasoning_tokens),0) reas,
      COALESCE(SUM(api_call_count),0) api
     FROM sessions`,
  )
  .get();
console.log("=== LIVE sessions rollup ===");
console.log(sessions);
console.log("SMU - sessions delta:", {
  i: liveSmu.i - sessions.i,
  o: liveSmu.o - sessions.o,
  cr: liveSmu.cr - sessions.cr,
  reas: liveSmu.reas - sessions.reas,
});

// models
const models = db
  .prepare(
    `SELECT model, COUNT(*) n,
      SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_read_tokens) cr, SUM(api_call_count) api
     FROM session_model_usage GROUP BY model ORDER BY i DESC`,
  )
  .all();
console.log("=== SMU by model ===");
for (const m of models) console.log(" ", m);

// snapshots overlap
console.log("=== SNAPSHOT OVERLAP (double-count risk) ===");
const snaps = [
  path.join(root, "state-snapshots", "20260702-184927-pre-update", "state.db"),
  path.join(root, "state-snapshots", "20260729-011414-minh-sync", "state.db"),
];
let totalOverlapIn = 0;
let totalSnapIn = 0;
for (const sp of snaps) {
  const sdb = new DatabaseSync(sp, { readOnly: true });
  const tables = sdb
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  const name = path.basename(path.dirname(sp));
  if (tables.includes("session_model_usage")) {
    const rows = sdb
      .prepare("SELECT session_id AS sid, input_tokens AS i, cache_read_tokens AS cr FROM session_model_usage")
      .all();
    let overlap = 0,
      only = 0,
      oIn = 0,
      oCr = 0,
      sIn = 0,
      sCr = 0;
    for (const r of rows) {
      sIn += r.i || 0;
      sCr += r.cr || 0;
      if (liveSids.has(r.sid)) {
        overlap++;
        oIn += r.i || 0;
        oCr += r.cr || 0;
      } else only++;
    }
    totalOverlapIn += oIn;
    totalSnapIn += sIn;
    console.log(name, { rows: rows.length, overlap, only, snapIn: sIn, snapCr: sCr, overlapIn: oIn, overlapCr: oCr });
  } else {
    const rows = sdb
      .prepare("SELECT id AS sid, input_tokens AS i, cache_read_tokens AS cr FROM sessions")
      .all();
    let overlap = 0,
      oIn = 0,
      sIn = 0,
      sCr = 0;
    for (const r of rows) {
      sIn += r.i || 0;
      sCr += r.cr || 0;
      if (liveSids.has(r.sid)) {
        overlap++;
        oIn += r.i || 0;
      }
    }
    totalOverlapIn += oIn;
    totalSnapIn += sIn;
    console.log(name, "sessions-only", { rows: rows.length, overlap, snapIn: sIn, snapCr: sCr, overlapIn: oIn });
  }
  sdb.close();
}

db.close();

console.log("=== parseHermes([root]) — current TokenLab logic ===");
const events = await parseHermes([root]);
let inSum = 0,
  outSum = 0,
  crSum = 0,
  reqSum = 0,
  costSum = 0,
  snapEv = 0,
  liveEv = 0;
for (const e of events) {
  inSum += e.inputTokens || 0;
  outSum += e.outputTokens || 0;
  crSum += e.cacheReadTokens || 0;
  reqSum += e.requestCount && e.requestCount > 0 ? e.requestCount : 1;
  costSum += e.estimatedCost || 0;
  if (String(e.sourcePath || "").includes("state-snapshots")) snapEv++;
  else liveEv++;
}
console.log({
  events: events.length,
  liveEv,
  snapEv,
  inSum,
  outSum,
  crSum,
  reqSum,
  costSum: Math.round(costSum * 100) / 100,
});
console.log("Inflation vs live SMU input:", {
  liveSmuIn: liveSmu.i,
  parsedIn: inSum,
  extra: inSum - liveSmu.i,
  pctExtra: (((inSum - liveSmu.i) / liveSmu.i) * 100).toFixed(1) + "%",
});
console.log("Inflation vs live SMU cache:", {
  liveSmuCr: liveSmu.cr,
  parsedCr: crSum,
  extra: crSum - liveSmu.cr,
});

// Today filter (local tz)
const today = filterByPeriod(events, "today", null, "local");
const tIn = today.reduce((s, e) => s + (e.inputTokens || 0), 0);
const tCr = today.reduce((s, e) => s + (e.cacheReadTokens || 0), 0);
const tReq = today.reduce((s, e) => s + (e.requestCount && e.requestCount > 0 ? e.requestCount : 1), 0);
const tCost = today.reduce((s, e) => s + (e.estimatedCost || 0), 0);
console.log("=== filterByPeriod today (local) ===", {
  rows: today.length,
  tIn,
  tCr,
  tReq,
  tCost: Math.round(tCost * 100) / 100,
});

// Pricing issues: XLab gateway alias
console.log("=== pricing check ===");
for (const m of ["XLab", "xlab", "kimi-k3", "Kimi-k3", "default", "auto"]) {
  console.log(" ", m, "key=", resolveModelKey(m), "rate=", getRateForModel(m));
}
const px = applyPricing({
  id: "t",
  agent: "hermes",
  model: "XLab",
  timestamp: new Date().toISOString(),
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 0,
  workspace: null,
  sourcePath: "",
});
console.log("1M/100k/1M cache cost XLab", px.estimatedCost);

// How much of cost is from XLab vs real models
const byModelCost = new Map();
for (const e of events) {
  const m = e.model || "null";
  byModelCost.set(m, (byModelCost.get(m) || 0) + (e.estimatedCost || 0));
}
console.log(
  "cost by model",
  [...byModelCost.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([m, c]) => [m, Math.round(c * 100) / 100]),
);

console.log("\n=== VERDICT SUMMARY ===");
console.log(
  "1) state-snapshots double-count: overlap input tokens ~",
  totalOverlapIn,
  "/ snap total",
  totalSnapIn,
);
console.log("2) parse total input inflated by", inSum - liveSmu.i, "vs live SMU");
console.log("3) Hermes DB cost fields are 0 — TokenLab estimates via price table");
console.log("4) Gateway label XLab rate:", getRateForModel("XLab"));
