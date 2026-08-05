import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collapseSourcePathRollups,
  mergeEventsByIdPreferRicher,
  preferRicherEvent,
} from "../src/backup.ts";
import type { UsageEvent } from "../src/types.ts";

function ev(partial: Partial<UsageEvent> & Pick<UsageEvent, "id" | "agent">): UsageEvent {
  return {
    model: "grok-4.5",
    timestamp: "2026-08-05T04:00:00.000Z",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    estimated: false,
    ...partial,
  } as UsageEvent;
}

test("collapseSourcePathRollups drops ghost Grok residual out=0 when real usage exists", () => {
  const path = "C:/Users/x/.grok/sessions/demo/sess-1/updates.jsonl";
  const real = ev({
    id: "real-tc-1",
    agent: "grok",
    model: "grok-4.5-build",
    inputTokens: 4_500,
    outputTokens: 3_500,
    cacheReadTokens: 100_000,
    totalTokens: 108_000,
    estimated: false,
    sourcePath: path,
  });
  // Old unstable residual ids (peak baked into hash) — must not survive once real exists
  const ghost1 = ev({
    id: "residual-peak-210316",
    agent: "grok",
    model: "grok-4.5",
    inputTokens: 210_316,
    outputTokens: 0,
    totalTokens: 210_316,
    estimated: true,
    sourcePath: path,
  });
  const ghost2 = ev({
    id: "residual-peak-263573",
    agent: "grok",
    model: "grok-4.5",
    inputTokens: 263_573,
    outputTokens: 0,
    totalTokens: 263_573,
    estimated: true,
    sourcePath: path,
  });
  // Live residual with estimated output from chunks — keep (multi-turn in progress)
  const live = ev({
    id: "live-residual",
    agent: "grok",
    model: "grok-4.5",
    inputTokens: 50_000,
    outputTokens: 800,
    totalTokens: 50_800,
    estimated: true,
    sourcePath: path,
  });
  // Other session still only residual — keep (in progress, no real yet)
  const otherPath = "C:/Users/x/.grok/sessions/demo/sess-2/updates.jsonl";
  const otherOnly = ev({
    id: "other-residual",
    agent: "grok",
    model: "grok-4.5",
    inputTokens: 23_100,
    outputTokens: 0,
    totalTokens: 23_100,
    estimated: true,
    sourcePath: otherPath,
  });

  const out = collapseSourcePathRollups([real, ghost1, ghost2, live, otherOnly]);
  const ids = new Set(out.map((e) => e.id));
  assert.ok(ids.has("real-tc-1"));
  assert.ok(ids.has("live-residual"), "keep estimated residual with out>0");
  assert.ok(ids.has("other-residual"), "keep residual when path has no real usage");
  assert.ok(!ids.has("residual-peak-210316"));
  assert.ok(!ids.has("residual-peak-263573"));
});

test("prefer-richer: same id residual then real usage keeps real non-estimated", () => {
  const id = "shared-tc-id";
  const path = "C:/Users/x/.grok/sessions/demo/sess-3/updates.jsonl";
  const residual = ev({
    id,
    agent: "grok",
    model: "grok-4.5",
    inputTokens: 23_100,
    outputTokens: 100,
    totalTokens: 23_200,
    estimated: true,
    sourcePath: path,
  });
  const real = ev({
    id,
    agent: "grok",
    model: "grok-4.5-build",
    inputTokens: 25_000,
    outputTokens: 900,
    cacheReadTokens: 80_000,
    totalTokens: 105_900,
    estimated: false,
    sourcePath: path,
  });
  const merged = mergeEventsByIdPreferRicher([residual], [real]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.estimated, false);
  assert.equal(merged[0]!.outputTokens, 900);
  assert.equal(merged[0]!.model, "grok-4.5-build");
});

test("prefer-richer: residual heavier than real still keeps non-estimated real", () => {
  const id = "heavy-residual-vs-real";
  const path = "C:/Users/x/.grok/sessions/demo/sess-4/updates.jsonl";
  // Stream residual peak often >> uncached real input after cache split
  const residual = ev({
    id,
    agent: "grok",
    model: "grok-4.5",
    inputTokens: 263_573,
    outputTokens: 5_000,
    totalTokens: 268_573,
    estimated: true,
    estimatedCost: 9.99,
    sourcePath: path,
  });
  const real = ev({
    id,
    agent: "grok",
    model: "grok-4.5-build",
    inputTokens: 4_820,
    outputTokens: 3_415,
    cacheReadTokens: 1_040_256,
    totalTokens: 1_048_491,
    estimated: false,
    estimatedCost: 0.15,
    routerCost: 0.12,
    sourcePath: path,
  });
  // Either merge order — real must win despite residual-looking weight when comparing
  // only uncached+out without cache (simulate weight trap via totalTokens on residual)
  const residualTrap = {
    ...residual,
    // force weight > real by stuffing totalTokens only on residual view
    totalTokens: 9_999_999,
    inputTokens: 9_999_999,
  };
  const a = preferRicherEvent(residualTrap as UsageEvent, real);
  const b = preferRicherEvent(real, residualTrap as UsageEvent);
  assert.equal(a.estimated, false, "real wins when next is real");
  assert.equal(b.estimated, false, "real wins when prev is real");
  assert.equal(a.outputTokens, 3_415);
  assert.equal(b.outputTokens, 3_415);
  assert.equal(a.model, "grok-4.5-build");

  // collapse must not drop the real row when a heavier est out=0 also exists
  const ghostOut0 = ev({
    id: "ghost-other-id",
    agent: "grok",
    model: "grok-4.5",
    inputTokens: 200_000,
    outputTokens: 0,
    totalTokens: 200_000,
    estimated: true,
    sourcePath: path,
  });
  const collapsed = collapseSourcePathRollups([residualTrap as UsageEvent, real, ghostOut0]);
  const byId = new Map(collapsed.map((e) => [e.id, e]));
  assert.ok(byId.has(id), "real usage id must survive collapse");
  assert.equal(byId.get(id)!.estimated, false);
  assert.equal(byId.get(id)!.outputTokens, 3_415);
  assert.ok(!byId.has("ghost-other-id"), "ghost out=0 dropped");
});
