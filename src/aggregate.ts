import type { GroupBy, GroupRow, StatsResult, TokenTotals, UsageEvent } from "./types.js";
import { priceCostParts, getRateForModel } from "./pricing.js";
import { normalizeModelName } from "./util.js";

function emptyTotals(currency = "USD"): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    estimatedCost: 0,
    inputCost: 0,
    cacheCost: 0,
    outputCost: 0,
    currency,
    eventCount: 0,
    cacheBilledTokens: 0,
    cacheFreeTokens: 0,
  };
}

type CostParts = { inputCost: number; cacheCost: number; outputCost: number };

function addWithParts(t: TokenTotals, e: UsageEvent, parts: CostParts): void {
  t.inputTokens += e.inputTokens || 0;
  t.outputTokens += e.outputTokens || 0;
  t.cacheReadTokens += e.cacheReadTokens || 0;
  t.cacheWriteTokens += e.cacheWriteTokens || 0;
  t.totalTokens += e.totalTokens || 0;
  t.estimatedCost += e.estimatedCost ?? 0;
  t.inputCost = (t.inputCost || 0) + parts.inputCost;
  t.cacheCost = (t.cacheCost || 0) + parts.cacheCost;
  t.outputCost = (t.outputCost || 0) + parts.outputCost;
  // Split the cache-read bucket by whether the rate table actually discounts it.
  // A bucket can carry billions of cache-hit tokens and still bill $0.00 for them
  // (LiteLLM mirrors Claude traffic at cacheReadPer1M === inputPer1M), so the
  // dashboard needs to say "measured, no discount" instead of looking unscanned.
  const cacheRead = e.cacheReadTokens || 0;
  if (cacheRead > 0) {
    const { rate } = getRateForModel(e.model);
    const discountsCache =
      rate.cacheReadPer1M != null && rate.cacheReadPer1M < rate.inputPer1M;
    if (discountsCache) t.cacheBilledTokens = (t.cacheBilledTokens || 0) + cacheRead;
    else t.cacheFreeTokens = (t.cacheFreeTokens || 0) + cacheRead;
  }
  // Count rows that actually told us about caching. A row with explicit zeroes
  // still counts: "the provider said 0" is a measurement, unlike silence.
  if (e.cacheReported) t.cacheReportedEvents = (t.cacheReportedEvents || 0) + 1;
  // Sum real API requests (daily rollups carry model.requests; per-call rows = 1)
  const reqs = e.requestCount;
  t.eventCount += typeof reqs === "number" && Number.isFinite(reqs) && reqs > 0 ? Math.floor(reqs) : 1;
}

function add(t: TokenTotals, e: UsageEvent): void {
  const parts = priceCostParts(
    e.model,
    e.inputTokens || 0,
    e.outputTokens || 0,
    e.cacheReadTokens || 0,
    e.cacheWriteTokens || 0,
    e.estimatedCost,
  );
  addWithParts(t, e, parts);
}

function groupKey(e: UsageEvent, by: GroupBy, tsMs?: number): string {
  if (by === "agent") return e.agent;
  if (by === "model") {
    // Strip provider suffixes; always lowercase so kimi-k3 ≡ Kimi-k3
    const m = normalizeModelName(e.model);
    // Label missing model with agent so "unknown" is not a mystery model name
    return (m || `unknown (${e.agent})`).toLowerCase();
  }
  const t = tsMs != null && Number.isFinite(tsMs) ? tsMs : Date.parse(e.timestamp);
  if (!Number.isFinite(t)) return "unknown";
  const d = new Date(t);
  if (by === "day") return d.toISOString().slice(0, 10);
  return `${d.toISOString().slice(0, 13)}:00`;
}

