import type { GroupBy, GroupRow, StatsResult, TokenTotals, UsageEvent } from "./types.js";

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
  t.eventCount += 1;
}

function groupKey(e: UsageEvent, by: GroupBy): string {
  if (by === "agent") return e.agent;
  if (by === "model") {
    const m = (e.model || "").trim();
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
