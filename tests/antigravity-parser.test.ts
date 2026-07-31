import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  extractModelFromText,
  parseAntigravity,
  parseAntigravityProxyDb,
  parseAntigravityTranscripts,
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
    assert.equal(first!.model, "kimi-k3");
    assert.equal(first!.outputTokens, 88);
    assert.ok((first!.estimatedCost ?? 0) > 0);
    assert.equal(first!.requestCount, 1);

    const second = events.find((e) => e.inputTokens === 1000);
    assert.ok(second);
    assert.equal(second!.model, "gemini-3.6-flash-high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extractModelFromText prefers specific Gemini Flash variants", () => {
  assert.equal(
    extractModelFromText("Model Selection` from None to Gemini 3.6 Flash (High)."),
    "gemini-3.6-flash-high",
  );
  assert.equal(
    extractModelFromText("noise gemini-3.6-flash-tiered and MODEL_PLACEHOLDER_M196"),
    "gemini-3.6-flash-tiered",
  );
  assert.equal(
    extractModelFromText("gemini-3.6-flash-high gemini-3.6-flash-tiered"),
    "gemini-3.6-flash-high",
  );
  assert.equal(extractModelFromText("MODEL_PLACEHOLDER_M71"), "gemini-3.6-flash-high");
  assert.notEqual(extractModelFromText("C:\\\\Users\\\\.gemini\\\\antigravity\\\\brain"), "gemini");
});

test("parseAntigravityTranscripts estimates tokens from brain logs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tokenlab-ag-tr-"));
  try {
    const logDir = path.join(
      root,
      "brain",
      "conv-abc",
      ".system_generated",
      "logs",
    );
    await mkdir(logDir, { recursive: true });
    const lines = [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-07-31T04:57:29Z",
        content:
          "hello world check chapters\nModel Selection from None to Gemini 3.6 Flash (High).",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-07-31T04:57:40Z",
        thinking: "I will inspect the directory and list files carefully.",
        tool_calls: [{ name: "list_dir", args: { DirectoryPath: "C:\\\\tmp" } }],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-07-31T04:58:00Z",
        content: "Done listing. Found 3 files.",
      },
    ];
    await writeFile(
      path.join(logDir, "transcript_full.jsonl"),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf8",
    );

    const events = await parseAntigravityTranscripts(root, new Map());
    assert.ok(events.length >= 2, "at least two model turns");
    assert.ok(events.every((e) => e.estimated === true));
    assert.ok(events.every((e) => e.agent === "antigravity"));
    assert.ok(
      events.every((e) => e.model === "gemini-3.6-flash-high"),
      "specific model from UI settings text",
    );
    const total = events.reduce((a, e) => a + e.inputTokens + e.outputTokens, 0);
    assert.ok(total > 20, "non-trivial estimated tokens");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseAntigravity merges proxy + local IDE transcripts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tokenlab-ag-all-"));
  try {
    // proxy
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { recursive: true });
    seedProxyDb(path.join(dataDir, "proxy.db"));

    // IDE layout under same root (portable)
    const logDir = path.join(root, "brain", "c1", ".system_generated", "logs");
    await mkdir(logDir, { recursive: true });
    await writeFile(
      path.join(logDir, "transcript.jsonl"),
      [
        JSON.stringify({
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          created_at: "2026-07-30T10:00:00Z",
          content: "write a poem about cats " + "x".repeat(200),
        }),
        JSON.stringify({
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          created_at: "2026-07-30T10:00:05Z",
          thinking: "Sure, here is a poem. " + "y".repeat(400),
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const events = await parseAntigravity([root]);
    const proxy = events.filter((e) => !e.estimated);
    const estimated = events.filter((e) => e.estimated);
    assert.equal(proxy.length, 2, "proxy real rows");
    assert.ok(estimated.length >= 1, "transcript estimates");
    assert.ok(
      events.reduce((a, e) => a + e.inputTokens, 0) > 24334,
      "total includes more than proxy alone",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