export function aggregate(
  events: UsageEvent[],
  groupBy: GroupBy = "agent",
  sort: "tokens" | "cost" = "cost",
  since: string | null = null,
  until: string | null = null,
  /** Optional parallel ms timestamps (same length) — avoids re-parse for day/hour keys */
  timestampsMs?: number[] | null,
): StatsResult {
  const totals = emptyTotals();
  const map = new Map<string, GroupRow>();
  const n = events.length;
  const useTs = Array.isArray(timestampsMs) && timestampsMs.length === n;

  for (let i = 0; i < n; i++) {
    const e = events[i]!;
    // priceCostParts once per event (was 2× — totals + group row)
    const parts = priceCostParts(
      e.model,
      e.inputTokens || 0,
      e.outputTokens || 0,
      e.cacheReadTokens || 0,
      e.cacheWriteTokens || 0,
      e.estimatedCost,
    );
    addWithParts(totals, e, parts);
    const key = groupKey(e, groupBy, useTs ? timestampsMs![i] : undefined);
    let row = map.get(key);
    if (!row) {
      row = { key, ...emptyTotals() };
      map.set(key, row);
    }
    addWithParts(row, e, parts);
  }

  const groups = [...map.values()].sort((a, b) =>
    sort === "cost" ? b.estimatedCost - a.estimatedCost : b.totalTokens - a.totalTokens,
  );

  // Every group row carries its own peak RPM so the table always has the column
  // and the chart can draw rate-over-time for hour/day buckets.
  // A group with no live rows keeps `rpm` undefined (rendered as "—") rather
  // than 0 — 0 would read as "measured, and it was zero", recreating the
  // "157 requests, 0 RPM" contradiction this column already had once.
  const rpmMap = rpmByGroup(events, groupBy, timestampsMs);
  for (const g of groups) {
    const peak = rpmMap.get(g.key);
    if (peak != null) g.rpm = peak;
  }

  return {
    totals,
    groups,
    groupBy,
    period: { since, until },
  };
}

/** Dashboard period keys (match UI segment + since query). */
export type DashPeriodKey = "today" | "24h" | "7d" | "30d" | "all";

export type PrecomputedPeriodStats = {
  builtAt: number;
  /** groupBy → StatsResult (sort=cost for agent/model, tokens for day/hour) */
  byGroup: Record<GroupBy, StatsResult>;
  usageRpm: ReturnType<typeof computeActiveUsageRpm>;
};

/**
 * Single-pass precompute for dashboard period tabs.
 * One priceCostParts per event total (not 2× per groupBy × period) so Today↔30D
 * switches are Map lookups instead of multi-second full rescans.
 */
export function precomputeDashboardPeriods(
  events: UsageEvent[],
  timestampsMs: number[],
  bounds: Record<DashPeriodKey, number | null>,
  nowMs: number = Date.now(),
): Map<DashPeriodKey, PrecomputedPeriodStats> {
  const keys: DashPeriodKey[] = ["today", "24h", "7d", "30d", "all"];
  type Acc = {
    totals: TokenTotals;
    agent: Map<string, GroupRow>;
    model: Map<string, GroupRow>;
    day: Map<string, GroupRow>;
    hour: Map<string, GroupRow>;
    rpmEvents: UsageEvent[];
  };
  const acc = new Map<DashPeriodKey, Acc>();
  for (const k of keys) {
    acc.set(k, {
      totals: emptyTotals(),
      agent: new Map(),
      model: new Map(),
      day: new Map(),
      hour: new Map(),
      rpmEvents: [],
    });
  }

  const n = events.length;
  const useTs = Array.isArray(timestampsMs) && timestampsMs.length === n;

  const bump = (map: Map<string, GroupRow>, key: string, e: UsageEvent, parts: CostParts) => {
    let row = map.get(key);
    if (!row) {
      row = { key, ...emptyTotals() };
      map.set(key, row);
    }
    addWithParts(row, e, parts);
  };

  for (let i = 0; i < n; i++) {
    const e = events[i]!;
    const t = useTs ? timestampsMs[i]! : Date.parse(e.timestamp);
    if (!Number.isFinite(t)) continue;
    const parts = priceCostParts(
      e.model,
      e.inputTokens || 0,
      e.outputTokens || 0,
      e.cacheReadTokens || 0,
      e.cacheWriteTokens || 0,
      e.estimatedCost,
    );
    const agentKey = e.agent;
    const modelKey = (normalizeModelName(e.model) || `unknown (${e.agent})`).toLowerCase();
    const dayKey = new Date(t).toISOString().slice(0, 10);
    const hourKey = `${new Date(t).toISOString().slice(0, 13)}:00`;

    for (const pk of keys) {
      const start = bounds[pk];
      if (start != null && t < start) continue;
      if (t > nowMs + 5_000) continue;
      const a = acc.get(pk)!;
      addWithParts(a.totals, e, parts);
      bump(a.agent, agentKey, e, parts);
      bump(a.model, modelKey, e, parts);
      bump(a.day, dayKey, e, parts);
      // Hour series only needed for today/24h charts
      if (pk === "today" || pk === "24h") bump(a.hour, hourKey, e, parts);
      a.rpmEvents.push(e);
    }
  }

  const finish = (
    map: Map<string, GroupRow>,
    groupBy: GroupBy,
    sort: "tokens" | "cost",
    since: string | null,
  ): StatsResult => {
    const groups = [...map.values()].sort((a, b) =>
      sort === "cost" ? b.estimatedCost - a.estimatedCost : b.totalTokens - a.totalTokens,
    );
    return {
      totals: emptyTotals(), // filled below
      groups,
      groupBy,
      period: { since, until: null },
    };
  };

  const out = new Map<DashPeriodKey, PrecomputedPeriodStats>();
  for (const pk of keys) {
    const a = acc.get(pk)!;
    const since = pk === "all" ? null : pk;
    const agentStats = finish(a.agent, "agent", "cost", since);
    agentStats.totals = a.totals;
    const modelStats = finish(a.model, "model", "cost", since);
    modelStats.totals = { ...a.totals };
    const dayStats = finish(a.day, "day", "tokens", since);
    dayStats.totals = { ...a.totals };
    const hourStats = finish(a.hour, "hour", "tokens", since);
    hourStats.totals = { ...a.totals };
    // Every group row carries its own peak RPM for the table's RPM column;
    // hour/day rows additionally feed the chart's rate-over-time mode.
    // Groups without live rows stay undefined ("—"), never a misleading 0.
    for (const [stats, by] of [
      [agentStats, "agent"],
      [modelStats, "model"],
      [dayStats, "day"],
      [hourStats, "hour"],
    ] as const) {
      const rpmMap = rpmByGroup(a.rpmEvents, by);
      for (const g of stats.groups) {
        const peak = rpmMap.get(g.key);
        if (peak != null) g.rpm = peak;
      }
    }
    out.set(pk, {
      builtAt: nowMs,
      byGroup: {
        agent: agentStats,
        model: modelStats,
        day: dayStats,
        hour: hourStats,
      },
      usageRpm: computeActiveUsageRpm(a.rpmEvents),
    });
  }
  return out;
}

