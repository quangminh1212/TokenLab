import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { pathExists } from "../src/util.js";
import { parseRouterUsage } from "../src/agents/shared/router-usage.js";
import { nineRouterRoots } from "../src/agents/9router/index.js";
import { xlabRouterRoots } from "../src/agents/xlabrouter/index.js";

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
    assert.ok(
      roots.some((r) => r.includes("routerlab") || r.includes("xlabrouter") || r.includes("var")),
    );
    const existing: string[] = [];
    for (const r of roots) {
      if (await pathExists(r)) existing.push(r);
    }
    const events = await parseRouterUsage(existing, "routerlab");
    assert.ok(Array.isArray(events));
    for (const e of events) {
      assert.equal(e.agent, "routerlab");
    }
    // When VPS mirror is present, dailySummary gap-fill should yield many events
    if (
      existing.some(
        (r) =>
          r.includes("mirrors") ||
          r.includes("routerlab\\data") ||
          r.includes("xlabrouter\\data") ||
          r.includes("xlabrouter/data") ||
          r.includes("routerlab/data"),
      )
    ) {
      assert.ok(events.length > 0, `expected routerlab events from ${existing.join(", ")}`);
    }
  });

  it("daily rollup ids stay stable when token totals grow", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-router-stable-"));
    try {
      const writeDaily = async (prompt: number, cost: number) => {
        await writeFile(
          path.join(dir, "usage-daily.json"),
          JSON.stringify({
            "2026-07-16": {
              requests: 10,
              promptTokens: prompt,
              completionTokens: 100,
              cost,
            },
          }),
          "utf8",
        );
      };
      await writeDaily(1_000, 1);
      const first = await parseRouterUsage([dir], "routerlab");
      assert.equal(first.length, 1);
      const id1 = first[0]!.id;
      await writeDaily(50_000, 20);
      const second = await parseRouterUsage([dir], "routerlab");
      assert.equal(second.length, 1);
      assert.equal(second[0]!.id, id1, "same day rollup must keep stable id");
      assert.equal(second[0]!.inputTokens, 50_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
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
      const events = await parseRouterUsage([dir], "routerlab");
      // 06-28 from daily; 06-29 sparse history (1 RQ) → still daily rollup
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

  it("requestCount on daily rollups sums to daily.requests (not 1 per model row)", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { aggregate } = await import("../src/aggregate.js");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-router-reqcount-"));
    try {
      await writeFile(
        path.join(dir, "usage-daily.json"),
        JSON.stringify({
          "2026-07-27": {
            requests: 100,
            promptTokens: 1_000_000,
            completionTokens: 10_000,
            cost: 5,
            byModel: {
              "gpt-5.6-sol|p": {
                requests: 90,
                promptTokens: 900_000,
                completionTokens: 9_000,
                cost: 4.5,
                rawModel: "gpt-5.6-sol",
                provider: "p",
              },
              "qwen3.7-max|p": {
                requests: 10,
                promptTokens: 100_000,
                completionTokens: 1_000,
                cost: 0.5,
                rawModel: "qwen3.7-max",
                provider: "p",
              },
            },
          },
        }),
        "utf8",
      );
      const events = await parseRouterUsage([dir], "9router");
      assert.equal(events.length, 2);
      assert.equal(events.find((e) => e.model === "gpt-5.6-sol")?.requestCount, 90);
      assert.equal(events.find((e) => e.model === "qwen3.7-max")?.requestCount, 10);
      const stats = aggregate(events, "model", "cost");
      assert.equal(stats.totals.eventCount, 100, "TOTAL REQUESTS must be sum of model.requests");
      assert.equal(stats.groups.find((g) => g.key === "gpt-5.6-sol")?.eventCount, 90);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gap-fills models missing from partial history via daily byModel", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-router-gapfill-"));
    try {
      const history = Array.from({ length: 30 }, (_, i) => ({
        id: `rq-sol-${i}`,
        timestamp: `2026-07-26T12:${String(i).padStart(2, "0")}:00.000Z`,
        provider: "openai-compatible",
        model: "gpt-5.6-sol",
        promptTokens: 10_000,
        completionTokens: 100,
        cost: 0.05,
        tokens: { prompt_tokens: 10_000, completion_tokens: 100 },
      }));
      await writeFile(
        path.join(dir, "request-details.jsonl"),
        history.map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf8",
      );
      await writeFile(
        path.join(dir, "usage-daily.json"),
        JSON.stringify({
          "2026-07-26": {
            requests: 35,
            promptTokens: 350_000,
            completionTokens: 3_500,
            cost: 2.0,
            byModel: {
              "gpt-5.6-sol|p": {
                requests: 30,
                promptTokens: 300_000,
                completionTokens: 3_000,
                cost: 1.5,
                rawModel: "gpt-5.6-sol",
                provider: "p",
              },
              "qwen3.7-max|p": {
                requests: 4,
                promptTokens: 40_000,
                completionTokens: 400,
                cost: 0.4,
                rawModel: "qwen3.7-max",
                provider: "p",
              },
              "minimax-m3|p": {
                requests: 1,
                promptTokens: 10_000,
                completionTokens: 100,
                cost: 0.1,
                rawModel: "minimax-m3",
                provider: "p",
              },
            },
          },
        }),
        "utf8",
      );
      const events = await parseRouterUsage([dir], "9router");
      // Substantial daily (≥20 req, ≥10k tok) is VPS dashboard authority —
      // emit byModel rollups, not partial history tails.
      const models = new Set(events.map((e) => e.model));
      assert.ok(models.has("gpt-5.6-sol"));
      assert.ok(models.has("qwen3.7-max"));
      assert.ok(models.has("minimax-m3"));
      assert.ok(events.every((e) => e.estimated), "daily rollups are estimated");
      const reqSum = events.reduce(
        (a, e) => a + (typeof e.requestCount === "number" && e.requestCount > 0 ? e.requestCount : 1),
        0,
      );
      assert.equal(reqSum, 35);
      const tok = events.reduce(
        (a, e) => a + (e.inputTokens || 0) + (e.outputTokens || 0),
        0,
      );
      assert.equal(tok, 353_500);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses dailySummary as day authority when history would under/over count", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-router-split-"));
    try {
      const history = Array.from({ length: 25 }, (_, i) => ({
        id: `rq-${i}`,
        timestamp: `2026-07-26T10:${String(i).padStart(2, "0")}:00.000Z`,
        provider: "qwencoder",
        model: "grok-4.5",
        promptTokens: 100_000 + i,
        completionTokens: 50 + i,
        cost: 0.05,
        tokens: { prompt_tokens: 100_000 + i, completion_tokens: 50 + i },
      }));
      await writeFile(
        path.join(dir, "request-details.jsonl"),
        history.map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf8",
      );
      await writeFile(
        path.join(dir, "usage-daily.json"),
        JSON.stringify({
          "2026-07-26": {
            requests: 99,
            promptTokens: 5_216_191,
            completionTokens: 23_766,
            cost: 10,
            byModel: {
              "grok-4.5|qwencoder": {
                requests: 99,
                promptTokens: 5_216_191,
                completionTokens: 23_766,
                cost: 10,
                rawModel: "grok-4.5",
                provider: "qwencoder",
              },
            },
          },
        }),
        "utf8",
      );
      const events = await parseRouterUsage([dir], "routerlab");
      // Daily authority: one rollup with full 99 requests / 5.2M tokens (matches VPS)
      assert.ok(events.every((e) => e.estimated));
      assert.ok(events.every((e) => e.model === "grok-4.5"));
      const reqSum = events.reduce(
        (a, e) => a + (typeof e.requestCount === "number" && e.requestCount > 0 ? e.requestCount : 1),
        0,
      );
      assert.equal(reqSum, 99);
      const inTok = events.reduce((a, e) => a + (e.inputTokens || 0), 0);
      assert.equal(inTok, 5_216_191);
      const cost = events.reduce((a, e) => a + (e.estimatedCost || 0), 0);
      assert.equal(cost, 10);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not double-count twin history exports", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-router-twin-"));
    try {
      const row = {
        timestamp: "2026-07-26T10:00:00.000Z",
        provider: "xai",
        model: "grok-4.5",
        promptTokens: 1000,
        completionTokens: 20,
        cost: 0.01,
        tokens: { prompt_tokens: 1000, completion_tokens: 20 },
      };
      await writeFile(
        path.join(dir, "request-details.jsonl"),
        JSON.stringify({
          id: "native-1",
          ...row,
          tokens: { prompt_tokens: 1000, completion_tokens: 20, cached_tokens: 800 },
        }) + "\n",
        "utf8",
      );
      // Twin without id / cache — same logical RQ (also 1ms drift)
      await writeFile(
        path.join(dir, "db.json"),
        JSON.stringify({
          usageData: {
            history: [
              {
                ...row,
                timestamp: "2026-07-26T10:00:00.001Z",
              },
            ],
          },
        }),
        "utf8",
      );
      const events = await parseRouterUsage([dir], "routerlab");
      assert.equal(events.length, 1);
      assert.equal(events[0]!.inputTokens, 1000);
      // Prefer richer twin with cache read
      assert.equal(events[0]!.cacheReadTokens, 800);
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

  it("stamps daily rollups with real last-request time (not future noon UTC)", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-router-daily-ts-"));
    try {
      // Use "today" so noon UTC may still be in the future (the original bug)
      const today = new Date().toISOString().slice(0, 10);
      const lastSeen = `${today}T01:15:00.000Z`;
      await writeFile(
        path.join(dir, "usage-daily.json"),
        JSON.stringify([
          {
            dateKey: today,
            data: {
              requests: 10,
              promptTokens: 1_000_000,
              completionTokens: 5_000,
              cost: 1.5,
              byModel: {
                "big-pickle|soa": {
                  requests: 10,
                  promptTokens: 1_000_000,
                  completionTokens: 5_000,
                  cost: 1.5,
                  rawModel: "big-pickle",
                  provider: "soa",
                },
              },
            },
          },
        ]),
        "utf8",
      );
      // Tiny history tail with real last-seen time for big-pickle
      await writeFile(
        path.join(dir, "usage-history.jsonl"),
        JSON.stringify({
          id: 99,
          timestamp: lastSeen,
          model: "big-pickle",
          promptTokens: 1000,
          completionTokens: 10,
          cost: 0.01,
          tokens: JSON.stringify({ prompt_tokens: 1000, completion_tokens: 10 }),
        }) + "\n",
        "utf8",
      );
      const events = await parseRouterUsage([dir], "9router");
      const pickle = events.find((e) => e.model === "big-pickle");
      assert.ok(pickle, "expected big-pickle daily event");
      assert.equal(pickle.inputTokens, 1_000_000);
      // Must use real last request time, not future noon / wall-clock now
      assert.equal(pickle.timestamp, new Date(lastSeen).toISOString());
      const mins = Math.floor((Date.now() - new Date(pickle.timestamp).getTime()) / 60000);
      assert.ok(mins >= 0, `timestamp must not be in the future (mins=${mins})`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("daily without history never invents a future noon-UTC timestamp", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-router-daily-nofuture-"));
    try {
      const today = new Date().toISOString().slice(0, 10);
      await writeFile(
        path.join(dir, "usage-daily.json"),
        JSON.stringify({
          [today]: {
            requests: 3,
            promptTokens: 5000,
            completionTokens: 100,
            cost: 0.5,
            byModel: {
              "big-pickle|x": {
                requests: 3,
                promptTokens: 5000,
                completionTokens: 100,
                cost: 0.5,
                rawModel: "big-pickle",
              },
            },
          },
        }),
        "utf8",
      );
      const events = await parseRouterUsage([dir], "9router");
      const pickle = events.find((e) => e.model === "big-pickle");
      assert.ok(pickle);
      const t = new Date(pickle!.timestamp).getTime();
      assert.ok(Number.isFinite(t));
      assert.ok(t <= Date.now() + 1000, `daily ts must not be in the future: ${pickle!.timestamp}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
