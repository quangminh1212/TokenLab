import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { parseHermes } from "../src/agents/hermes/index.ts";
import { replaceFreshAgentSourceEvents } from "../src/backup.ts";

test("parseHermes prefers session_model_usage and does not double-count state.db", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xlab-hermes-"));
  try {
    const dbPath = path.join(root, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        model TEXT,
        started_at TEXT,
        ended_at TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        reasoning_tokens INTEGER,
        cwd TEXT,
        estimated_cost_usd REAL,
        actual_cost_usd REAL,
        api_call_count INTEGER
      );
      CREATE TABLE session_model_usage (
        session_id TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        reasoning_tokens INTEGER,
        estimated_cost_usd REAL,
        actual_cost_usd REAL,
        api_call_count INTEGER,
        first_seen TEXT,
        last_seen TEXT
      );
      INSERT INTO sessions VALUES (
        'sess-1', 'XLab', '2026-07-20T10:00:00Z', '2026-07-20T11:00:00Z',
        1000, 100, 500, 0, 50, 'C:\\\\Dev\\\\Demo', 0, 0, 3
      );
      INSERT INTO session_model_usage VALUES (
        'sess-1', 'claude-opus-4.8', 1200, 150, 500, 0, 50,
        0.05, NULL, 3, '2026-07-20T10:00:00Z', '2026-07-20T11:00:00Z'
      );
      INSERT INTO session_model_usage VALUES (
        'sess-1', 'Kimi-k3', 400, 80, 0, 0, 0,
        NULL, NULL, 1, '2026-07-20T10:30:00Z', '2026-07-20T10:40:00Z'
      );
    `);
    db.close();

    const events = await parseHermes([root]);
    // SMU (2 models); session total lower → no gap event
    assert.equal(events.length, 2);
    const models = new Set(events.map((e) => e.model));
    assert.ok(models.has("claude-opus-4.8"));
    assert.ok(models.has("Kimi-k3"));
    const totalIn = events.reduce((s, e) => s + e.inputTokens, 0);
    assert.equal(totalIn, 1600);
    // reasoning 50 added on top of opus output 150
    const opus = events.find((e) => e.model === "claude-opus-4.8")!;
    assert.equal(opus.outputTokens, 200);
    assert.ok(Math.abs((opus.estimatedCost ?? 0) - 0.05) < 1e-9);
    assert.equal(opus.requestCount, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseHermes gap-fills when session rollup exceeds SMU (prefer over-count)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xlab-hermes-gap-"));
  try {
    const dbPath = path.join(root, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        model TEXT,
        started_at TEXT,
        ended_at TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        reasoning_tokens INTEGER,
        cwd TEXT,
        estimated_cost_usd REAL,
        actual_cost_usd REAL,
        api_call_count INTEGER
      );
      CREATE TABLE session_model_usage (
        session_id TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        reasoning_tokens INTEGER,
        estimated_cost_usd REAL,
        actual_cost_usd REAL,
        api_call_count INTEGER,
        first_seen TEXT,
        last_seen TEXT
      );
      INSERT INTO sessions VALUES (
        'sess-gap', 'XLab', '2026-07-20T10:00:00Z', '2026-07-20T11:00:00Z',
        10000, 500, 2000, 0, 100, NULL, 0, 0, 5
      );
      INSERT INTO session_model_usage VALUES (
        'sess-gap', 'Kimi-k3', 3000, 100, 500, 0, 0,
        NULL, NULL, 2, '2026-07-20T10:00:00Z', '2026-07-20T10:30:00Z'
      );
    `);
    db.close();

    const events = await parseHermes([root]);
    assert.ok(events.length >= 2);
    const gap = events.find((e) => e.id && e.estimated === true);
    assert.ok(gap, "expected gap-fill event");
    // session in 10000 - smu 3000 = 7000; out (500+100 reasoning) - smu 100 = 500; cache 2000-500=1500
    assert.equal(gap!.inputTokens, 7000);
    assert.equal(gap!.outputTokens, 500);
    assert.equal(gap!.cacheReadTokens, 1500);
    const totalIn = events.reduce((s, e) => s + e.inputTokens, 0);
    assert.equal(totalIn, 10000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseHermes skips snapshot sessions already covered by live state.db", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xlab-hermes-snap-"));
  try {
    // Live DB
    const liveDb = path.join(root, "state.db");
    const live = new DatabaseSync(liveDb);
    live.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, model TEXT, started_at TEXT, ended_at TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
        cache_write_tokens INTEGER, reasoning_tokens INTEGER, cwd TEXT,
        estimated_cost_usd REAL, actual_cost_usd REAL, api_call_count INTEGER
      );
      CREATE TABLE session_model_usage (
        session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        estimated_cost_usd REAL, actual_cost_usd REAL, api_call_count INTEGER,
        first_seen TEXT, last_seen TEXT
      );
      INSERT INTO sessions VALUES (
        'shared-sess', 'kimi-k3', '2026-07-20T10:00:00Z', '2026-07-20T11:00:00Z',
        1000, 100, 0, 0, 0, NULL, 0, 0, 1
      );
      INSERT INTO session_model_usage VALUES (
        'shared-sess', 'kimi-k3', 1000, 100, 0, 0, 0,
        NULL, NULL, 1, '2026-07-20T10:00:00Z', '2026-07-20T11:00:00Z'
      );
    `);
    live.close();

    // Snapshot with overlapping session (must NOT double-count) + unique history
    const snapDir = path.join(root, "state-snapshots", "20260701-old");
    await mkdir(snapDir, { recursive: true });
    const snap = new DatabaseSync(path.join(snapDir, "state.db"));
    snap.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, model TEXT, started_at TEXT, ended_at TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
        cache_write_tokens INTEGER, reasoning_tokens INTEGER, cwd TEXT,
        estimated_cost_usd REAL, actual_cost_usd REAL, api_call_count INTEGER
      );
      CREATE TABLE session_model_usage (
        session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        estimated_cost_usd REAL, actual_cost_usd REAL, api_call_count INTEGER,
        first_seen TEXT, last_seen TEXT
      );
      INSERT INTO session_model_usage VALUES (
        'shared-sess', 'kimi-k3', 9999, 999, 0, 0, 0,
        NULL, NULL, 9, '2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z'
      );
      INSERT INTO session_model_usage VALUES (
        'only-in-snap', 'grok-4.5', 500, 50, 0, 0, 0,
        NULL, NULL, 1, '2026-07-01T12:00:00Z', '2026-07-01T12:30:00Z'
      );
    `);
    snap.close();

    const events = await parseHermes([root]);
    const shared = events.filter((e) => e.inputTokens === 1000 || e.inputTokens === 9999);
    assert.equal(shared.length, 1, "shared session must appear once (live wins)");
    assert.equal(shared[0]!.inputTokens, 1000);
    const hist = events.find((e) => e.model === "grok-4.5");
    assert.ok(hist, "unique snapshot session kept");
    assert.equal(hist!.inputTokens, 500);
    const totalIn = events.reduce((s, e) => s + e.inputTokens, 0);
    assert.equal(totalIn, 1500);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseHermes falls back to sessions when SMU empty", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xlab-hermes-sess-"));
  try {
    const dbPath = path.join(root, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        model TEXT,
        model_config TEXT,
        started_at TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        reasoning_tokens INTEGER,
        cwd TEXT,
        estimated_cost_usd REAL,
        actual_cost_usd REAL,
        api_call_count INTEGER
      );
      INSERT INTO sessions VALUES (
        'sess-2', 'XLab',
        '{"model":"XLab","provider":"9router"}',
        '2026-07-21T10:00:00Z',
        5000, 200, 1000, 0, 80, NULL, 0, 0, 2
      );
    `);
    db.close();

    const events = await parseHermes([root]);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.inputTokens, 5000);
    // output 200 + reasoning 80 (over-count policy)
    assert.equal(events[0]!.outputTokens, 280);
    assert.equal(events[0]!.cacheReadTokens, 1000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hermes SMU id stays stable when tokens grow and request dumps are ignored", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xlab-hermes-stable-"));
  try {
    const dbPath = path.join(root, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, model TEXT, started_at TEXT, ended_at TEXT,
        input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER
      );
      CREATE TABLE session_model_usage (
        session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        api_call_count INTEGER, first_seen TEXT, last_seen TEXT
      );
      INSERT INTO sessions VALUES (
        'sess-live', 'glm-5.3', '2026-10-03T01:00:00Z', '2026-10-03T02:00:00Z',
        1000, 10, 0
      );
      INSERT INTO session_model_usage VALUES (
        'sess-live', 'glm-5.3', 1000, 10, 0, 0, 0, 1,
        '2026-10-03T01:00:00Z', '2026-10-03T02:00:00Z'
      );
    `);
    db.close();
    await mkdir(path.join(root, "sessions"), { recursive: true });
    await writeFile(
      path.join(root, "sessions", "request_dump_today.json"),
      JSON.stringify({
        timestamp: "2026-10-03T02:00:00Z",
        model: "glm-5.3",
        input_tokens: 999999,
        output_tokens: 1,
      }),
    );

    const first = await parseHermes([root]);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.inputTokens, 1000);

    const db2 = new DatabaseSync(dbPath);
    db2.exec(`UPDATE session_model_usage SET input_tokens = 5000, output_tokens = 40 WHERE session_id = 'sess-live'`);
    db2.close();

    const second = await parseHermes([root], { light: true });
    assert.equal(second.length, 1);
    assert.equal(second[0]!.id, first[0]!.id);
    assert.equal(second[0]!.inputTokens, 5000);

    const stacked = replaceFreshAgentSourceEvents(
      second,
      [
        {
          ...first[0]!,
          id: "legacy-token-baked-id",
          inputTokens: 1000,
          totalTokens: 1010,
          estimatedCost: 2,
        },
        first[0]!,
      ],
      "hermes",
    );
    assert.equal(stacked.length, 1);
    assert.equal(stacked[0]!.inputTokens, 5000);
    assert.equal(stacked[0]!.id, second[0]!.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