/**
 * Live request rate over a sliding wall-clock window (default 3 minutes).

 *
 * International / APM standard (Prometheus rate, Datadog, New Relic):
 *   RPS = N / T_seconds
 *   RPM = RPS × 60 = N × 60 / T_seconds
 * where N = completed live API calls in the open-closed interval (now−T, now]
 * and T is the exact window length in seconds (not discrete calendar minutes).
 *
 * Only real per-call rows count — estimated daily rollups and zero-token probes
 * are excluded so the rate reflects live traffic, not historical floors.
 */
/**
 * Count distinct UTC minute buckets that contain ≥1 event.
 *
 * Kept for the mean-rate calculation (`meanRpm`) and as a public helper; the
 * headline RPM is now a peak minute, so idle gaps can no longer dilute it.
 */
export function countActiveMinutes(events: UsageEvent[]): number {
  if (!Array.isArray(events) || events.length === 0) return 0;
  const buckets = new Set<number>();
  for (const e of events) {
    if (!e) continue;
    const t = new Date(e.timestamp).getTime();
    if (!Number.isFinite(t)) continue;
    buckets.add(Math.floor(t / 60_000));
  }
  return buckets.size;
}

function eventRequestCount(e: UsageEvent): number {
  const rc = e.requestCount;
  if (typeof rc === "number" && Number.isFinite(rc) && rc > 0) return Math.floor(rc);
  return 1;
}

/**
 * Period PEAK RPM: the busiest single minute, counted from **real per-call rows
 * only**.
 *
 *   RPM = max over minute m of ( requests landing in calendar minute m )
 *
 * A "calendar minute" is floor(ts / 60s), so a burst of 12 calls inside one
 * minute reads as 12 RPM no matter how those seconds are distributed.
 *
 * Estimated daily rollup rows are excluded, and that exclusion is load-bearing:
 * a rollup carries a whole day's request count (e.g. 4692) but only ONE
 * timestamp, so counting it would collapse a day of traffic into a single
 * minute and report a fake peak of 4692 req/min. Verified: one rollup row moved
 * the peak from 1 to 4693. Only per-call rows have timestamps that mean "this
 * request happened then", which is what a per-minute peak requires.
 *
 * The old active-minutes mean (`totalRequests / activeMinutes`, rollups
 * included) is still returned as `meanRpm` for callers that want the average,
 * but `rpm` — the headline number — is the live peak.
 */
