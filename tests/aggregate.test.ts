import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregate } from "../src/aggregate.js";
import type { UsageEvent } from "../src/types.js";

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

test("aggregate by model merges names with provider parentheses", () => {
  const events: UsageEvent[] = [
    {
      ...sample[0],
      id: "a",
      model: "gpt-5.5 (openai-compatible-responses-edd706dd-4c64-4148-ba97-f5bddf8c0cfc)",
      totalTokens: 100,
      estimatedCost: 1,
      inputTokens: 80,
      outputTokens: 20,
    },
    {
      ...sample[0],
      id: "b",
      model: "gpt-5.5|openai-compatible-chat-aa9b60d1",
      totalTokens: 50,
      estimatedCost: 0.5,
      inputTokens: 40,
      outputTokens: 10,
    },
    {
      ...sample[0],
      id: "c",
      model: "gpt-5.5",
      totalTokens: 30,
      estimatedCost: 0.3,
      inputTokens: 20,
      outputTokens: 10,
    },
  ];
  const r = aggregate(events, "model", "cost");
  const gpt = r.groups.find((g) => g.key === "gpt-5.5");
  assert.ok(gpt, `expected gpt-5.5 group, got ${r.groups.map((g) => g.key).join(",")}`);
  assert.equal(gpt.eventCount, 3);
  assert.equal(gpt.totalTokens, 180);
  assert.ok(Math.abs(gpt.estimatedCost - 1.8) < 1e-9);
});
