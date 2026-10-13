import type { UsageEvent } from "../types.js";

export const PHANMEMVIP_DAILY_LIMIT_MINUTES = 17 * 60 + 50;

export interface PhanmemvipUsage {
  date: string;
  usedMinutes: number | null;
  limitMinutes: number;
  updatedAt: string | null;
}

type UsageMirror = Record<string, unknown> | null;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const VIETNAM_OFFSET = "+07:00";

function phanmemvipModel(model: string | null): boolean {
  if (!model) return false;
  const name = model.trim().toLowerCase().replace(/^[a-z0-9_-]+\//, "");
  return (
    name === "xlab" ||
    /^(?:pmv|vip|phanmemvip)[-_]/.test(name) ||
    /^claude-(?:fable|sonnet|opus)(?:[-_./]|$)/.test(name) ||
    /^kimi-k3(?:[-_./]|$)/.test(name)
  );
}

function summarizeEventUsage(
  events: readonly UsageEvent[],
  date: string,
): { usedMinutes: number; updatedAt: string | null } {
  const dayStart = Date.parse(`${date}T00:00:00${VIETNAM_OFFSET}`);
  if (!Number.isFinite(dayStart)) return { usedMinutes: 0, updatedAt: null };
  const dayEnd = dayStart + DAY_MS;
  const activeMinutes = new Set<number>();
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const event of events) {
    if (event.agent !== "litellm" || !phanmemvipModel(event.model)) continue;
    // Daily rollups carry many requests but do not preserve which minutes were active.
    if (event.estimated || (event.requestCount != null && event.requestCount > 1)) continue;
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < dayStart || timestamp >= dayEnd) continue;
    activeMinutes.add(Math.floor(timestamp / MINUTE_MS));
    latestTimestamp = Math.max(latestTimestamp, timestamp);
  }

  return {
    usedMinutes: Math.min(PHANMEMVIP_DAILY_LIMIT_MINUTES, activeMinutes.size),
    updatedAt: Number.isFinite(latestTimestamp)
      ? new Date(latestTimestamp).toISOString()
      : null,
  };
}

function readMirrorMinutes(mirror: UsageMirror): number | null {
  if (!mirror) return null;
  if (Array.isArray(mirror.minutes)) {
    return new Set(mirror.minutes.filter((minute): minute is string => typeof minute === "string")).size;
  }
  if (mirror.usedMinutes == null || mirror.usedMinutes === "") return null;
  const value = Number(mirror.usedMinutes);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function laterTimestamp(...values: Array<string | null>): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp) && timestamp > latestMs) {
      latest = value;
      latestMs = timestamp;
    }
  }
  return latest;
}

/**
 * Merge the minute guard mirror with LiteLLM's request history. The guard mirror
 * is authoritative when it contains a current-day timestamp or minute list;
 * otherwise request history fills the gap instead of turning a stale mirror
 * into a fresh-looking zero.
 */
export function resolvePhanmemvipUsage(
  mirror: UsageMirror,
  events: readonly UsageEvent[],
  date: string,
): PhanmemvipUsage {
  const eventUsage = summarizeEventUsage(events, date);
  const dayStart = Date.parse(`${date}T00:00:00${VIETNAM_OFFSET}`);
  const dayEnd = dayStart + DAY_MS;

  const mirrorMinutes = mirror?.date === date ? readMirrorMinutes(mirror) : null;
  const mirrorUpdatedAt = typeof mirror?.updatedAt === "string" ? mirror.updatedAt : null;
  const mirrorUpdatedMs = mirrorUpdatedAt ? Date.parse(mirrorUpdatedAt) : Number.NaN;
  const mirrorTimestampIsToday =
    Number.isFinite(mirrorUpdatedMs) && mirrorUpdatedMs >= dayStart && mirrorUpdatedMs < dayEnd;
  const hasCurrentMirrorEvidence =
    mirrorMinutes !== null && (mirrorTimestampIsToday || Array.isArray(mirror?.minutes));
  const validMirrorMinutes = hasCurrentMirrorEvidence ? mirrorMinutes : null;

  if (validMirrorMinutes === null && eventUsage.usedMinutes === 0) {
    return {
      date,
      usedMinutes: null,
      limitMinutes: PHANMEMVIP_DAILY_LIMIT_MINUTES,
      updatedAt: null,
    };
  }

  return {
    date,
    usedMinutes: Math.min(
      PHANMEMVIP_DAILY_LIMIT_MINUTES,
      Math.max(validMirrorMinutes ?? 0, eventUsage.usedMinutes),
    ),
    limitMinutes: PHANMEMVIP_DAILY_LIMIT_MINUTES,
    updatedAt: laterTimestamp(
      mirrorTimestampIsToday ? mirrorUpdatedAt : null,
      eventUsage.updatedAt,
    ),
  };
}