export function computeActiveUsageRpm(events: UsageEvent[]): {
  requests: number;
  activeMinutes: number;
  /** Peak RPM = busiest single minute's request count (live rows only) */
  rpm: number;
  /** RPS equivalent = rpm / 60 */
  rps: number;
  /** Average over active minutes (totalRequests / activeMinutes) */
  meanRpm: number;
  method: "peak_minute";
  unit: "req/min";
} {
  let requests = 0;
  // minute bucket → requests in it (peak is the max of these)
  const perMinute = new Map<number, number>();
  // Live requests only, kept separate so the mean below stays comparable to the
  // old number while the peak ignores aggregated rollups.
  const livePerMinute = new Map<number, number>();

  for (const e of events) {
    if (!e) continue;
    const reqs = eventRequestCount(e);
    requests += reqs;
    const t = new Date(e.timestamp).getTime();
    if (!Number.isFinite(t)) continue;
    const m = Math.floor(t / 60_000);
    perMinute.set(m, (perMinute.get(m) ?? 0) + reqs);
    // Peak source: real per-call rows only (see doc comment above)
    if (!e.estimated) {
      livePerMinute.set(m, (livePerMinute.get(m) ?? 0) + reqs);
    }
  }

  let rpm = 0;
  for (const count of livePerMinute.values()) {
    if (count > rpm) rpm = count;
  }
  const activeMinutes = perMinute.size;
  const meanRpm = activeMinutes > 0 ? requests / activeMinutes : 0;
  return {
    requests,
    activeMinutes,
    rpm,
    rps: rpm / 60,
    meanRpm,
    method: "peak_minute",
    unit: "req/min",
  };
}

/**
 * Per-group PEAK RPM for the breakdown table and the chart's RPM mode.
 *
 * RPM here is the busiest single minute inside the group, expressed in
 * requests/minute:
 *
 *   for each group g:  RPM_g = max over minute m in g of ( requests in m )
 *
 * A minute is a calendar minute (floor(ts / 60s)); all requests landing in the
 * same calendar minute are summed, so a burst of 12 calls at 10:03:xx reads as
 * 12 RPM regardless of how they are spread across those 60 seconds.
 *
 * This is a *peak* metric, so it answers "how fast did this bucket ever go",
 * not "how fast did it average". An idle hour therefore reports the rate of its
 * own busiest minute rather than being diluted toward zero, and a day-based
 * chart shows each day's busiest minute.
 *
 * Estimated daily rollups are ALWAYS excluded, even for the table. A rollup
 * carries a whole day's request count under one timestamp, so its "minute" is
 * fiction: including it collapsed a day into one minute and produced a fake
 * 4692 req/min peak (verified). Only real per-call rows have timestamps that
 * mean "this request happened then", which is what a per-minute peak needs.
 * Groups with no live rows therefore get no entry and render as "—".
 *
 * Returns a Map keyed by the same key used by `groupKey()`, so callers can
 * attach it straight onto GroupRow.rpm.
 *
 * `scope` decides whether zero-token / zero-cost probes count:
 *
 * - "table" (default) — probes count, matching the group's Requests column,
 *   which has no token filter. Keeps the two adjacent columns consistent.
 * - "live" — probes dropped, matching the live rate used elsewhere.
 */
export function rpmByGroup(
  events: UsageEvent[],
  by: GroupBy,
  timestampsMs?: number[] | null,
  scope: "table" | "live" = "table",
): Map<string, number> {
  const n = events.length;
  const useTs = Array.isArray(timestampsMs) && timestampsMs.length === n;
  // key → (minute bucket → requests in that minute). The peak is resolved at the
  // end so we only keep per-minute counters instead of every event.
  const acc = new Map<string, Map<number, number>>();

  for (let i = 0; i < n; i++) {
    const e = events[i]!;
    if (!e) continue;
    // Aggregated rollups have no trustworthy minute — always excluded.
    if (e.estimated) continue;
    const t = useTs ? timestampsMs![i]! : Date.parse(e.timestamp);
    if (!Number.isFinite(t)) continue;
    // Zero-token / zero-cost probes are not billable usage, so they are dropped
    // from the live rate. In "table" scope they must still be counted, because
    // the Requests column next to RPM counts them too (eventCount has no
    // token filter) — otherwise the two columns disagree.
    if (scope === "live") {
      const tok =
        (Number(e.inputTokens) || 0) +
        (Number(e.outputTokens) || 0) +
        (Number(e.cacheReadTokens) || 0) +
        (Number(e.cacheWriteTokens) || 0);
      if (tok <= 0 && !(Number(e.estimatedCost) > 0)) continue;
    }

    const key = groupKey(e, by, t);
    let minutes = acc.get(key);
    if (!minutes) {
      minutes = new Map<number, number>();
      acc.set(key, minutes);
    }
    const minute = Math.floor(t / 60_000);
    minutes.set(minute, (minutes.get(minute) ?? 0) + eventRequestCount(e));
  }

  const out = new Map<string, number>();
  for (const [key, minutes] of acc) {
    let peak = 0;
    for (const count of minutes.values()) {
      if (count > peak) peak = count;
    }
    out.set(key, peak);
  }
  return out;
}

