import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregate } from "./aggregate.js";
import type { UsageEvent } from "./types.js";

const sample: UsageEvent[] = [
  {
    id: "1",
    agent: "cursor",
    model: "gpt-4.1",
    timestamp: "2026-07-11T10:00:00.000Z",
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1200,
    estimatedCost: 0.5,
    currency: "USD",
    pricingStatus: "priced",
    workspace: null,
    sourcePath: "x",
  },
  {
    id: "2",
    agent: "grok",
    model: "grok-4.5",
    timestamp: "2026-07-11T11:00:00.000Z",
    inputTokens: 2000,
    outputTokens: 400,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 2400,
    estimatedCost: 1.2,
    currency: "USD",
    pricingStatus: "priced",
    workspace: null,
    sourcePath: "y",
  },
];

test("aggregate by agent sorts by cost", () => {
  const r = aggregate(sample, "agent", "cost");
  assert.equal(r.groups[0].key, "grok");
  assert.equal(r.totals.totalTokens, 3600);
  assert.ok(Math.abs(r.totals.estimatedCost - 1.7) < 1e-9);
});
