import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildDailyAgentModelRollups,
  buildGistFullBackup,
  buildGistRestoreRollups,
  buildPeriodStats,
  buildPortableConfig,
  buildSettingsBackup,
  machineIdFromEvent,
  mergeLocalPreferOverGistRollups,
  mergeMultiMachineGistRollups,
  collapseRouterDailyEvents,
  loadScanCache,
  restoreBackup,
  mirrorsRoot,
  mergeEventsByIdPreferRicher,
  preferRicherEvent,
  salvageScanCacheJson,
  saveScanCache,
  scanCacheBackupPath,
  scanCachePath,
} from "../src/backup.js";
import type { UsageEvent } from "../src/types.js";
import { pathExists } from "../src/util.js";

function evt(partial: Partial<UsageEvent> & { id: string }): UsageEvent {
  return {
    agent: "devin",
    model: null,
    timestamp: "2026-07-15T00:00:00.000Z",
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 110,
    estimatedCost: 1,
    currency: "USD",
    pricingStatus: "priced",
    workspace: null,
    sourcePath: "/x",
    ...partial,
  };
}

test("collapseRouterDailyEvents keeps richest estimated row per day+model", () => {
  const low = evt({
    id: "old-daily-low",
    agent: "xlabrouter",
    model: "mixed",
    estimated: true,
    inputTokens: 1_000,
    totalTokens: 1_100,
    estimatedCost: 1,
    timestamp: "2026-07-16T12:00:00.000Z",
  });
  const high = evt({
    id: "old-daily-high",
    agent: "xlabrouter",
    model: "mixed",
    estimated: true,
    inputTokens: 50_000,
    totalTokens: 55_000,
    estimatedCost: 20,
    timestamp: "2026-07-16T15:00:00.000Z",
  });
  // Requests smaller than daily → keep daily (not double)
  const requestSameDay = evt({
    id: "req-same",
    agent: "xlabrouter",
    model: "gpt-5",
    estimated: false,
    inputTokens: 10,
    totalTokens: 12,
    estimatedCost: 0.01,
    timestamp: "2026-07-16T10:00:00.000Z",
  });
  // Day without daily rollup → kept
  const requestOtherDay = evt({
    id: "req-other",
    agent: "xlabrouter",
    model: "gpt-5",
    estimated: false,
    inputTokens: 10,
    totalTokens: 12,
    estimatedCost: 0.01,
    timestamp: "2026-07-10T10:00:00.000Z",
  });
  const merged = collapseRouterDailyEvents([low, high, requestSameDay, requestOtherDay]);
  assert.equal(merged.length, 2);
  const daily = merged.find((e) => e.estimated);
  assert.equal(daily?.totalTokens, 55_000);
  assert.equal(merged.some((e) => e.id === "req-same"), false);
  assert.ok(merged.some((e) => e.id === "req-other"));
});

test("collapseRouterDailyEvents prefers requests when they exceed stale daily", () => {
  const staleDaily = evt({
    id: "daily-stale",
    agent: "9router",
    model: "mixed",
    estimated: true,
    inputTokens: 1_000,
    totalTokens: 1_100,
    estimatedCost: 1,
    timestamp: "2026-07-16T12:00:00.000Z",
  });
  const r1 = evt({
    id: "r1",
    agent: "9router",
    model: "gpt-5",
    estimated: false,
    inputTokens: 40_000,
    totalTokens: 42_000,
    estimatedCost: 10,
    timestamp: "2026-07-16T08:00:00.000Z",
  });
  const r2 = evt({
    id: "r2",
    agent: "9router",
    model: "gpt-5",
    estimated: false,
    inputTokens: 30_000,
    totalTokens: 31_000,
    estimatedCost: 8,
    timestamp: "2026-07-16T09:00:00.000Z",
  });
  const merged = collapseRouterDailyEvents([staleDaily, r1, r2]);
  // Prefer overcount: request sum (73k) > daily (1.1k) → keep both requests, drop daily
  assert.equal(merged.some((e) => e.id === "daily-stale"), false);
  assert.ok(merged.some((e) => e.id === "r1"));
  assert.ok(merged.some((e) => e.id === "r2"));
  const tok = merged.reduce((a, e) => a + (e.totalTokens || 0), 0);
  assert.equal(tok, 73_000);
});

