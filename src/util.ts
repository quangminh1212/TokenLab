import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentId, UsageEvent } from "./types.js";

export function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

/**
 * Canonical agent ids for display + aggregation.
 * XLab Router rebranded to RouterLab — keep reading legacy event/agent keys.
 */
export function normalizeAgentId(agent: string | null | undefined): AgentId {
  const a = String(agent || "").trim().toLowerCase();
  if (!a) return "custom";
  if (a === "xlabrouter" || a === "xlrouter" || a === "xlab-router" || a === "xlab_router") {
    return "routerlab";
  }
  return a as AgentId;
}

/** Human-facing agent name (dashboard / RECENT EVENTS). */
export function agentDisplayName(agent: string | null | undefined): string {
  const id = normalizeAgentId(agent);
  const labels: Record<string, string> = {
    routerlab: "RouterLab",
    xlabrouter: "RouterLab",
    "9router": "9Router",
    litellm: "LiteLLM",
    "claude-code": "Claude Code",
    codex: "OpenAI Codex (App)",
    cursor: "Cursor",
    windsurf: "Windsurf",
    grok: "Grok (xAI)",
    hermes: "Hermes Agent",
    qwencoder: "QwenCoder Cloud",
    copilot: "GitHub Copilot",
    devin: "Devin",
    opencode: "OpenCode",
    antigravity: "Antigravity",
  };
  return labels[id] || labels[String(agent || "")] || String(agent || "unknown");
}

/** User home — platform-aware (USERPROFILE on Windows, HOME on Unix). */
export function homeDir(): string {
  if (process.platform === "win32") {
    return process.env.USERPROFILE || process.env.HOME || process.cwd();
  }
  return process.env.HOME || process.env.USERPROFILE || process.cwd();
}

/**
 * Roaming / config-style application data root.
 * - Windows: %APPDATA%
 * - macOS: ~/Library/Application Support
 * - Linux: $XDG_CONFIG_HOME || ~/.config
 */
export function appDataDir(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA || path.join(homeDir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(homeDir(), "Library", "Application Support");
  }
  return process.env.XDG_CONFIG_HOME || path.join(homeDir(), ".config");
}

/**
 * Local / machine-scoped application data root.
 * - Windows: %LOCALAPPDATA%
 * - macOS: ~/Library/Application Support (Electron convention)
 * - Linux: $XDG_DATA_HOME || ~/.local/share
 */
export function localAppDataDir(): string {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA || path.join(homeDir(), "AppData", "Local");
  }
  if (process.platform === "darwin") {
    return path.join(homeDir(), "Library", "Application Support");
  }
  return process.env.XDG_DATA_HOME || path.join(homeDir(), ".local", "share");
}

/**
 * Cache directory root.
 * - Windows: %LOCALAPPDATA%
 * - macOS: ~/Library/Caches
 * - Linux: $XDG_CACHE_HOME || ~/.cache
 */
export function cacheDir(): string {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA || path.join(homeDir(), "AppData", "Local");
  }
  if (process.platform === "darwin") {
    return path.join(homeDir(), "Library", "Caches");
  }
  return process.env.XDG_CACHE_HOME || path.join(homeDir(), ".cache");
}

/** Open a URL in the default browser (best-effort, non-blocking). */
export function openBrowser(url: string): void {
  try {
    let cmd: string;
    let args: string[];
    if (process.platform === "win32") {
      cmd = "cmd";
      args = ["/c", "start", "", url];
    } else if (process.platform === "darwin") {
      cmd = "open";
      args = [url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {
      // ignore missing xdg-open / open
    });
    child.unref();
  } catch {
    // browser open is optional
  }
}

export function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(homeDir(), p.slice(2));
  }
  return p;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function walkFiles(
  root: string,
  options: { maxDepth?: number; match?: (name: string, full: string) => boolean } = {},
): Promise<string[]> {
  const maxDepth = options.maxDepth ?? 8;
  const out: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip VCS, deps, and common temp/fixture trees (Codex plugin fixtures etc.)
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === ".tmp" ||
          entry.name === "tmp" ||
          entry.name === "fixtures" ||
          entry.name === "__tests__" ||
          entry.name === "testdata" ||
          entry.name === "mocks"
        ) {
          continue;
        }
        subdirs.push(full);
      } else if (entry.isFile()) {
        if (!options.match || options.match(entry.name, full)) out.push(full);
      }
    }
    // Parallel subtree walks (bounded) — sequential readdir was slow on large trees;
    // unbounded Promise.all thrashed the disk when many agents scanned at once.
    if (subdirs.length === 1) {
      await walk(subdirs[0]!, depth + 1);
    } else if (subdirs.length > 1) {
      const WALK_CONC = 6;
      for (let i = 0; i < subdirs.length; i += WALK_CONC) {
        const chunk = subdirs.slice(i, i + WALK_CONC);
        await Promise.all(chunk.map((d) => walk(d, depth + 1)));
      }
    }
  }

  if (await pathExists(root)) await walk(root, 0);
  return out;
}

