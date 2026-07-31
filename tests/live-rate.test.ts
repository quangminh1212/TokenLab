import assert from "node:assert/strict";
import { test } from "node:test";
import { isLiveRequestEvent } from "../src/live-rate.ts";
import type { UsageEvent } from "../src/types.ts";

function base(partial: Partial<UsageEvent>): UsageEvent {
  return {
    id: "t",
    agent: "antigravity",
    model: "gemini-3.6-flash-high",
    timestamp: "2026-07-31T05:00:00.000Z",
    inputTokens: 1000,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1050,
    estimatedCost: 0.01,
    currency: "USD",
    pricingStatus: "priced",
    workspace: null,
    sourcePath: "/tmp/x",
    requestCount: 1,
    ...partial,
  };
}

test("isLiveRequestEvent keeps real per-call rows", () => {
  assert.equal(isLiveRequestEvent(base({ estimated: false })), true);
});

test("isLiveRequestEvent keeps estimated single-turn (Antigravity transcript)", () => {
  assert.equal(
    isLiveRequestEvent(base({ estimated: true, requestCount: 1, inputTokens: 12_000, outputTokens: 200, totalTokens: 12_200 })),
    true,
  );
});

test("isLiveRequestEvent drops estimated multi-RQ rollups", () => {
  assert.equal(
    isLiveRequestEvent(base({ estimated: true, requestCount: 500, inputTokens: 1e6, totalTokens: 1e6 })),
    false,
  );
});

test("isLiveRequestEvent drops multi-million token estimated blobs", () => {
  assert.equal(
    isLiveRequestEvent(
      base({
        estimated: true,
        requestCount: 1,
        inputTokens: 50_000_000,
        outputTokens: 1_000_000,
        totalTokens: 51_000_000,
      }),
    ),
    false,
  );
});
