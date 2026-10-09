import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregate } from "../src/aggregate.js";
import type { UsageEvent } from "../src/types.js";

function ev(id: string, agent: string, cacheRead: number, cacheReported?: boolean): UsageEvent {
  return {
    id, agent, model: "claude-fable-5", timestamp: "2026-10-09T01:00:00.000Z",
    inputTokens: 100, outputTokens: 10, cacheReadTokens: cacheRead, cacheWriteTokens: 0,
    totalTokens: 100 + 10 + cacheRead, estimatedCost: 0.01, currency: "USD",
    pricingStatus: "priced", workspace: null, sourcePath: "x",
    ...(cacheReported === undefined ? {} : { cacheReported }),
  };
}

test("cacheReportedEvents counts only rows that actually reported cache", () => {
  const r = aggregate([
    ev("a", "dsh", 500, true),   // measured
    ev("b", "dsh", 0, true),     // measured zero
    ev("c", "dsh", 300),         // untouched -> never reported
  ], "agent", "cost");
  const row = r.groups.find((g) => g.key === "dsh")!;
  assert.equal(row.cacheReportedEvents, 2, "only the two flagged rows count");
  assert.equal(row.cacheReadTokens, 800);

  // A group whose rows never mentioned caching stays at 0, so the UI keeps "—".
  const r2 = aggregate([ev("d", "litellm", 0), ev("e", "litellm", 0)], "agent", "cost");
  assert.equal(r2.groups.find((g) => g.key === "litellm")!.cacheReportedEvents, undefined);
});

test("cacheReportedEvents is absent (not zero) when nothing reported cache", () => {
  const r = aggregate([ev("f", "grok", 0)], "agent", "cost");
  const row = r.groups.find((g) => g.key === "grok")!;
  assert.ok(!row.cacheReportedEvents, "must stay unset so the dashboard renders an em dash");
});