export async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export function parseJsonl(text: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      // skip bad lines
    }
  }
  return rows;
}

export function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

/**
 * Normalize model display/group keys so variants collapse together:
 *  - "gpt-5.5 (openai-compatible-responses-uuid)" → "gpt-5.5"
 *  - "gpt-5.5|provider-id" → "gpt-5.5"
 *  - "provider/gpt-5.5" → "gpt-5.5" (keeps last path segment when useful)
 *  - trims whitespace / trailing punctuation
 */
export function normalizeModelName(model: string | null | undefined): string | null {
  if (model == null) return null;
  let m = String(model).trim();
  if (!m) return null;

  // Strip parenthetical provider/connection suffixes: "name (…)"
  // Repeat for nested "a (b (c))" style once or twice.
  for (let i = 0; i < 3; i++) {
    const next = m.replace(/\s*\([^)]*\)\s*$/g, "").trim();
    if (next === m) break;
    m = next;
  }

  // Strip bracket suffixes: "name [conn]"
  m = m.replace(/\s*\[[^\]]*\]\s*$/g, "").trim();

  // Router daily keys: "rawModel|providerId"
  if (m.includes("|")) {
    m = m.split("|")[0].trim();
  }

  // "provider/model" or "openai/gpt-4.1" → prefer last segment if it looks like a model id
  if (m.includes("/") && !m.startsWith("http")) {
    const parts = m.split("/").map((p) => p.trim()).filter(Boolean);
    const last = parts[parts.length - 1] || m;
    // Keep full string if last segment is too generic
    if (last && last.length >= 2 && !/^(models?|v\d+)$/i.test(last)) {
      m = last;
    }
  }

  // Collapse internal whitespace
  m = m.replace(/\s+/g, " ").trim();
  // Drop trailing separators
  m = m.replace(/[-_:|]+$/g, "").trim();

  // Common vendor spelling variants → canonical form for grouping + rates
  const lower = m.toLowerCase();
  if (lower.startsWith("deep-seek")) m = "deepseek" + m.slice("deep-seek".length);
  if (lower.startsWith("deep_seek")) m = "deepseek" + m.slice("deep_seek".length);
  // Digigo / digigo case
  if (lower === "digigo") m = "Digigo";

  return m || null;
}

export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  // Rough heuristic: ~4 chars per token for mixed code/English
  return estimateTokensFromChars(text.length);
}

/**
 * Same ~4 chars/token heuristic without allocating a string.
 * Prefer this when only a character/byte count is known — never `"x".repeat(n)`.
 */
export function estimateTokensFromChars(charCount: number): number {
  const n = Number(charCount) || 0;
  if (n <= 0) return 0;
  return Math.max(1, Math.ceil(n / 4));
}

/**
 * Offset (ms) to add to UTC instant so wall-clock in `timeZone` matches
 * the same numbers as if they were UTC. Used for zoned start-of-day math.
 */
function timeZoneOffsetMs(timeZone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour) % 24,
    Number(map.minute),
    Number(map.second),
  );
  return asUTC - date.getTime();
}

/** Start of calendar day (00:00:00.000) in the given IANA timezone (or "local" / "UTC"). */
export function startOfDayInTimeZone(
  timeZone?: string | null,
  now: Date = new Date(),
): Date {
  const tz = (timeZone || "local").trim() || "local";
  if (tz === "local") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (tz === "UTC" || tz === "Etc/UTC") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  try {
    const offset = timeZoneOffsetMs(tz, now);
    const localAsUtc = new Date(now.getTime() + offset);
    const startAsUtc = Date.UTC(
      localAsUtc.getUTCFullYear(),
      localAsUtc.getUTCMonth(),
      localAsUtc.getUTCDate(),
    );
    // Recompute offset at the guessed boundary (DST-safe enough for day starts)
    const guess = new Date(startAsUtc - offset);
    const offset2 = timeZoneOffsetMs(tz, guess);
    return new Date(startAsUtc - offset2);
  } catch {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }
}

/**
 * Parse period start. `timeZone` applies to "today" / "yesterday"
 * (IANA id, "local", or "UTC"). Relative 7d/24h is always wall-clock now − N.
 */
