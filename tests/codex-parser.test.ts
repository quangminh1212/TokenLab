import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";
import { parseCodex } from "../src/agents/codex/index.js";

describe("parseCodex", () => {
  const temps: string[] = [];
  after(async () => {
    for (const t of temps) {
      await rm(t, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("attributes LiteLLM history into codex when token_count.info is null", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tokenlab-codex-"));
    temps.push(root);
    const sessions = path.join(root, "sessions", "2026", "08", "02");
    await mkdir(sessions, { recursive: true });

    const rollout = path.join(sessions, "rollout-test.jsonl");
    const lines = [
      {
        timestamp: "2026-08-02T05:43:00.000Z",
        type: "session_meta",
        payload: {
          session_id: "s1",
          cwd: "C:\\Dev\\CursorProxy",
          model_provider: "9router",
          model: "kimi-k3",
        },
      },
      {
        timestamp: "2026-08-02T05:43:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "t1" },
      },
      {
        timestamp: "2026-08-02T05:43:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello world" }],
        },
      },
      {
        timestamp: "2026-08-02T05:43:05.000Z",
        type: "event_msg",
        payload: { type: "token_count", info: null, rate_limits: {} },
      },
      {
        timestamp: "2026-08-02T05:43:10.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hi there" }],
        },
      },
      {
        timestamp: "2026-08-02T05:43:12.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "t1" },
      },
    ];
    await writeFile(rollout, lines.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");

    // Proxy mirror under TOKENLAB_DATA_DIR so loadProxyUsageIndex finds it
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "tokenlab-data-"));
    temps.push(dataDir);
    const mirror = path.join(dataDir, "mirrors", "litellm");
    await mkdir(mirror, { recursive: true });
    const hist = path.join(mirror, "usage-history.jsonl");
    await writeFile(
      hist,
      JSON.stringify({
        id: "req-codex-1",
        timestamp: "2026-08-02T05:43:08.000Z",
        model: "openai/Kimi-k3",
        provider: "openai",
        promptTokens: 1200,
        completionTokens: 40,
        cost: 0.012,
        status: "success",
      }) + "\n",
      "utf8",
    );

    const prev = process.env.TOKENLAB_DATA_DIR;
    process.env.TOKENLAB_DATA_DIR = dataDir;
    try {
      const events = await parseCodex([root]);
      assert.ok(events.length >= 1, `expected attributed events, got ${events.length}`);
      const e = events.find((x) => x.inputTokens === 1200 && x.outputTokens === 40);
      assert.ok(e, "expected proxy-attributed event with real token counts");
      assert.equal(e!.agent, "codex");
      assert.ok((e!.estimatedCost ?? 0) > 0 || e!.inputTokens === 1200);
      assert.ok(String(e!.sourcePath).includes("←"), "sourcePath should note proxy origin");
    } finally {
      if (prev === undefined) delete process.env.TOKENLAB_DATA_DIR;
      else process.env.TOKENLAB_DATA_DIR = prev;
    }
  });

  it("estimates content when no proxy match and info is null", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tokenlab-codex-est-"));
    temps.push(root);
    const sessions = path.join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    const rollout = path.join(sessions, "rollout-est.jsonl");
    // Long enough content so chars/4 produces clear token counts
    const userText = "u".repeat(40);
    const asstText = "a".repeat(20);
    const lines = [
      {
        timestamp: "2026-08-02T01:00:00.000Z",
        type: "session_meta",
        payload: { session_id: "s2", model: "gpt-test", cwd: "C:\\Dev" },
      },
      {
        timestamp: "2026-08-02T01:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started" },
      },
      {
        timestamp: "2026-08-02T01:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ text: userText }],
        },
      },
      {
        timestamp: "2026-08-02T01:00:03.000Z",
        type: "event_msg",
        payload: { type: "token_count", info: null },
      },
      {
        timestamp: "2026-08-02T01:00:04.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ text: asstText }],
        },
      },
      {
        timestamp: "2026-08-02T01:00:05.000Z",
        type: "event_msg",
        payload: { type: "task_complete" },
      },
    ];
    await writeFile(rollout, lines.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");

    // Isolate from real machine mirrors
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "tokenlab-data-empty-"));
    temps.push(dataDir);
    process.env.TOKENLAB_DATA_DIR = dataDir;
    process.env.TOKENLAB_LITELLM_DIR = path.join(dataDir, "none");
    process.env.NINEROUTER_HOME = path.join(dataDir, "none2");

    try {
      const events = await parseCodex([root]);
      assert.ok(events.length >= 1, `expected estimate events, got ${events.length}`);
      const e = events[0]!;
      assert.equal(e.agent, "codex");
      assert.equal(e.estimated, true);
      assert.equal(e.inputTokens, Math.ceil(40 / 4));
      assert.equal(e.outputTokens, Math.ceil(20 / 4));
    } finally {
      delete process.env.TOKENLAB_DATA_DIR;
      delete process.env.TOKENLAB_LITELLM_DIR;
      delete process.env.NINEROUTER_HOME;
    }
  });

  it("still parses real token_count info when present", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tokenlab-codex-real-"));
    temps.push(root);
    const sessions = path.join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    const rollout = path.join(sessions, "rollout-real.jsonl");
    await writeFile(
      rollout,
      JSON.stringify({
        timestamp: "2026-08-02T02:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 100,
              output_tokens: 25,
            },
          },
        },
      }) + "\n",
      "utf8",
    );

    const dataDir = await mkdtemp(path.join(os.tmpdir(), "tokenlab-data-real-"));
    temps.push(dataDir);
    process.env.TOKENLAB_DATA_DIR = dataDir;
    try {
      const events = await parseCodex([root]);
      assert.ok(events.some((e) => e.inputTokens === 100 && e.outputTokens === 25));
      assert.ok(events.every((e) => e.estimated !== true || e.inputTokens === 100));
    } finally {
      delete process.env.TOKENLAB_DATA_DIR;
    }
  });
});
