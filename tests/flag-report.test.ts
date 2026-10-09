import assert from "node:assert/strict";
import { test } from "node:test";
import { computeDayActivity, computeFlagReport, defaultFlagThresholds } from "../src/flag-report.js";
import type { UsageEvent } from "../src/types.js";

/**
 * Regression fixtures are built to reproduce the *measured* shape of the real
 * LiteLLM mirror days, not an invented even cadence. Evenly-spaced traffic puts
 * a request in nearly every minute and therefore inflates `activeHours` to the
 * span, which is not what the mirror shows. The real days have bursts separated
 * by short idle gaps, so `activeMinutes` (877 of 1361 minutes on 2026-10-07)
 * stays well below the span.
 *
 * Measured values these fixtures aim at (from the live mirror):
 *
 *   day         reqs  span_h  active_h  hrs_with_traffic  idle_in_span  med_gap  share<=60s
 *   2026-10-07  3905  22.68   14.62     23                0             5.81s    0.947
 *   2026-10-08  3159  17.45   12.22     17                1 (hour 1)    7.44s    0.964
 */

function ev(iso: string, extra: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: iso,
    agent: "litellm",
    model: "claude-opus-5.5",
    timestamp: iso,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 120,
    estimatedCost: 0.01,
    currency: "USD",
    pricingStatus: "priced",
    workspace: null,
    sourcePath: "test",
    ...extra,
  };
}

/**
 * Build a day with a *requested* span: bursts of sub-minute cadence separated by
 * longer pauses, with the burst count solved so the last request lands close to
 * `targetSpanHours` after the first.
 *
 * Guessing the burst/pause pair is how the first version of these fixtures went
 * wrong -- it produced an 11.9h span while claiming 22.7h. Solving for the
 * number of cycles keeps the fixture tied to the measured target, so a change in
 * the numbers fails loudly instead of silently testing the wrong shape.
 */
function burstyDay(opts: {
  startIso: string;
  /** Desired first-request-to-last-request distance, in hours. */
  targetSpanHours: number;
  /** Seconds between requests inside a burst. */
  burstGapSeconds: number;
  /** Requests per burst. */
  burstSize: number;
  /** Seconds of idle between bursts. */
  pauseSeconds: number;
}): UsageEvent[] {
  const cycleSeconds = (opts.burstSize - 1) * opts.burstGapSeconds + opts.pauseSeconds;
  const targetSeconds = opts.targetSpanHours * 3600;
  const cycles = Math.max(1, Math.round(targetSeconds / cycleSeconds));
  const out: UsageEvent[] = [];
  let t = Date.parse(opts.startIso);
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < opts.burstSize; i++) {
      out.push(ev(new Date(t).toISOString()));
      t += opts.burstGapSeconds * 1000;
    }
    t += opts.pauseSeconds * 1000;
  }
  return out;
}

test("a single request has zero span and no cadence", () => {
  const days = computeDayActivity([ev("2026-10-07T12:00:00.000Z")]);
  assert.equal(days.length, 1);
  const d = days[0]!;
  assert.equal(d.spanHours, 0);
  assert.equal(d.activeMinutes, 1);
  assert.equal(d.hoursWithTraffic, 1);
  assert.equal(d.medianGapSeconds, null);
  assert.equal(d.shareGapsUnder60s, 0, "no gaps means no automated cadence");
});

test("span is inflated by two distant requests, active minutes is not", () => {
  // The core finding: an "18h" reading comes from span, not from real activity.
  // Two requests 18h apart read as 18h of span but only 2 active minutes, which
  // is why span must never be presented to the user as "hours of use".
  const events = [ev("2026-10-07T00:00:00.000Z"), ev("2026-10-07T18:00:00.000Z")];
  const d = computeDayActivity(events)[0]!;
  assert.equal(d.spanHours, 18);
  assert.equal(d.activeMinutes, 2);
  assert.ok(Math.abs(d.activeHours - 2 / 60) < 1e-9);
  assert.equal(d.requestCount, 2);
  assert.ok(d.activeHours < 0.05, "active time is tiny despite an 18h span");
});

test("idle hours between the first and last request are reported", () => {
  // Traffic at 00h and 05h only -> hours 1,2,3,4 are idle inside the span.
  const events = [ev("2026-10-07T00:10:00.000Z"), ev("2026-10-07T05:10:00.000Z")];
  const d = computeDayActivity(events)[0]!;
  assert.deepEqual(d.idleHours, [1, 2, 3, 4]);
  assert.equal(d.idleHoursInSpan, 4);
  assert.equal(d.hoursWithTraffic, 2);
});

