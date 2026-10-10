import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { mkdtemp as mkTmp, writeFile as wrFile, rm as rmDir } from "node:fs/promises";
import { tmpdir as tmpOs } from "node:os";
import { pathExists } from "../src/util.js";
import { parseRouterUsage } from "../src/agents/shared/router-usage.js";
import { nineRouterRoots } from "../src/agents/9router/index.js";
import { xlabRouterRoots } from "../src/agents/xlabrouter/index.js";
import { liteLlmRoots } from "../src/agents/litellm/index.js";

/**
 * Run a parser case with a throwaway config so pricing is deterministic and does
 * not depend on the developer's own %APPDATA%/tokenlab/config.json.
 * `preferRouterCost: false` makes token counts come from the router while every
 * price comes from `customRates` — the behaviour TokenLab ships with.
 */
async function withConfig<T>(
  pricing: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const dir = await mkTmp(path.join(tmpOs(), "xlab-cfg-"));
  const prev = process.env.TOKENLAB_CONFIG;
  process.env.TOKENLAB_CONFIG = path.join(dir, "config.json");
  try {
    await wrFile(
      process.env.TOKENLAB_CONFIG,
      JSON.stringify({ pricing: { currency: "USD", preferRouterCost: false, ...pricing } }),
      "utf8",
    );
    const { loadConfig, resetConfigCache } = await import("../src/config.js");
    resetConfigCache();
    await loadConfig();
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.TOKENLAB_CONFIG;
    else process.env.TOKENLAB_CONFIG = prev;
    const { resetConfigCache } = await import("../src/config.js");
    resetConfigCache();
    await rmDir(dir, { recursive: true, force: true });
  }
}

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

  it("litellm roots resolve and parse mirror when present", async () => {
    const roots = liteLlmRoots().filter(Boolean);
    assert.ok(roots.length >= 2);
    assert.ok(roots.some((r) => r.includes("litellm")));
    const existing: string[] = [];
    for (const r of roots) {
      if (await pathExists(r)) existing.push(r);
    }
    const events = await parseRouterUsage(existing, "litellm");
    assert.ok(Array.isArray(events));
    for (const e of events) {
      assert.equal(e.agent, "litellm");
    }
    if (
      existing.some(
        (r) =>
          r.includes("mirrors") ||
          r.includes("litellm\\data") ||
          r.includes("litellm/data"),
      )
    ) {
      // After VPS sync, mirror should yield events
      // (skip hard assert when mirror empty / machine never synced)
      if (events.length > 0) {
        assert.ok(events[0]!.inputTokens + events[0]!.outputTokens > 0);
      }
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
      // History is the single source for any day it covers, even a sparse one:
      // no daily rollup is added on top. Days with no history at all fall back
      // to their dailySummary row.
      assert.ok(events.some((e) => e.timestamp.startsWith("2026-06-28")));
      assert.ok(events.some((e) => e.timestamp.startsWith("2026-06-29")));
      const d28 = events.find((e) => e.timestamp.startsWith("2026-06-28"));
      assert.equal(d28?.inputTokens, 50000);
      assert.equal(d28?.estimatedCost, 12.5);
      // 06-29 has a real request row → that row is kept verbatim, and the
      // dailySummary entry for the same day must NOT be added as well.
      const d29 = events.filter((e) => e.timestamp.startsWith("2026-06-29"));
      assert.equal(d29.length, 1, `expected exactly the history row, got ${d29.length}`);
      assert.equal(d29[0]?.inputTokens, 10, "history tokens must be kept as-is");
      assert.ok(
        !d29.some((e) => e.estimated && e.inputTokens === 90000),
        "the dailySummary rollup for a history-covered day must not also be emitted",
      );
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

  it("history wins for a day it covers, so no daily rollup is added on top", async () => {
    // History and daily rollups are two views of one day. Adding the rollup on
    // top of the requests double counted whole days on the live mirror (2.004x).
    // The rule now: if a day has any request rows, they ARE the day.
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
      // Only the real request rows survive — the daily rollup for the same day
      // must NOT also be emitted, and neither must the models that appear only
      // in the unused rollup.
      const models = new Set(events.map((e) => e.model));
      assert.deepEqual([...models], ["gpt-5.6-sol"]);
      assert.equal(events.length, 30);
      assert.ok(events.every((e) => !e.estimated), "request rows are not estimated");
      const reqSum = events.reduce(
        (a, e) => a + (typeof e.requestCount === "number" && e.requestCount > 0 ? e.requestCount : 1),
        0,
      );
      assert.equal(reqSum, 30);
      const tok = events.reduce((a, e) => a + (e.inputTokens || 0) + (e.outputTokens || 0), 0);
      assert.equal(tok, 30 * 10_100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prefers near-complete history so local Today sees post-noon UTC requests (LiteLLM)", async () => {
    // Daily stamp at noon UTC falls into "yesterday" for UTC+7 after local midnight.
    // When SpendLogs history covers ~all tokens, keep individual RQs (real timestamps).
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { filterByPeriod } = await import("../src/util.js");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-litellm-today-"));
    try {
      const n = 50;
      const history = Array.from({ length: n }, (_, i) => {
        const mm = String(Math.floor(i / 60)).padStart(2, "0");
        const ss = String(i % 60).padStart(2, "0");
        // Mix: morning UTC + post-17:00Z (local next morning UTC+7)
        const hour = i < 40 ? 10 : 17;
        return {
          id: `ll-${i}`,
          timestamp: `2026-07-29T${String(hour).padStart(2, "0")}:${mm}:${ss}.000Z`,
          model: "openai/Kimi-k3",
          provider: "openai",
          promptTokens: 1000,
          completionTokens: 10,
          cost: 0.01,
          tokens: { prompt_tokens: 1000, completion_tokens: 10 },
        };
      });
      await writeFile(
        path.join(dir, "usage-history.jsonl"),
        history.map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf8",
      );
      await writeFile(
        path.join(dir, "usage-daily.json"),
        JSON.stringify({
          "2026-07-29": {
            requests: n,
            promptTokens: n * 1000,
            completionTokens: n * 10,
            cost: n * 0.01,
            byModel: {
              "openai/Kimi-k3|openai": {
                requests: n,
                promptTokens: n * 1000,
                completionTokens: n * 10,
                cost: n * 0.01,
                rawModel: "openai/Kimi-k3",
                provider: "openai",
              },
            },
          },
        }),
        "utf8",
      );
      const events = await parseRouterUsage([dir], "litellm");
      assert.ok(events.length >= n * 0.9, `expected ~${n} RQs, got ${events.length}`);
      // Near-complete history must be kept as individual requests (real
      // timestamps), not collapsed into one daily blob. The day-level cost row is
      // always estimated by design, so count the rows that carry real tokens.
      assert.ok(
        events.filter((e) => e.totalTokens > 0).length >= n * 0.9,
        "near-complete history should not collapse to daily rollups only",
      );
      // Local Today starting 17:00Z (UTC+7 midnight) must include post-noon spill RQs
      const todayStart = "2026-07-29T17:00:00.000Z";
      const inToday = filterByPeriod(events, todayStart, null, "UTC");
      assert.ok(
        inToday.length >= 8,
        `expected post-17:00Z RQs in local Today, got ${inToday.length}`,
      );
      // Cost still comes from the router's daily total, exactly once.
      const cost = events.reduce((a, e) => a + (e.estimatedCost || 0), 0);
      assert.ok(
        Math.abs(cost - n * 0.01) < 0.01,
        `day cost must equal the router daily total ${(n * 0.01).toFixed(2)}, got ${cost}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses LiteLLM model_group and maps legacy OpenClaw rows to glm-5.3", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-litellm-model-group-"));
    try {
      const rows = [
        {
          id: "grouped",
          timestamp: "2026-08-01T10:00:00.000Z",
          model: "openai/openclaw",
          model_group: "glm-5.3",
          provider: "openai",
          promptTokens: 100,
          completionTokens: 20,
          cost: 0.01,
          tokens: { prompt_tokens: 100, completion_tokens: 20 },
        },
        {
          id: "legacy",
          timestamp: "2026-08-01T10:01:00.000Z",
          model: "openclaw",
          provider: "openai",
          promptTokens: 80,
          completionTokens: 10,
          cost: 0.01,
          tokens: { prompt_tokens: 80, completion_tokens: 10 },
        },
      ];
      await writeFile(
        path.join(dir, "usage-history.jsonl"),
        rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf8",
      );
      const events = await parseRouterUsage([dir], "litellm");
      assert.equal(events.length, 2);
      assert.ok(events.every((e) => e.model === "glm-5.3"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not stamp yesterday daily rollup into next local morning (Today leak)", async () => {
    // Reproduce: history spill at 17:12Z (00:12 UTC+7 next day) must NOT pull
    // the full previous UTC-day daily ($448-class) into TokenLab "Today".
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { filterByPeriod } = await import("../src/util.js");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-router-today-leak-"));
    try {
      // A few early-next-local-day rows still bucketed under UTC dateKey 2026-07-27
      const history = Array.from({ length: 7 }, (_, i) => ({
        id: `spill-${i}`,
        timestamp: `2026-07-27T17:${String(10 + i).padStart(2, "0")}:00.000Z`,
        provider: "openai-compatible",
        model: "qwen3.7-max",
        promptTokens: 1000,
        completionTokens: 10,
        cost: 0.01,
        tokens: { prompt_tokens: 1000, completion_tokens: 10 },
      }));
      await writeFile(
        path.join(dir, "usage-history.jsonl"),
        history.map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf8",
      );
      await writeFile(
        path.join(dir, "usage-daily.json"),
        JSON.stringify({
          "2026-07-27": {
            requests: 9733,
            promptTokens: 815_566_524,
            completionTokens: 9_879_812,
            cost: 448.3367,
            byModel: {
              "qwen3.7-max|p": {
                requests: 9733,
                promptTokens: 815_566_524,
                completionTokens: 9_879_812,
                cost: 448.3367,
                rawModel: "qwen3.7-max",
                provider: "p",
              },
            },
          },
        }),
        "utf8",
      );
      const events = await parseRouterUsage([dir], "9router");
      // History covers this day, so it IS the day — no rollup is synthesised.
      // That is strictly safer for the leak being guarded here: a synthetic
      // rollup stamped at dateKey noon would land in the previous local day.
      assert.ok(
        events.every((e) => !e.estimated),
        "a history-covered day must not also produce a daily rollup",
      );
      assert.equal(events.length, 7);
      for (const e of events) {
        assert.equal(e.timestamp.slice(0, 10), "2026-07-27");
      }
      // Local "today" starting 17:00Z 2026-07-27 (UTC+7 midnight Jul 28) must NOT
      // include the $448 prior-day rollup.
      const todayStart = "2026-07-27T17:00:00.000Z";
      const inToday = filterByPeriod(events, todayStart, null, "UTC");
      const todayCost = inToday.reduce((a, e) => a + (Number(e.estimatedCost) || 0), 0);
      assert.ok(
        todayCost < 1,
        `yesterday daily must not leak into local today (cost=${todayCost})`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a history-covered day instead of replacing it with dailySummary", async () => {
    // A day with real request rows is taken as-is, even when dailySummary
    // reports more (here 99 req vs the 25 rows the mirror holds). Mixing the two
    // views is what produced 2.004x days on the live LiteLLM mirror.
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
      assert.equal(events.length, 25, "the 25 request rows must be kept as-is");
      assert.ok(events.every((e) => !e.estimated), "no synthesised rollup alongside real rows");
      assert.ok(events.every((e) => e.model === "grok-4.5"));
      const inTok = events.reduce((a, e) => a + (e.inputTokens || 0), 0);
      const expectedIn = history.reduce((a, r) => a + r.promptTokens, 0);
      assert.equal(inTok, expectedIn);
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

  it("keeps history cache as reported, without merging daily cachedTokens", async () => {
    // Trade-off made deliberately: history is the single source for a day it
    // covers, so a cache count that only dailySummary knows is NOT merged in.
    // Mixing the two views is what double counted whole days (2.004x on the live
    // mirror), and cache tokens are excluded from totalTokens anyway — they only
    // affect the (cheaper) cache-read rate.
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-router-cache-gap-"));
    try {
      const day = "2026-07-20";
      // History covers I/O + requests but reports 0 cache
      await writeFile(
        path.join(dir, "usage-history.jsonl"),
        JSON.stringify({
          id: "h1",
          timestamp: `${day}T10:00:00.000Z`,
          model: "gpt-5.6-sol",
          provider: "openai",
          promptTokens: 100_000,
          completionTokens: 200,
          cost: 1.0,
          tokens: { prompt_tokens: 100_000, completion_tokens: 200 },
        }) + "\n",
        "utf8",
      );
      // Daily byModel has the cache hit that history omitted
      await writeFile(
        path.join(dir, "usage-daily.json"),
        JSON.stringify({
          [day]: {
            requests: 1,
            promptTokens: 100_000,
            completionTokens: 200,
            cachedTokens: 80_000,
            cost: 1.0,
            byModel: {
              "gpt-5.6-sol|openai": {
                requests: 1,
                promptTokens: 100_000,
                completionTokens: 200,
                cachedTokens: 80_000,
                cost: 1.0,
                rawModel: "gpt-5.6-sol",
                provider: "openai",
              },
            },
          },
        }),
        "utf8",
      );
      const events = await parseRouterUsage([dir], "litellm");
      assert.equal(events.length, 1, "history row is kept, no rollup alongside it");
      assert.equal(events[0]!.inputTokens, 100_000);
      assert.equal(events[0]!.outputTokens, 200);
      // Cache is exactly what history reported (nothing here), never daily's.
      assert.equal(events[0]!.cacheReadTokens, 0);
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
      // History is the single source for a day it covers, so this test omits it:
      // it asserts the daily rollup path, which is used only for days with no
      // per-request rows at all.
      const events = await parseRouterUsage([dir], "9router");
      const pickle = events.find((e) => e.model === "big-pickle");
      assert.ok(pickle, "expected big-pickle daily event");
      assert.equal(pickle.inputTokens, 1_000_000);
      // Must use the real last-request time, not future noon / wall-clock now.
      // The rollup may carry no explicit lastSeen, so accept a same-day stamp.
      assert.ok(
        pickle.timestamp.startsWith(today),
        `daily ts must stay on ${today}, got ${pickle.timestamp}`,
      );
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

  it("prices history rows from the rate table, never from the router's own cost", async () => {
    // LiteLLM mirrors carry a `cost` field produced by LiteLLM's own catalogue.
    // TokenLab deliberately ignores it: tokens come from the router, prices come
    // from the local rate table / customRates. This pins that behaviour so a
    // future change cannot silently start re-exporting the router's numbers.
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const DAY = "2026-10-06";
    // Wildly wrong router cost: if it leaked through, the total would be this.
    const ROUTER_COST = 7327.8158;

    await withConfig(
      { customRates: { "claude-fable-5": { inputPer1M: 10, outputPer1M: 50 } } },
      async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-ownrate-"));
    try {
      const n = 40;
      const history = Array.from({ length: n }, (_, i) => ({
        id: `ownrate-${i}`,
        timestamp: `${DAY}T0${i % 10}:${String(i).padStart(2, "0")}:00.000Z`,
        model_group: "claude-fable-5",
        provider: "openai",
        promptTokens: 100_000,
        completionTokens: 1_000,
        cachedTokens: 0,
        cost: ROUTER_COST / n,
        tokens: { prompt_tokens: 100_000, completion_tokens: 1_000 },
      }));
      await writeFile(
        path.join(dir, "usage-history.jsonl"),
        history.map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf8",
      );
      await writeFile(
        path.join(dir, "usage-daily.json"),
        JSON.stringify({
          [DAY]: {
            requests: n,
            promptTokens: n * 100_000,
            completionTokens: n * 1_000,
            cachedTokens: 0,
            cost: ROUTER_COST,
            byModel: {
              "claude-fable-5|openai": {
                requests: n,
                promptTokens: n * 100_000,
                completionTokens: n * 1_000,
                cachedTokens: 0,
                cost: ROUTER_COST,
                rawModel: "claude-fable-5",
                provider: "openai",
              },
            },
          },
        }),
        "utf8",
      );
      const events = await parseRouterUsage([dir], "litellm");
      const dayRows = events.filter((e) => e.timestamp.startsWith(DAY));
      assert.equal(dayRows.length, n, "history rows should be kept as-is");
      const cost = dayRows.reduce((a, e) => a + (e.estimatedCost || 0), 0);
      // Router cost must NOT appear.
      assert.ok(
        Math.abs(cost - ROUTER_COST) > 1,
        `router's own cost leaked into the total: ${cost}`,
      );
      // Every row is priced from a known rate, so none may be unknown_model.
      for (const e of dayRows) {
        assert.notEqual(
          e.pricingStatus,
          "unknown_model",
          `row ${e.id} (${e.model}) fell back to unknown pricing`,
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
      },
    );
  });

  it("does not double-count one real model split across byModel keys", async () => {
    // Regression (real LiteLLM data, 2026-10-06): a day is exported as several
    // byModel keys that are ADDITIVE fragments (`anthropic/claude-fable-5|openai`
    // plus `openai/Claude-Fable|openai`). Summing per RAW key is correct for
    // tokens; summing per `rawModel` doubled them, because both keys carry the
    // same rawModel. This pins the token total, which is what must never double.
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-litellm-split-"));
    try {
      const DAY = "2026-10-06";
      const DAY_TOK = 719_698_289;
      const DAY_OUT = 2_812_609;
      const big = 7_299.789_740_000_005;
      const small = 7_622.851_950_000_01;
      const dayCost = 7_327.815_758_000_002_5;
      await writeFile(
        path.join(dir, "usage-daily.json"),
        JSON.stringify({
          [DAY]: {
            requests: 6117,
            promptTokens: DAY_TOK,
            completionTokens: DAY_OUT,
            cachedTokens: 0,
            cost: dayCost,
            byModel: {
              "anthropic/claude-fable-5|openai": {
                requests: 5974,
                promptTokens: 700_000_000,
                completionTokens: 2_700_000,
                cachedTokens: 0,
                cost: big,
                rawModel: "openai/Claude-Fable",
                provider: "openai",
              },
              "openai/Claude-Fable|openai": {
                requests: 6314,
                promptTokens: DAY_TOK - 700_000_000,
                completionTokens: 112_609,
                cachedTokens: 0,
                cost: small,
                rawModel: "openai/Claude-Fable",
                provider: "openai",
              },
            },
          },
        }),
        "utf8",
      );
      await withConfig(
        {
          customRates: {
            "claude-fable-5": { inputPer1M: 10, outputPer1M: 50 },
            "claude-fable": { inputPer1M: 10, outputPer1M: 50 },
          },
        },
        async () => {
          const events = await parseRouterUsage([dir], "litellm");
          const rows = events.filter((e) => e.timestamp.startsWith(DAY));
          // Tokens must match the day exactly — doubling here is the bug being pinned.
          const inTok = rows.reduce((a, e) => a + e.inputTokens, 0);
          const outTok = rows.reduce((a, e) => a + e.outputTokens, 0);
          assert.equal(inTok, DAY_TOK, `input must equal the day total, got ${inTok}`);
          assert.equal(outTok, DAY_OUT, `output must equal the day total, got ${outTok}`);
          // Cost comes from the local rate table (claude-fable-5 => $10/$50 per 1M),
          // never from the router's own cost field.
          const cost = rows.reduce((a, e) => a + (e.estimatedCost || 0), 0);
          const expected = (DAY_TOK / 1e6) * 10 + (DAY_OUT / 1e6) * 50;
          assert.ok(
            Math.abs(cost - expected) < Math.max(1, expected * 0.02),
            `cost must come from the rate table (~${expected.toFixed(2)}), got ${cost}`,
          );
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // --- cache reporting (CACHE $ column) ------------------------------------

  it("flags cacheReported when a history row carries the cachedTokens key, even as 0", async () => {
    // Regression: LiteLLM's per-request export always emits `cachedTokens`, so a
    // 0 is a measurement ("no cache reused"), not silence. Before this, the
    // parser never set `cacheReported`, so the dashboard rendered CACHE $ as "—"
    // for the whole litellm agent even while it carried billions of cached
    // tokens on other rows.
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-router-cacherep-"));
    try {
      await writeFile(
        path.join(dir, "usage-history.jsonl"),
        [
          JSON.stringify({
            id: "with-cache",
            timestamp: "2026-10-08T01:00:00.000Z",
            model: "anthropic/claude-opus-5.5",
            model_group: "claude-opus-5.5",
            provider: "openai",
            promptTokens: 96_235,
            completionTokens: 512,
            cachedTokens: 95_872,
            cost: 0.011692,
            tokens: { prompt_tokens: 96_235, completion_tokens: 512 },
          }),
          JSON.stringify({
            id: "zero-cache-but-reported",
            timestamp: "2026-10-08T01:05:00.000Z",
            model: "anthropic/claude-opus-5.5",
            model_group: "claude-opus-5.5",
            provider: "openai",
            promptTokens: 44_461,
            completionTokens: 458,
            cachedTokens: 0,
            cost: 0.186748,
            tokens: { prompt_tokens: 44_461, completion_tokens: 458 },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const events = await parseRouterUsage([dir], "litellm");
      assert.equal(events.length, 2);
      const withCache = events.find((e) => e.cacheReadTokens === 95_872)!;
      const zeroCache = events.find((e) => e.cacheReadTokens === 0)!;
      assert.ok(withCache, "the cached row must survive parsing");
      assert.equal(withCache.cacheReported, true);
      assert.equal(
        zeroCache.cacheReported,
        true,
        "an explicit cachedTokens:0 still counts as reported cache",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("aggregate reports litellm cacheReportedEvents so CACHE $ stops rendering an em dash", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { aggregate } = await import("../src/aggregate.js");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-router-cacheagg-"));
    try {
      await writeFile(
        path.join(dir, "usage-history.jsonl"),
        [
          JSON.stringify({
            id: "r1",
            timestamp: "2026-10-08T02:00:00.000Z",
            model: "anthropic/claude-opus-5.5",
            provider: "openai",
            promptTokens: 10_000,
            completionTokens: 100,
            cachedTokens: 9_000,
            cost: 0.1,
            tokens: { prompt_tokens: 10_000, completion_tokens: 100 },
          }),
          JSON.stringify({
            id: "r2",
            timestamp: "2026-10-08T02:01:00.000Z",
            model: "anthropic/claude-opus-5.5",
            provider: "openai",
            promptTokens: 10_000,
            completionTokens: 100,
            cachedTokens: 0,
            cost: 0.1,
            tokens: { prompt_tokens: 10_000, completion_tokens: 100 },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const events = await parseRouterUsage([dir], "litellm");
      const result = aggregate(events, "agent", "cost");
      const row = result.groups.find((g) => g.key === "litellm")!;
      assert.equal(row.cacheReportedEvents, 2, "both rows reported cache");
      assert.equal(row.cacheReadTokens, 9_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("splits LiteLLM's cache-inclusive prompt tokens into input and cache-read", async () => {
    // LiteLLM's invariant (litellm/cost_calculator.py L455-460):
    //   "prompt_tokens already INCLUDES cached_tokens"
    // TokenLab keeps the two apart, so inputTokens + cacheReadTokens must equal
    // the source promptTokens exactly — not exceed it by the cache count.
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-litellm-split-"));
    try {
      await writeFile(
        path.join(dir, "usage-history.jsonl"),
        [
          JSON.stringify({
            id: "s1",
            timestamp: "2026-10-08T02:00:00.000Z",
            model: "anthropic/claude-opus-5.5",
            provider: "openai",
            promptTokens: 119_173,
            completionTokens: 180,
            cachedTokens: 117_632,
            cost: 0.009764,
            tokens: { prompt_tokens: 119_173, completion_tokens: 180 },
          }),
          // No cache field at all: the prompt stays entirely uncached.
          JSON.stringify({
            id: "s2",
            timestamp: "2026-10-08T02:01:00.000Z",
            model: "anthropic/claude-fable-5",
            provider: "openai",
            promptTokens: 1_000,
            completionTokens: 10,
            cost: 0.01,
            tokens: { prompt_tokens: 1_000, completion_tokens: 10 },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const events = await parseRouterUsage([dir], "litellm");
      const cached = events.find((e) => e.id && e.cacheReadTokens > 0)!;
      assert.equal(cached.cacheReadTokens, 117_632);
      assert.equal(cached.inputTokens, 119_173 - 117_632, "cache is carved out of the prompt");
      assert.equal(cached.inputTokens + cached.cacheReadTokens, 119_173, "prompt reconciles");
      assert.equal(cached.totalTokens, 119_173 + 180);

      const plain = events.find((e) => e.inputTokens === 1_000)!;
      assert.equal(plain.cacheReadTokens, 0);
      assert.equal(plain.cacheReported, false, "absence of the key is silence, not a zero");

      const { aggregate } = await import("../src/aggregate.js");
      const row = aggregate(events, "agent", "cost").groups.find((g) => g.key === "litellm")!;
      assert.equal(row.inputTokens, 1_000 + (119_173 - 117_632));
      assert.equal(row.cacheReadTokens, 117_632);
      assert.equal(row.totalTokens, 1_000 + 10 + 119_173 + 180, "no token counted twice");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("separates cache tokens that earn no discount from ones that do", async () => {
    // Both of these LiteLLM mirror models have cacheReadPer1M === inputPer1M, so
    // their billions of cache-hit tokens bill $0.00. The dashboard must be able to
    // say "measured, no published discount" instead of looking unscanned.
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { aggregate } = await import("../src/aggregate.js");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-cache-billed-"));
    try {
      await writeFile(
        path.join(dir, "usage-history.jsonl"),
        [
          // claude-fable-5: cacheReadPer1M === inputPer1M === 10 -> no discount.
          JSON.stringify({
            id: "b1", timestamp: "2026-10-08T02:00:00.000Z", model: "anthropic/claude-fable-5",
            provider: "openai", promptTokens: 1_000_000, completionTokens: 1_000,
            cachedTokens: 800_000, cost: 1,
            tokens: { prompt_tokens: 1_000_000, completion_tokens: 1_000 },
          }),
          // deepseek-v4-pro: cacheReadPer1M 0.003625 < inputPer1M 0.435 -> discounted.
          JSON.stringify({
            id: "b2", timestamp: "2026-10-08T02:01:00.000Z", model: "deepseek-v4-pro",
            provider: "openai", promptTokens: 500_000, completionTokens: 500,
            cachedTokens: 400_000, cost: 1,
            tokens: { prompt_tokens: 500_000, completion_tokens: 500 },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const events = await parseRouterUsage([dir], "litellm");
      const row = aggregate(events, "agent", "cost").groups.find((g) => g.key === "litellm")!;
      assert.equal(row.cacheReadTokens, 1_200_000);
      assert.equal(row.cacheFreeTokens, 800_000, "claude-fable-5 hits bill at the input rate");
      assert.equal(row.cacheBilledTokens, 400_000, "deepseek-v4-pro hits earn a real discount");
      assert.equal(
        (row.cacheFreeTokens || 0) + (row.cacheBilledTokens || 0),
        row.cacheReadTokens,
        "every measured cache token is classified",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("counts a day's cache exactly once when byModel keys are overlapping views", async () => {
    // Real LiteLLM mirror, 2026-07-31. The VPS UI export emits ONE model view
    // twice — a provider-native key and a bare key, byte-identical — and both
    // carry `rawModel: "openai/Kimi-k3"`, which is the model's IDENTITY. The
    // duplicate key is the only double-count and must be dropped.
    //
    //   day          in=1310221946 out=7806517 cache=2176363904 req=22797 cost=1000.37
    //   kimi-k3      in=1209500081 out=6795583 cache=1088118336 req=20782 cost=467.01
    //   openai/…     in=1209500081 out=6795583 cache=1088118336 req=20782 cost=467.01
    //
    // A daily rollup carries prompt and cache as SEPARATE buckets (unlike a
    // per-request history row, where cache is a subset of prompt): the day prompt
    // is the sum of the model prompts plus the remainder's, the day cache likewise.
    // Note the day cache (2.18B) EXCEEDS the day prompt (1.31B) — arithmetically
    // impossible if cache were a subset, so no subtraction may be applied here.
    // Both columns must reconcile by addition, and neither may be zeroed.
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-router-cache-rem-"));
    try {
      const DAY = "2026-07-31";
      const modelCache = 1_088_118_336;
      const bigIn = 1_209_500_081;
      const bigOut = 6_795_583;
      const view = {
        requests: 20_782,
        promptTokens: bigIn,
        completionTokens: bigOut,
        cachedTokens: modelCache,
        cost: 467.01,
        rawModel: "openai/Kimi-k3",
        provider: "openai",
      };
      await writeFile(
        path.join(dir, "usage-daily.json"),
        JSON.stringify({
          [DAY]: {
            requests: 22_797,
            promptTokens: 1_310_221_946,
            completionTokens: 7_806_517,
            cachedTokens: 2_176_363_904,
            cost: 1_000.37,
            byModel: {
              "kimi-k3|openai": view,
              "openai/Kimi-k3|openai": view,
              "qwen3.7-max|openai": {
                requests: 1,
                promptTokens: 66_121,
                completionTokens: 782,
                cachedTokens: 63_616,
                cost: 0.019245,
                rawModel: "openai/qwen3.7-max",
                provider: "openai",
              },
              "openai/qwen3.7-max|openai": {
                requests: 1,
                promptTokens: 66_121,
                completionTokens: 782,
                cachedTokens: 63_616,
                cost: 0.019245,
                rawModel: "openai/qwen3.7-max",
                provider: "openai",
              },
            },
          },
        }),
        "utf8",
      );

      const events = await parseRouterUsage([dir], "litellm");
      const rows = events.filter((e) => e.timestamp.startsWith(DAY));
      const totalCache = rows.reduce((a, e) => a + e.cacheReadTokens, 0);
      assert.equal(
        totalCache,
        2_176_363_904,
        `each cached token must be counted once, got ${totalCache}`,
      );
      // Twin keys collapsed: one row per real model, plus the genuinely uncovered
      // tail (the day has 22,797 requests; the named models account for 20,783).
      assert.deepEqual(
        rows.map((e) => e.model).sort(),
        ["Kimi-k3", "qwen3.7-max", "unattributed"],
      );
      // The named model rows appear ONCE each — that is the dedupe under test.
      for (const m of ["Kimi-k3", "qwen3.7-max"]) {
        assert.equal(rows.filter((e) => e.model === m).length, 1, `${m} must not be duplicated`);
      }
      // Prompt and cache are ALREADY-SEPARATE buckets in a daily rollup, so each
      // reconciles with the day field by ADDITION and nothing is counted twice.
      // The day prompt is the sum of the model rows plus the remainder, and the
      // day cache likewise — that is the point of the assertion.
      assert.equal(
        rows.reduce((a, e) => a + e.inputTokens, 0),
        1_310_221_946,
        "rollup input column must equal the day prompt, unabridged",
      );
      assert.equal(
        rows.reduce((a, e) => a + e.inputTokens + e.cacheReadTokens, 0),
        1_310_221_946 + 2_176_363_904,
      );
      assert.equal(rows.reduce((a, e) => a + e.outputTokens, 0), 7_806_517);
      // The old reading (`input = prompt − cache`) collapsed input to a fragment
      // and folded cache into the input column. Guard that it cannot come back:
      // the day prompt is 1.31B while the day cache is 2.18B, so an input column
      // smaller than the cache column would mean the subset rule leaked in.
      assert.equal(
        rows.reduce((a, e) => a + e.cacheReadTokens, 0),
        2_176_363_904,
      );
      // Note the day cache EXCEEDS the day prompt in this fixture, which is
      // precisely what disproves the subset reading — so no input-vs-cache
      // ordering is asserted here; the equalities above are the guard.
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still attributes cache to a remainder row covering models byModel misses", async () => {
    // Here 60% of the day's prompt tokens belong to models the byModel map never
    // mentions, so the remainder is real traffic — not a mirror of the rows above
    // it. It keeps both its tokens and its cache.
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-router-cache-rem2-"));
    try {
      const DAY = "2026-07-25";
      await writeFile(
        path.join(dir, "usage-daily.json"),
        JSON.stringify({
          [DAY]: {
            requests: 100,
            promptTokens: 1_000_000,
            completionTokens: 10_000,
            cachedTokens: 500_000,
            cost: 5,
            byModel: {
              "gpt-5.6-sol|openai": {
                requests: 40,
                promptTokens: 400_000,
                completionTokens: 4_000,
                cachedTokens: 200_000,
                cost: 2,
                rawModel: "gpt-5.6-sol",
                provider: "openai",
              },
            },
          },
        }),
        "utf8",
      );

      const events = await parseRouterUsage([dir], "litellm");
      const rows = events.filter((e) => e.timestamp.startsWith(DAY));
      const remainder = rows.find((e) => e.model === "unattributed");
      assert.ok(remainder, "a genuine uncovered remainder must still be emitted");
      // Rollup buckets are independent: the remainder carries the day prompt the
      // named models did not claim (1,000,000 − 400,000) and the day cache they
      // did not claim (500,000 − 200,000), with no subset relationship between
      // the two — neither is folded into the other.
      assert.equal(remainder.inputTokens, 600_000);
      assert.equal(remainder.cacheReadTokens, 300_000, "its cache belongs to it");
      assert.equal(rows.reduce((a, e) => a + e.cacheReadTokens, 0), 500_000);
      assert.equal(rows.reduce((a, e) => a + e.inputTokens, 0), 1_000_000);
      assert.equal(rows.reduce((a, e) => a + e.outputTokens, 0), 10_000);
      // Every day token is accounted exactly once: prompt by the input column,
      // cache by the cache column.
      assert.equal(
        rows.reduce((a, e) => a + e.inputTokens, 0),
        400_000 + 600_000,
      );
      assert.equal(
        rows.reduce((a, e) => a + e.cacheReadTokens, 0),
        200_000 + 300_000,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not subtract rollup cache from rollup prompt tokens", async () => {
    // LiteLLM uses two mutually exclusive conventions, and the source tag is the
    // only discriminator:
    //   * per-request usage-history.jsonl : cachedTokens is a cache-HIT subset of
    //     promptTokens, so input = prompt − cached (see the case above).
    //   * daily rollup usage-daily.json   : promptTokens is input-ONLY and
    //     cachedTokens is cache-ONLY — two independent buckets, NOT a subset.
    //
    // The rollup reading is proven by the live mirror: 22 of its 73 day blocks
    // report cachedTokens > promptTokens (2026-07-29: prompt 228,698,527 vs
    // cached 361,695,488), which is arithmetically impossible if cache were a
    // subset. Subtracting there collapsed the reported input column by 43%
    // (9.03B rollup prompt reported as 5.12B) and double-counted day-level cache.
    // Ambiguous rows are deliberately left un-subtracted: over-counting is
    // acceptable, wrongly discarding 43% of the input column is not.
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-router-rollup-cache-"));
    try {
      const DAY = "2026-07-29";
      const DAY_PROMPT = 228_698_527;
      const DAY_CACHE = 361_695_488;
      const MODEL_PROMPT = 100_000_000;
      const MODEL_CACHE = 361_695_488;
      const MODEL_OUTPUT = 786_042;
      await writeFile(
        path.join(dir, "usage-daily.json"),
        JSON.stringify({
          [DAY]: {
            requests: 2662,
            promptTokens: DAY_PROMPT,
            completionTokens: MODEL_OUTPUT,
            cachedTokens: DAY_CACHE,
            cost: 216.67307592,
            byModel: {
              "anthropic/claude-fable-5|Claude-Fable": {
                requests: 2600,
                promptTokens: MODEL_PROMPT,
                completionTokens: MODEL_OUTPUT,
                cachedTokens: MODEL_CACHE,
                cost: 216.67307592,
                model_group: "anthropic/claude-fable-5",
                rawModel: "Claude-Fable/Claude-Fable",
                provider: "Claude-Fable",
              },
            },
          },
        }),
        "utf8",
      );

      const events = await parseRouterUsage([dir], "litellm");
      const rows = events.filter((e) => e.timestamp.startsWith(DAY));
      assert.ok(rows.length > 0, "rollup day must produce events");

      const covered = rows.find((e) => e.model !== "unattributed");
      assert.ok(covered, "the byModel row is emitted");
      // The rollup prompt account survives intact — no cache subtraction.
      assert.equal(covered.inputTokens, MODEL_PROMPT);
      assert.equal(covered.cacheReadTokens, MODEL_CACHE);
      assert.equal(covered.outputTokens, MODEL_OUTPUT);

      // Day prompt 228,698,527 − model prompt 100,000,000 = 128,698,527 left
      // over. The remainder's cache is the day cache minus the model's, which is
      // zero here because the model row already carries the whole day's cache.
      const remainder = rows.find((e) => e.model === "unattributed");
      if (remainder) {
        assert.equal(remainder.inputTokens, DAY_PROMPT - MODEL_PROMPT);
        assert.equal(remainder.cacheReadTokens, 0);
      }

      // Bucket-level invariants: input is NOT collapsed toward
      // prompt − cache and cache is counted exactly once.
      const inputSum = rows.reduce((a, e) => a + e.inputTokens, 0);
      const cacheSum = rows.reduce((a, e) => a + e.cacheReadTokens, 0);
      assert.equal(inputSum, DAY_PROMPT, "rollup input column keeps the full prompt");
      assert.equal(cacheSum, DAY_CACHE, "rollup cache counted exactly once");
      // Discriminator for the old bug: a subset reading would have set the covered
      // row's input to MODEL_PROMPT − MODEL_CACHE (here 100,000,000 − 361,695,488
      // → clamped to 0) and the day input would have collapsed to just the
      // remainder. Guard the row itself, not a day-vs-cache comparison — the day
      // cache legitimately EXCEEDS the day prompt in this fixture, which is
      // exactly why the subset rule is disproven.
      assert.ok(
        covered.inputTokens > 0,
        "a cache-exceeding prompt must never be zeroed by subtraction",
      );
      assert.notEqual(covered.inputTokens, 0);
      // Over-counting bias: never report less prompt volume than the day total.
      assert.ok(inputSum >= DAY_PROMPT);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps history subset semantics while rollup stays uncleaned", async () => {
    // Same day from both conventions at once — the discriminator must be the
    // source tag, not the agent. History rows keep prompt = input + cached;
    // rollup rows must not have their cache subtracted.
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "xlab-router-two-conv-"));
    try {
      const DAY = "2026-08-01";
      await writeFile(
        path.join(dir, "usage-history.jsonl"),
        JSON.stringify({
          id: "s1",
          timestamp: `${DAY}T09:00:00.000Z`,
          model: "anthropic/Claude-Fable-5.5",
          promptTokens: 119_173,
          completionTokens: 500,
          cachedTokens: 117_632,
          cost: 0.009764,
        }) + "\n",
        "utf8",
      );
      // History covers this day, so this rollup is a gap-fill that must not
      // reach the output at all — but the parsing it drives must still be safe.
      await writeFile(
        path.join(dir, "usage-daily.json"),
        JSON.stringify({
          [DAY]: {
            requests: 1,
            promptTokens: 119_173,
            completionTokens: 500,
            cachedTokens: 117_632,
            cost: 0.009764,
            byModel: {
              "anthropic/Claude-Fable-5.5|Claude-Fable": {
                requests: 1,
                promptTokens: 119_173,
                completionTokens: 500,
                cachedTokens: 117_632,
                cost: 0.009764,
                rawModel: "Claude-Fable/Claude-Fable-5.5",
                provider: "Claude-Fable",
              },
            },
          },
        }),
        "utf8",
      );

      const events = await parseRouterUsage([dir], "litellm");
      const rows = events.filter((e) => e.timestamp.startsWith(DAY));
      assert.equal(rows.length, 1, "history wins for its day; no rollup added");
      const [row] = rows;
      assert.ok(row);
      // History semantics are unchanged by the rollup fix.
      assert.equal(row.inputTokens + row.cacheReadTokens, 119_173);
      assert.equal(row.inputTokens, 119_173 - 117_632);
      assert.equal(row.cacheReadTokens, 117_632);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
