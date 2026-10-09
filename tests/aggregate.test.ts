import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregate,
  computeActiveUsageRpm,
  computeLiveRequestRate,
  countActiveMinutes,
  costReport,
  rpmByGroup,
} from "../src/aggregate.js";
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
  assert.equal(r.totals.eventCount, 2, "default 1 request per event");
});

test("aggregate eventCount sums requestCount (daily rollup style)", () => {
  const events: UsageEvent[] = [
    { ...sample[0]!, id: "d1", requestCount: 90, estimatedCost: 4.5 },
    { ...sample[1]!, id: "d2", requestCount: 10, estimatedCost: 0.5 },
  ];
  const r = aggregate(events, "model", "cost");
  assert.equal(r.totals.eventCount, 100);
  assert.equal(r.groups.find((g) => g.key === "gpt-4.1")?.eventCount, 90);
  assert.equal(r.groups.find((g) => g.key === "grok-4.5")?.eventCount, 10);
});

test("costReport matches agent and normalized-model aggregates in one report", () => {
  const events: UsageEvent[] = [
    ...sample,
    {
      ...sample[0]!,
      id: "3",
      model: "gpt-4.1 (openai-compatible-responses)",
      inputTokens: 50,
      outputTokens: 50,
      totalTokens: 100,
      estimatedCost: 0.25,
      requestCount: 3,
    },
  ];
  const agent = aggregate(events, "agent", "cost", "7d", "until");
  const model = aggregate(events, "model", "cost", "7d", "until");
  const report = costReport(events, "7d", "until");
  const total = agent.totals.estimatedCost || 1;

  assert.equal(report.totalEstimatedCost, agent.totals.estimatedCost);
  assert.deepEqual(report.period, { since: "7d", until: "until" });
  assert.deepEqual(
    report.byAgent,
    agent.groups.map((g) => ({
      agent: g.key,
      estimatedCost: g.estimatedCost,
      totalTokens: g.totalTokens,
      share: g.estimatedCost / total,
    })),
  );
  assert.deepEqual(
    report.byModel,
    model.groups.map((g) => ({
      model: g.key,
      estimatedCost: g.estimatedCost,
      totalTokens: g.totalTokens,
    })),
  );
});

test("computeActiveUsageRpm returns the PEAK minute (busiest minute drives RPM)", () => {
  // 10 requests across 2 distinct minutes, with a long idle gap between.
  // Minute 01:00 has 4+1 = 5 requests; minute 03:15 has 5 requests.
  const events: UsageEvent[] = [
    {
      ...sample[0]!,
      id: "a1",
      timestamp: "2026-07-28T01:00:10.000Z",
      requestCount: 4,
      estimated: false,
    },
    {
      ...sample[0]!,
      id: "a2",
      timestamp: "2026-07-28T01:00:40.000Z", // same minute as a1
      requestCount: 1,
      estimated: false,
    },
    {
      ...sample[0]!,
      id: "b1",
      timestamp: "2026-07-28T03:15:00.000Z", // different minute, long idle after a*
      requestCount: 5,
      estimated: false,
    },
  ];
  assert.equal(countActiveMinutes(events), 2);
  const r = computeActiveUsageRpm(events);
  assert.equal(r.method, "peak_minute");
  assert.equal(r.requests, 10); // 4+1+5
  assert.equal(r.activeMinutes, 2);
  // Peak = busiest single minute = 5 requests (NOT the 10/2 = 5 mean — same
  // here by coincidence, so the distinguishing case is asserted below).
  assert.equal(r.rpm, 5);
  assert.equal(r.meanRpm, 5);
  assert.ok(Math.abs(r.rps - 5 / 60) < 1e-9);
});

test("peak RPM beats the mean when traffic is bursty (the whole point of the change)", () => {
  // Minute A: 30 requests packed together. Minutes B..D: 1 request each.
  // Mean over active minutes = 33/4 = 8.25, but the busiest minute is 30.
  const events: UsageEvent[] = [
    { ...sample[0]!, id: "burst", timestamp: "2026-07-28T01:00:00.000Z", requestCount: 30, estimated: false },
    { ...sample[0]!, id: "b", timestamp: "2026-07-28T01:05:00.000Z", requestCount: 1, estimated: false },
    { ...sample[0]!, id: "c", timestamp: "2026-07-28T01:10:00.000Z", requestCount: 1, estimated: false },
    { ...sample[0]!, id: "d", timestamp: "2026-07-28T01:15:00.000Z", requestCount: 1, estimated: false },
  ];
  const r = computeActiveUsageRpm(events);
  assert.equal(r.requests, 33);
  assert.equal(r.activeMinutes, 4);
  assert.equal(r.meanRpm, 33 / 4); // 8.25 — the old headline number
  assert.equal(r.rpm, 30); // peak — the new headline number
  assert.notEqual(r.rpm, r.meanRpm);
});