test("idle hours are counted only between the first and last request", () => {
  // Documents a real limitation of the span-based reading. A day that starts at
  // 00:30, runs to 17:00, then goes quiet for the rest of the day reports idle
  // hours of 1..11 and 13..16 (the gaps *inside* the span) but says nothing
  // about the 18h..23h silence, because the span ends at the last request.
  //
  // This asymmetry is exactly why the provider's span-ish "18h" figure and a
  // true activity measure disagree, and why this module reports both instead of
  // collapsing them into one "hours used" number.
  const trailing = computeDayActivity([
    ev("2026-10-08T00:30:00.000Z"),
    ev("2026-10-08T12:00:00.000Z"),
    ev("2026-10-08T17:00:00.000Z"),
  ])[0]!;
  assert.equal(trailing.hoursWithTraffic, 3);
  // Trailing silence (hours 18..23) is not represented at all.
  assert.ok(!trailing.idleHours.includes(18));
  assert.ok(!trailing.idleHours.includes(23));
  // The interior gaps are the ones reported.
  assert.deepEqual(
    trailing.idleHours,
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16],
  );

  // When the silence sits *between* two requests it IS reported, which proves
  // the metric works and the difference is purely about trailing time.
  const interior = computeDayActivity([
    ev("2026-10-08T00:30:00.000Z"),
    ev("2026-10-08T23:00:00.000Z"),
  ])[0]!;
  assert.deepEqual(interior.idleHours, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
});

test("regression: 2026-10-07 shape is flagged by span and round-the-clock, not by active hours", () => {
  // Real shape: bursts of sub-minute cadence with short pauses, spanning
  // 22.68h with zero idle hours, activeHours 14.62 (well below the span).
  const events = burstyDay({
    startIso: "2026-10-07T01:12:49.000Z",
    targetSpanHours: 22.68,
    burstGapSeconds: 5,
    burstSize: 40,
    pauseSeconds: 240,
  });

  const report = computeFlagReport(events, defaultFlagThresholds());
  const d = report.days[0]!;

  assert.equal(d.idleHoursInSpan, 0, "traffic in every hour inside the span");
  assert.ok(d.spanHours >= 18, `span ${d.spanHours}h reaches the 18h threshold`);
  assert.ok(d.spanHours <= 24, `span ${d.spanHours}h stays within the day`);
  assert.ok(
    d.activeHours < d.spanHours - 2,
    `active ${d.activeHours}h must stay clearly below span ${d.spanHours}h`,
  );
  assert.ok(d.shareGapsUnder60s >= 0.9, "sub-minute cadence is the bot signature");
  assert.ok(d.medianGapSeconds != null && d.medianGapSeconds <= 60);

  assert.ok(report.daysOverSpan.includes("2026-10-07"), "span reading flags the day");
  assert.ok(report.daysRoundTheClock.includes("2026-10-07"), "zero idle hours flags the day");

  const verdict = report.verdicts[0]!;
  assert.equal(verdict.flagged, true);
  assert.ok(verdict.reasons.length >= 2, "multiple independent reasons are reported");
  assert.ok(
    verdict.reasons.some((r) => r.includes("span")),
    "the reason names the metric so the reading is auditable",
  );
});

test("regression: 2026-10-08 stays under the 18h span threshold", () => {
  // Real shape: traffic from 00:00 to 17:27, span 17.45h -> below the bar.
  const events = burstyDay({
    startIso: "2026-10-08T00:00:35.000Z",
    targetSpanHours: 17.45,
    burstGapSeconds: 7,
    burstSize: 40,
    pauseSeconds: 240,
  });
  const report = computeFlagReport(events, defaultFlagThresholds());
  const d = report.days[0]!;
  assert.ok(d.spanHours < 18, `17.45h span stays under 18h, got ${d.spanHours}`);
  assert.ok(!report.daysOverSpan.includes("2026-10-08"));
  assert.ok(d.activeHours < 18);
});

test("estimated daily rollups never contribute cadence or span", () => {
  // A rollup carries a whole day under one timestamp; counting it would fake a
  // continuous run, exactly as documented in rpmByGroup.
  const events = [
    ev("2026-10-07T00:00:00.000Z"),
    ev("2026-10-07T12:00:00.000Z", { estimated: true, requestCount: 5000 }),
    ev("2026-10-07T23:59:00.000Z"),
  ];
  const d = computeDayActivity(events)[0]!;
  assert.equal(d.requestCount, 2, "the rollup is excluded");
  assert.equal(d.activeMinutes, 2);
});

test("days are bucketed by UTC calendar date", () => {
  const events = [ev("2026-10-07T23:59:00.000Z"), ev("2026-10-08T00:01:00.000Z")];
  const days = computeDayActivity(events);
  assert.deepEqual(
    days.map((d) => d.day),
    ["2026-10-07", "2026-10-08"],
  );
});

