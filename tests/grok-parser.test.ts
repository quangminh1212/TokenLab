import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseGrok } from "../src/agents/grok/index.ts";
import { priceTokens } from "../src/pricing.ts";

test("parseGrok prefers turn_completed usage and splits cache", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xlab-grok-"));
  try {
    const sessionDir = path.join(root, "sessions", "proj", "sess-1");
    await mkdir(sessionDir, { recursive: true });

    await writeFile(
      path.join(sessionDir, "summary.json"),
      JSON.stringify({
        info: { id: "sess-1", cwd: "C:\\Dev\\Demo" },
        current_model_id: "grok-4.5",
        updated_at: "2026-07-15T10:00:00.000Z",
      }),
    );

    // Real Grok shape: inputTokens is FULL prompt (includes cache)
    const usageLine = JSON.stringify({
      timestamp: 1784110894,
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "prompt-abc",
          stop_reason: "end_turn",
          usage: {
            inputTokens: 100_000,
            outputTokens: 2_000,
            totalTokens: 102_000,
            cachedReadTokens: 80_000,
            reasoningTokens: 500,
            modelCalls: 3,
            modelUsage: {
              "grok-4.5": {
                inputTokens: 100_000,
                outputTokens: 2_000,
                totalTokens: 102_000,
                cachedReadTokens: 80_000,
              },
            },
          },
        },
      },
    });
    // Noise lines that must be ignored
    const noise = JSON.stringify({
      timestamp: 1784110890,
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
          _meta: { totalTokens: 999_999 },
        },
      },
    });
    await writeFile(path.join(sessionDir, "updates.jsonl"), `${noise}\n${usageLine}\n`);

    // Inflated chat history should be ignored when usage exists
    await writeFile(
      path.join(sessionDir, "chat_history.jsonl"),
      [
        JSON.stringify({ type: "user", content: "x".repeat(50_000) }),
        JSON.stringify({ type: "assistant", content: "y".repeat(50_000) }),
      ].join("\n"),
    );

    const events = await parseGrok([root]);
    assert.equal(events.length, 1);
    const e = events[0]!;
    assert.equal(e.agent, "grok");
    assert.equal(e.model, "grok-4.5");
    assert.equal(e.estimated, false);
    // uncached = 100k - 80k
    assert.equal(e.inputTokens, 20_000);
    assert.equal(e.cacheReadTokens, 80_000);
    assert.equal(e.outputTokens, 2_000);
    assert.equal(e.totalTokens, 102_000);
    assert.equal(e.pricingStatus, "priced");

    // Cost must use cache rate, not full input rate on cached portion
    const correct = priceTokens("grok-4.5", 20_000, 2_000, 80_000, 0);
    assert.ok(e.estimatedCost != null);
    assert.ok(Math.abs((e.estimatedCost ?? 0) - (correct.estimatedCost ?? 0)) < 1e-12);

    const wrongAllInput = priceTokens("grok-4.5", 100_000, 2_000, 0, 0);
    assert.ok((e.estimatedCost ?? 0) < (wrongAllInput.estimatedCost ?? 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseGrok falls back to chat estimate when updates has no usage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xlab-grok-fb-"));
  try {
    const sessionDir = path.join(root, "sessions", "proj", "sess-2");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, "summary.json"),
      JSON.stringify({
        info: { id: "sess-2", cwd: "C:\\Dev\\Demo" },
        current_model_id: "grok-4.5",
        updated_at: "2026-07-15T11:00:00.000Z",
      }),
    );
    await writeFile(
      path.join(sessionDir, "chat_history.jsonl"),
      [
        JSON.stringify({ type: "user", content: "hello world test" }),
        JSON.stringify({
          type: "user",
          synthetic_reason: "system_reminder",
          content: "x".repeat(10_000),
        }),
        JSON.stringify({ type: "assistant", content: "hi there friend" }),
      ].join("\n"),
    );

    const events = await parseGrok([root]);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.estimated, true);
    // Over-count policy: synthetic injects are included in prompt estimate
    assert.ok((events[0]!.inputTokens ?? 0) > 1000);
    assert.ok((events[0]!.outputTokens ?? 0) > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
