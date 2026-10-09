/**
 * "Why was this key flagged as a tool/bot?" diagnostics.
 *
 * Background, established from evidence rather than assumption:
 *
 * A provider warning claimed the key "ran 18 giờ/ngày". The LiteLLM callback
 * that enforces rate limits (`glm_rps_limit.py`, reconstructed in
 * `rate-guard.ts`) contains **no** duration logic at all — it only has 1s and
 * 60s sliding windows. So the "18 hours" figure is produced by the *provider*,
 * not by LiteLLM, and no formula for it is published.
 *
 * Replaying the real mirror history shows which readings the provider could
 * have used, and they disagree sharply:
 *
 *   day          requests   span(đầu→cuối)   phút-có-req   giờ-có-traffic
 *   2026-10-07       3907        23.41h          14.63h        24/24
 *   2026-10-08       3159        17.45h          12.22h        17/24
 *
 * Only `span` reaches the claimed magnitude, and even it reports 23.41h rather
 * than 18h — i.e. the provider rounded a span down. Because these definitions
 * are not interchangeable, this module reports **all** of them side by side and
 * never collapses them into a single "hours used" number.
 *
 * The metric that actually identifies tool/bot behaviour is not hours at all:
 * on 2026-10-07 the median gap between requests was 6.7 seconds and 95.4% of
 * gaps were ≤60s, with zero idle hours. That traffic shape — not the 18h figure
 * — is what separates "a machine left running" from human use, so it is
 * measured here too.
 */

import type { UsageEvent } from "./types.js";

/** A request with its resolved epoch-milliseconds timestamp. */
interface TimedPoint {
  atMs: number;
  event: UsageEvent;
}

/**
 * How much of a day the key was active, under each defensible definition.
 *
 * All values are hours. They are deliberately *not* summed or averaged into one
 * number, because the definitions answer different questions and disagree.
 */
export interface DayActivity {
  /** Calendar day, `YYYY-MM-DD`, in the reporting timezone. */
  day: string;
  requestCount: number;
  /**
   * Wall-clock distance from the day's first request to its last.
   * This is the loosest reading and the only one that approaches a provider's
   * "18h" claim. Inflated by a single request at each end of a long idle gap.
   */
  spanHours: number;
  /**
   * Minutes containing ≥1 request, divided by 60. Idle time is excluded, so a
   * quiet day with two distant requests scores near zero instead of "18h".
   */
  activeMinutes: number;
  activeHours: number;
  /** Count of distinct clock hours (0–23) containing ≥1 request, 0–24. */
  hoursWithTraffic: number;
  /** Clock hours inside the span with no request at all. */
  idleHoursInSpan: number;
  /** The specific idle hours, ascending — the evidence for "always on". */
  idleHours: number[];
  /** Longest run where every consecutive gap was ≤ `continuousGapSeconds`. */
  longestContinuousRunHours: number;
  /** Median seconds between consecutive requests in the day. */
  medianGapSeconds: number | null;
  /** Share of consecutive gaps ≤ 60s, as a fraction 0–1. */
  shareGapsUnder60s: number;
}

export interface FlagThresholds {
  /** Hours of `spanHours` at or above which a day is flagged. */
  spanHours: number;
  /** Hours of `activeHours` at or above which a day is flagged. */
  activeHours: number;
  /** Gap size, in seconds, treated as "still the same continuous run". */
  continuousGapSeconds: number;
  /** A day with at most this many idle hours counts as traffic around the clock. */
  maxIdleHours: number;
  /** Share of sub-60s gaps at or above which the cadence reads as automated. */
  automatedGapShare: number;
}

/**
 * Defaults chosen so the *diagnosis* matches the observed warning rather than
 * flattering it: a day is called out when the loosest reading (span) or the
 * cadence evidence trips, and the strict readings are reported alongside so a
 * false positive is visible immediately.
 */
export function defaultFlagThresholds(): FlagThresholds {
  return {
    spanHours: 18,
    activeHours: 12,
    continuousGapSeconds: 300,
    maxIdleHours: 0,
    automatedGapShare: 0.9,
  };
}

