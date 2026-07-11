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
    assert.ok(roots.some((r) => r.includes("xlabrouter") || r.includes("var")));
    const existing: string[] = [];
    for (const r of roots) {
      if (await pathExists(r)) existing.push(r);
    }
    const events = await parseRouterUsage(existing, "xlabrouter");
    assert.ok(Array.isArray(events));
    for (const e of events) {
      assert.equal(e.agent, "xlabrouter");
    }
    // When VPS mirror is present, dailySummary gap-fill should yield many events
    if (existing.some((r) => r.includes("mirrors") || r.includes(`${"xlabrouter"}\\data`) || r.includes("xlabrouter/data"))) {
      assert.ok(events.length > 0, `expected xlabrouter events from ${existing.join(", ")}`);
    }
  });

  it("reconciles sparse history against dailySummary", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-xlabrouter-"));
    try {
      await writeFile(
        path.join(dir, "db.json"),
        JSON.stringify({
          usageData: {
            history: [
              {
                id: "h1",
                timestamp: "2026-06-29T10:00:00.000Z",
                model: "gpt-5.5",
                provider: "x",
                tokens: { prompt_tokens: 10, completion_tokens: 2 },
                cost: 0.01,
              },
            ],
            totalRequestsLifetime: 1000,
            dailySummary: {
              "2026-06-28": {
                requests: 100,
                promptTokens: 50000,
                completionTokens: 1000,
                cost: 12.5,
                byModel: {
                  "gpt-5.5|prov": {
                    requests: 100,
                    promptTokens: 50000,
                    completionTokens: 1000,
                    cost: 12.5,
                    rawModel: "gpt-5.5",
                    provider: "prov",
                  },
                },
              },
              "2026-06-29": {
                requests: 200,
                promptTokens: 90000,
                completionTokens: 2000,
                cost: 20,
                byModel: {
                  "gpt-5.5|prov": {
                    requests: 200,
                    promptTokens: 90000,
                    completionTokens: 2000,
                    cost: 20,
                    rawModel: "gpt-5.5",
                    provider: "prov",
                  },
                },
              },
            },
          },
        }),
        "utf8",
      );
      const events = await parseRouterUsage([dir], "xlabrouter");
      // 06-28 from daily; 06-29 sparse history (1 < 95% of 200) → use daily rollup
      assert.ok(events.some((e) => e.timestamp.startsWith("2026-06-28")));
      assert.ok(events.some((e) => e.timestamp.startsWith("2026-06-29")));
      const d28 = events.find((e) => e.timestamp.startsWith("2026-06-28"));
      assert.equal(d28?.inputTokens, 50000);
      assert.equal(d28?.estimatedCost, 12.5);
      const d29 = events.find((e) => e.timestamp.startsWith("2026-06-29"));
      assert.equal(d29?.inputTokens, 90000);
      assert.equal(d29?.estimatedCost, 20);
      assert.equal(events.filter((e) => e.timestamp.startsWith("2026-06-29")).length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parses a synthetic history row via export file", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-router-"));
    try {
      await writeFile(
        path.join(dir, "usage-history.jsonl"),
        [
          JSON.stringify({
            id: 1,
            timestamp: "2026-07-01T12:00:00.000Z",
            provider: "xai",
            model: "grok-4-fast",
            promptTokens: 100,
            completionTokens: 20,
            cost: 0.0123,
            tokens: JSON.stringify({ prompt_tokens: 100, completion_tokens: 20 }),
          }),
          // cost:0 falls back to rate table (not locked at $0)
          JSON.stringify({
            id: 2,
            timestamp: "2026-07-01T13:00:00.000Z",
            provider: "xai",
            model: "grok-4-fast",
            promptTokens: 50_000,
            completionTokens: 100,
            cost: 0,
            tokens: JSON.stringify({ prompt_tokens: 50000, completion_tokens: 100 }),
          }),
        ].join("\n") + "\n",
        "utf8",
      );
      const events = await parseRouterUsage([dir], "9router");
      assert.equal(events.length, 2);
      assert.equal(events[0].inputTokens, 100);
      assert.equal(events[0].outputTokens, 20);
      assert.equal(events[0].estimatedCost, 0.0123);
      assert.equal(events[0].model, "grok-4-fast");
      // 50k in + 100 out at grok-4-fast rates → positive table price
      assert.ok((events[1].estimatedCost || 0) > 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
