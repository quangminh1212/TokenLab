import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseQwenCoder } from "../src/agents/qwencoder/index.ts";

test("parseQwenCoder reads dashboard-scrape models", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tl-qwencoder-"));
  try {
    await writeFile(
      path.join(root, "dashboard-scrape.json"),
      JSON.stringify({
        scrapedAt: "2026-08-05T10:00:00.000Z",
        periodDays: 30,
        totals: { tokensUsed: 2_394_300_000, requests: 45928, successRequests: 41433 },
        models: [
          { model: "qwen3.7-max", requests: 17861, tokens: 1_505_400_000, pct: 63.5 },
          { model: "gpt-5.6-sol", requests: 10985, tokens: 453_600_000, pct: 19.1 },
        ],
      }),
      "utf8",
    );
    const events = await parseQwenCoder([root]);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.agent, "qwencoder");
    const q = events.find((e) => e.model === "qwen3.7-max")!;
    assert.equal(q.inputTokens, 1_505_400_000);
    assert.equal(q.requestCount, 17861);
    const totalIn = events.reduce((s, e) => s + e.inputTokens, 0);
    assert.equal(totalIn, 1_505_400_000 + 453_600_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseQwenCoder reads models API envelope", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tl-qwencoder-api-"));
  try {
    await writeFile(
      path.join(root, "api_v1_dashboard_analysis_models_me.json"),
      JSON.stringify({
        success: true,
        data: {
          models: [
            {
              model: "kimi-k3",
              input_tokens: 1000,
              output_tokens: 200,
              requests: 3,
            },
          ],
        },
      }),
      "utf8",
    );
    const events = await parseQwenCoder([root]);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.model, "kimi-k3");
    assert.equal(events[0]!.inputTokens, 1000);
    assert.equal(events[0]!.outputTokens, 200);
    assert.equal(events[0]!.requestCount, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseQwenCoder usage-daily byModel", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tl-qwencoder-daily-"));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "usage-daily.json"),
      JSON.stringify({
        "2026-08-01": {
          byModel: {
            "gpt-5.6-sol": { inputTokens: 5000, outputTokens: 100, requests: 2 },
          },
        },
      }),
      "utf8",
    );
    const events = await parseQwenCoder([root]);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.timestamp.slice(0, 10), "2026-08-01");
    assert.equal(events[0]!.inputTokens, 5000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