test("longest continuous run breaks on a gap above the threshold", () => {
  const thresholds = { ...defaultFlagThresholds(), continuousGapSeconds: 60 };
  // 10 requests 30s apart (run of 270s), then a 10-minute gap, then 10 more.
  const start = Date.parse("2026-10-07T00:00:00.000Z");
  const events: UsageEvent[] = [];
  for (let i = 0; i < 10; i++) events.push(ev(new Date(start + i * 30_000).toISOString()));
  const afterGap = start + 9 * 30_000 + 600_000;
  for (let i = 0; i < 10; i++) events.push(ev(new Date(afterGap + i * 30_000).toISOString()));

  const d = computeDayActivity(events, thresholds)[0]!;
  // 9 gaps * 30s = 270s = 0.075h in each run.
  assert.ok(Math.abs(d.longestContinuousRunHours - 270 / 3600) < 1e-9);
});

test("thresholds are configurable and drive the verdicts", () => {
  // 10-minute cadence over 16h: a human-scale pause, never a continuous run.
  const slow: UsageEvent[] = [];
  for (let i = 0; i < 100; i++) {
    slow.push(ev(new Date(Date.parse("2026-10-07T00:00:00.000Z") + i * 600_000).toISOString()));
  }
  const high = { ...defaultFlagThresholds(), spanHours: 1000, activeHours: 1000, maxIdleHours: -1 };

  // 10-min gaps are all > 60s, so the sub-60s share is 0 and no threshold below
  // 1 can ever mark this day as automated -- which is the correct behaviour.
  const relaxed = computeFlagReport(slow, { ...high, automatedGapShare: 0.9 });
  assert.equal(relaxed.days[0]!.shareGapsUnder60s, 0);
  assert.ok(!relaxed.daysAutomatedCadence.includes("2026-10-07"), "10-min cadence is not bot-like");
  assert.deepEqual(relaxed.daysAutomatedCadence, []);
  assert.deepEqual(relaxed.daysRoundTheClock, [], "maxIdleHours=-1 disables the round-the-clock check");

  // A fast cadence trips the same threshold, proving it is the metric and not
  // the threshold value that separates the two shapes.
  const fast: UsageEvent[] = [];
  for (let i = 0; i < 100; i++) {
    fast.push(ev(new Date(Date.parse("2026-10-07T00:00:00.000Z") + i * 30_000).toISOString()));
  }
  const strict = computeFlagReport(fast, { ...high, automatedGapShare: 0.9 });
  assert.ok(strict.days[0]!.shareGapsUnder60s > 0.9);
  assert.ok(strict.daysAutomatedCadence.includes("2026-10-07"));

  // Raising the bar above the observed share excludes it again. Uniform 30s
  // spacing gives a share of exactly 1.0, so only a threshold above 1 can
  // exclude it -- which is the correct boundary, not a quirk.
  const raised = computeFlagReport(fast, { ...high, automatedGapShare: 1.0000001 });
  assert.deepEqual(raised.daysAutomatedCadence, []);
});

test("the round-the-clock check is driven by maxIdleHours", () => {
  const events = burstyDay({
    startIso: "2026-10-07T01:12:49.000Z",
    targetSpanHours: 22.68,
    burstGapSeconds: 5,
    burstSize: 40,
    pauseSeconds: 240,
  });
  // Zero idle hours inside the span -> flagged at the default threshold.
  const zero = computeFlagReport(events, defaultFlagThresholds());
  assert.ok(zero.daysRoundTheClock.includes("2026-10-07"));
  // Requiring "at most -1 idle hours" can never be satisfied.
  const impossible = computeFlagReport(events, {
    ...defaultFlagThresholds(),
    maxIdleHours: -1,
  });
  assert.deepEqual(impossible.daysRoundTheClock, []);
});

test("period-wide cadence aggregates every day", () => {
  const events: UsageEvent[] = [];
  for (let i = 0; i < 50; i++) {
    events.push(ev(new Date(Date.parse("2026-10-07T00:00:00.000Z") + i * 30_000).toISOString()));
    events.push(ev(new Date(Date.parse("2026-10-08T00:00:00.000Z") + i * 30_000).toISOString()));
  }
  const report = computeFlagReport(events);
  assert.equal(report.medianGapSeconds, 30, "median of the pooled 30s gaps");
  assert.ok(report.shareGapsUnder60s > 0.9);
  assert.ok(report.longestRunHours > 0);
});

test("empty input yields an empty report rather than throwing", () => {
  const report = computeFlagReport([]);
  assert.deepEqual(report.days, []);
  assert.deepEqual(report.verdicts, []);
  assert.equal(report.medianGapSeconds, null);
  assert.equal(report.longestRunHours, 0);
  assert.equal(report.shareGapsUnder60s, 0);
});

test("events with unparseable timestamps are skipped", () => {
  const events = [ev("not-a-date"), ev("2026-10-07T10:00:00.000Z")];
  const days = computeDayActivity(events);
  assert.equal(days.length, 1);
  assert.equal(days[0]!.requestCount, 1);
});
