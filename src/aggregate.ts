import type { GroupBy, GroupRow, StatsResult, TokenTotals, UsageEvent } from "./types.js";
import { priceCostParts } from "./pricing.js";
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
  const trackPeak = groupBy === "hour" || groupBy === "day";
  const minutes = trackPeak ? new Map<number, number>() : null;

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
    if (minutes) {
      const ts = useTs ? timestampsMs![i]! : Date.parse(e.timestamp);
      bumpMinute(minutes, ts, peakMinuteWeight(e));
    }
  }

  if (minutes) {
    const peaks = peakUsageFromMinutes(minutes);
    const byBucket = groupBy === "hour" ? peaks.hour : peaks.day;
    for (const row of map.values()) row.peakRpm = byBucket.get(row.key) || 0;
  }

  const groups = [...map.values()].sort((a, b) =>
    sort === "cost" ? b.estimatedCost - a.estimatedCost : b.totalTokens - a.totalTokens,
  );

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
    minutes: Map<number, number>;
  };
  const acc = new Map<DashPeriodKey, Acc>();
  for (const k of keys) {
    acc.set(k, {
      totals: emptyTotals(),
      agent: new Map(),
      model: new Map(),
      day: new Map(),
      hour: new Map(),
      minutes: new Map(),
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
    const weight = peakMinuteWeight(e);
    const minuteKey = Math.floor(t / 60_000);

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
      if (weight > 0) bumpMinute(a.minutes, minuteKey * 60_000, weight);
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
    const peaks = peakUsageFromMinutes(a.minutes);
    for (const row of a.hour.values()) row.peakRpm = peaks.hour.get(row.key) || 0;
    for (const row of a.day.values()) row.peakRpm = peaks.day.get(row.key) || 0;
    out.set(pk, {
      builtAt: nowMs,
      byGroup: {
        agent: agentStats,
        model: modelStats,
        day: dayStats,
        hour: hourStats,
      },
      usageRpm: {
        requests: peaks.requests,
        activeMinutes: peaks.activeMinutes,
        rpm: peaks.rpm,
        rps: peaks.rps,
        method: peaks.method,
        unit: peaks.unit,
      },
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
 * Matches RouterLab `countActiveMinutes` — idle gaps do not dilute RPM.
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

/**
 * One logged call in this minute.
 * Session snapshots store a lifetime requestCount on a single timestamp, so that
 * count is not a burst. Estimated rollups and empty probes are skipped.
 */
function peakMinuteWeight(e: UsageEvent): number {
  return minuteRequestWeight(e) > 0 ? 1 : 0;
}

/**
 * Live-window weight. Estimated rollups and empty probes are skipped.
 * requestCount counts only for a real batch of 1..100; a session total above that is one row.
 */
export function minuteRequestWeight(e: UsageEvent): number {
  if (!e || e.estimated) return 0;
  const tok =
    (Number(e.inputTokens) || 0) +
    (Number(e.outputTokens) || 0) +
    (Number(e.cacheReadTokens) || 0) +
    (Number(e.cacheWriteTokens) || 0);
  if (tok <= 0 && !(Number(e.estimatedCost) > 0)) return 0;
  const rc = e.requestCount;
  if (typeof rc === "number" && Number.isFinite(rc) && rc > 0 && rc <= 100) return Math.floor(rc);
  return 1;
}

function bumpMinute(minutes: Map<number, number>, tsMs: number, weight: number): void {
  if (weight <= 0 || !Number.isFinite(tsMs)) return;
  const mk = Math.floor(tsMs / 60_000);
  minutes.set(mk, (minutes.get(mk) || 0) + weight);
}

function peakUsageFromMinutes(minutes: Map<number, number>): {
  requests: number;
  activeMinutes: number;
  rpm: number;
  rps: number;
  method: "peak_minute";
  unit: "req/min";
  hour: Map<string, number>;
  day: Map<string, number>;
} {
  let requests = 0;
  let rpm = 0;
  const hour = new Map<string, number>();
  const day = new Map<string, number>();
  for (const [mk, count] of minutes) {
    requests += count;
    if (count > rpm) rpm = count;
    const d = new Date(mk * 60_000);
    const hourKey = `${d.toISOString().slice(0, 13)}:00`;
    const dayKey = d.toISOString().slice(0, 10);
    if (count > (hour.get(hourKey) || 0)) hour.set(hourKey, count);
    if (count > (day.get(dayKey) || 0)) day.set(dayKey, count);
  }
  return {
    requests,
    activeMinutes: minutes.size,
    rpm,
    rps: rpm / 60,
    method: "peak_minute",
    unit: "req/min",
    hour,
    day,
  };
}

/**
 * Period RPM = the busiest single minute in the range (not the mean).
 * The chart uses the same peak inside each hour or day.
 */
export function computeActiveUsageRpm(events: UsageEvent[]): {
  requests: number;
  activeMinutes: number;
  /** Highest requests in any one minute */
  rpm: number;
  /** RPS equivalent = rpm / 60 */
  rps: number;
  method: "peak_minute";
  unit: "req/min";
} {
  const minutes = new Map<number, number>();
  for (const e of events) {
    if (!e) continue;
    bumpMinute(minutes, Date.parse(e.timestamp), peakMinuteWeight(e));
  }
  const peaks = peakUsageFromMinutes(minutes);
  return {
    requests: peaks.requests,
    activeMinutes: peaks.activeMinutes,
    rpm: peaks.rpm,
    rps: peaks.rps,
    method: peaks.method,
    unit: peaks.unit,
  };
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
    const t = new Date(e.timestamp).getTime();
    // Open-closed window (start, now] with small clock-skew tolerance
    if (!Number.isFinite(t) || t <= start || t > nowMs + 5_000) continue;
    const reqs = minuteRequestWeight(e);
    if (reqs <= 0) continue;
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
  const byAgent = aggregate(events, "agent", "cost", since, until);
  const byModel = aggregate(events, "model", "cost", since, until);
  const total = byAgent.totals.estimatedCost || 1;
  return {
    currency: "USD",
    totalEstimatedCost: byAgent.totals.estimatedCost,
    period: { since, until },
    byAgent: byAgent.groups.map((g) => ({
      agent: g.key,
      estimatedCost: g.estimatedCost,
      totalTokens: g.totalTokens,
      share: g.estimatedCost / total,
    })),
    byModel: byModel.groups.map((g) => ({
      model: g.key,
      estimatedCost: g.estimatedCost,
      totalTokens: g.totalTokens,
    })),
  };
}