test("activeMinutes counts only minutes that actually carried requests", () => {
  // 24h window with activity packed into two clusters: 3 calls in minute 09:00
  // and 1 call in minute 21:30. The other 1438 minutes are idle and must NOT
  // count — "one busy minute = one full minute of use" is the whole rule.
  const events: UsageEvent[] = [
    { ...sample[0]!, id: "m1a", timestamp: "2026-07-28T09:00:05.000Z", requestCount: 1, estimated: false },
    { ...sample[0]!, id: "m1b", timestamp: "2026-07-28T09:00:35.000Z", requestCount: 1, estimated: false },
    { ...sample[0]!, id: "m1c", timestamp: "2026-07-28T09:00:59.000Z", requestCount: 1, estimated: false },
    { ...sample[0]!, id: "m2", timestamp: "2026-07-28T21:30:00.000Z", requestCount: 1, estimated: false },
  ];
  const r = computeActiveUsageRpm(events);
  // 3 calls share one calendar minute → they contribute 1 active minute, not 3
  assert.equal(r.activeMinutes, 2);
  assert.equal(r.requests, 4);
  // 2 active minutes of 1440 in the day is the point: the card must not imply
  // the machine was busy all day just because requests span the whole day.
  assert.ok(r.activeMinutes < 1440);
  assert.equal(r.rpm, 3); // busiest minute = the 09:00 burst
});

test("a daily rollup row inflates activeMinutes by exactly one minute", () => {
  // Rollups carry a whole day's request count under ONE timestamp. They are
  // excluded from the peak (fake 4692 req/min), but for an "active time" card
  // they still add one real minute bucket. Pinned so the card's semantics stay
  // visible if that ever changes.
  const events: UsageEvent[] = [
    { ...sample[0]!, id: "live", timestamp: "2026-07-28T09:00:10.000Z", requestCount: 1, estimated: false },
    { ...sample[0]!, id: "rollup", timestamp: "2026-07-28T23:59:00.000Z", requestCount: 4692, estimated: true },
  ];
  const r = computeActiveUsageRpm(events);
  assert.equal(r.activeMinutes, 2);
  assert.equal(r.rpm, 1); // rollup never drives the peak
  assert.equal(r.requests, 4693); // but it does inflate the request total
});