export function parseSince(since?: string | null, timeZone?: string | null): Date | null {
  if (!since) return null;
  const key = String(since).trim().toLowerCase();
  if (key === "today") {
    return startOfDayInTimeZone(timeZone, new Date());
  }
  if (key === "yesterday") {
    const start = startOfDayInTimeZone(timeZone, new Date());
    return new Date(start.getTime() - 86_400_000);
  }
  const m = since.match(/^(\d+)([smhd])$/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms =
      unit === "s" ? n * 1000 :
      unit === "m" ? n * 60_000 :
      unit === "h" ? n * 3_600_000 :
      n * 86_400_000;
    return new Date(Date.now() - ms);
  }
  const d = new Date(since);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Filter events by [since, until]. Uses Date.parse (faster than `new Date` per row)
 * and precomputes bound ms so hot API paths do not re-parse bounds every iteration.
 */
export function filterByPeriod(
  events: UsageEvent[],
  since?: string | null,
  until?: string | null,
  timeZone?: string | null,
): UsageEvent[] {
  if (!events.length) return events;
  const s = parseSince(since, timeZone);
  const u = until ? new Date(until) : null;
  const sMs = s ? s.getTime() : null;
  const uMs = u && !Number.isNaN(u.getTime()) ? u.getTime() : null;
  if (sMs == null && uMs == null) return events;
  return events.filter((e) => {
    const t = Date.parse(e.timestamp);
    if (Number.isNaN(t)) return false;
    if (sMs != null && t < sMs) return false;
    if (uMs != null && t > uMs) return false;
    return true;
  });
}

/** Parallel timestamp index (ms) for events — NaN timestamps become 0. */
export function buildTimestampIndex(events: UsageEvent[]): number[] {
  const n = events.length;
  const ts = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const t = Date.parse(events[i]!.timestamp);
    ts[i] = Number.isNaN(t) ? 0 : t;
  }
  return ts;
}

/**
 * Sort events ascending by timestamp (stable). Returns new arrays — does not mutate input.
 * Disk + hot period filters can then use O(log n) range extraction.
 */
export function sortEventsByTime(events: UsageEvent[]): {
  events: UsageEvent[];
  timestampsMs: number[];
} {
  const n = events.length;
  if (n === 0) return { events: [], timestampsMs: [] };
  const order = new Array<number>(n);
  const ts = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    order[i] = i;
    const t = Date.parse(events[i]!.timestamp);
    ts[i] = Number.isNaN(t) ? 0 : t;
  }
  order.sort((a, b) => {
    const d = ts[a]! - ts[b]!;
    return d !== 0 ? d : a - b;
  });
  const outEvents = new Array<UsageEvent>(n);
  const outTs = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const src = order[i]!;
    outEvents[i] = events[src]!;
    outTs[i] = ts[src]!;
  }
  return { events: outEvents, timestampsMs: outTs };
}

function bisectLeftTs(timestampsMs: number[], target: number): number {
  let lo = 0;
  let hi = timestampsMs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timestampsMs[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function bisectRightTs(timestampsMs: number[], target: number): number {
  let lo = 0;
  let hi = timestampsMs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timestampsMs[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * O(log n + k) period filter when `events` are sorted ascending by timestamp and
 * `timestampsMs` is the parallel index (same length). Falls back to linear filter
 * if lengths mismatch.
 */
export function filterByPeriodSorted(
  events: UsageEvent[],
  timestampsMs: number[],
  since?: string | null,
  until?: string | null,
  timeZone?: string | null,
): UsageEvent[] {
  return filterByPeriodSortedDetailed(events, timestampsMs, since, until, timeZone).events;
}

/** Like filterByPeriodSorted but also returns the sliced parallel timestamp index. */
export function filterByPeriodSortedDetailed(
  events: UsageEvent[],
  timestampsMs: number[],
  since?: string | null,
  until?: string | null,
  timeZone?: string | null,
): { events: UsageEvent[]; timestampsMs: number[] } {
  if (!events.length) return { events, timestampsMs: [] };
  if (timestampsMs.length !== events.length) {
    const filtered = filterByPeriod(events, since, until, timeZone);
    return { events: filtered, timestampsMs: buildTimestampIndex(filtered) };
  }
  const s = parseSince(since, timeZone);
  const u = until ? new Date(until) : null;
  const sMs = s ? s.getTime() : null;
  const uMs = u && !Number.isNaN(u.getTime()) ? u.getTime() : null;
  if (sMs == null && uMs == null) return { events, timestampsMs };
  const lo = sMs != null ? bisectLeftTs(timestampsMs, sMs) : 0;
  const hi = uMs != null ? bisectRightTs(timestampsMs, uMs) : events.length;
  if (lo >= hi) return { events: [], timestampsMs: [] };
  if (lo <= 0 && hi >= events.length) return { events, timestampsMs };
  return {
    events: events.slice(lo, hi),
    timestampsMs: timestampsMs.slice(lo, hi),
  };
}

/** Format USD with thousand dots and decimal comma: $197.527,9600 */
export function formatUsd(n: number, digits = 4): string {
  const v = Number(n) || 0;
  const neg = v < 0;
  const fixed = Math.abs(v).toFixed(digits);
  const [intPart, decPart] = fixed.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-$" : "$"}${grouped}${decPart != null ? `,${decPart}` : ""}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