test("preferRicherEvent fills null model even when default cost is higher", () => {
  const stale = evt({
    id: "same",
    model: null,
    estimatedCost: 5,
    totalTokens: 110,
  });
  const fresh = evt({
    id: "same",
    model: "glm-5-2",
    estimatedCost: 0.2,
    totalTokens: 110,
  });
  const kept = preferRicherEvent(stale, fresh);
  assert.equal(kept.model, "glm-5-2");
  assert.equal(kept.estimatedCost, 0.2);
});

test("mergeEventsByIdPreferRicher upgrades null-model cache rows", () => {
  const cached = [
    evt({ id: "a", model: null, estimatedCost: 9, inputTokens: 50, totalTokens: 60 }),
    evt({ id: "b", model: "swe-1-6", estimatedCost: 1, inputTokens: 50, totalTokens: 60 }),
  ];
  const scanned = [
    evt({ id: "a", model: "kimi-k2-7", estimatedCost: 0.5, inputTokens: 50, totalTokens: 60 }),
    evt({ id: "b", model: "swe-1-6", estimatedCost: 1, inputTokens: 50, totalTokens: 60 }),
  ];
  const merged = mergeEventsByIdPreferRicher(scanned, cached);
  const byId = Object.fromEntries(merged.map((e) => [e.id, e]));
  assert.equal(byId.a.model, "kimi-k2-7");
  assert.equal(byId.b.model, "swe-1-6");
});