test("computeLiveRequestRate uses sliding-window mean (RPM = N×60/T)", () => {
  const now = Date.parse("2026-07-27T12:00:00.000Z");
  const events: UsageEvent[] = [
    {
      ...sample[0]!,
      id: "live-1",
      timestamp: new Date(now - 30_000).toISOString(), // 0.5 min ago
      requestCount: 2,
      estimated: false,
    },
    {
      ...sample[0]!,
      id: "live-2",
      timestamp: new Date(now - 90_000).toISOString(), // 1.5 min ago
      requestCount: 3,
      estimated: false,
    },
    {
      ...sample[0]!,
      id: "live-3",
      timestamp: new Date(now - 150_000).toISOString(), // 2.5 min ago
      requestCount: 1,
      estimated: false,
    },
    {
      ...sample[0]!,
      id: "old",
      timestamp: new Date(now - 400_000).toISOString(), // >3 min — excluded
      requestCount: 100,
      estimated: false,
    },
    {
      ...sample[0]!,
      id: "daily-fat",
      timestamp: new Date(now - 20_000).toISOString(),
      estimated: true,
      requestCount: 500, // estimated rollup — skipped
    },
    {
      ...sample[0]!,
      id: "probe",
      timestamp: new Date(now - 10_000).toISOString(),
      estimated: false,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      requestCount: 1, // zero-token probe — skipped
    },
  ];
  const live = computeLiveRequestRate(events, 3, now);
  assert.equal(live.windowMinutes, 3);
  assert.equal(live.windowSeconds, 180);
  assert.equal(live.method, "sliding_window_mean");
  assert.equal(live.unit, "req/min");
  assert.equal(live.requests, 6); // 2+3+1
  // International: RPM = N×60/T , RPS = N/T
  assert.ok(Math.abs(live.rpm - (6 * 60) / 180) < 1e-9); // 2.0
  assert.ok(Math.abs(live.rps - 6 / 180) < 1e-9); // 1/30
  assert.equal(live.perMinute.length, 3);
  // offsets: oldest minute first (offset 2), then 1, then current 0
  assert.equal(live.perMinute[0]!.offset, 2);
  assert.equal(live.perMinute[0]!.requests, 1); // 2.5 min ago
  assert.equal(live.perMinute[1]!.requests, 3); // 1.5 min ago
  assert.equal(live.perMinute[2]!.requests, 2); // 0.5 min ago
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

test("aggregate by model merges case variants into one lowercase key", () => {
  const events: UsageEvent[] = [
    {
      ...sample[0],
      id: "k1",
      model: "kimi-k3",
      totalTokens: 100,
      estimatedCost: 1,
      inputTokens: 80,
      outputTokens: 20,
    },
    {
      ...sample[0],
      id: "k2",
      model: "Kimi-k3",
      totalTokens: 50,
      estimatedCost: 0.5,
      inputTokens: 40,
      outputTokens: 10,
    },
    {
      ...sample[0],
      id: "k3",
      model: "KIMI-K3",
      totalTokens: 30,
      estimatedCost: 0.3,
      inputTokens: 20,
      outputTokens: 10,
    },
    {
      ...sample[0],
      id: "x1",
      model: "xlab",
      totalTokens: 10,
      estimatedCost: 0.1,
      inputTokens: 8,
      outputTokens: 2,
    },
    {
      ...sample[0],
      id: "x2",
      model: "XLab",
      totalTokens: 10,
      estimatedCost: 0.1,
      inputTokens: 8,
      outputTokens: 2,
    },
  ];
  const r = aggregate(events, "model", "cost");
  const kimi = r.groups.find((g) => g.key === "kimi-k3");
  assert.ok(kimi, `expected single kimi-k3 group, got ${r.groups.map((g) => g.key).join(",")}`);
  assert.equal(kimi.eventCount, 3);
  assert.equal(kimi.totalTokens, 180);
  assert.equal(kimi.key, "kimi-k3");
  const xlab = r.groups.find((g) => g.key === "xlab");
  assert.ok(xlab, `expected xlab group, got ${r.groups.map((g) => g.key).join(",")}`);
  assert.equal(xlab.eventCount, 2);
  assert.equal(xlab.key, "xlab");
  // No duplicate case-split rows
  assert.equal(r.groups.filter((g) => g.key.toLowerCase() === "kimi-k3").length, 1);
  assert.equal(r.groups.filter((g) => g.key.toLowerCase() === "xlab").length, 1);
});

test("rpmByGroup reports each hour's PEAK minute, so a burst is not averaged away", () => {
  const mk = (id: string, ts: string, requestCount: number): UsageEvent => ({
    ...sample[0]!,
    id,
    timestamp: ts,
    requestCount,
    estimated: false,
  });
  const events: UsageEvent[] = [
    // 02:00 hour — 1 request in each of 2 minutes → peak minute = 1
    mk("h2a", "2026-07-28T02:00:10.000Z", 1),
    mk("h2b", "2026-07-28T02:04:50.000Z", 1),
    // 03:00 hour — 6 requests all inside ONE minute → peak minute = 6
    mk("h3a", "2026-07-28T03:10:00.000Z", 4),
    mk("h3b", "2026-07-28T03:10:30.000Z", 2),
    // 04:00 hour — one burst of 20 then a trickle: peak must be 20, not 22/2
    mk("h4a", "2026-07-28T04:00:05.000Z", 20),
    mk("h4b", "2026-07-28T04:30:00.000Z", 2),
  ];

  const byHour = rpmByGroup(events, "hour");
  assert.equal(byHour.get("2026-07-28T02:00"), 1); // peak minute = 1 request
  assert.equal(byHour.get("2026-07-28T03:00"), 6); // 4+2 in the same minute
  assert.equal(byHour.get("2026-07-28T04:00"), 20); // burst survives; mean would be 11
  assert.notEqual(byHour.get("2026-07-28T04:00"), 11);
});

test("rollups never contribute to peak RPM, but do inflate the Requests column", () => {
  const mk = (id: string, ts: string, extra: Partial<UsageEvent> = {}): UsageEvent => ({
    ...sample[0]!,
    id,
    timestamp: ts,
    requestCount: 1,
    estimated: false,
    ...extra,
  });
  const events: UsageEvent[] = [
    mk("real", "2026-07-28T05:00:10.000Z"),
    // Daily rollup blob — a whole day's requests under ONE timestamp
    mk("rollup", "2026-07-28T05:30:00.000Z", { estimated: true, requestCount: 50 }),
    // Zero-token / zero-cost stream probe — excluded from live scope
    mk("probe", "2026-07-28T05:45:00.000Z", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
    }),
  ];

  // "live" scope: 1 real request, 1 active minute → peak 1
  const liveHour = rpmByGroup(events, "hour", null, "live");
  assert.equal(liveHour.get("2026-07-28T05:00"), 1);
  const liveDay = rpmByGroup(events, "day", null, "live");
  assert.equal(liveDay.get("2026-07-28"), 1);

  // "table" scope: same peak. The rollup's 50 is NOT a real minute, so it must
  // not win the max, and the probe is a real (if pointless) call sharing 05:45.
  const tableHour = rpmByGroup(events, "hour");
  assert.equal(tableHour.get("2026-07-28T05:00"), 1);

  // The table row still shows all 52 requests (rollup and probe included) —
  // Requests and RPM intentionally measure different things now, and the peak
  // must reflect only rows with trustworthy per-minute timestamps.
  const hourStats = aggregate(events, "hour", "tokens");
  const row = hourStats.groups.find((g) => g.key === "2026-07-28T05:00");
  assert.equal(row?.eventCount, 52); // real 1 + rollup 50 + probe 1
  assert.equal(row?.rpm, 1); // peak from real rows only — not 50

  // agent/model rows get a peak too
  const agentStats = aggregate(events, "agent", "cost");
  assert.ok(agentStats.groups.length > 0);
  for (const g of agentStats.groups) {
    assert.ok((g.rpm ?? 0) > 0);
  }
});

test("rollup-only groups report no RPM (undefined) instead of a fake peak", () => {
  const mk = (id: string, model: string, ts: string, over: Partial<UsageEvent> = {}): UsageEvent => ({
    ...sample[0]!,
    id,
    model,
    timestamp: ts,
    requestCount: 1,
    estimated: false,
    ...over,
  });

  // A model whose usage arrives ONLY as an estimated rollup (real-world case:
  // an agent that reports daily totals instead of per-call rows).
  const onlyRollup: UsageEvent[] = [
    mk("r1", "claude-sonnet", "2026-07-28T05:00:00.000Z", {
      estimated: true,
      requestCount: 157,
      totalTokens: 1_177_887,
      inputTokens: 1_000_000,
    }),
  ];
  const s1 = aggregate(onlyRollup, "model", "cost");
  const row1 = s1.groups[0]!;
  assert.equal(row1.eventCount, 157);
  // Previously this row reported rpm 0 (the "157 requests, 0 RPM" contradiction).
  // Now it reports *undefined*: no live minute exists, so there is no peak to
  // state, and the UI renders "—" rather than a fabricated 0 or 157.
  assert.equal(row1.rpm, undefined);
  assert.equal(rpmByGroup(onlyRollup, "model").get("claude-sonnet"), undefined);

  // The regression that forced this: a rollup sitting next to real rows used to
  // hijack the peak (verified at 4692 req/min from a single day rollup).
  const mixed: UsageEvent[] = [
    mk("m1", "claude-sonnet", "2026-07-28T02:00:00.000Z", { estimated: true, requestCount: 4692 }),
    mk("m2", "claude-sonnet", "2026-07-28T02:00:10.000Z", { requestCount: 3 }),
    mk("m3", "claude-sonnet", "2026-07-28T02:05:40.000Z", { requestCount: 5 }),
  ];
  const row2 = aggregate(mixed, "model", "cost").groups[0]!;
  assert.equal(row2.eventCount, 4700); // rollup still counted in Requests
  // Busiest real minute = 3 (m2 alone); the 4692 rollup must not win.
  assert.equal(row2.rpm, 5); // m3: 5 in its own minute beats m2's 3
  assert.notEqual(row2.rpm, 4692);
});

test("agent/model rpm is scoped per group, so a burst is not diluted by other groups", () => {
  const mk = (id: string, agent: string, ts: string, requestCount: number): UsageEvent => ({
    ...sample[0]!,
    id,
    agent,
    timestamp: ts,
    requestCount,
    estimated: false,
  });
  const events: UsageEvent[] = [
    // Agent A: 8 requests in ONE minute → 8 RPM
    mk("a1", "agent-a", "2026-07-28T09:00:05.000Z", 8),
    // Agent B: 1 request in a different minute → 1 RPM
    mk("b1", "agent-b", "2026-07-28T09:30:00.000Z", 1),
  ];

  const stats = aggregate(events, "agent", "cost");
  assert.equal(stats.groups.find((g) => g.key === "agent-a")?.rpm, 8);
  assert.equal(stats.groups.find((g) => g.key === "agent-b")?.rpm, 1);
});
