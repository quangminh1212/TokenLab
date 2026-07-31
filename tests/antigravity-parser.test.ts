import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  parseAntigravity,
  parseAntigravityProxyDb,
} from "../src/agents/antigravity/index.ts";

function seedProxyDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE requests (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      timestamp TEXT NOT NULL,
      model TEXT,
      resolved_model TEXT,
      provider TEXT,
      direction TEXT,
      type TEXT,
      content TEXT,
      prompt_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      tool_calls TEXT,
      error TEXT,
      duration_ms INTEGER,
      attempts INTEGER DEFAULT 1,
      cost REAL DEFAULT 0
    );
  `);
  const ins = db.prepare(`
    INSERT INTO requests
      (id, timestamp, model, resolved_model, provider, direction, type,
       prompt_tokens, output_tokens, cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Successful routed request
  ins.run(
    "req_ok_1",
    "2026-07-31T04:57:41.579Z",
    "gemini-3.6-flash-high",
    "kimi-k3",
    "openai",
    "outgoing",
    "tool-call",
    24334,
    88,
    0.012299,
  );
  // Error with no tokens — should be skipped
  ins.run(
    "req_err_1",
    "2026-07-31T04:59:23.664Z",
    "gemini-3.6-flash-tiered",
    "",
    "",
    "outgoing",
    "error",
    0,
    0,
    0,
  );
  // Short brand resolved_model → keep Antigravity alias
  ins.run(
    "req_ok_2",
    "2026-07-31T05:00:00.000Z",
    "gemini-3.6-flash-high",
    "XLab",
    "openrouter",
    "outgoing",
    "text",
    1000,
    50,
    0.001,
  );
  db.close();
}

test("parseAntigravityProxyDb reads requests and skips empty errors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tokenlab-ag-"));
  try {
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "proxy.db");
    seedProxyDb(dbPath);

    const events = await parseAntigravityProxyDb(dbPath);
    assert.equal(events.length, 2, "two billable rows");

    const first = events.find((e) => e.inputTokens === 24334);
    assert.ok(first);
    assert.equal(first!.agent, "antigravity");
    assert.equal(first!.model, "kimi-k3"); // real resolved id preferred
    assert.equal(first!.outputTokens, 88);
    assert.ok((first!.estimatedCost ?? 0) > 0, "uses router cost");
    assert.equal(first!.requestCount, 1);

    const second = events.find((e) => e.inputTokens === 1000);
    assert.ok(second);
    // Short brand "XLab" → keep gemini alias
    assert.equal(second!.model, "gemini-3.6-flash-high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseAntigravity discovers ~/.antigravity-style data/proxy.db", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tokenlab-ag-root-"));
  try {
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { recursive: true });
    seedProxyDb(path.join(dataDir, "proxy.db"));

    const events = await parseAntigravity([root]);
    assert.equal(events.length, 2);
    const totalIn = events.reduce((a, e) => a + e.inputTokens, 0);
    assert.equal(totalIn, 24334 + 1000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