/**
 * Merge partial config over the defaults, rejecting values that would make the
 * report meaningless (negative hours, a share outside 0–1). A bad field falls
 * back to its default rather than disabling the check, so a typo cannot quietly
 * turn the audit into a no-op.
 */
export function resolveFlagThresholds(
  partial?: Partial<FlagThresholds> | null,
): FlagThresholds {
  const base = defaultFlagThresholds();
  if (!partial || typeof partial !== "object") return base;

  const hours = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 24 * 31 ? n : fallback;
  };
  const seconds = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const share = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
  };

  return {
    spanHours: hours(partial.spanHours, base.spanHours),
    activeHours: hours(partial.activeHours, base.activeHours),
    continuousGapSeconds: seconds(partial.continuousGapSeconds, base.continuousGapSeconds),
    // maxIdleHours is an upper bound that may legitimately be 0.
    maxIdleHours: hours(partial.maxIdleHours, base.maxIdleHours),
    automatedGapShare: share(partial.automatedGapShare, base.automatedGapShare),
  };
}

export interface DayVerdict {
  day: string;
  flagged: boolean;
  /** Which thresholds tripped, for explaining the verdict. */
  reasons: string[];
}

export interface FlagReport {
  thresholds: FlagThresholds;
  days: DayActivity[];
  verdicts: DayVerdict[];
  /** Per-metric day counts, so a caller can see which reading drives the flags. */
  daysOverSpan: string[];
  daysOverActive: string[];
  daysRoundTheClock: string[];
  daysAutomatedCadence: string[];
  /** Longest continuous run across the whole period. */
  longestRunHours: number;
  /** Median gap across the whole period. */
  medianGapSeconds: number | null;
  shareGapsUnder60s: number;
}

/** Format an epoch-ms value as a `YYYY-MM-DD` key in UTC. */
function dayKeyUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Longest continuous run, where a run continues while each consecutive gap is
 * ≤ `maxGapSeconds`. This is the "tool left running" signature: sustained
 * traffic with no human-scale pause.
 */
function longestContinuousRunSeconds(points: TimedPoint[], maxGapSeconds: number): number {
  if (points.length < 2) return 0;
  let best = 0;
  let current = 0;
  for (let i = 1; i < points.length; i++) {
    const gap = (points[i]!.atMs - points[i - 1]!.atMs) / 1000;
    if (gap <= maxGapSeconds) current += gap;
    else current = 0;
    if (current > best) best = current;
  }
  return best;
}

/**
 * Resolve events to ascending timed points.
 *
 * Estimated daily rollups are dropped: they carry a whole day's request count
 * under a single timestamp, so their "gap" is fiction and would manufacture a
 * false continuous run — the same reasoning `rpmByGroup` documents.
 */
function toTimedPoints(events: UsageEvent[]): TimedPoint[] {
  const out: TimedPoint[] = [];
  for (const e of events) {
    if (!e || e.estimated) continue;
    const atMs = Date.parse(e.timestamp);
    if (!Number.isFinite(atMs)) continue;
    out.push({ atMs, event: e });
  }
  out.sort((a, b) => a.atMs - b.atMs);
  return out;
}

/**
 * Compute per-day activity under every defensible definition.
 *
 * Days are UTC calendar days, matching the rest of TokenLab's minute bucketing
 * (see `computeActiveUsageRpm`), so the numbers here can be compared with the
 * dashboard without a second timezone convention.
 */
