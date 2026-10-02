import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import * as agentRegistry from "../src/agents/index.ts";
import { parseOpenClaw } from "../src/agents/openclaw/index.ts";
import type { UsageEvent } from "../src/types.ts";

test("parseOpenClaw reads per-response usage from the active SQLite transcript", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xlab-openclaw-"));
  try {
    const agentDir = path.join(root, "agents", "main", "agent");
    await mkdir(agentDir, { recursive: true });
    const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
    db.exec(`
      CREATE TABLE session_windows (
        session_id TEXT PRIMARY KEY,
        model_provider TEXT,
        model TEXT
      );
      CREATE TABLE transcript_events (
        session_id TEXT,
        seq INTEGER,
        event_json TEXT,
        created_at INTEGER
      );
      INSERT INTO session_windows VALUES ('session-1', 'hermes', 'glm-5.3');
    `);
    const events = [
      {
        type: "model_change",
        timestamp: "2026-09-20T08:04:17.356Z",
        provider: "hermes",
        modelId: "glm-5.3",
      },
      {
        type: "message",
        timestamp: "2026-09-20T08:04:24.280Z",
        message: {
          role: "assistant",
          usage: {
            input: 36_869,
            output: 33,
            cacheRead: 0,
            cacheWrite: 0,
            total: 36_902,
          },
        },
      },
    ];
    const insert = db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?)");
    events.forEach((event, index) => {
      insert.run("session-1", index + 1, JSON.stringify(event), Date.parse(event.timestamp));
    });
    db.close();

    const usage = await parseOpenClaw([root]);
    assert.equal(usage.length, 1);
    assert.equal(usage[0]!.agent, "openclaw");
    assert.equal(usage[0]!.model, "glm-5.3");
    assert.equal(usage[0]!.timestamp, "2026-09-20T08:04:24.280Z");
    assert.equal(usage[0]!.inputTokens, 36_869);
    assert.equal(usage[0]!.outputTokens, 33);
    assert.equal(usage[0]!.totalTokens, 36_902);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scan reconciliation keeps a mirrored OpenClaw call counted once under Hermes", () => {
  const reconcile = (agentRegistry as unknown as Record<string, unknown>)
    .dedupeMirroredOpenClawEvents as
    | ((openclaw: UsageEvent[], hermes: UsageEvent[]) => UsageEvent[])
    | undefined;
  assert.equal(typeof reconcile, "function");

  const makeEvent = (overrides: Partial<UsageEvent>): UsageEvent => ({
    id: "event",
    agent: "openclaw",
    model: "glm-5.3",
    timestamp: "2026-09-20T08:04:24.280Z",
    inputTokens: 36_869,
    outputTokens: 33,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 36_902,
    estimatedCost: 0.05,
    currency: "USD",
    pricingStatus: "priced",
    workspace: null,
    sourcePath: "C:\\Users\\GHC\\.openclaw\\agents\\main\\agent\\openclaw-agent.sqlite",
    ...overrides,
  });
  const mirror = makeEvent({ id: "openclaw-mirror" });
  const unrelated = makeEvent({ id: "other-request", timestamp: "2026-09-20T08:05:00.000Z" });
  const hermes: UsageEvent = {
    ...mirror,
    id: "hermes-source",
    agent: "hermes",
    timestamp: "2026-09-20T08:04:24.249Z",
    inputTokens: 20_485,
    cacheReadTokens: 16_384,
    estimatedCost: 0.033,
    sourcePath: "C:\\Users\\GHC\\AppData\\Local\\hermes\\state.db",
  };

  const result = reconcile!([mirror, unrelated], [hermes]);
  assert.deepEqual(result.map((event) => event.id), ["other-request"]);
});
