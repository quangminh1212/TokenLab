import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { pathExists } from "../../util.js";
import { parseRouterUsage } from "./router-usage.js";
import { nineRouterRoots } from "../9router/index.js";
import { xlabRouterRoots } from "../xlabrouter/index.js";

describe("router usage parsers", () => {
  it("discovers at least one 9router root with data on this machine (or skips)", async () => {
    const roots: string[] = [];
    for (const r of nineRouterRoots()) {
      if (await pathExists(r)) roots.push(r);
    }
    if (roots.length === 0) {
      // No local/VPS mirror — still valid on a clean machine
      assert.ok(nineRouterRoots().length >= 3);
      return;
    }
    const events = await parseRouterUsage(roots, "9router");
    // When VPS mirror is present we expect many events
    if (roots.some((r) => r.includes("9router") && (r.includes("data") || r.includes("mirrors")))) {
      assert.ok(events.length > 0, `expected events from ${roots.join(", ")}`);
      const e = events[0];
      assert.equal(e.agent, "9router");
      assert.ok(e.inputTokens + e.outputTokens > 0);
      assert.ok(e.timestamp);
    }
  });

  it("xlabrouter roots resolve without throw", async () => {
    const roots = xlabRouterRoots().filter(Boolean);
    assert.ok(roots.length >= 3);
    const existing: string[] = [];
    for (const r of roots) {
      if (await pathExists(r)) existing.push(r);
    }
    const events = await parseRouterUsage(existing, "xlabrouter");
    assert.ok(Array.isArray(events));
    // Local AppData xlabrouter often has empty history — zero is OK
    for (const e of events) {
      assert.equal(e.agent, "xlabrouter");
    }
  });

  it("parses a synthetic history row via export file", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-router-"));
    try {
      await writeFile(
        path.join(dir, "usage-history.jsonl"),
        JSON.stringify({
          id: 1,
          timestamp: "2026-07-01T12:00:00.000Z",
          provider: "xai",
          model: "grok-4-fast",
          promptTokens: 100,
          completionTokens: 20,
          cost: 0.0123,
          tokens: JSON.stringify({ prompt_tokens: 100, completion_tokens: 20 }),
        }) + "\n",
        "utf8",
      );
      const events = await parseRouterUsage([dir], "9router");
      assert.equal(events.length, 1);
      assert.equal(events[0].inputTokens, 100);
      assert.equal(events[0].outputTokens, 20);
      assert.equal(events[0].estimatedCost, 0.0123);
      assert.equal(events[0].model, "grok-4-fast");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
