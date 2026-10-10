import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { parseHermes } from "../src/agents/hermes/index.ts";

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
    // Each SMU row is a session summary with a real span, so it is split across
    // the minutes it covered rather than stamped on one instant. Assert on the
    // TOTALS: splitting must not duplicate or drop usage.
    const models = new Set(events.map((e) => e.model));
    assert.ok(models.has("claude-opus-4.8"));
    assert.ok(models.has("Kimi-k3"));
    const totalIn = events.reduce((s, e) => s + e.inputTokens, 0);
    assert.equal(totalIn, 1600);
    // opus: 3 calls over a 1h span -> 3 rows within minutes 10:00..10:02
    const opus = events.filter((e) => e.model === "claude-opus-4.8");
    assert.equal(opus.length, 3);
    // reasoning 50 added on top of opus output 150, and preserved across the split
    assert.equal(opus.reduce((s, e) => s + e.outputTokens, 0), 200);
    assert.equal(opus.reduce((s, e) => s + e.cacheReadTokens, 0), 500);
    assert.ok(Math.abs(opus.reduce((s, e) => s + (e.estimatedCost ?? 0), 0) - 0.05) < 1e-9);
    assert.equal(opus.reduce((s, e) => s + (e.requestCount ?? 0), 0), 3);
    // Split rows must not all share one timestamp, or the peak is still faked.
    const opusTimes = new Set(opus.map((e) => e.timestamp));
    assert.equal(opusTimes.size, 3);
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
    // The gap-fill row and the SMU row are both session summaries with real
    // spans, so each is split across its covered minutes. Identify the gap rows
    // by their estimated flag and assert on totals.
    const gapRows = events.filter((e) => e.estimated === true);
    assert.ok(gapRows.length >= 1, "expected gap-fill event(s)");
    // session in 10000 - smu 3000 = 7000; out (500+100 reasoning) - smu 100 = 500; cache 2000-500=1500
    assert.equal(gapRows.reduce((s, e) => s + e.inputTokens, 0), 7000);
    assert.equal(gapRows.reduce((s, e) => s + e.outputTokens, 0), 500);
    assert.equal(gapRows.reduce((s, e) => s + e.cacheReadTokens, 0), 1500);
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
    // The row carried cache_read_tokens, so the CACHE $ column must show a real
    // number instead of the "—" it rendered while the flag went unset.
    assert.equal(events[0]!.cacheReported, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseHermes spreads a long session so peak RPM is not the session total", async () => {
  // Real regression: a 3135-call hermes session spanning ~25h was emitted as ONE
  // event on its last_seen minute, so peak RPM read 3135 and all of the traffic
  // was attributed to the wrong calendar day.
  const root = await mkdtemp(path.join(tmpdir(), "xlab-hermes-span-"));
  try {
    const db = new DatabaseSync(path.join(root, "state.db"));
    db.exec(`
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
        'sess-long', 'Kimi-k3', 100000, 5000, 20000, 0, 0,
        12.5, NULL, 3135, '2026-08-03T16:43:14Z', '2026-08-04T17:57:37Z'
      );
    `);
    db.close();

    const events = await parseHermes([root]);
    // Totals preserved exactly across the split.
    assert.equal(events.reduce((s, e) => s + (e.requestCount ?? 0), 0), 3135);
    assert.equal(events.reduce((s, e) => s + e.inputTokens, 0), 100000);
    assert.equal(events.reduce((s, e) => s + e.outputTokens, 0), 5000);
    assert.ok(Math.abs(events.reduce((s, e) => s + (e.estimatedCost ?? 0), 0) - 12.5) < 1e-6);

    // The busiest single minute must be a small fraction of the session total —
    // that is what stops peak RPM from reading 3135.
    const busiest = Math.max(...events.map((e) => e.requestCount ?? 0));
    assert.ok(busiest < 100, `busiest minute should be far below 3135, got ${busiest}`);

    // Traffic lands on BOTH calendar days the session actually spanned.
    const days = new Set(events.map((e) => e.timestamp.slice(0, 10)));
    assert.ok(days.has("2026-08-03"), "expected usage on the session's first day");
    assert.ok(days.has("2026-08-04"), "expected usage on the session's second day");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