test("restore mirrors blocks path traversal", async () => {
  const root = mirrorsRoot();
  const evilRel = path.join(root, "..", "..", "evil-xlab-traversal-test.txt");
  // clean any previous
  try {
    await rm(evilRel, { force: true });
  } catch {
    /* ignore */
  }

  const result = await restoreBackup({
    format: "xlab-token-backup",
    formatVersion: 2,
    appVersion: "1.0.1",
    exportedAt: new Date().toISOString(),
    scope: "full",
    config: {
      timezone: "Asia/Ho_Chi_Minh",
      pricing: { currency: "USD", preferRouterCost: true, customRates: {} },
    },
    mirrors: {
      "../../evil-xlab-traversal-test.txt": "pwned",
      "..\\..\\evil-xlab-traversal-test2.txt": "pwned",
      "safe-test/nested.json": '{"ok":true}',
    },
  });

  assert.equal(await pathExists(evilRel), false, "must not write outside mirrors root");
  assert.ok(result.mirrorsRestored >= 1, "safe file should restore");
  const safe = path.join(root, "safe-test", "nested.json");
  assert.equal(await pathExists(safe), true);
  const body = await readFile(safe, "utf8");
  assert.equal(body, '{"ok":true}');
  // cleanup safe test file
  try {
    await rm(path.join(root, "safe-test"), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test("saveScanCache round-trips and loadScanCache recovers from .bak when main is corrupt", async () => {
  const root = path.join(process.cwd(), ".test-scan-cache-" + Date.now());
  const prev = process.env.XLAB_TOKEN_DATA_DIR;
  process.env.XLAB_TOKEN_DATA_DIR = root;
  try {
    await mkdir(root, { recursive: true });
    const events = [
      evt({ id: "persist-a", agent: "grok", inputTokens: 1000, totalTokens: 1100, estimatedCost: 2 }),
      evt({ id: "persist-b", agent: "windsurf", inputTokens: 500, totalTokens: 550, estimatedCost: 1 }),
    ];
    await saveScanCache(events);
    const loaded = await loadScanCache();
    assert.equal(loaded.length, 2);
    assert.equal(loaded.find((e) => e.id === "persist-a")?.inputTokens, 1000);

    // Simulate interrupted write leaving invalid JSON in the main file.
    await writeFile(scanCachePath(), '{"id":"broken"', "utf8");
    const recovered = await loadScanCache();
    assert.equal(recovered.length, 2, "must fall back to .bak after corrupt main");
    assert.equal(await pathExists(scanCacheBackupPath()), true);
  } finally {
    if (prev === undefined) delete process.env.XLAB_TOKEN_DATA_DIR;
    else process.env.XLAB_TOKEN_DATA_DIR = prev;
    await rm(root, { recursive: true, force: true });
  }
});

test("salvageScanCacheJson recovers objects from truncated JSON array", () => {
  const good = evt({ id: "salv-a", agent: "grok", inputTokens: 900, totalTokens: 1000, estimatedCost: 3 });
  const prefix = `[${JSON.stringify(good)},{"id":"broken"`;
  const salvaged = salvageScanCacheJson(prefix);
  assert.equal(salvaged.length, 1);
  assert.equal(salvaged[0]?.id, "salv-a");
});

test("concurrent saveScanCache calls do not corrupt output", async () => {
  const root = path.join(process.cwd(), ".test-scan-cache-concurrent-" + Date.now());
  const prev = process.env.XLAB_TOKEN_DATA_DIR;
  process.env.XLAB_TOKEN_DATA_DIR = root;
  try {
    await mkdir(root, { recursive: true });
    const batches = Array.from({ length: 8 }, (_, i) => [
      evt({
        id: `c-${i}`,
        agent: "grok",
        inputTokens: 100 + i,
        totalTokens: 110 + i,
        estimatedCost: 0.1 * i,
      }),
    ]);
    await Promise.all(batches.map((batch) => saveScanCache(batch)));
    const loaded = await loadScanCache();
    assert.ok(loaded.length >= 1);
    JSON.parse(await readFile(scanCachePath(), "utf8"));
  } finally {
    if (prev === undefined) delete process.env.XLAB_TOKEN_DATA_DIR;
    else process.env.XLAB_TOKEN_DATA_DIR = prev;
    await rm(root, { recursive: true, force: true });
  }
});

test("restore accepts v1 settings-only backup", async () => {
  const r = await restoreBackup({
    format: "xlab-token-backup",
    formatVersion: 1,
    appVersion: "1.0.1",
    exportedAt: new Date().toISOString(),
    config: {
      timezone: "UTC",
      pricing: {
        currency: "USD",
        preferRouterCost: false,
        customRates: { "test-model-xlab": { inputPer1M: 1, outputPer1M: 2 } },
      },
    },
  });
  assert.equal(r.ok, true);
  assert.ok(r.customRateCount >= 1);
  assert.equal(r.events, undefined);
});

test("unified backup file includes portable project settings (no token)", () => {
  const s = buildSettingsBackup();
  assert.equal(s.format, "xlab-token-backup");
  assert.ok(s.config.timezone);
  assert.ok(s.config.pricing);
  assert.ok(s.config.pricing?.currency);
  assert.equal(typeof s.config.pricing?.preferRouterCost, "boolean");
  // PAT must never be serialized into the shared backup file
  assert.equal((s.config.backup as { githubToken?: string } | undefined)?.githubToken, undefined);
  const portable = buildPortableConfig();
  assert.equal(portable.pricing?.currency, s.config.pricing?.currency);
});

test("buildPeriodStats covers byModel + byAgent for all dashboard periods", () => {
  const now = Date.now();
  const events = [
    evt({
      id: "p1",
      agent: "grok",
      model: "grok-4.5",
      timestamp: new Date(now - 60_000).toISOString(),
      inputTokens: 1000,
      totalTokens: 1100,
      estimatedCost: 2,
    }),
    evt({
      id: "p2",
      agent: "windsurf",
      model: "swe-1-6",
      timestamp: new Date(now - 2 * 86_400_000).toISOString(),
      inputTokens: 500,
      totalTokens: 550,
      estimatedCost: 1,
    }),
    evt({
      id: "p3",
      agent: "grok",
      model: "grok-4.5",
      timestamp: new Date(now - 10 * 86_400_000).toISOString(),
      inputTokens: 200,
      totalTokens: 220,
      estimatedCost: 0.5,
    }),
  ];
  const stats = buildPeriodStats(events, "UTC");
  for (const key of ["today", "24h", "7d", "30d", "all"] as const) {
    assert.ok(stats[key], `missing period ${key}`);
    assert.ok(Array.isArray(stats[key].byModel));
    assert.ok(Array.isArray(stats[key].byAgent));
  }
  assert.ok(stats.all.byModel.some((r) => r.key.includes("grok")));
  assert.ok(stats.all.byAgent.some((r) => r.key === "grok"));
  assert.ok(stats.all.byAgent.some((r) => r.key === "windsurf"));
  assert.equal(stats.all.totals.eventCount, 3);
});

test("buildGistRestoreRollups uses hour buckets for recent, day for older", () => {
  const now = Date.now();
  const events = [
    evt({
      id: "r1",
      agent: "grok",
      model: "grok-4.5 (xAI)",
      timestamp: new Date(now - 30 * 60_000).toISOString(),
      inputTokens: 100,
      totalTokens: 110,
      estimatedCost: 1,
    }),
    evt({
      id: "r2",
      agent: "grok",
      model: "grok-4.5",
      timestamp: new Date(now - 20 * 60_000).toISOString(),
      inputTokens: 50,
      totalTokens: 55,
      estimatedCost: 0.5,
    }),
    evt({
      id: "r3",
      agent: "windsurf",
      model: "swe-1-6",
      // older than 8d hour window → daily bucket
      timestamp: new Date(now - 12 * 86_400_000).toISOString(),
      inputTokens: 10,
      totalTokens: 11,
      estimatedCost: 0.1,
    }),
  ];
  const rollups = buildGistRestoreRollups(events, now, "pc-a");
  const recent = rollups.filter((e) => String(e.sourcePath).startsWith("backup:gist-hour"));
  const older = rollups.filter((e) => String(e.sourcePath).startsWith("backup:gist-daily"));
  assert.ok(recent.length >= 1);
  assert.equal(older.length, 1);
  const grok = recent.find((e) => e.agent === "grok");
  assert.ok(grok);
  assert.equal(grok!.inputTokens, 150);
  assert.equal(grok!.estimatedCost, 1.5);
  assert.equal(machineIdFromEvent(grok!), "pc-a");
  assert.equal(grok!.sourcePath, "backup:gist-hour:pc-a");
  // alias still works
  assert.equal(buildDailyAgentModelRollups(events).length, rollups.length);
});

test("mergeLocalPreferOverGistRollups drops only same-machine gist when local covers key", () => {
  const local = [
    evt({
      id: "local-1",
      agent: "grok",
      model: "grok-4.5",
      timestamp: "2026-07-15T10:00:00.000Z",
      inputTokens: 100,
      totalTokens: 110,
      estimatedCost: 1,
      sourcePath: "/real/path",
    }),
  ];
  const imported = [
    evt({
      id: "gist-same",
      agent: "grok",
      model: "grok-4.5",
      timestamp: "2026-07-15T12:00:00.000Z",
      inputTokens: 9999,
      totalTokens: 9999,
      estimatedCost: 50,
      sourcePath: "backup:gist-daily:pc-a",
      workspace: "pc-a",
    }),
    evt({
      id: "gist-other",
      agent: "grok",
      model: "grok-4.5",
      timestamp: "2026-07-15T12:00:00.000Z",
      inputTokens: 500,
      totalTokens: 550,
      estimatedCost: 5,
      sourcePath: "backup:gist-daily:pc-b",
      workspace: "pc-b",
    }),
    evt({
      id: "gist-2",
      agent: "windsurf",
      model: "swe-1-6",
      timestamp: "2026-07-14T12:00:00.000Z",
      inputTokens: 10,
      totalTokens: 11,
      estimatedCost: 0.1,
      sourcePath: "backup:gist-hour:pc-a",
      workspace: "pc-a",
    }),
  ];
  const merged = mergeLocalPreferOverGistRollups(local, imported, "pc-a");
  assert.ok(merged.some((e) => e.id === "local-1"));
  assert.ok(merged.some((e) => e.id === "gist-other"), "other machine always kept");
  assert.ok(merged.some((e) => e.id === "gist-2"), "uncovered agent kept");
  assert.ok(!merged.some((e) => e.id === "gist-same"), "same-machine covered rollup dropped");
});

test("mergeMultiMachineGistRollups sums two hosts and replaces same host", () => {
  const fromA = buildGistRestoreRollups(
    [
      evt({
        id: "a1",
        agent: "grok",
        model: "grok-4.5",
        timestamp: new Date().toISOString(),
        inputTokens: 100,
        totalTokens: 110,
        estimatedCost: 2,
      }),
    ],
    Date.now(),
    "pc-a",
  );
  const fromB = buildGistRestoreRollups(
    [
      evt({
        id: "b1",
        agent: "grok",
        model: "grok-4.5",
        timestamp: new Date().toISOString(),
        inputTokens: 50,
        totalTokens: 55,
        estimatedCost: 1,
      }),
    ],
    Date.now(),
    "pc-b",
  );
  // B uploads after A: remote has A, local is B
  const merged = mergeMultiMachineGistRollups(fromB, fromA, "pc-b");
  assert.equal(merged.length, 2, "both machines kept");
  assert.ok(merged.some((e) => machineIdFromEvent(e) === "pc-a"));
  assert.ok(merged.some((e) => machineIdFromEvent(e) === "pc-b"));
  const totalCost = merged.reduce((s, e) => s + (e.estimatedCost || 0), 0);
  assert.equal(totalCost, 3);

  // A re-uploads with higher cost — replaces A's old slice, keeps B
  const fromA2 = buildGistRestoreRollups(
    [
      evt({
        id: "a2",
        agent: "grok",
        model: "grok-4.5",
        timestamp: new Date().toISOString(),
        inputTokens: 200,
        totalTokens: 220,
        estimatedCost: 4,
      }),
    ],
    Date.now(),
    "pc-a",
  );
  const merged2 = mergeMultiMachineGistRollups(fromA2, merged, "pc-a");
  assert.equal(merged2.length, 2);
  const aRow = merged2.find((e) => machineIdFromEvent(e) === "pc-a");
  assert.equal(aRow?.estimatedCost, 4);
  const bRow = merged2.find((e) => machineIdFromEvent(e) === "pc-b");
  assert.equal(bRow?.estimatedCost, 1);
});

test("buildGistFullBackup is period-stats and much smaller than raw events", async () => {
  const events = Array.from({ length: 200 }, (_, i) =>
    evt({
      id: `bulk-${i}`,
      agent: i % 2 === 0 ? "grok" : "windsurf",
      model: i % 3 === 0 ? "grok-4.5" : "swe-1-6",
      timestamp: new Date(Date.now() - (i % 40) * 86_400_000).toISOString(),
      inputTokens: 100 + i,
      totalTokens: 110 + i,
      estimatedCost: 0.01 * (i + 1),
    }),
  );
  const backup = await buildGistFullBackup(events, { machineId: "pc-a" });
  assert.equal(backup.scope, "period-stats");
  assert.equal(backup.formatVersion, 3);
  assert.ok(backup.periodStats?.all?.byModel.length);
  assert.ok(backup.periodStats?.all?.byAgent.length);
  assert.ok((backup.events?.length || 0) < events.length);
  assert.equal(backup.meta?.sourceEventCount, 200);
  assert.equal(backup.meta?.machineId, "pc-a");
  assert.ok(backup.meta?.machines?.includes("pc-a"));
  const rawSize = Buffer.byteLength(JSON.stringify(events), "utf8");
  const gistSize = Buffer.byteLength(JSON.stringify(backup), "utf8");
  assert.ok(gistSize < rawSize, `gist ${gistSize} should be < raw ${rawSize}`);
});

test("buildGistFullBackup multi-machine sums periodStats cost", async () => {
  const now = new Date().toISOString();
  const eventsA = [
    evt({
      id: "ma1",
      agent: "grok",
      model: "grok-4.5",
      timestamp: now,
      inputTokens: 1000,
      totalTokens: 1100,
      estimatedCost: 10,
    }),
  ];
  const eventsB = [
    evt({
      id: "mb1",
      agent: "grok",
      model: "grok-4.5",
      timestamp: now,
      inputTokens: 500,
      totalTokens: 550,
      estimatedCost: 5,
    }),
  ];
  const remoteA = await buildGistFullBackup(eventsA, { machineId: "pc-a" });
  const merged = await buildGistFullBackup(eventsB, {
    machineId: "pc-b",
    remoteEvents: remoteA.events,
  });
  assert.ok(merged.meta?.machines?.includes("pc-a"));
  assert.ok(merged.meta?.machines?.includes("pc-b"));
  assert.equal(merged.events?.length, 2);
  const allCost = merged.periodStats?.all?.totals.estimatedCost || 0;
  assert.ok(Math.abs(allCost - 15) < 0.0001, `expected 15 got ${allCost}`);
});

test("Gist restore rollups match source totals for dashboard periods", async () => {
  const now = Date.now();
  const events = Array.from({ length: 120 }, (_, i) =>
    evt({
      id: `acc-${i}`,
      agent: i % 2 === 0 ? "grok" : "devin",
      model: i % 3 === 0 ? "grok-4.5" : "glm-5-2",
      timestamp: new Date(now - i * 3_600_000).toISOString(), // last 120 hours
      inputTokens: 100 + i,
      outputTokens: 10,
      totalTokens: 110 + i,
      estimatedCost: 0.05 * (i + 1),
    }),
  );
  const { filterByPeriod } = await import("../src/util.js");
  const { aggregate } = await import("../src/aggregate.js");
  const rollups = buildGistRestoreRollups(events, now);
  for (const period of ["today", "24h", "7d", "30d", null] as const) {
    const src = aggregate(filterByPeriod(events, period, null, "UTC"), "model", "cost").totals;
    const rol = aggregate(filterByPeriod(rollups, period, null, "UTC"), "model", "cost").totals;
    const costErr = Math.abs(rol.estimatedCost - src.estimatedCost);
    const tokErr = Math.abs(rol.totalTokens - src.totalTokens);
    assert.ok(
      costErr < 0.0001 && tokErr < 1,
      `period ${period ?? "all"} costΔ=${costErr} tokΔ=${tokErr} src=${src.estimatedCost} rol=${rol.estimatedCost}`,
    );
  }
});