export function computeDayActivity(
  events: UsageEvent[],
  thresholds: FlagThresholds = defaultFlagThresholds(),
): DayActivity[] {
  const points = toTimedPoints(events);
  const byDay = new Map<string, TimedPoint[]>();
  for (const p of points) {
    const key = dayKeyUtc(p.atMs);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(p);
    else byDay.set(key, [p]);
  }

  const out: DayActivity[] = [];
  for (const [day, items] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const first = items[0]!.atMs;
    const last = items[items.length - 1]!.atMs;
    const spanHours = (last - first) / 3_600_000;

    const minuteBuckets = new Set<number>();
    const hourBuckets = new Set<number>();
    for (const p of items) {
      minuteBuckets.add(Math.floor(p.atMs / 60_000));
      hourBuckets.add(new Date(p.atMs).getUTCHours());
    }
    const activeMinutes = minuteBuckets.size;
    const activeHours = activeMinutes / 60;

    const firstHour = new Date(first).getUTCHours();
    const lastHour = new Date(last).getUTCHours();
    // Same-day span only: an event set crossing midnight would need multi-day
    // hour arithmetic, and each day is bucketed separately above.
    const idleHours: number[] = [];
    for (let h = firstHour; h <= lastHour; h++) {
      if (!hourBuckets.has(h)) idleHours.push(h);
    }

    const gaps: number[] = [];
    for (let i = 1; i < items.length; i++) {
      gaps.push((items[i]!.atMs - items[i - 1]!.atMs) / 1000);
    }
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const under60 = gaps.filter((g) => g <= 60).length;

    out.push({
      day,
      requestCount: items.length,
      spanHours,
      activeMinutes,
      activeHours,
      hoursWithTraffic: hourBuckets.size,
      idleHoursInSpan: idleHours.length,
      idleHours,
      longestContinuousRunHours:
        longestContinuousRunSeconds(items, thresholds.continuousGapSeconds) / 3600,
      medianGapSeconds: median(sortedGaps),
      shareGapsUnder60s: gaps.length > 0 ? under60 / gaps.length : 0,
    });
  }
  return out;
}

/**
 * Build the full flag report: per-day numbers plus each metric's day list.
 *
 * Reporting four separate day lists rather than one verdict is the point. A
 * provider's "18h" cannot be reproduced, so the honest output is which reading
 * trips which threshold — and the caller decides which to trust.
 */
export function computeFlagReport(
  events: UsageEvent[],
  thresholds: FlagThresholds = defaultFlagThresholds(),
): FlagReport {
  const days = computeDayActivity(events, thresholds);

  const daysOverSpan = days.filter((d) => d.spanHours >= thresholds.spanHours).map((d) => d.day);
  const daysOverActive = days
    .filter((d) => d.activeHours >= thresholds.activeHours)
    .map((d) => d.day);
  const daysRoundTheClock = days
    .filter((d) => d.idleHoursInSpan <= thresholds.maxIdleHours)
    .map((d) => d.day);
  const daysAutomatedCadence = days
    .filter((d) => d.shareGapsUnder60s >= thresholds.automatedGapShare)
    .map((d) => d.day);

  const verdicts: DayVerdict[] = days.map((d) => {
    const reasons: string[] = [];
    if (d.spanHours >= thresholds.spanHours) {
      reasons.push(
        `span ${d.spanHours.toFixed(2)}h >= ${thresholds.spanHours}h (first→last request, includes idle gaps)`,
      );
    }
    if (d.activeHours >= thresholds.activeHours) {
      reasons.push(
        `active ${d.activeHours.toFixed(2)}h >= ${thresholds.activeHours}h (minutes containing a request)`,
      );
    }
    if (d.idleHoursInSpan <= thresholds.maxIdleHours) {
      reasons.push(
        `traffic in every hour across the span (${d.idleHoursInSpan} idle hour(s) <= ${thresholds.maxIdleHours})`,
      );
    }
    if (d.shareGapsUnder60s >= thresholds.automatedGapShare) {
      reasons.push(
        `${(d.shareGapsUnder60s * 100).toFixed(1)}% of gaps <= 60s >= ${(thresholds.automatedGapShare * 100).toFixed(0)}% (automated cadence)`,
      );
    }
    return { day: d.day, flagged: reasons.length > 0, reasons };
  });

  // Period-wide cadence, computed the same way as the per-day figures.
  const points = toTimedPoints(events);
  const allGaps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    allGaps.push((points[i]!.atMs - points[i - 1]!.atMs) / 1000);
  }
  const sortedAll = [...allGaps].sort((a, b) => a - b);

  return {
    thresholds,
    days,
    verdicts,
    daysOverSpan,
    daysOverActive,
    daysRoundTheClock,
    daysAutomatedCadence,
    longestRunHours:
      longestContinuousRunSeconds(points, thresholds.continuousGapSeconds) / 3600,
    medianGapSeconds: median(sortedAll),
    shareGapsUnder60s: allGaps.length > 0 ? allGaps.filter((g) => g <= 60).length / allGaps.length : 0,
  };
}
