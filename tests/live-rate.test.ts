import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  buildRecentLiveEvents,
  isLiveRequestEvent,
  loadHotMirrorLiveEvents,
} from "../src/live-rate.ts";
import type { UsageEvent } from "../src/types.ts";

function base(partial: Partial<UsageEvent>): UsageEvent {
  return {
    id: "t",
    agent: "antigravity",
    model: "gemini-3.6-flash-high",
    timestamp: "2026-07-31T05:00:00.000Z",
    inputTokens: 1000,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1050,
    estimatedCost: 0.01,
    currency: "USD",
    pricingStatus: "priced",
    workspace: null,
    sourcePath: "/tmp/x",
    requestCount: 1,
    ...partial,
  };
}

test("isLiveRequestEvent keeps real per-call rows", () => {
  assert.equal(isLiveRequestEvent(base({ estimated: false })), true);
});

test("isLiveRequestEvent keeps estimated single-turn (Antigravity transcript)", () => {
  assert.equal(
    isLiveRequestEvent(base({ estimated: true, requestCount: 1, inputTokens: 12_000, outputTokens: 200, totalTokens: 12_200 })),
    true,
  );
});

test("isLiveRequestEvent drops estimated multi-RQ rollups", () => {
  assert.equal(
    isLiveRequestEvent(base({ estimated: true, requestCount: 500, inputTokens: 1e6, totalTokens: 1e6 })),
    false,
  );
});

test("isLiveRequestEvent drops multi-million token estimated blobs", () => {
  assert.equal(
    isLiveRequestEvent(
      base({
        estimated: true,
        requestCount: 1,
        inputTokens: 50_000_000,
        outputTokens: 1_000_000,
        totalTokens: 51_000_000,
      }),
    ),
    false,
  );
});

test("buildRecentLiveEvents keeps same-second requests and newest duplicate", async () => {
  const old = base({
    id: "old",
    timestamp: "2026-07-31T05:00:00.100Z",
  });
  const newest = base({
    id: "newest",
    timestamp: "2026-07-31T05:00:00.900Z",
  });
  const sibling = base({
    id: "sibling",
    timestamp: "2026-07-31T05:00:00.901Z",
    inputTokens: 1001,
    totalTokens: 1051,
  });
  const future = base({
    id: "future-rollup",
    timestamp: "2026-07-31T05:02:00.000Z",
  });
  const events = await buildRecentLiveEvents([old, newest, sibling, future], {
    limit: 3,
    sinceMs: Date.parse("2026-07-31T04:59:00.000Z"),
    untilMs: Date.parse("2026-07-31T05:01:00.000Z"),
    nowMs: Date.parse("2026-07-31T05:01:00.000Z"),
    timestampsMs: [
      Date.parse(old.timestamp),
      Date.parse(newest.timestamp),
      Date.parse(sibling.timestamp),
      Date.parse(future.timestamp),
    ],
  });

  assert.deepEqual(
    events.map((e) => e.id),
    ["sibling", "newest", "old"],
    "millisecond-distinct bursts must not collapse or let an older duplicate win",
  );
});

test("loadHotMirrorLiveEvents reads JSON snapshots and invalidates on file changes", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tokenlab-live-rate-"));
  const mirror = path.join(dataDir, "mirrors", "litellm");
  const file = path.join(mirror, "db.json");
  const sqliteFile = path.join(mirror, "data.sqlite");
  const previous = process.env.TOKENLAB_DATA_DIR;
  const nowMs = Date.parse("2026-01-01T00:10:00.000Z");
  const row = (id: string, timestamp: string) => ({
    id,
    timestamp,
    model: "test-model",
    promptTokens: 100,
    completionTokens: 10,
    cost: 0.01,
  });

  try {
    await mkdir(mirror, { recursive: true });
    process.env.TOKENLAB_DATA_DIR = dataDir;
    const sqlite = new DatabaseSync(sqliteFile);
    sqlite.exec(
      `CREATE TABLE usageHistory (
        id INTEGER PRIMARY KEY,
        timestamp TEXT,
        provider TEXT,
        model TEXT,
        connectionId TEXT,
        apiKey TEXT,
        endpoint TEXT,
        promptTokens INTEGER,
        completionTokens INTEGER,
        cost REAL,
        status TEXT,
        tokens TEXT,
        meta TEXT
      )`,
    );
    sqlite
      .prepare(
        `INSERT INTO usageHistory
          (id, timestamp, model, promptTokens, completionTokens, cost, tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        7,
        "2026-01-01T00:08:30.000Z",
        "sqlite-model",
        200,
        20,
        0.02,
        JSON.stringify({ prompt_tokens_details: { cached_tokens: 50 } }),
      );
    sqlite.close();
    await writeFile(
      file,
      JSON.stringify({ usageData: { history: [row("one", "2026-01-01T00:09:00.000Z")] } }),
      "utf8",
    );
    const first = await loadHotMirrorLiveEvents(nowMs, 60, 64 * 1024);
    assert.ok(first.some((e) => e.id.endsWith(":one")), "JSON db history should be visible");
    assert.ok(first.some((e) => e.id.endsWith(":7")), "SQLite history should be visible");

    await writeFile(
      file,
      JSON.stringify({
        usageData: {
          history: [
            row("one", "2026-01-01T00:09:00.000Z"),
            row("two", "2026-01-01T00:09:30.000Z"),
          ],
        },
      }),
      "utf8",
    );
    const second = await loadHotMirrorLiveEvents(nowMs, 60, 64 * 1024);
    assert.ok(second.some((e) => e.id.endsWith(":two")), "changed snapshot should be re-read immediately");
  } finally {
    if (previous === undefined) delete process.env.TOKENLAB_DATA_DIR;
    else process.env.TOKENLAB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});
