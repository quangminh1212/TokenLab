import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseClaudeCode } from "../src/agents/claude-code/index.ts";

test("parseClaudeCode deduplicates repeated content blocks and keeps full usage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xlab-claude-"));
  try {
    const projectDir = path.join(root, "projects", "C--Dev-Demo");
    await mkdir(projectDir, { recursive: true });

    const repeatedMessageId = "msg_ce_repeated_blocks";
    const secondMessageId = "msg_cb_second_request";
    const rows = [
      // User usage must not be counted as an assistant API response.
      {
        type: "user",
        uuid: "user-1",
        message: {
          role: "user",
          usage: { input_tokens: 999_999, output_tokens: 999_999 },
        },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        timestamp: "2026-09-13T01:00:00.000Z",
        apiBlockIndex: 0,
        message: {
          id: repeatedMessageId,
          role: "assistant",
          model: "openclaw",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_creation: {
              ephemeral_5m_input_tokens: 4,
              ephemeral_1h_input_tokens: 6,
              input_tokens: 10,
            },
          },
        },
      },
      // Claude Code/OpenClaw repeats the same usage for every content block.
      {
        type: "assistant",
        uuid: "assistant-2",
        timestamp: "2026-09-13T01:00:00.001Z",
        apiBlockIndex: 1,
        message: {
          id: repeatedMessageId,
          role: "assistant",
          model: "openclaw",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_creation: {
              ephemeral_5m_input_tokens: 4,
              ephemeral_1h_input_tokens: 6,
              input_tokens: 10,
            },
          },
        },
      },
      {
        type: "assistant",
        uuid: "assistant-3",
        timestamp: "2026-09-13T01:00:00.002Z",
        apiBlockIndex: 2,
        message: {
          id: repeatedMessageId,
          role: "assistant",
          model: "openclaw",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_creation: {
              ephemeral_5m_input_tokens: 4,
              ephemeral_1h_input_tokens: 6,
              input_tokens: 10,
            },
          },
        },
      },
      {
        type: "assistant",
        uuid: "assistant-4",
        requestId: "request-2",
        apiBlockIndex: 0,
        message: {
          id: secondMessageId,
          role: "assistant",
          model: "glm-5.3",
          usage: { input_tokens: 7, output_tokens: 9 },
        },
      },
      {
        type: "assistant",
        uuid: "assistant-5",
        requestId: "request-2",
        apiBlockIndex: 1,
        message: {
          id: secondMessageId,
          role: "assistant",
          model: "glm-5.3",
          usage: { input_tokens: 7, output_tokens: 9 },
        },
      },
    ];
    const file = path.join(projectDir, "session.jsonl");
    await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

    const events = await parseClaudeCode([root]);
    assert.equal(events.length, 2, "one event per logical API response");

    const first = events.find((event) => event.model === "openclaw");
    assert.ok(first);
    assert.equal(first.inputTokens, 100);
    assert.equal(first.outputTokens, 20);
    assert.equal(first.cacheReadTokens, 50);
    assert.equal(first.cacheWriteTokens, 10);
    assert.equal(first.totalTokens, 180);
    assert.equal(first.workspace, "C--Dev-Demo");
    assert.equal(first.estimated, false);
    assert.equal(first.sourcePath, file);

    const second = events.find((event) => event.model === "glm-5.3");
    assert.ok(second);
    assert.equal(second.totalTokens, 16);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
