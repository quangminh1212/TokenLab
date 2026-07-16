import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { XlabTokenConfig } from "./config.js";
import { getConfigSync, loadConfig, saveConfig } from "./config.js";
import {
  getOpenRouterFetchedAt,
  getOpenRouterModelsSync,
  openrouterCachePath,
  type OpenRouterModelEntry,
} from "./openrouter-models.js";
import { aggregate } from "./aggregate.js";
import type { TokenTotals, UsageEvent } from "./types.js";
import {
  appDataDir,
  filterByPeriod,
  normalizeModelName,
  pathExists,
  stableId,
  startOfDayInTimeZone,
} from "./util.js";
import { VERSION } from "./version.js";

// Simple file logger to %LOCALAPPDATA%\xlab-token\backup.txt
const logDir = path.join(process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd(), "xlab-token");
const logFile = path.join(logDir, "backup.txt");

function log(...args: unknown[]): void {
  const message = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`;
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    fs.appendFileSync(logFile, message + "\r\n");
  } catch {
    // ignore logging errors
  }
}

function logError(...args: unknown[]): void {
  log("[ERROR]", ...args);
}

export const BACKUP_FORMAT = "xlab-token-backup" as const;
/** v1 = settings only · v2 = full events · v3 = period stats (by model + agent) */
export const BACKUP_FORMAT_VERSION = 3 as const;

export type BackupScope = "settings" | "full" | "period-stats";

/** Dashboard periods mirrored into Gist backups */
export type GistPeriodKey = "today" | "24h" | "7d" | "30d" | "all";

export interface CompactTokenRow {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedCost: number;
  eventCount: number;
}

export interface PeriodGroupRow extends CompactTokenRow {
  key: string;
}

export interface PeriodSnapshot {
  period: GistPeriodKey;
  since: string | null;
  totals: CompactTokenRow;
  byModel: PeriodGroupRow[];
  byAgent: PeriodGroupRow[];
}

/**
 * Portable project settings embedded in every backup file
 * (export settings / export full / Gist — same schema).
 * Never includes GitHub PAT.
 */
export type PortableBackupConfig = {
  timezone?: string;
  host?: string;
  port?: number;
  pricing?: XlabTokenConfig["pricing"];
  /** Gist destination metadata only (no token) */
  backup?: {
    gistId?: string;
    gistUrl?: string;
    lastBackupAt?: string;
    autoDaily?: boolean;
  };
};

/**
 * Single on-disk / Gist file format for all backup features:
 * `format: "xlab-token-backup"` — settings-only, full, or period-stats (Gist).
 */
export interface XlabBackup {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  appVersion: string;
  exportedAt: string;
  platform?: string;
  scope: BackupScope;
  /** Project settings (timezone, pricing, host/port, gist id/url) */
  config: PortableBackupConfig;
  /**
   * Usage by model & agent for Today / 24h / 7D / 30D / All.
   * Always present on Gist; optional on full export.
   */
  periodStats?: Partial<Record<GistPeriodKey, PeriodSnapshot>>;
  /** Raw scan events (full) or hour/day rollups (period-stats / multi-machine) */
  events?: UsageEvent[];
  /** Cached OpenRouter model catalog (full scope) */
  openrouter?: {
    fetchedAt: number;
    models: OpenRouterModelEntry[];
  };
  /**
   * Mirror files under %APPDATA%/xlab-token/mirrors (full scope).
   * Keys are relative paths like "9router/usage-daily.json".
   */
  mirrors?: Record<string, string>;
  meta?: {
    note?: string;
    eventCount?: number;
    /** Original raw events before period aggregation (Gist v3) */
    sourceEventCount?: number;
    /** Daily agent×model rollup rows in `events` (Gist v3) */
    rollupEventCount?: number;
    modelCount?: number;
    agentCount?: number;
    /** Hostname(s) contributing to this Gist (multi-machine sync) */
    machineId?: string;
    machines?: string[];
    openrouterModelCount?: number;
    mirrorFileCount?: number;
    mirrorBytes?: number;
  };
}

/** Snapshot of current project settings for any backup file (never the PAT). */
export function buildPortableConfig(): PortableBackupConfig {
  const cfg = getConfigSync();
  const out: PortableBackupConfig = {
    timezone: cfg.timezone || "local",
    pricing: {
      currency: cfg.pricing?.currency || "USD",
      preferRouterCost: cfg.pricing?.preferRouterCost !== false,
      customRates: { ...(cfg.pricing?.customRates || {}) },
    },
  };
  if (cfg.host) out.host = cfg.host;
  if (typeof cfg.port === "number" && Number.isFinite(cfg.port)) out.port = cfg.port;
  if (
    cfg.backup?.gistId ||
    cfg.backup?.gistUrl ||
    cfg.backup?.lastBackupAt ||
    cfg.backup?.autoDaily !== undefined
  ) {
    out.backup = {
      ...(cfg.backup.gistId ? { gistId: cfg.backup.gistId } : {}),
      ...(cfg.backup.gistUrl ? { gistUrl: cfg.backup.gistUrl } : {}),
      ...(cfg.backup.lastBackupAt ? { lastBackupAt: cfg.backup.lastBackupAt } : {}),
      ...(cfg.backup.autoDaily !== undefined ? { autoDaily: cfg.backup.autoDaily !== false } : {}),
    };
  }
  return out;
}

export function dataRoot(): string {
  return process.env.XLAB_TOKEN_DATA_DIR || path.join(appDataDir(), "xlab-token");
}

export function mirrorsRoot(): string {
  return path.join(dataRoot(), "mirrors");
}

/** Persisted events from other machines / restores — merged into scan cache by id. */
export function importedEventsPath(): string {
  return path.join(dataRoot(), "imported-events.json");
}

function eventTokenWeight(e: UsageEvent): number {
  if (typeof e.totalTokens === "number" && Number.isFinite(e.totalTokens)) return e.totalTokens;
  return (
    (Number(e.inputTokens) || 0) +
    (Number(e.outputTokens) || 0) +
    (Number(e.cacheReadTokens) || 0) +
    (Number(e.cacheWriteTokens) || 0)
  );
}

function hasModelName(e: UsageEvent): boolean {
  const m = e.model;
  return typeof m === "string" && m.trim().length > 0;
}

/**
 * Prefer the richer of two same-id rows.
 * Order: more tokens → known model over null → non-estimated → higher cost.
 * Model fill must beat sticky high default-rate cost from null-model rows
 * (otherwise Devin stays as "unknown" forever after the first bad scan).
 */
export function preferRicherEvent(prev: UsageEvent, next: UsageEvent): UsageEvent {
  const pt = eventTokenWeight(prev);
  const et = eventTokenWeight(next);
  if (et > pt) return next;
  if (et < pt) return prev;

  const prevModel = hasModelName(prev);
  const nextModel = hasModelName(next);
  if (nextModel && !prevModel) return next;
  if (prevModel && !nextModel) return prev;

  if (!next.estimated && prev.estimated) return next;
  if (next.estimated && !prev.estimated) return prev;

  if ((Number(next.estimatedCost) || 0) > (Number(prev.estimatedCost) || 0)) return next;
  return prev;
}

/** Union events by `id` (first wins for duplicates). */
export function mergeEventsById(...lists: UsageEvent[][]): UsageEvent[] {
  const byId = new Map<string, UsageEvent>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!e || typeof e.id !== "string" || !e.id) continue;
      if (!byId.has(e.id)) byId.set(e.id, e);
    }
  }
  return [...byId.values()];
}

/**
 * Union by id, but when the same id appears in multiple lists keep the richer row
 * (more tokens, then known model, then higher cost). Prevents a partial re-scan
 * from shrinking all-time totals while still filling in missing model names.
 */
export function mergeEventsByIdPreferRicher(...lists: UsageEvent[][]): UsageEvent[] {
  const byId = new Map<string, UsageEvent>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!e || typeof e.id !== "string" || !e.id) continue;
      const prev = byId.get(e.id);
      if (!prev) {
        byId.set(e.id, e);
        continue;
      }
      byId.set(e.id, preferRicherEvent(prev, e));
    }
  }
  // Policy: thà tính thừa còn hơn bỏ sót.
  // Only drop true clones / stale rollup versions — never the richer day total.
  return collapseExactUsageDuplicates(
    collapseSourcePathRollups(collapseRouterDailyEvents([...byId.values()])),
  );
}

/**
 * Windsurf progressive rescans mint new ids for the same .pb when tokens grow.
 * Keep the richest row per file. Do NOT collapse Grok by timestamp — turns can
 * share a second and must all be kept (prefer overcount over missing turns).
 */
export function collapseSourcePathRollups(events: UsageEvent[]): UsageEvent[] {
  if (!Array.isArray(events) || events.length === 0) return events || [];
  const best = new Map<string, UsageEvent>();
  const out: UsageEvent[] = [];

  for (const e of events) {
    if (!e || typeof e.sourcePath !== "string" || !e.sourcePath) {
      out.push(e);
      continue;
    }
    const sp = e.sourcePath.replace(/\\/g, "/").toLowerCase();
    // Only Windsurf cascade files: one logical session per .pb, keep richest.
    if (e.agent === "windsurf" && sp.endsWith(".pb")) {
      const key = `ws|${sp}`;
      const prev = best.get(key);
      best.set(key, prev ? preferRicherEvent(prev, e) : e);
      continue;
    }
    out.push(e);
  }
  for (const e of best.values()) out.push(e);
  return out;
}

/**
 * Router days: collapse multi-version estimated rollups (unstable ids) to the
 * richest per model, then keep max(daily totals, request totals) for that day.
 * Never drop the higher side — stale daily must not hide fuller request history
 * and request samples must not hide a complete daily rollup.
 */
export function collapseRouterDailyEvents(events: UsageEvent[]): UsageEvent[] {
  if (!Array.isArray(events) || events.length === 0) return events || [];

  type DayBucket = { dailies: UsageEvent[]; requests: UsageEvent[] };
  const nonRouter: UsageEvent[] = [];
  const byAgentDay = new Map<string, DayBucket>();

  for (const e of events) {
    if (!e || typeof e.id !== "string") continue;
    const isRouter = e.agent === "9router" || e.agent === "xlabrouter";
    if (!isRouter) {
      nonRouter.push(e);
      continue;
    }
    const day = (e.timestamp || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      nonRouter.push(e);
      continue;
    }
    const key = `${e.agent}|${day}`;
    let bucket = byAgentDay.get(key);
    if (!bucket) {
      bucket = { dailies: [], requests: [] };
      byAgentDay.set(key, bucket);
    }
    if (e.estimated) bucket.dailies.push(e);
    else bucket.requests.push(e);
  }

  const out: UsageEvent[] = [...nonRouter];
  for (const bucket of byAgentDay.values()) {
    // Same logical daily rollup rewritten many times → keep richest per model.
    const dailyByModel = new Map<string, UsageEvent>();
    for (const e of bucket.dailies) {
      const model = (typeof e.model === "string" && e.model.trim()) || "mixed";
      const prev = dailyByModel.get(model);
      dailyByModel.set(model, prev ? preferRicherEvent(prev, e) : e);
    }
    const dailies = [...dailyByModel.values()];
    const requests = bucket.requests;

    if (dailies.length === 0) {
      out.push(...requests);
      continue;
    }
    if (requests.length === 0) {
      out.push(...dailies);
      continue;
    }

    const dailyTok = dailies.reduce((a, e) => a + eventTokenWeight(e), 0);
    const reqTok = requests.reduce((a, e) => a + eventTokenWeight(e), 0);
    const dailyCost = dailies.reduce((a, e) => a + (Number(e.estimatedCost) || 0), 0);
    const reqCost = requests.reduce((a, e) => a + (Number(e.estimatedCost) || 0), 0);

    // Prefer overcount: always keep the higher token side; never both (double).
    // Tie → higher cost; still tie → more rows (more detail, slight overcount bias).
    const preferRequests =
      reqTok > dailyTok ||
      (reqTok === dailyTok && reqCost > dailyCost) ||
      (reqTok === dailyTok &&
        reqCost === dailyCost &&
        requests.length > dailies.length);

    if (preferRequests) out.push(...requests);
    else out.push(...dailies);
  }
  return out;
}

/**
 * Drop byte-identical clones (same agent/time/tokens/source, different id).
 * Common after Devin sqlite + jsonl both ingested the same message_nodes row.
 */
export function collapseExactUsageDuplicates(events: UsageEvent[]): UsageEvent[] {
  if (!Array.isArray(events) || events.length === 0) return events || [];
  const best = new Map<string, UsageEvent>();
  for (const e of events) {
    if (!e || typeof e.id !== "string") continue;
    const key = [
      e.agent,
      e.timestamp || "",
      e.model || "",
      e.inputTokens || 0,
      e.outputTokens || 0,
      e.cacheReadTokens || 0,
      e.cacheWriteTokens || 0,
      e.sourcePath || "",
    ].join("|");
    const prev = best.get(key);
    best.set(key, prev ? preferRicherEvent(prev, e) : e);
  }
  return [...best.values()];
}

export async function loadImportedEvents(): Promise<UsageEvent[]> {
  const p = importedEventsPath();
  try {
    if (!(await pathExists(p))) return [];
    const raw = JSON.parse(await readFile(p, "utf8")) as unknown;
    return sanitizeEvents(raw) || [];
  } catch (err) {
    logError("loadImportedEvents failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

export async function saveImportedEvents(events: UsageEvent[]): Promise<void> {
  const p = importedEventsPath();
  await mkdir(path.dirname(p), { recursive: true });
  const clean = sanitizeEvents(events) || [];
  await writeFile(p, JSON.stringify(clean), "utf8");
  log("saveImportedEvents:", clean.length, "→", p);
}

/** Local disk cache of the last successful full/union scan — survives restart so UI is never empty mid-scan. */
export function scanCachePath(): string {
  return path.join(dataRoot(), "scan-cache.json");
}

export function scanCacheBackupPath(): string {
  return `${scanCachePath()}.bak`;
}

/** Last-known-good archive — survives corrupt main + .bak (e.g. interrupted rename). */
export function scanCacheArchivePath(): string {
  return path.join(dataRoot(), "scan-cache.archive.json");
}

/** Serialize writes — concurrent saveScanCache must not interleave on the same file. */
let scanCacheSaveChain: Promise<void> = Promise.resolve();

async function readScanCacheFile(filePath: string): Promise<UsageEvent[]> {
  const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  return sanitizeEvents(raw) || [];
}

/**
 * Recover individual event objects from a truncated / corrupt JSON array.
 * Used when a large scan-cache write is interrupted mid-file.
 */
export function salvageScanCacheJson(text: string): UsageEvent[] {
  const out: UsageEvent[] = [];
  if (!text || !text.includes("{")) return out;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1)) as unknown;
          const batch = sanitizeEvents([obj]);
          if (batch?.[0]) out.push(batch[0]);
        } catch {
          /* skip partial object */
        }
        start = -1;
      }
    }
  }
  return out;
}

async function loadScanCacheCandidate(filePath: string): Promise<UsageEvent[] | null> {
  if (!(await pathExists(filePath))) return null;
  try {
    const events = await readScanCacheFile(filePath);
    return events.length > 0 ? events : null;
  } catch {
    try {
      const text = await readFile(filePath, "utf8");
      const salvaged = salvageScanCacheJson(text);
      if (salvaged.length > 0) {
        log("loadScanCache: salvaged", salvaged.length, "events from corrupt →", filePath);
        return salvaged;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function scanCacheScore(events: UsageEvent[]): { count: number; tokens: number } {
  let tokens = 0;
  for (const e of events) tokens += eventTokenWeight(e);
  return { count: events.length, tokens };
}

export async function loadScanCache(): Promise<UsageEvent[]> {
  const p = scanCachePath();
  const candidates = [p, scanCacheBackupPath(), scanCacheArchivePath()];
  let best: UsageEvent[] = [];
  let bestScore = { count: 0, tokens: 0 };
  let bestFrom = "";
  for (const candidate of candidates) {
    const events = await loadScanCacheCandidate(candidate);
    if (!events || events.length === 0) continue;
    const score = scanCacheScore(events);
    // Prefer more events; on near-ties pick higher token weight so a truncated
    // progressive write does not beat a slightly shorter but complete cache.
    const better =
      score.count > bestScore.count + 50 ||
      (score.count >= bestScore.count - 50 && score.tokens > bestScore.tokens) ||
      (score.count > bestScore.count && score.tokens >= bestScore.tokens * 0.9);
    if (better || best.length === 0) {
      best = events;
      bestScore = score;
      bestFrom = candidate;
    }
  }
  if (best.length > 0) {
    if (bestFrom !== p) {
      log("loadScanCache: recovered", best.length, "events from →", bestFrom);
    }
    // Heal legacy unstable daily ids + exact clones so restart totals stay honest.
    return collapseExactUsageDuplicates(collapseRouterDailyEvents(best));
  }
  logError("loadScanCache: no valid cache file (main + .bak + archive all failed)");
  return [];
}

export type SaveScanCacheOpts = {
  /**
   * - full (default): collapse + .bak + archive (shutdown / end of full scan)
   * - quick: skip heavy collapse + archive (progressive mid-scan) — less CPU/RAM/disk
   */
  mode?: "full" | "quick";
};

export async function saveScanCache(
  events: UsageEvent[],
  opts: SaveScanCacheOpts = {},
): Promise<void> {
  const mode = opts.mode === "quick" ? "quick" : "full";
  // Progressive saves already hold clean-ish rows; skip O(n) collapse passes mid-scan.
  const clean =
    mode === "quick"
      ? events
      : collapseExactUsageDuplicates(
          collapseSourcePathRollups(collapseRouterDailyEvents(sanitizeEvents(events) || [])),
        );
  const p = scanCachePath();
  const bak = scanCacheBackupPath();
  await mkdir(path.dirname(p), { recursive: true });

  const job = scanCacheSaveChain.then(async () => {
    // Keep supervisor hang-watchdog happy during large JSON serialize/write.
    try {
      const { writeHeartbeat } = await import("./process-guard.js");
      writeHeartbeat();
    } catch {
      /* optional */
    }
    // One serialize only — avoid JSON.parse(verify) which doubled peak RAM (~8MB×2+).
    const json = JSON.stringify(clean);
    if (!json.startsWith("[") || !json.endsWith("]")) {
      throw new Error("scan cache serialize produced non-array JSON");
    }

    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmp, json, "utf8");
      await rename(tmp, p);
      // .bak every write so corrupt main is recoverable
      try {
        await copyFile(p, bak);
      } catch (err) {
        logError("saveScanCache: backup copy failed:", err instanceof Error ? err.message : err);
      }
      // Archive only on full saves (not every progressive tick)
      if (mode === "full") {
        try {
          await copyFile(p, scanCacheArchivePath());
        } catch (err) {
          logError("saveScanCache: archive copy failed:", err instanceof Error ? err.message : err);
        }
      }
      log("saveScanCache:", clean.length, mode, "→", p);
      try {
        const { writeHeartbeat } = await import("./process-guard.js");
        writeHeartbeat();
      } catch {
        /* optional */
      }
    } catch (err) {
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
  });

  scanCacheSaveChain = job.catch(() => {
    /* keep chain alive for later saves */
  });
  await job;
}

async function listFilesRecursive(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  if (!(await pathExists(dir))) return out;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await listFilesRecursive(full, base)));
    } else if (ent.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out;
}

/**
 * Mirror export: daily / aggregate only (international practice).
 * Never ship multi‑MB per-request histories (usage-history.jsonl, etc.).
 */
const MIRROR_MAX_TOTAL_BYTES = 8 * 1024 * 1024; // 8 MB total
const MIRROR_MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB per file

/** Basename allow-list for compact aggregate mirrors */
const MIRROR_ALLOW_NAMES = new Set([
  "usage-daily.json",
  "usagedaily.json",
  "dailysummary.json",
  "db.json",
  "usage.json",
  "usagedata.json",
  "config.json",
  "ok.json",
]);

function isRequestLevelMirror(rel: string): boolean {
  const base = rel.split("/").pop()?.toLowerCase() || "";
  if (base.endsWith(".jsonl")) return true;
  if (base.includes("usage-history") || base.includes("usagehistory")) return true;
  if (base.includes("request-detail") || base.includes("requestdetail")) return true;
  if (base.includes("history") && base.endsWith(".jsonl")) return true;
  return false;
}

function isAllowedMirror(rel: string): boolean {
  if (isRequestLevelMirror(rel)) return false;
  const base = rel.split("/").pop()?.toLowerCase() || "";
  if (MIRROR_ALLOW_NAMES.has(base)) return true;
  // small json aggregates only
  if (base.endsWith(".json") && !base.includes("history")) return true;
  return false;
}

async function collectMirrors(): Promise<{
  files: Record<string, string>;
  fileCount: number;
  bytes: number;
  skipped: string[];
}> {
  const root = mirrorsRoot();
  const files: Record<string, string> = {};
  const skipped: string[] = [];
  let bytes = 0;
  const rels = await listFilesRecursive(root);
  for (const rel of rels.sort()) {
    if (!isAllowedMirror(rel)) {
      skipped.push(`${rel} (request-level or disallowed)`);
      continue;
    }
    const full = path.join(root, ...rel.split("/"));
    try {
      const st = await stat(full);
      if (st.size > MIRROR_MAX_FILE_BYTES) {
        skipped.push(`${rel} (${Math.round(st.size / 1024)}KB > cap)`);
        continue;
      }
      if (bytes + st.size > MIRROR_MAX_TOTAL_BYTES) {
        skipped.push(`${rel} (over total cap)`);
        continue;
      }
      const text = await readFile(full, "utf8");
      files[rel] = text;
      bytes += Buffer.byteLength(text, "utf8");
    } catch {
      skipped.push(rel);
    }
  }
  return { files, fileCount: Object.keys(files).length, bytes, skipped };
}

export function buildSettingsBackup(opts?: { eventCountHint?: number; note?: string }): XlabBackup {
  const mid = getMachineId();
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: VERSION,
    exportedAt: new Date().toISOString(),
    platform: process.platform,
    scope: "settings",
    config: buildPortableConfig(),
    meta: {
      note:
        opts?.note ||
        "XLab Token backup file (settings): timezone, pricing, host/port, gist link — same format as Gist/full",
      eventCount: opts?.eventCountHint,
      machineId: mid,
      machines: [mid],
    },
  };
}

/** @deprecated use buildSettingsBackup or buildFullBackup */
export function buildBackup(opts?: { eventCountHint?: number; note?: string }): XlabBackup {
  return buildSettingsBackup(opts);
}

export async function buildFullBackup(opts: {
  events: UsageEvent[];
  includeMirrors?: boolean;
  note?: string;
}): Promise<XlabBackup> {
  const base = buildSettingsBackup({
    eventCountHint: opts.events.length,
    note:
      opts.note ||
      "XLab Token backup file (full): settings + events + periodStats + OpenRouter + mirrors",
  });
  base.scope = "full";

  // Events (in-memory scan cache) — same objects when possible (avoid map clone RAM)
  base.events = opts.events;

  // Dashboard periods (same shape as Gist) so full export stays one format
  try {
    base.periodStats = buildPeriodStats(opts.events, base.config.timezone || "local");
    const all = base.periodStats.all;
    if (all) {
      base.meta = {
        ...base.meta,
        modelCount: all.byModel.length,
        agentCount: all.byAgent.length,
      };
    }
  } catch {
    /* optional — never fail full export */
  }

  // OpenRouter catalog from memory or disk
  const memModels = getOpenRouterModelsSync();
  const memAt = getOpenRouterFetchedAt();
  if (memModels.length > 0) {
    base.openrouter = { fetchedAt: memAt || Date.now(), models: memModels };
  } else {
    try {
      const p = openrouterCachePath();
      if (await pathExists(p)) {
        const raw = JSON.parse(await readFile(p, "utf8")) as {
          fetchedAt?: number;
          models?: OpenRouterModelEntry[];
        };
        if (Array.isArray(raw.models) && raw.models.length) {
          base.openrouter = {
            fetchedAt: Number(raw.fetchedAt) || Date.now(),
            models: raw.models,
          };
        }
      }
    } catch {
      // optional
    }
  }

  let mirrorFileCount = 0;
  let mirrorBytes = 0;
  if (opts.includeMirrors !== false) {
    const m = await collectMirrors();
    if (m.fileCount > 0) {
      base.mirrors = m.files;
      mirrorFileCount = m.fileCount;
      mirrorBytes = m.bytes;
    }
    if (m.skipped.length) {
      base.meta = {
        ...base.meta,
        note:
          (base.meta?.note || "") +
          ` · skipped mirrors: ${m.skipped.slice(0, 5).join(", ")}${m.skipped.length > 5 ? "…" : ""}`,
      };
    }
  }

  base.meta = {
    ...base.meta,
    eventCount: base.events.length,
    openrouterModelCount: base.openrouter?.models.length || 0,
    mirrorFileCount,
    mirrorBytes,
  };
  return base;
}

export function isXlabBackup(raw: unknown): raw is XlabBackup {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  return o.format === BACKUP_FORMAT && typeof o.config === "object" && o.config != null;
}

export type RestoreResult = {
  ok: true;
  config: XlabTokenConfig;
  customRateCount: number;
  events?: UsageEvent[];
  openrouterRestored: boolean;
  mirrorsRestored: number;
  scope: BackupScope | "settings";
};

async function restoreOpenrouter(or: XlabBackup["openrouter"]): Promise<boolean> {
  if (!or || !Array.isArray(or.models) || or.models.length === 0) return false;
  const mod = await import("./openrouter-models.js");
  await mod.replaceOpenRouterCache({
    fetchedAt: Number(or.fetchedAt) || Date.now(),
    models: or.models,
  });
  return true;
}

function safeMirrorPath(root: string, rel: string): string | null {
  if (!rel || typeof rel !== "string") return null;
  // Normalize separators; reject absolute / drive-letter / parent segments
  const normalized = rel.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!normalized) return null;
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) return null;
  if (normalized.split("/").some((p) => p === ".." || p === "" || p === ".")) return null;
  const rootResolved = path.resolve(root);
  const full = path.resolve(rootResolved, ...normalized.split("/"));
  const prefix = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  if (full !== rootResolved && !full.startsWith(prefix)) return null;
  return full;
}

async function restoreMirrors(mirrors: Record<string, string> | undefined): Promise<number> {
  if (!mirrors || typeof mirrors !== "object") return 0;
  const root = mirrorsRoot();
  let n = 0;
  for (const [rel, content] of Object.entries(mirrors)) {
    if (typeof content !== "string") continue;
    const full = safeMirrorPath(root, rel);
    if (!full) continue;
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
    n += 1;
  }
  return n;
}

function sanitizeEvents(raw: unknown): UsageEvent[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: UsageEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.agent !== "string") continue;
    const inputTokens = Number(e.inputTokens) || 0;
    const outputTokens = Number(e.outputTokens) || 0;
    const cacheReadTokens = Number(e.cacheReadTokens) || 0;
    const cacheWriteTokens = Number(e.cacheWriteTokens) || 0;
    out.push({
      id: e.id,
      agent: e.agent as UsageEvent["agent"],
      model: e.model == null ? null : String(e.model),
      timestamp: typeof e.timestamp === "string" ? e.timestamp : new Date().toISOString(),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens:
        Number(e.totalTokens) ||
        inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      estimatedCost: e.estimatedCost == null ? null : Number(e.estimatedCost),
      currency: typeof e.currency === "string" ? e.currency : "USD",
      pricingStatus:
        e.pricingStatus === "priced" ||
        e.pricingStatus === "unknown_model" ||
        e.pricingStatus === "zero_rate" ||
        e.pricingStatus === "estimated"
          ? e.pricingStatus
          : "estimated",
      workspace: e.workspace == null ? null : String(e.workspace),
      sourcePath: typeof e.sourcePath === "string" ? e.sourcePath : "backup",
      estimated: Boolean(e.estimated),
    });
  }
  return out;
}

/** Restore config (+ optional events / openrouter / mirrors). Same file format as Gist. */
export async function restoreBackup(raw: unknown): Promise<RestoreResult> {
  if (!isXlabBackup(raw)) {
    throw new Error("Invalid backup file (expected xlab-token-backup format)");
  }
  const prev = await loadConfig();
  const incoming = raw.config || {};
  const rates = incoming.pricing?.customRates;
  const inBackup = incoming.backup && typeof incoming.backup === "object" ? incoming.backup : null;

  const next = await saveConfig({
    ...prev,
    timezone:
      typeof incoming.timezone === "string" && incoming.timezone.trim()
        ? incoming.timezone.trim()
        : prev.timezone,
    host: typeof incoming.host === "string" && incoming.host.trim() ? incoming.host.trim() : prev.host,
    port:
      typeof incoming.port === "number" && Number.isFinite(incoming.port) ? incoming.port : prev.port,
    pricing: {
      ...prev.pricing,
      currency: incoming.pricing?.currency || prev.pricing?.currency || "USD",
      preferRouterCost:
        typeof incoming.pricing?.preferRouterCost === "boolean"
          ? incoming.pricing.preferRouterCost
          : prev.pricing?.preferRouterCost,
      customRates:
        rates && typeof rates === "object"
          ? { ...rates }
          : prev.pricing?.customRates || {},
    },
    backup: {
      ...prev.backup,
      // Restore gist link metadata only — never a token from file
      ...(inBackup?.gistId ? { gistId: String(inBackup.gistId) } : {}),
      ...(inBackup?.gistUrl ? { gistUrl: String(inBackup.gistUrl) } : {}),
      ...(inBackup?.lastBackupAt ? { lastBackupAt: String(inBackup.lastBackupAt) } : {}),
      ...(typeof inBackup?.autoDaily === "boolean" ? { autoDaily: inBackup.autoDaily } : {}),
    },
  });

  const events = sanitizeEvents(raw.events);
  const openrouterRestored = await restoreOpenrouter(raw.openrouter);
  const mirrorsRestored = await restoreMirrors(raw.mirrors);
  const scope: BackupScope =
    raw.scope === "period-stats"
      ? "period-stats"
      : raw.scope === "full" ||
          (events && events.length > 0) ||
          openrouterRestored ||
          mirrorsRestored > 0
        ? "full"
        : "settings";

  return {
    ok: true,
    config: next,
    customRateCount: Object.keys(next.pricing?.customRates || {}).length,
    events,
    openrouterRestored,
    mirrorsRestored,
    scope,
  };
}

export type GistUploadResult = {
  id: string;
  htmlUrl: string;
  public: boolean;
  updated: boolean;
};

function githubToken(fromBody?: string | null): string | null {
  const t =
    (fromBody && String(fromBody).trim()) ||
    process.env.XLAB_GITHUB_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    getConfigSync().backup?.githubToken?.trim() ||
    "";
  return t || null;
}

/** GitHub Gist hard-ish limit; keep headroom under 100MB API max */
const GIST_MAX_BYTES = 50 * 1024 * 1024;

function toCompactRow(t: TokenTotals): CompactTokenRow {
  return {
    inputTokens: t.inputTokens || 0,
    outputTokens: t.outputTokens || 0,
    cacheReadTokens: t.cacheReadTokens || 0,
    cacheWriteTokens: t.cacheWriteTokens || 0,
    totalTokens: t.totalTokens || 0,
    estimatedCost: t.estimatedCost || 0,
    eventCount: t.eventCount || 0,
  };
}

const GIST_PERIODS: ReadonlyArray<{ key: GistPeriodKey; since: string | null }> = [
  { key: "today", since: "today" },
  { key: "24h", since: "24h" },
  { key: "7d", since: "7d" },
  { key: "30d", since: "30d" },
  { key: "all", since: null },
];

/**
 * Aggregate usage into dashboard periods (Today / 24h / 7D / 30D / All)
 * with both **by model** and **by agent** breakdowns.
 */
export function buildPeriodStats(
  events: UsageEvent[],
  timeZone?: string | null,
): Record<GistPeriodKey, PeriodSnapshot> {
  const tz = timeZone ?? getConfigSync().timezone ?? "local";
  const out = {} as Record<GistPeriodKey, PeriodSnapshot>;
  for (const p of GIST_PERIODS) {
    const filtered = filterByPeriod(events, p.since, null, tz);
    const byModel = aggregate(filtered, "model", "cost", p.since, null);
    const byAgent = aggregate(filtered, "agent", "cost", p.since, null);
    out[p.key] = {
      period: p.key,
      since: p.since,
      totals: toCompactRow(byModel.totals),
      byModel: byModel.groups.map((g) => ({ key: g.key, ...toCompactRow(g) })),
      byAgent: byAgent.groups.map((g) => ({ key: g.key, ...toCompactRow(g) })),
    };
  }
  return out;
}

type RollupAcc = {
  agent: UsageEvent["agent"];
  model: string | null;
  /** Bucket id: day `YYYY-MM-DD` or hour `YYYY-MM-DDTHH` */
  bucket: string;
  kind: "hour" | "day";
  /** Latest source timestamp in bucket — keeps Today/24h/7d filters accurate */
  lastTs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedCost: number;
  eventCount: number;
};

function addToRollup(row: RollupAcc, e: UsageEvent, ts: number): void {
  row.inputTokens += Number(e.inputTokens) || 0;
  row.outputTokens += Number(e.outputTokens) || 0;
  row.cacheReadTokens += Number(e.cacheReadTokens) || 0;
  row.cacheWriteTokens += Number(e.cacheWriteTokens) || 0;
  row.totalTokens +=
    Number(e.totalTokens) ||
    (Number(e.inputTokens) || 0) +
      (Number(e.outputTokens) || 0) +
      (Number(e.cacheReadTokens) || 0) +
      (Number(e.cacheWriteTokens) || 0);
  row.estimatedCost += Number(e.estimatedCost) || 0;
  row.eventCount += 1;
  if (ts > row.lastTs) row.lastTs = ts;
}

/** Stable machine id for multi-host Gist sync (hostname). */
export function getMachineId(): string {
  const env =
    process.env.XLAB_MACHINE_ID?.trim() ||
    process.env.COMPUTERNAME?.trim() ||
    process.env.HOSTNAME?.trim() ||
    "";
  if (env) return sanitizeMachineId(env);
  try {
    return sanitizeMachineId(os.hostname() || "unknown");
  } catch {
    return "unknown";
  }
}

function sanitizeMachineId(raw: string): string {
  const s = String(raw)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return s || "unknown";
}

/**
 * Parse machine id from Gist rollup.
 * `backup:gist-hour:DESKTOP-A` / `backup:gist-daily:laptop` — legacy untagged → "".
 */
export function machineIdFromEvent(e: UsageEvent): string {
  const sp = typeof e.sourcePath === "string" ? e.sourcePath : "";
  if (sp.startsWith("backup:gist-hour:") || sp.startsWith("backup:gist-daily:")) {
    const mid = sp.split(":").slice(2).join(":").trim();
    if (mid) return sanitizeMachineId(mid);
  }
  // Legacy rows stored hostname in workspace
  if (isGistRollupEvent(e) && typeof e.workspace === "string" && e.workspace.trim()) {
    return sanitizeMachineId(e.workspace);
  }
  return "";
}

function rollupAccToEvent(row: RollupAcc, machineId: string): UsageEvent {
  const mid = sanitizeMachineId(machineId || "unknown");
  const prefix = row.kind === "hour" ? "gist-hour" : "gist-daily";
  const basePath = row.kind === "hour" ? "backup:gist-hour" : "backup:gist-daily";
  return {
    id: stableId(prefix, mid, row.bucket, row.agent, row.model || "unknown"),
    agent: row.agent,
    model: row.model,
    timestamp: new Date(row.lastTs).toISOString(),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    totalTokens: row.totalTokens,
    estimatedCost: row.estimatedCost,
    currency: "USD",
    pricingStatus: "estimated",
    workspace: mid,
    sourcePath: `${basePath}:${mid}`,
    estimated: true,
  };
}

/**
 * Compact restore rows for Gist (per machine):
 * - last 8 days → hour × agent × model (Today / 24h / 7D stay accurate)
 * - older → day × agent × model (30D / All)
 * Timestamp = last event in bucket so rolling windows match source.
 */
export function buildGistRestoreRollups(
  events: UsageEvent[],
  nowMs = Date.now(),
  machineId: string = getMachineId(),
): UsageEvent[] {
  // 8d of hourly covers rolling 7d without whole-day bleed at the window edge
  const hourCutoff = nowMs - 8 * 86_400_000;
  const map = new Map<string, RollupAcc>();
  const mid = sanitizeMachineId(machineId || getMachineId());

  for (const e of events) {
    if (!e || typeof e.agent !== "string") continue;
    // Skip already-imported rollups from other machines (do not re-bucket)
    if (isGistRollupEvent(e)) continue;
    const ts = new Date(e.timestamp).getTime();
    if (Number.isNaN(ts)) continue;
    const model = normalizeModelName(e.model);
    const useHour = ts >= hourCutoff;
    const bucket = useHour
      ? new Date(ts).toISOString().slice(0, 13) // YYYY-MM-DDTHH
      : new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
    const kind: "hour" | "day" = useHour ? "hour" : "day";
    const key = `${kind}|${bucket}|${e.agent}|${model || ""}`;
    let row = map.get(key);
    if (!row) {
      row = {
        agent: e.agent,
        model,
        bucket,
        kind,
        lastTs: ts,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        estimatedCost: 0,
        eventCount: 0,
      };
      map.set(key, row);
    }
    addToRollup(row, e, ts);
  }

  return [...map.values()].map((row) => rollupAccToEvent(row, mid));
}

/** @deprecated use buildGistRestoreRollups */
export function buildDailyAgentModelRollups(events: UsageEvent[]): UsageEvent[] {
  return buildGistRestoreRollups(events);
}

export function isGistRollupEvent(e: UsageEvent): boolean {
  return typeof e.sourcePath === "string" && e.sourcePath.startsWith("backup:gist");
}

/** day|agent|model key for collapse / anti-double-count */
export function gistCoverageKey(e: UsageEvent): string {
  const day = (e.timestamp || "").slice(0, 10);
  const model = normalizeModelName(e.model) || "";
  return `${day}|${e.agent}|${model}`;
}

/**
 * Merge local scan with imported (Gist) events.
 * - Always keep other machines' rollups (multi-host sum).
 * - Drop **this machine's** Gist rollups when local already has real scan rows
 *   for the same day×agent×model (avoids double-count after rescan).
 */
export function mergeLocalPreferOverGistRollups(
  local: UsageEvent[],
  imported: UsageEvent[],
  machineId: string = getMachineId(),
): UsageEvent[] {
  // Fast path: no imports → no allocation / merge cost
  if (!imported || imported.length === 0) return local || [];
  if (!local || local.length === 0) return imported;

  const mid = sanitizeMachineId(machineId || getMachineId());
  const covered = new Set<string>();
  for (const e of local) {
    if (!e || typeof e.agent !== "string") continue;
    if (isGistRollupEvent(e)) continue;
    covered.add(gistCoverageKey(e));
  }
  const filteredImported = imported.filter((e) => {
    if (!e || typeof e.agent !== "string") return false;
    if (!isGistRollupEvent(e)) return true;
    const eventMid = machineIdFromEvent(e);
    // Other machine (or legacy untagged treated as foreign): always keep for sum
    if (eventMid && eventMid !== mid) return true;
    // Same machine (or untagged on this host): drop if local scan covers key
    return !covered.has(gistCoverageKey(e));
  });
  if (filteredImported.length === 0) return local;
  return mergeEventsByIdPreferRicher(local, filteredImported);
}

/**
 * Multi-machine Gist merge:
 * keep remote rollups from **other** machines + this machine's fresh local rollups.
 * Same machine remote rows are replaced by local (local is source of truth).
 */
export function mergeMultiMachineGistRollups(
  localRollups: UsageEvent[],
  remoteEvents: UsageEvent[] | undefined,
  machineId: string = getMachineId(),
): UsageEvent[] {
  const mid = sanitizeMachineId(machineId || getMachineId());
  const others: UsageEvent[] = [];
  for (const e of remoteEvents || []) {
    if (!e || typeof e.agent !== "string") continue;
    if (!isGistRollupEvent(e)) {
      // Legacy full-event backups: keep as-is (different ids)
      others.push(e);
      continue;
    }
    const eventMid = machineIdFromEvent(e);
    // Untagged legacy rollups: treat as foreign so we don't wipe history on first multi upgrade
    if (!eventMid || eventMid !== mid) others.push(e);
  }
  return mergeEventsByIdPreferRicher(others, localRollups);
}

function listMachinesFromEvents(events: UsageEvent[], fallback?: string): string[] {
  const set = new Set<string>();
  if (fallback) set.add(sanitizeMachineId(fallback));
  for (const e of events) {
    const mid = machineIdFromEvent(e);
    if (mid) set.add(mid);
  }
  return [...set].sort();
}

/**
 * Gist-tuned backup: settings + **by model / by agent** for Today·24h·7D·30D·All
 * + hour/day rollups. Supports multi-machine: pass `remoteEvents` from existing Gist
 * so other hosts are kept and usage is summed in periodStats.
 */
export async function buildGistFullBackup(
  events: UsageEvent[],
  opts?: {
    remoteEvents?: UsageEvent[];
    machineId?: string;
    remoteConfig?: XlabBackup["config"];
  },
): Promise<XlabBackup> {
  const cfg = getConfigSync();
  const tz = cfg.timezone || "local";
  const mid = sanitizeMachineId(opts?.machineId || getMachineId());
  const localRollups = buildGistRestoreRollups(events, Date.now(), mid);
  const mergedRollups = mergeMultiMachineGistRollups(localRollups, opts?.remoteEvents, mid);
  // periodStats from merged rollups = sum across all machines
  const periodStats = buildPeriodStats(mergedRollups, tz);
  const allSnap = periodStats.all;
  const modelCount = allSnap?.byModel.length || 0;
  const agentCount = allSnap?.byAgent.length || 0;
  const hourCount = mergedRollups.filter((e) => String(e.sourcePath).includes("gist-hour")).length;
  const dayCount = mergedRollups.length - hourCount;
  const machines = listMachinesFromEvents(mergedRollups, mid);

  // Merge custom rates from remote + local (local wins on conflict)
  const remoteRates = opts?.remoteConfig?.pricing?.customRates || {};
  const localRates = cfg.pricing?.customRates || {};
  const base = buildSettingsBackup({
    eventCountHint: events.length,
    note: "XLab Token backup file (Gist/period-stats): full project settings + multi-machine usage sum",
  });
  // Same portable config as export; merge rates; keep remote gist id if local missing
  base.config = {
    ...buildPortableConfig(),
    pricing: {
      currency: cfg.pricing?.currency || "USD",
      preferRouterCost: cfg.pricing?.preferRouterCost !== false,
      customRates: { ...remoteRates, ...localRates },
    },
    backup: {
      ...(opts?.remoteConfig?.backup || {}),
      ...(buildPortableConfig().backup || {}),
    },
  };
  base.formatVersion = BACKUP_FORMAT_VERSION;
  base.scope = "period-stats";
  base.periodStats = periodStats;
  base.events = mergedRollups;
  base.meta = {
    ...base.meta,
    eventCount: events.length,
    sourceEventCount: events.length,
    rollupEventCount: mergedRollups.length,
    modelCount,
    agentCount,
    machineId: mid,
    machines,
    openrouterModelCount: 0,
    mirrorFileCount: 0,
    mirrorBytes: 0,
    note:
      (base.meta?.note || "") +
      ` · machines: ${machines.join(", ") || mid} · ${modelCount} models · ${agentCount} agents · ${hourCount}h+${dayCount}d rollups`,
  };
  return base;
}

const GIST_BACKUP_FILENAME = "xlab-token-backup.json";

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": `xlab-token/${VERSION}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Fetch existing Gist backup JSON (no restore). Returns null if missing/invalid.
 * Used for multi-machine merge before upload.
 */
export async function fetchGistBackup(opts: {
  token: string;
  gistId: string;
}): Promise<XlabBackup | null> {
  const gistId = String(opts.gistId || "").trim();
  if (!gistId || !opts.token) return null;
  try {
    const res = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, {
      method: "GET",
      headers: githubHeaders(opts.token),
    });
    if (!res.ok) {
      log("fetchGistBackup:", res.status, "for", gistId);
      return null;
    }
    const data = (await res.json()) as {
      files?: Record<string, { content?: string; truncated?: boolean; raw_url?: string }>;
    };
    const file =
      data.files?.[GIST_BACKUP_FILENAME] ?? Object.values(data.files || {})[0];
    if (!file) return null;

    let text = file.content || "";
    // Large gists may truncate content — pull raw_url
    if (file.truncated && file.raw_url) {
      const rawRes = await fetch(file.raw_url, {
        headers: {
          Authorization: `Bearer ${opts.token}`,
          "User-Agent": `xlab-token/${VERSION}`,
        },
      });
      if (rawRes.ok) text = await rawRes.text();
    }
    if (!text) return null;
    const raw = JSON.parse(text) as unknown;
    if (!isXlabBackup(raw)) return null;
    return raw;
  } catch (err) {
    logError("fetchGistBackup failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Create or update a secret GitHub Gist with **period usage**.
 * Multi-machine: downloads existing Gist first, keeps other hosts' rollups,
 * replaces this host's slice, periodStats = sum of all machines.
 */
export async function uploadBackupToGist(opts: {
  token?: string | null;
  gistId?: string | null;
  public?: boolean;
  eventCountHint?: number;
  saveToken?: boolean;
  /** @deprecated Gist always uploads period-stats when events are provided */
  scope?: BackupScope;
  events?: UsageEvent[];
}): Promise<{ backup: XlabBackup; gist: GistUploadResult; scope: BackupScope }> {
  log("uploadBackupToGist called");
  log("Options gistId:", opts.gistId, "public:", opts.public, "saveToken:", opts.saveToken, "events:", opts.events?.length ?? 0);

  const token = githubToken(opts.token);
  if (!token) {
    logError("Missing GitHub token");
    throw new Error(
      "Missing GitHub token. Pass token, set XLAB_GITHUB_TOKEN / GITHUB_TOKEN, or save one in Settings.",
    );
  }
  log("GitHub token resolved (length):", token.length);

  const prevId =
    (opts.gistId && String(opts.gistId).trim()) ||
    getConfigSync().backup?.gistId ||
    "";

  // Multi-machine: pull remote before overwrite
  let remote: XlabBackup | null = null;
  if (prevId) {
    remote = await fetchGistBackup({ token, gistId: prevId });
    if (remote) {
      log(
        "Fetched remote Gist for merge: events=",
        remote.events?.length ?? 0,
        "machines=",
        remote.meta?.machines?.join(",") || remote.meta?.machineId || "?",
      );
    }
  }

  // Period-stats (by model + agent) when we have the event cache
  let backup: XlabBackup;
  let scope: BackupScope = "period-stats";
  if (opts.events && opts.events.length >= 0) {
    backup = await buildGistFullBackup(opts.events, {
      remoteEvents: remote?.events,
      remoteConfig: remote?.config,
    });
    scope = "period-stats";
  } else {
    backup = buildSettingsBackup({
      eventCountHint: opts.eventCountHint,
      note: "Settings only — no usage cache available at upload time; Rescan then backup again",
    });
    scope = "settings";
  }
  log(
    "Backup built, scope:",
    scope,
    "sourceEvents:",
    backup.meta?.sourceEventCount ?? 0,
    "rollups:",
    backup.events?.length ?? 0,
    "models:",
    backup.meta?.modelCount ?? 0,
    "agents:",
    backup.meta?.agentCount ?? 0,
    "machines:",
    backup.meta?.machines?.join(",") || backup.meta?.machineId || "",
  );

  // Compact JSON (no pretty-print)
  let content = JSON.stringify(backup);
  let size = Buffer.byteLength(content, "utf8");

  if (size > GIST_MAX_BYTES) {
    throw new Error(
      `Period-stats backup is ${Math.round(size / 1024 / 1024)}MB (limit ~${Math.round(GIST_MAX_BYTES / 1024 / 1024)}MB). ` +
        `Use Export full download instead, or reduce history.`,
    );
  }

  const filename = GIST_BACKUP_FILENAME;
  const machinesLabel = (backup.meta?.machines || []).join("+") || backup.meta?.machineId || "1host";
  const description = `XLab Token multi-machine · ${machinesLabel} · ${backup.meta?.modelCount || 0} models · ${backup.meta?.agentCount || 0} agents · ${backup.exportedAt} · v${backup.appVersion}`;

  const headers = githubHeaders(token);

  let res: Response;
  let updated = false;
  if (prevId) {
    res = await fetch(`https://api.github.com/gists/${encodeURIComponent(prevId)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        description,
        files: { [filename]: { content } },
      }),
    });
    updated = true;
    if (res.status === 404) {
      updated = false;
      res = await fetch("https://api.github.com/gists", {
        method: "POST",
        headers,
        body: JSON.stringify({
          description,
          public: opts.public === true,
          files: { [filename]: { content } },
        }),
      });
    }
  } else {
    res = await fetch("https://api.github.com/gists", {
      method: "POST",
      headers,
      body: JSON.stringify({
        description,
        public: opts.public === true,
        files: { [filename]: { content } },
      }),
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub Gist API ${res.status}: ${text.slice(0, 240) || res.statusText}`);
  }

  const data = (await res.json()) as {
    id?: string;
    html_url?: string;
    public?: boolean;
  };
  if (!data.id || !data.html_url) {
    throw new Error("GitHub Gist response missing id/url");
  }

  const gist: GistUploadResult = {
    id: data.id,
    htmlUrl: data.html_url,
    public: Boolean(data.public),
    updated,
  };

  const cfg = await loadConfig();
  await saveConfig({
    ...cfg,
    backup: {
      ...cfg.backup,
      gistId: gist.id,
      gistUrl: gist.htmlUrl,
      lastBackupAt: backup.exportedAt,
      ...(opts.saveToken && token ? { githubToken: token } : {}),
    },
  });
  log("Backup config saved, gistId:", gist.id, "gistUrl:", gist.htmlUrl);

  return { backup, gist, scope };
}

/**
 * Download a backup from a GitHub Gist and restore it locally.
 * If gistId is omitted, uses the one saved in config.
 */
export async function downloadBackupFromGist(opts: {
  token?: string | null;
  gistId?: string | null;
}): Promise<{ backup: XlabBackup; restored: RestoreResult }> {
  log("downloadBackupFromGist called");
  const token = githubToken(opts.token);
  if (!token) {
    logError("Missing GitHub token for download");
    throw new Error(
      "Missing GitHub token. Pass token, set XLAB_GITHUB_TOKEN / GITHUB_TOKEN, or save one in Settings.",
    );
  }

  const gistId = (opts.gistId && String(opts.gistId).trim()) || getConfigSync().backup?.gistId;
  if (!gistId) {
    logError("No gistId provided or saved in config");
    throw new Error("No gistId provided or saved in config.");
  }
  log("Downloading gist:", gistId);

  const backup = await fetchGistBackup({ token, gistId });
  if (!backup) {
    logError("Gist has no usable backup file");
    throw new Error("Gist has no usable backup file (or invalid format).");
  }

  log(
    "Backup downloaded, events:",
    backup.events?.length ?? 0,
    "scope:",
    backup.scope,
    "machines:",
    backup.meta?.machines?.join(",") || backup.meta?.machineId || "",
  );
  const restored = await restoreBackup(backup);
  log("Backup restored, scope:", restored.scope);

  // Save gist metadata to config if not present
  const cfg = await loadConfig();
  if (!cfg.backup?.gistId && gistId) {
    await saveConfig({
      ...cfg,
      backup: {
        ...cfg.backup,
        gistId,
      },
    });
    log("Saved gist metadata to config");
  }

  return { backup, restored };
}

/**
 * True if lastBackupAt is on or after the start of "today" in the given timezone
 * (same calendar day as dashboard "Today").
 */
export function isBackupDoneToday(
  lastBackupAt: string | null | undefined,
  timeZone?: string | null,
): boolean {
  if (!lastBackupAt) return false;
  const last = new Date(lastBackupAt);
  if (Number.isNaN(last.getTime())) return false;
  const start = startOfDayInTimeZone(timeZone, new Date());
  return last.getTime() >= start.getTime();
}

export type AutoDailyGistResult =
  | { ok: true; skipped: true; reason: string }
  | { ok: true; skipped: false; gist: GistUploadResult; exportedAt: string }
  | { ok: false; error: string };

let autoDailyGistInFlight: Promise<AutoDailyGistResult> | null = null;

/**
 * Background daily Gist backup when gistId + token exist and autoDaily !== false.
 * At most one successful upload per local calendar day (uses lastBackupAt).
 */
export async function tryAutoDailyGistBackup(events: UsageEvent[]): Promise<AutoDailyGistResult> {
  if (autoDailyGistInFlight) return autoDailyGistInFlight;

  autoDailyGistInFlight = (async (): Promise<AutoDailyGistResult> => {
    try {
      const cfg = getConfigSync();
      if (cfg.backup?.autoDaily === false) {
        return { ok: true, skipped: true, reason: "disabled" };
      }
      const gistId = cfg.backup?.gistId?.trim();
      const token = githubToken();
      if (!gistId) return { ok: true, skipped: true, reason: "no-gist" };
      if (!token) return { ok: true, skipped: true, reason: "no-token" };
      if (isBackupDoneToday(cfg.backup?.lastBackupAt, cfg.timezone)) {
        return { ok: true, skipped: true, reason: "already-today" };
      }
      if (!events || events.length === 0) {
        return { ok: true, skipped: true, reason: "no-events" };
      }

      log("auto daily Gist backup starting…", events.length, "events");
      const result = await uploadBackupToGist({
        token,
        gistId,
        events,
        public: false,
      });
      log("auto daily Gist backup OK:", result.gist.htmlUrl);
      return {
        ok: true,
        skipped: false,
        gist: result.gist,
        exportedAt: result.backup.exportedAt,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("auto daily Gist backup failed:", msg);
      return { ok: false, error: msg };
    } finally {
      autoDailyGistInFlight = null;
    }
  })();

  return autoDailyGistInFlight;
}
