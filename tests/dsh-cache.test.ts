import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseDsh } from "../src/agents/dsh/index.ts";
import { getRateForModel, priceCostParts } from "../src/pricing.ts";

/**
 * DSH sessions are the "Anthropic Harness" source in the dashboard.
 *
 * Two usage shapes appear in real session files:
 *
 *  A) cache-aware — adds cacheReadTokens, with `total = input + cache + output`.
 *  B) legacy — `inputTokens`/`outputTokens`/`totalTokens` only, with
 *     `total = input + output`. ~99.5% of recorded rows.
 *
 * The dashboard's CACHE $ column read "—" because shape B yielded
 * cacheReadTokens = 0 for almost every row.
 *
 * Billing rule (verified against 7153/7153 billed LiteLLM rows for the same
 * model): `cost = 10 * promptTokens + 50 * completionTokens`, where
 * `promptTokens` ALREADY contains the cached part and the cache is billed at the
 * SAME rate as fresh input. A cache read is a hit-rate fact, not a discount — so
 * `inputTokens` must keep the whole prompt and only the *displayed* split is
 * reconstructed.
 */

async function writeSession(root: string, project: string, name: string, rows: unknown[]) {
  const dir = path.join(root, project);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, name),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
  return dir;
}

function turn(seq: number, usage: Record<string, unknown>, model = "anthropic/claude-fable-5") {
  return [
    { type: "request/context", seq: seq - 1, cwd: "/work/demo", data: { model } },
    { type: "assistant/message", seq, cwd: "/work/demo", data: { usage } },
  ];
}

test("parseDsh keeps cache reads from the cache-aware usage shape", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xlab-dsh-"));
  try {
    await writeSession(
      root,
      "demo",
      "session.jsonl",
      turn(1, {
        inputTokens: 535,
        outputTokens: 181,
        totalTokens: 98_764,
        cacheReadTokens: 98_048,
      }),
    );

    const events = await parseDsh([root]);
    assert.equal(events.length, 1);
    const e = events[0]!;
    assert.equal(e.cacheReadTokens, 98_048, "cache reads must survive parsing");
    assert.equal(e.inputTokens, 535, "cache-aware inputTokens is passed through");
    assert.equal(e.cacheReported, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseDsh reconstructs a cache read for legacy rows while preserving the prompt total", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xlab-dsh-legacy-"));
  try {
    // Legacy shape: total == input + output, no cache field. Prompts grow
    // 165k -> 168k -> 169k, exactly like the real Claude-Fable sessions.
    await writeSession(root, "demo", "session.jsonl", [
      { type: "request/context", seq: 0, cwd: "/work/demo", data: { model: "anthropic/claude-fable-5" } },
      { type: "assistant/message", seq: 1, cwd: "/work/demo", data: { usage: { inputTokens: 165_056, outputTokens: 512, totalTokens: 165_568 } } },
      { type: "assistant/message", seq: 2, cwd: "/work/demo", data: { usage: { inputTokens: 168_204, outputTokens: 120, totalTokens: 168_324 } } },
      { type: "assistant/message", seq: 3, cwd: "/work/demo", data: { usage: { inputTokens: 169_110, outputTokens: 88, totalTokens: 169_198 } } },
    ]);

    const events = await parseDsh([root]);
    assert.equal(events.length, 3);
    const [first, second, third] = [events[0]!, events[1]!, events[2]!];

    // Turn 1: nothing cached yet, so the whole prompt is fresh input.
    assert.equal(first.cacheReadTokens, 0);
    assert.equal(first.inputTokens, 165_056);

    // Turns 2-3: the previous turn's prompt is reported as a cache read, so
    // CACHE $ stops reading "—" and the fresh part is only the growth.
    assert.equal(second.cacheReadTokens, 165_056);
    assert.equal(second.inputTokens, 168_204 - 165_056);
    assert.equal(third.cacheReadTokens, 168_204);
    assert.equal(third.inputTokens, 169_110 - 168_204);

    // Nothing invented or lost: each row still accounts for its whole prompt.
    for (const [e, prompt] of [[first, 165_056], [second, 168_204], [third, 169_110]] as const) {
      assert.equal(e.inputTokens + e.cacheReadTokens, prompt, "split must preserve the prompt total");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy reconstruction leaves the billed total identical to the provider's formula", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xlab-dsh-cost-"));
  try {
    // Two turns, legacy shape. The gateway bills 10*prompt + 50*out per turn and
    // charges the cached part at the same rate as fresh input, so splitting the
    // prompt between Input $ and Cache $ must not move a cent.
    await writeSession(root, "demo", "session.jsonl", [
      { type: "request/context", seq: 0, cwd: "/work/demo", data: { model: "anthropic/claude-fable-5" } },
      { type: "assistant/message", seq: 1, cwd: "/work/demo", data: { usage: { inputTokens: 100_000, outputTokens: 1_000, totalTokens: 101_000 } } },
      { type: "assistant/message", seq: 2, cwd: "/work/demo", data: { usage: { inputTokens: 120_000, outputTokens: 1_000, totalTokens: 121_000 } } },
    ]);

    const events = await parseDsh([root]);
    assert.equal(events.length, 2);

    const priced = events.reduce(
      (a, e) =>
        a +
        priceCostParts(e.model, e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheWriteTokens)
          .tableTotal,
      0,
    );
    const expected =
      (100_000 / 1e6) * 10 + (1_000 / 1e6) * 50 + (120_000 / 1e6) * 10 + (1_000 / 1e6) * 50;
    assert.ok(
      Math.abs(priced - expected) < 1e-9,
      `billed total drifted: got ${priced}, expected ${expected}`,
    );

    // The reported parts must add up to the total the dashboard prints.
    const parts = priceCostParts(
      events[1]!.model,
      events[1]!.inputTokens,
      events[1]!.outputTokens,
      events[1]!.cacheReadTokens,
      events[1]!.cacheWriteTokens,
    );
    assert.ok(
      Math.abs(parts.inputCost + parts.cacheCost + parts.outputCost - parts.tableTotal) < 1e-9,
      "Input $ + Cache $ + Output $ must equal Total $",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- pricing -------------------------------------------------------------

test("cache reads on these gateways bill at the input rate, not a discount", async () => {
  // Verified: cost = 10*prompt + 50*out on 7153/7153 billed rows, with prompt
  // already containing cache. A cheaper cacheReadPer1M would under-bill.
  const rate = getRateForModel("claude-fable-5");
  assert.equal(rate.rate.inputPer1M, 10);
  assert.equal(rate.rate.outputPer1M, 50);
  assert.equal(
    rate.rate.cacheReadPer1M,
    rate.rate.inputPer1M,
    "a cache read is billed like fresh input on this gateway",
  );

  // 1M prompt (fully cached) + 1M output => $10 + $50, cache included in the $10.
  const parts = priceCostParts("claude-fable-5", 1_000_000, 1_000_000, 1_000_000, 0);
  assert.equal(parts.inputCost, 10);
  assert.equal(parts.cacheCost, 10);
  assert.equal(parts.outputCost, 50);
});

test("every Claude model the router bills prices cache like input", async () => {
  for (const model of [
    "claude-fable-5",
    "claude-fable",
    "claude-opus-5",
    "claude-opus-5.5",
    "claude-sonnet-5.5",
  ]) {
    const { rate } = getRateForModel(model);
    assert.equal(
      rate.cacheReadPer1M,
      rate.inputPer1M,
      `${model} must bill cache reads at the input rate`,
    );
  }
});
