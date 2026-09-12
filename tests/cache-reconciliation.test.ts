import assert from "node:assert/strict";
import { test } from "node:test";
import {
  replaceFreshAgentSessionEvents,
  replaceFreshAgentSourceEvents,
} from "../src/backup.ts";
import type { UsageEvent } from "../src/types.ts";

function event(partial: Partial<UsageEvent> & Pick<UsageEvent, "id" | "sourcePath">): UsageEvent {
  return {
    agent: "claude-code",
    model: "openclaw",
    timestamp: "2026-09-13T01:00:00.000Z",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    estimatedCost: 0,
    currency: "USD",
    pricingStatus: "priced",
    workspace: "C--Dev-Demo",
    estimated: false,
    ...partial,
  };
}

test("fresh Claude source rows replace legacy per-content-block cache rows", () => {
  const source = "C:/Users/GHC/.claude/projects/C--Dev-Demo/session.jsonl";
  const oldBlock1 = event({
    id: "legacy-block-1",
    sourcePath: source,
    inputTokens: 100,
    totalTokens: 100,
  });
  const oldBlock2 = event({
    id: "legacy-block-2",
    sourcePath: source,
    inputTokens: 100,
    totalTokens: 100,
  });
  const oldOtherFile = event({
    id: "other-file",
    sourcePath: "C:/Users/GHC/.claude/projects/C--Dev-Demo/other.jsonl",
    inputTokens: 50,
    totalTokens: 50,
  });
  const fresh = event({
    id: "stable-request-id",
    sourcePath: source,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
  });

  const out = replaceFreshAgentSourceEvents(
    [fresh],
    [oldBlock1, oldBlock2, oldOtherFile],
    "claude-code",
  );
  assert.equal(out.filter((row) => row.sourcePath === source).length, 1);
  assert.ok(out.some((row) => row.id === "stable-request-id"));
  assert.ok(out.some((row) => row.id === "other-file"));
  assert.ok(!out.some((row) => row.id === "legacy-block-1"));
  assert.ok(!out.some((row) => row.id === "legacy-block-2"));
});

test("fresh Grok updates replace a persisted usage fallback for the same session", () => {
  const usagePath = "C:/Users/GHC/.grok/sessions/proj/sess-1/usage.json";
  const updatesPath = "C:/Users/GHC/.grok/sessions/proj/sess-1/updates.jsonl";
  const oldPersisted = event({
    id: "persisted-turn-1",
    agent: "grok",
    sourcePath: usagePath,
    inputTokens: 100,
    outputTokens: 10,
    totalTokens: 110,
  });
  const freshUpdate = event({
    id: "update-turn-1",
    agent: "grok",
    sourcePath: updatesPath,
    inputTokens: 100,
    outputTokens: 10,
    totalTokens: 110,
  });

  const out = replaceFreshAgentSessionEvents([freshUpdate], [oldPersisted], "grok");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.id, "update-turn-1");
});