export function computeLiveRequestRate(
  events: UsageEvent[],
  windowMinutes = 3,
  nowMs: number = Date.now(),
): {
  windowMinutes: number;
  /** Exact observation window in seconds (T in rate formula) */
  windowSeconds: number;
  requests: number;
  /**
   * Mean requests per minute over the sliding window:
   * RPM = N × 60 / T_seconds
   */
  rpm: number;
  /** Mean requests per second: RPS = N / T_seconds */
  rps: number;
  /** Algorithm id for clients/docs */
  method: "sliding_window_mean";
  unit: "req/min";
  /** Oldest minute first (offset = age in whole minutes); last slot = current partial minute */
  perMinute: Array<{ offset: number; requests: number }>;
} {
  const mins = Math.max(1, Math.min(60, Math.floor(windowMinutes) || 3));
  const windowMs = mins * 60_000;
  const windowSeconds = windowMs / 1000;
  const start = nowMs - windowMs;
  const perMinute = Array.from({ length: mins }, (_, i) => ({
    offset: mins - 1 - i, // mins-1 … 0 (0 = current partial minute)
    requests: 0,
  }));

  let total = 0;
  for (const e of events) {
    if (!e) continue;
    // Estimated daily / model rollups are not live API calls
    if (e.estimated) continue;
    const t = new Date(e.timestamp).getTime();
    // Open-closed window (start, now] with small clock-skew tolerance
    if (!Number.isFinite(t) || t <= start || t > nowMs + 5_000) continue;
    // Empty stream probes (0 tokens, no cost) are not billable API usage
    const tok =
      (Number(e.inputTokens) || 0) +
      (Number(e.outputTokens) || 0) +
      (Number(e.cacheReadTokens) || 0) +
      (Number(e.cacheWriteTokens) || 0);
    if (tok <= 0 && !(Number(e.estimatedCost) > 0)) continue;
    // Live row = one completed request; requestCount only when a true multi-call batch
    const rc = e.requestCount;
    const reqs =
      typeof rc === "number" && Number.isFinite(rc) && rc > 0 && rc <= 100
        ? Math.floor(rc)
        : 1;
    total += reqs;
    const ageMs = nowMs - t;
    const ageMin = Math.min(mins - 1, Math.max(0, Math.floor(ageMs / 60_000)));
    // ageMin 0 = current minute → last slot; ageMin mins-1 = oldest → first slot
    const idx = mins - 1 - ageMin;
    if (idx >= 0 && idx < mins) perMinute[idx]!.requests += reqs;
  }

  // Standard continuous mean rate (not integer minute buckets)
  const rps = windowSeconds > 0 ? total / windowSeconds : 0;
  const rpm = rps * 60;

  return {
    windowMinutes: mins,
    windowSeconds,
    requests: total,
    rpm,
    rps,
    method: "sliding_window_mean",
    unit: "req/min",
    perMinute,
  };
}

export function costReport(events: UsageEvent[], since: string | null = null, until: string | null = null) {
  const totals = emptyTotals();
  const agents = new Map<string, GroupRow>();
  const models = new Map<string, GroupRow>();
  const getGroup = (groups: Map<string, GroupRow>, key: string): GroupRow => {
    let row = groups.get(key);
    if (!row) {
      row = { key, ...emptyTotals() };
      groups.set(key, row);
    }
    return row;
  };

  // Build both breakdowns together. Calling aggregate twice priced and traversed
  // large event lists twice for the same cost report.
  for (const event of events) {
    const parts = priceCostParts(
      event.model,
      event.inputTokens || 0,
      event.outputTokens || 0,
      event.cacheReadTokens || 0,
      event.cacheWriteTokens || 0,
      event.estimatedCost,
    );
    addWithParts(totals, event, parts);
    addWithParts(getGroup(agents, groupKey(event, "agent")), event, parts);
    addWithParts(getGroup(models, groupKey(event, "model")), event, parts);
  }

  const sortByCost = (a: GroupRow, b: GroupRow): number =>
    b.estimatedCost - a.estimatedCost;
  const byAgent = [...agents.values()].sort(sortByCost);
  const byModel = [...models.values()].sort(sortByCost);
  const total = totals.estimatedCost || 1;
  return {
    currency: "USD",
    totalEstimatedCost: totals.estimatedCost,
    period: { since, until },
    byAgent: byAgent.map((g) => ({
      agent: g.key,
      estimatedCost: g.estimatedCost,
      totalTokens: g.totalTokens,
      share: g.estimatedCost / total,
    })),
    byModel: byModel.map((g) => ({
      model: g.key,
      estimatedCost: g.estimatedCost,
      totalTokens: g.totalTokens,
    })),
  };
}
