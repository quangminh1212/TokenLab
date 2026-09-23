import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { parseOpenCode } from "../src/agents/opencode/index.ts";

const CREATED_AT = 1_780_000_000_000;

function createMessageDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY,
      directory TEXT NOT NULL,
      model TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      tokens_input INTEGER,
      tokens_output INTEGER,
      tokens_reasoning INTEGER,
      tokens_cache_read INTEGER,
      tokens_cache_write INTEGER
    );
  `);
  return db;
}

test("parseOpenCode reads v2 SQLite usage and deduplicates migrated v1/JSON messages", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tokenlab-opencode-v2-"));
  try {
    const dbPath = path.join(root, "opencode.db");
    const db = createMessageDatabase(dbPath);
    db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "session-1",
      "C:\\Dev\\sample",
      JSON.stringify({ providerID: "openai", id: "openai/gpt-5" }),
      CREATED_AT,
      CREATED_AT + 10,
      180,
      40,
      7,
      30,
      5,
    );
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
      "msg-overlap",
      "session-1",
      CREATED_AT,
      JSON.stringify({
        role: "assistant",
        modelID: "legacy-model",
        time: { created: CREATED_AT },
        tokens: { total: 185, input: 120, output: 20, reasoning: 10, cache: { read: 30, write: 5 } },
      }),
    );

    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "msg-overlap",
      "session-1",
      "assistant",
      1,
      CREATED_AT,
      CREATED_AT,
      JSON.stringify({
        agent: "build",
        model: { providerID: "openai", id: "openai/gpt-5" },
        time: { created: CREATED_AT },
        tokens: { input: 100, output: 20, reasoning: 7, cache: { read: 25, write: 5 } },
      }),
    );
    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "msg-reasoning-only",
      "session-1",
      "assistant",
      2,
      CREATED_AT + 1,
      CREATED_AT + 1,
      JSON.stringify({
        model: { providerID: "openai", id: "openai/gpt-5" },
        time: { created: CREATED_AT + 1 },
        tokens: { input: 50, output: 0, reasoning: 8, cache: { read: 0, write: 0 } },
      }),
    );
    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "msg-user",
      "session-1",
      "user",
      3,
      CREATED_AT + 2,
      CREATED_AT + 2,
      JSON.stringify({
        time: { created: CREATED_AT + 2 },
        tokens: { input: 999, output: 999, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    db.close();

    const legacyJsonDir = path.join(root, "storage", "message", "session-1");
    await mkdir(legacyJsonDir, { recursive: true });
    await writeFile(
      path.join(legacyJsonDir, "message-msg-overlap.json"),
      JSON.stringify({
        id: "msg-overlap",
        role: "assistant",
        modelID: "old-json-model",
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      "utf8",
    );

    const events = await parseOpenCode([root]);
    assert.equal(events.length, 3, "detail rows are deduplicated and the compacted-session gap is filled");

    const overlap = events.find((event) => event.inputTokens === 100);
    assert.ok(overlap);
    assert.equal(overlap!.model, "gpt-5");
    assert.equal(overlap!.timestamp, new Date(CREATED_AT).toISOString());
    assert.equal(overlap!.workspace, "C:\\Dev\\sample");
    assert.equal(overlap!.outputTokens, 27, "reasoning is added to visible output exactly once");
    assert.equal(overlap!.cacheReadTokens, 25);
    assert.equal(overlap!.cacheWriteTokens, 5);
    assert.equal(overlap!.totalTokens, 157);
    assert.equal(overlap!.sourcePath, dbPath);

    const reasoningOnly = events.find((event) => event.inputTokens === 50);
    assert.ok(reasoningOnly);
    assert.equal(reasoningOnly!.outputTokens, 8);
    assert.equal(reasoningOnly!.totalTokens, 58);

    const compactedGap = events.find((event) => event.estimated);
    assert.ok(compactedGap);
    assert.equal(compactedGap!.inputTokens, 30);
    assert.equal(compactedGap!.outputTokens, 12);
    assert.equal(compactedGap!.cacheReadTokens, 5);
    assert.equal(compactedGap!.cacheWriteTokens, 0);
    assert.equal(compactedGap!.totalTokens, 47);
    assert.equal(compactedGap!.workspace, "C:\\Dev\\sample");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseOpenCode falls back to the legacy SQLite message table", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tokenlab-opencode-v1-"));
  try {
    const dbPath = path.join(root, "opencode.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
      "msg-v1",
      "session-v1",
      CREATED_AT,
      JSON.stringify({
        role: "assistant",
        modelID: "legacy-model",
        path: { cwd: "C:\\Dev\\legacy" },
        time: { created: CREATED_AT },
        tokens: { total: 185, input: 120, output: 20, reasoning: 10, cache: { read: 30, write: 5 } },
      }),
    );
    db.close();

    const events = await parseOpenCode([root]);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.model, "legacy-model");
    assert.equal(events[0]!.workspace, "C:\\Dev\\legacy");
    assert.equal(events[0]!.inputTokens, 120);
    assert.equal(events[0]!.outputTokens, 30);
    assert.equal(events[0]!.cacheReadTokens, 30);
    assert.equal(events[0]!.cacheWriteTokens, 5);
    assert.equal(events[0]!.totalTokens, 185);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseOpenCode keeps support for legacy JSON message files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tokenlab-opencode-json-"));
  try {
    const messageDir = path.join(root, "storage", "message", "session-json");
    await mkdir(messageDir, { recursive: true });
    await writeFile(
      path.join(messageDir, "message-json-only.json"),
      JSON.stringify({
        id: "msg-json-only",
        role: "assistant",
        modelID: "legacy-json-model",
        time: { created: CREATED_AT },
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
      }),
      "utf8",
    );

    const events = await parseOpenCode([root]);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.model, "legacy-json-model");
    assert.equal(events[0]!.inputTokens, 10);
    assert.equal(events[0]!.outputTokens, 7);
    assert.equal(events[0]!.cacheReadTokens, 3);
    assert.equal(events[0]!.cacheWriteTokens, 1);
    assert.equal(events[0]!.totalTokens, 21);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
