import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageEvent } from "../src/types.js";
import { resolvePhanmemvipUsage } from "../src/server/phanmemvip-usage.js";

function usageEvent(
  partial: Pick<UsageEvent, "id" | "agent" | "model" | "timestamp">,
): UsageEvent {
  return {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 2,
    estimatedCost: 0,
    currency: "USD",
    pricingStatus: "priced",
    workspace: null,
    sourcePath: "test",
    ...partial,
  };
}

test("stale zero mirror falls back to today's PhanmemVIP LiteLLM minutes", () => {
  const result = resolvePhanmemvipUsage(
    {
      date: "2026-10-13",
      usedMinutes: 0,
      limitMinutes: 1070,
      updatedAt: null,
    },
    [
      usageEvent({
        id: "fable-1",
        agent: "litellm",
        model: "claude-fable-5",
        timestamp: "2026-10-12T17:03:05.000Z",
      }),
      usageEvent({
        id: "sonnet-same-minute",
        agent: "litellm",
        model: "pmv-sonnet-5",
        timestamp: "2026-10-12T17:03:58.000Z",
      }),
      usageEvent({
        id: "opus-next-minute",
        agent: "litellm",
        model: "claude-opus-4.7",
        timestamp: "2026-10-12T17:04:00.000Z",
      }),
      usageEvent({
        id: "other-provider",
        agent: "litellm",
        model: "mintrouter-big-pickle",
        timestamp: "2026-10-12T17:05:00.000Z",
      }),
      usageEvent({
        id: "other-agent",
        agent: "codex",
        model: "claude-fable-5",
        timestamp: "2026-10-12T17:06:00.000Z",
      }),
      {
        ...usageEvent({
          id: "daily-rollup",
          agent: "litellm",
          model: "claude-fable-5",
          timestamp: "2026-10-12T17:07:00.000Z",
        }),
        estimated: true,
        requestCount: 500,
      },
      usageEvent({
        id: "previous-vietnam-day",
        agent: "litellm",
        model: "claude-fable-5",
        timestamp: "2026-10-12T16:59:59.000Z",
      }),
    ],
    "2026-10-13",
  );

  assert.deepEqual(result, {
    date: "2026-10-13",
    usedMinutes: 2,
    limitMinutes: 1070,
    updatedAt: "2026-10-12T17:04:00.000Z",
  });
});

test("current mirror and request history use the greater active-minute count", () => {
  const result = resolvePhanmemvipUsage(
    {
      date: "2026-10-13",
      minutes: ["07:00", "07:01", "07:02", "07:03"],
      usedMinutes: 4,
      updatedAt: "2026-10-13T04:10:00.000Z",
    },
    [
      usageEvent({
        id: "fable-1",
        agent: "litellm",
        model: "claude-fable-5",
        timestamp: "2026-10-12T17:03:05.000Z",
      }),
    ],
    "2026-10-13",
  );

  assert.equal(result.usedMinutes, 4);
  assert.equal(result.updatedAt, "2026-10-13T04:10:00.000Z");
});

test("no current mirror evidence or matching events does not fabricate zero", () => {
  const result = resolvePhanmemvipUsage(
    {
      date: "2026-10-13",
      usedMinutes: 0,
      updatedAt: null,
    },
    [],
    "2026-10-13",
  );

  assert.equal(result.usedMinutes, null);
  assert.equal(result.updatedAt, null);
});
