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
    dsh: "DeepSeek Harness",
    codex: "OpenAI Codex",
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

/** Cheap file identity for cache invalidation — one stat, no read. */
export type FileStamp = { size: number; mtimeMs: number };

/**
 * Stat a file for cache keying. Returns null when missing/unreadable, which
 * callers treat as "nothing to parse" (same as a failed read).
 */
export async function stampFile(file: string): Promise<FileStamp | null> {
  try {
    const s = await stat(file);
    if (!s.isFile()) return null;
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Per-file JSONL parse cache keyed by (path, size, mtime).
 *
 * A full scan re-walks the same corpus every pass, and most session logs do not
 * change between passes. Keying on the file stamp lets unchanged files skip the
 * read + JSON.parse entirely, which dominates scan wall time on large histories.
 *
 * Bounded by both entry count and retained bytes so a machine with very large
 * logs cannot use this cache as an unbounded heap. Entries are only ever used
 * when the stamp matches exactly, so a stale entry can never be served.
 */
type JsonlCacheEntry = { stamp: FileStamp; rows: unknown[]; bytes: number };

/**
 * Cache budget.
 *
 * `rows` are parsed JSON objects, which cost several times their source bytes in
 * heap, so this is deliberately modest: across a 16GB corpus (this host's codex
 * tree) a large cap only thrashes and wastes RAM without improving hit rate.
 * The real win comes from *event-level* caching in the parsers, which stores only
 * the derived usage rows. This cache exists to serialize repeated reads within a
 * single process for small/medium files.
 */
const JSONL_CACHE_MAX_ENTRIES = 4_000;
const JSONL_CACHE_MAX_BYTES = 96 * 1024 * 1024;

const jsonlCache = new Map<string, JsonlCacheEntry>();
let jsonlCacheBytes = 0;
let jsonlCacheHits = 0;
let jsonlCacheMisses = 0;

export function jsonlCacheStats(): {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
} {
  return {
    entries: jsonlCache.size,
    bytes: jsonlCacheBytes,
    hits: jsonlCacheHits,
    misses: jsonlCacheMisses,
  };
}

export function clearJsonlCache(): void {
  jsonlCache.clear();
  jsonlCacheBytes = 0;
  jsonlCacheHits = 0;
  jsonlCacheMisses = 0;
  eventCache.clear();
  eventCacheBytes = 0;
  eventCacheHits = 0;
  eventCacheMisses = 0;
}

/**
 * Per-file cache of *derived usage events*.
 *
 * This is the unit that makes rescanning cheap: `UsageEvent` rows are small and
 * already priced, whereas re-deriving them requires reading and parsing the whole
 * source log. Keyed by the same (path, size, mtime) stamp, so a cache entry can
 * only be served for a byte-identical file.
 *
 * The cap must exceed a full pass (measured ~200k events for this host's codex
 * tree alone) or the cache evicts its own entries mid-scan and never scores a
 * hit. 900k events is roughly the sum of every agent's history here and costs
 * a few hundred MB at most — far less than the multi-GB of raw JSON it replaces.
 */
const EVENT_CACHE_MAX_ENTRIES = 900_000;

const eventCache = new Map<
  string,
  { stamp: FileStamp; events: UsageEvent[]; signature?: string }
>();
let eventCacheCount = 0;
let eventCacheBytes = 0;
let eventCacheHits = 0;
let eventCacheMisses = 0;

export function eventCacheStats(): {
  files: number;
  events: number;
  bytes: number;
  hits: number;
  misses: number;
} {
  return {
    files: eventCache.size,
    events: eventCacheCount,
    bytes: eventCacheBytes,
    hits: eventCacheHits,
    misses: eventCacheMisses,
  };
}

function evictEventCache(): void {
  while (eventCacheCount > EVENT_CACHE_MAX_ENTRIES && eventCache.size > 1) {
    const oldest = eventCache.keys().next();
    if (oldest.done) break;
    const entry = eventCache.get(oldest.value);
    if (entry) {
      eventCacheCount -= entry.events.length;
      eventCacheBytes -= entry.events.length * EVENT_BYTES_ESTIMATE;
    }
    eventCache.delete(oldest.value);
  }
}

/** Rough retained size of one event, used only to expose a memory figure. */
const EVENT_BYTES_ESTIMATE = 420;

/**
 * Return cached events for `file` when its stamp is unchanged, otherwise call
 * `produce` and memoize the result.
 *
 * `produce` is only invoked on a miss, so unchanged files skip read + parse +
 * pricing entirely. Events are frozen into a fresh array per caller to protect
 * the cached copy from downstream mutation.
 *
 * `opts.signature` supports products derived from more than one file: pass a
 * digest of every source artifact and the caller supplies its own identity for
 * `file`. When set, the stat-based stamp is bypassed — the caller has already
 * resolved the freshness that matters, and `file` need not even exist.
 */
export async function cachedEventsForFile(
  file: string,
  produce: () => Promise<UsageEvent[]>,
  opts: { maxBytes?: number; signature?: string } = {},
): Promise<UsageEvent[]> {
  // Caller-managed signature: skip the single-file stat entirely.
  if (opts.signature != null) {
    const signature = opts.signature;
    const cached = eventCache.get(file);
    if (cached && cached.signature === signature) {
      eventCacheHits += 1;
      eventCache.delete(file);
      eventCache.set(file, cached);
      return cached.events.slice();
    }
    eventCacheMisses += 1;
    const events = await produce();
    const previous = eventCache.get(file);
    if (previous) {
      eventCacheCount -= previous.events.length;
      eventCacheBytes -= previous.events.length * EVENT_BYTES_ESTIMATE;
      eventCache.delete(file);
    }
    eventCache.set(file, { stamp: { size: 0, mtimeMs: 0 }, events, signature });
    eventCacheCount += events.length;
    eventCacheBytes += events.length * EVENT_BYTES_ESTIMATE;
    evictEventCache();
    return events;
  }

  const stamp = await stampFile(file);
  if (!stamp) return [];
  if (opts.maxBytes != null && stamp.size > opts.maxBytes) {
    eventCacheMisses += 1;
    return produce();
  }

  const cached = eventCache.get(file);
  if (cached && cached.stamp.size === stamp.size && cached.stamp.mtimeMs === stamp.mtimeMs) {
    eventCacheHits += 1;
    eventCache.delete(file);
    eventCache.set(file, cached);
    return cached.events.slice();
  }

  eventCacheMisses += 1;
  const events = await produce();
  const previous = eventCache.get(file);
  if (previous) {
    eventCacheCount -= previous.events.length;
    eventCacheBytes -= previous.events.length * EVENT_BYTES_ESTIMATE;
    eventCache.delete(file);
  }
  eventCache.set(file, { stamp, events });
  eventCacheCount += events.length;
  eventCacheBytes += events.length * EVENT_BYTES_ESTIMATE;
  evictEventCache();
  return events;
}

/**
 * Generic per-file memo of an arbitrary derived value, keyed by the file stamp.
 *
 * Used by parsers whose per-file product is not a `UsageEvent[]` (for example
 * Claude Code's request candidates, which are deduped globally afterwards).
 * `produce` runs only on a miss. Callers must treat the returned array as
 * read-only, because later hits hand back the same cached instance.
 */
const derivedCache = new Map<string, { stamp: FileStamp; value: unknown; size: number }>();
let derivedCacheBytes = 0;
const DERIVED_CACHE_MAX_BYTES = 256 * 1024 * 1024;

export async function cachedCandidatesForFile<T>(
  file: string,
  produce: () => Promise<T[]>,
  opts: { maxBytes?: number; estimateBytes?: (value: T) => number } = {},
): Promise<T[]> {
  const stamp = await stampFile(file);
  if (!stamp) return [];
  if (opts.maxBytes != null && stamp.size > opts.maxBytes) return produce();

  const cached = derivedCache.get(file);
  if (cached && cached.stamp.size === stamp.size && cached.stamp.mtimeMs === stamp.mtimeMs) {
    eventCacheHits += 1;
    derivedCache.delete(file);
    derivedCache.set(file, cached);
    return cached.value as T[];
  }

  eventCacheMisses += 1;
  const value = await produce();
  const size = opts.estimateBytes
    ? value.reduce((sum, item) => sum + opts.estimateBytes!(item), 0)
    : value.length * EVENT_BYTES_ESTIMATE;
  const previous = derivedCache.get(file);
  if (previous) {
    derivedCacheBytes -= previous.size;
    derivedCache.delete(file);
  }
  derivedCache.set(file, { stamp, value, size });
  derivedCacheBytes += size;
  while (derivedCacheBytes > DERIVED_CACHE_MAX_BYTES && derivedCache.size > 1) {
    const oldest = derivedCache.keys().next();
    if (oldest.done) break;
    const entry = derivedCache.get(oldest.value);
    if (entry) derivedCacheBytes -= entry.size;
    derivedCache.delete(oldest.value);
  }
  return value;
}

function evictJsonlCache(maxEntries: number, maxBytes: number): void {
  while (jsonlCache.size > maxEntries || jsonlCacheBytes > maxBytes) {
    const oldest = jsonlCache.keys().next();
    if (oldest.done) break;
    const entry = jsonlCache.get(oldest.value);
    if (entry) jsonlCacheBytes -= entry.bytes;
    jsonlCache.delete(oldest.value);
  }
}

/** Reinsert on hit so the eviction order is LRU rather than FIFO. */
function touchJsonlCache(file: string, entry: JsonlCacheEntry): void {
  jsonlCache.delete(file);
  jsonlCache.set(file, entry);
}

/**
 * Read + parse a JSONL file, reusing the previous parse when the file is
 * byte-identical (same size and mtime) to a cached stamp.
 *
 * Returns null when the file cannot be read, matching `readText`.
 */
export async function readJsonlCached(
  file: string,
  opts: { maxBytes?: number } = {},
): Promise<unknown[] | null> {
  const stamp = await stampFile(file);
  if (!stamp) return null;

  // Skip absurdly large files rather than materializing them as one string.
  if (opts.maxBytes != null && stamp.size > opts.maxBytes) {
    jsonlCacheMisses += 1;
    return null;
  }

  const cached = jsonlCache.get(file);
  if (cached && cached.stamp.size === stamp.size && cached.stamp.mtimeMs === stamp.mtimeMs) {
    jsonlCacheHits += 1;
    touchJsonlCache(file, cached);
    return cached.rows;
  }

  jsonlCacheMisses += 1;
  const text = await readText(file);
  if (text == null) return null;
  const rows = parseJsonl(text);
  const entry: JsonlCacheEntry = { stamp, rows, bytes: text.length };
  const previous = jsonlCache.get(file);
  if (previous) jsonlCacheBytes -= previous.bytes;
  jsonlCache.set(file, entry);
  jsonlCacheBytes += entry.bytes;
  evictJsonlCache(JSONL_CACHE_MAX_ENTRIES, JSONL_CACHE_MAX_BYTES);
  // `text.length` approximates UTF-16 char count; the string is released here.
  return rows;
}

/**
 * Read + parse a JSON document, reusing the previous parse when the file stamp
 * is unchanged. Accepts an array or an object with a known array field.
 */
export async function readJsonCached(file: string): Promise<unknown[] | null> {
  const stamp = await stampFile(file);
  if (!stamp) return null;

  const cached = jsonlCache.get(file);
  if (cached && cached.stamp.size === stamp.size && cached.stamp.mtimeMs === stamp.mtimeMs) {
    jsonlCacheHits += 1;
    touchJsonlCache(file, cached);
    return cached.rows;
  }

  jsonlCacheMisses += 1;
  const text = await readText(file);
  if (text == null) return null;
  let rows: unknown[];
  try {
    const data = JSON.parse(text) as unknown;
    if (Array.isArray(data)) rows = data;
    else if (data && typeof data === "object") {
      const o = data as Record<string, unknown>;
      if (Array.isArray(o.messages)) rows = o.messages;
      else if (Array.isArray(o.events)) rows = o.events;
      else if (Array.isArray(o.usage)) rows = o.usage;
      else rows = [data];
    } else {
      return null;
    }
  } catch {
    return null;
  }
  const entry: JsonlCacheEntry = { stamp, rows, bytes: text.length };
  const previous = jsonlCache.get(file);
  if (previous) jsonlCacheBytes -= previous.bytes;
  jsonlCache.set(file, entry);
  jsonlCacheBytes += entry.bytes;
  evictJsonlCache(JSONL_CACHE_MAX_ENTRIES, JSONL_CACHE_MAX_BYTES);
  return rows;
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
  // LiteLLM internal alias for the openclaw 5.3 route (Claude Code / router SpendLogs)
  // — display the real public model, not the router alias.
  if (lower === "openclaw") m = "glm-5.3";

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
