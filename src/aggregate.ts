import type { GroupBy, GroupRow, StatsResult, TokenTotals, UsageEvent } from "./types.js";
import { normalizeModelName } from "./util.js";

function emptyTotals(currency = "USD"): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    estimatedCost: 0,
    currency,
    eventCount: 0,
  };
}

function add(t: TokenTotals, e: UsageEvent): void {
  t.inputTokens += e.inputTokens;
  t.outputTokens += e.outputTokens;
  t.cacheReadTokens += e.cacheReadTokens;
  t.cacheWriteTokens += e.cacheWriteTokens;
  t.totalTokens += e.totalTokens;
  t.estimatedCost += e.estimatedCost ?? 0;
  // Sum real API requests (daily rollups carry model.requests; per-call rows = 1)
  const reqs = e.requestCount;
  t.eventCount += typeof reqs === "number" && Number.isFinite(reqs) && reqs > 0 ? Math.floor(reqs) : 1;
}

function groupKey(e: UsageEvent, by: GroupBy): string {
  if (by === "agent") return e.agent;
  if (by === "model") {
    // Strip provider suffixes in parentheses / pipes so variants merge
    const m = normalizeModelName(e.model);
    // Label missing model with agent so "unknown" is not a mystery model name
    return m || `unknown (${e.agent})`;
  }
  const d = new Date(e.timestamp);
  if (Number.isNaN(d.getTime())) return "unknown";
  if (by === "day") return d.toISOString().slice(0, 10);
  return `${d.toISOString().slice(0, 13)}:00`;
}

export function aggregate(
  events: UsageEvent[],
  groupBy: GroupBy = "agent",
  sort: "tokens" | "cost" = "cost",
  since: string | null = null,
  until: string | null = null,
): StatsResult {
  const totals = emptyTotals();
  const map = new Map<string, GroupRow>();

  for (const e of events) {
    add(totals, e);
    const key = groupKey(e, groupBy);
    let row = map.get(key);
    if (!row) {
      row = { key, ...emptyTotals() };
      map.set(key, row);
    }
    add(row, e);
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
