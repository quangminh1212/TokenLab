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
  normalizeAgentId,
  normalizeModelName,
  pathExists,
  stableId,
  startOfDayInTimeZone,
} from "./util.js";
import { VERSION } from "./version.js";

// Simple file logger to %LOCALAPPDATA%\tokenlab\backup.txt
const logDir = path.join(process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd(), "tokenlab");
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

export const BACKUP_FORMAT = "tokenlab" as const;
/** Legacy format name accepted on import for backward compatibility. */
const BACKUP_FORMAT_LEGACY = "tokenlab-backup";
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
 * `format: "tokenlab"` — settings-only, full, or period-stats (Gist).
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
   * Mirror files under %APPDATA%/tokenlab/mirrors (full scope).
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
  // Backward compat: pre-rename env var still wins (so existing installs don't lose data).
  return process.env.TOKENLAB_DATA_DIR || process.env.XLAB_TOKEN_DATA_DIR || path.join(appDataDir(), "tokenlab");
}

/**
 * Legacy data root before the XLab Token → TokenLab rename (commit a9dfda1).
 * Used by migrateLegacyDataDir() and as a fallback read path so usage never
 * silently drops when a user upgrades without re-running setup.
 *
 * Returns "" when an env override (TOKENLAB_DATA_DIR / XLAB_TOKEN_DATA_DIR) is
 * set — the user is explicitly opting into a custom data dir, so we must not
 * pull in the default %APPDATA%/xlab-token legacy location (breaks tests and
 * isolated dev runs).
 */
export function legacyDataRoot(): string {
  if (process.env.TOKENLAB_DATA_DIR || process.env.XLAB_TOKEN_DATA_DIR) return "";
  return path.join(appDataDir(), "xlab-token");
}

export function mirrorsRoot(): string {
  return path.join(dataRoot(), "mirrors");
}

/** Persisted events from other machines / restores — merged into scan cache by id. */
export function importedEventsPath(): string {
  return path.join(dataRoot(), "imported-events.json");
}

/** Legacy imported-events path under the pre-rename data dir. */
export function legacyImportedEventsPath(): string {
  return path.join(legacyDataRoot(), "imported-events.json");
}

/** Legacy scan-cache path under the pre-rename data dir. */
export function legacyScanCachePath(): string {
  return path.join(legacyDataRoot(), "scan-cache.json");
}

/** Legacy mirrors root under the pre-rename data dir. */
export function legacyMirrorsRoot(): string {
  return path.join(legacyDataRoot(), "mirrors");
}

/**
 * One-time migration from the pre-rename `%APPDATA%/xlab-token` data dir to
 * `%APPDATA%/tokenlab`. Runs at startup. Idempotent — only copies files that
 * are missing or smaller in the new dir, so usage totals can only grow.
 *
 * Why: the rename commit changed dataRoot() without migrating, which silently
 * dropped scan-cache.json, imported-events.json, mirrors/, and config.json.
 * That made all-time usage (especially 9router via VPS mirror + Gist restore)
 * collapse on existing installs.
 */
export async function migrateLegacyDataDir(): Promise<void> {
  const legacy = legacyDataRoot();
  const target = dataRoot();
  if (!legacy || !target) return;
  if (path.resolve(legacy) === path.resolve(target)) return; // env override points at legacy
  if (!(await pathExists(legacy))) return;

  await mkdir(target, { recursive: true });

  // Sentinel so we only run the heavy copy once per machine.
  const sentinel = path.join(target, ".migrated-from-xlab-token");
  if (await pathExists(sentinel)) {
    // Still fall through to per-file fallbacks below for safety, but skip the
    // bulk mirrors/ copy (already done).
  } else {
    // Copy mirrors/ (VPS data) — only files missing in target.
    try {
      if (await pathExists(legacyMirrorsRoot())) {
        await copyDirMissing(legacyMirrorsRoot(), mirrorsRoot());
      }
    } catch (err) {
      logError("migrateLegacyDataDir: mirrors copy failed:", err instanceof Error ? err.message : err);
    }
    try {
      await writeFile(sentinel, new Date().toISOString(), "utf8");
    } catch {
      /* non-fatal */
    }
  }

  // Per-file fallbacks — always run so a partial/failed earlier migration
  // still heals on next start. Only copy when target file is missing OR
  // smaller than the legacy file (usage only grows, never shrinks).
  const filePairs: Array<{ rel: string; legacy: string; target: string }> = [
    { rel: "imported-events.json", legacy: legacyImportedEventsPath(), target: importedEventsPath() },
    { rel: "scan-cache.json", legacy: legacyScanCachePath(), target: scanCachePath() },
    { rel: "scan-cache.json.bak", legacy: `${legacyScanCachePath()}.bak`, target: `${scanCachePath()}.bak` },
    { rel: "scan-cache.archive.json", legacy: path.join(legacyDataRoot(), "scan-cache.archive.json"), target: scanCacheArchivePath() },
  ];
  for (const { rel, legacy: lp, target: tp } of filePairs) {
    try {
      if (!(await pathExists(lp))) continue;
      const legacyStat = await stat(lp);
      let targetSize = 0;
      if (await pathExists(tp)) {
        targetSize = (await stat(tp)).size;
      }
      // Only copy when target is missing or smaller — never overwrite a richer
      // current cache with an older smaller one.
      if (targetSize > 0 && targetSize >= legacyStat.size) continue;
      await mkdir(path.dirname(tp), { recursive: true });
      await copyFile(lp, tp);
      log(`migrateLegacyDataDir: copied ${rel} (${legacyStat.size} bytes) → ${tp}`);
    } catch (err) {
      logError(`migrateLegacyDataDir: copy ${rel} failed:`, err instanceof Error ? err.message : err);
    }
  }

  // Merge legacy config.json into the new one — fill missing keys only.
  // IMPORTANT: always loadConfig() first. getConfigSync() before load returns
  // empty defaults and used to re-import a dead legacy gistId every restart,
  // which made auto-daily POST a brand-new Gist on each run (404 → create).
  try {
    const legacyConfigPath = path.join(legacyDataRoot(), "config.json");
    if (await pathExists(legacyConfigPath)) {
      const legacyCfg = JSON.parse(await readFile(legacyConfigPath, "utf8")) as Record<string, unknown>;
      const cur = await loadConfig();
      const merged: Record<string, unknown> = { ...legacyCfg, ...cur };
      // Deep-merge customRates (legacy rates fill gaps; current wins on conflict)
      const legacyRates = (legacyCfg.pricing as { customRates?: Record<string, unknown> } | undefined)?.customRates;
      const curRates = cur.pricing?.customRates || {};
      if (legacyRates && typeof legacyRates === "object") {
        merged.pricing = {
          ...(cur.pricing || { currency: "USD" }),
          customRates: { ...legacyRates, ...curRates },
        };
      }
      // Gist link: current always wins when set. Never clobber a live gistId
      // with an older deleted one from %APPDATA%/xlab-token.
      if (legacyCfg.backup && typeof legacyCfg.backup === "object") {
        const lb = legacyCfg.backup as Record<string, unknown>;
        const cb = (cur.backup || {}) as Record<string, unknown>;
        const curId = String(cb.gistId || "").trim();
        const legId = String(lb.gistId || "").trim();
        const curUrl = String(cb.gistUrl || "").trim();
        const legUrl = String(lb.gistUrl || "").trim();
        const curLast = String(cb.lastBackupAt || "");
        const legLast = String(lb.lastBackupAt || "");
        const newerLast =
          curLast && legLast
            ? new Date(curLast).getTime() >= new Date(legLast).getTime()
              ? curLast
              : legLast
            : curLast || legLast || undefined;
        merged.backup = {
          ...lb,
          ...cb,
          githubToken: cb.githubToken || lb.githubToken,
          // Prefer current link forever once set (single gist + revisions)
          gistId: curId || legId || undefined,
          gistUrl: (curId ? curUrl : "") || curUrl || legUrl || undefined,
          lastBackupAt: newerLast,
          autoDaily: cb.autoDaily !== undefined ? cb.autoDaily : lb.autoDaily,
        };
      }
      await saveConfig(merged as XlabTokenConfig);
      // Keep legacy file in sync so a future merge cannot resurrect a dead id
      await syncLegacyGistMeta({
        gistId: (merged.backup as { gistId?: string } | undefined)?.gistId,
        gistUrl: (merged.backup as { gistUrl?: string } | undefined)?.gistUrl,
        lastBackupAt: (merged.backup as { lastBackupAt?: string } | undefined)?.lastBackupAt,
      });
      log("migrateLegacyDataDir: merged legacy config.json into current");
    }
  } catch (err) {
    logError("migrateLegacyDataDir: config merge failed:", err instanceof Error ? err.message : err);
  }
}

/** Write gistId/url/lastBackupAt into legacy xlab-token config so migrate cannot resurrect a dead id. */
async function syncLegacyGistMeta(meta: {
  gistId?: string | null;
  gistUrl?: string | null;
  lastBackupAt?: string | null;
}): Promise<void> {
  try {
    const legacyConfigPath = path.join(legacyDataRoot(), "config.json");
    if (!(await pathExists(legacyConfigPath))) return;
    const raw = JSON.parse(await readFile(legacyConfigPath, "utf8")) as Record<string, unknown>;
    const prev = (raw.backup && typeof raw.backup === "object" ? raw.backup : {}) as Record<
      string,
      unknown
    >;
    const nextId = String(meta.gistId || "").trim();
    if (!nextId) return;
    if (
      prev.gistId === nextId &&
      prev.gistUrl === (meta.gistUrl || prev.gistUrl) &&
      prev.lastBackupAt === (meta.lastBackupAt || prev.lastBackupAt)
    ) {
      return;
    }
    raw.backup = {
      ...prev,
      gistId: nextId,
      ...(meta.gistUrl ? { gistUrl: String(meta.gistUrl) } : {}),
      ...(meta.lastBackupAt ? { lastBackupAt: String(meta.lastBackupAt) } : {}),
    };
    await writeFile(legacyConfigPath, JSON.stringify(raw, null, 2), "utf8");
    log("syncLegacyGistMeta: legacy config gistId →", nextId);
  } catch (err) {
    logError("syncLegacyGistMeta failed:", err instanceof Error ? err.message : err);
  }
}

/** Recursively copy files from src → dest, skipping files that already exist in dest. */
async function copyDirMissing(src: string, dest: string): Promise<void> {
  if (!(await pathExists(src))) return;
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      await copyDirMissing(s, d);
    } else if (ent.isFile()) {
      if (await pathExists(d)) continue; // never overwrite — usage only grows
      await copyFile(s, d);
    }
  }
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
 * Order: non-estimated → more tokens → known model over null → higher cost.
 * Official / real usage must never be replaced by a heavier stream residual
 * (Grok residual peak totalTokens often >> uncached+out after cache split).
 * Model fill still beats sticky null-model rows among equal estimate-ness.
 */
export function preferRicherEvent(prev: UsageEvent, next: UsageEvent): UsageEvent {
  // Real (non-estimated) always wins over estimated — even if residual has more tokens.
  if (!next.estimated && prev.estimated) return next;
  if (next.estimated && !prev.estimated) return prev;

  const pt = eventTokenWeight(prev);
  const et = eventTokenWeight(next);
  if (et > pt) return next;
  if (et < pt) return prev;

  const prevModel = hasModelName(prev);
  const nextModel = hasModelName(next);
  if (nextModel && !prevModel) return next;
  if (prevModel && !nextModel) return prev;

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
  // Policy: thà tính thừa còn hơn bỏ sót — usage chỉ tăng, không bao giờ giảm.
  // collapseRouterDailyEvents deduplicates same-provider daily rollups that
  // have different ids (e.g. scanned vs imported/Gist). It collapses by
  // day+model+workspace so different providers are kept separate. Events with
  // null workspace use their id as key (never collapsed — could be different
  // providers, keep all to avoid undercount).
  return collapseExactUsageDuplicates(
    collapseSourcePathRollups(collapseRouterDailyEvents([...byId.values()])),
  );
}

/**
 * Windsurf progressive rescans mint new ids for the same .pb when tokens grow.
 * Keep the richest row per file. Do NOT collapse Grok by timestamp — turns can
 * share a second and must all be kept (prefer overcount over missing turns).
 *
 * Also drops stale Grok stream residuals: older scans minted unique residual ids
 * (peak baked into hash) with output=0. Once real turn_completed.usage exists for
 * that updates.jsonl, those ghosts double-count context as input and pollute
 * RECENT REQUESTS with `model ~ in/0`.
 */
export function collapseSourcePathRollups(events: UsageEvent[]): UsageEvent[] {
  if (!Array.isArray(events) || events.length === 0) return events || [];
  const best = new Map<string, UsageEvent>();
  const out: UsageEvent[] = [];

  // Windsurf cascade collapse (unchanged)
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
  // Grok residual ghosts + pure out=0 stacks (shared with mono high-water)
  return dropGrokStaleResiduals(out);
}

/**
 * When keeping individual request rows for RECENT EVENTS but the history window
 * is incomplete vs daily rollups, emit estimated remainder rows so day totals
 * never fall below the daily floor (usage only grows / never oscillates down).
 */
function gapFillRouterDayFromDailies(
  dailies: UsageEvent[],
  requests: UsageEvent[],
): UsageEvent[] {
  if (!dailies.length) return [];

  type Acc = { n: number; tok: number; cost: number };
  const hist = new Map<string, Acc>();
  for (const e of requests) {
    const model = (typeof e.model === "string" && e.model.trim()) || "mixed";
    const ws = (typeof e.workspace === "string" && e.workspace.trim()) || "";
    const key = `${model}|${ws}`;
    const prev = hist.get(key) || { n: 0, tok: 0, cost: 0 };
    const reqs =
      typeof e.requestCount === "number" && e.requestCount > 0
        ? Math.floor(e.requestCount)
        : 1;
    prev.n += reqs;
    prev.tok += eventTokenWeight(e);
    prev.cost += Number(e.estimatedCost) || 0;
    hist.set(key, prev);
  }

  // Also aggregate history without workspace so "mixed"/empty-ws dailies match
  const histByModel = new Map<string, Acc>();
  for (const e of requests) {
    const model = (typeof e.model === "string" && e.model.trim()) || "mixed";
    const prev = histByModel.get(model) || { n: 0, tok: 0, cost: 0 };
    const reqs =
      typeof e.requestCount === "number" && e.requestCount > 0
        ? Math.floor(e.requestCount)
        : 1;
    prev.n += reqs;
    prev.tok += eventTokenWeight(e);
    prev.cost += Number(e.estimatedCost) || 0;
    histByModel.set(model, prev);
  }

  const out: UsageEvent[] = [];
  for (const d of dailies) {
    const model = (typeof d.model === "string" && d.model.trim()) || "mixed";
    const ws = (typeof d.workspace === "string" && d.workspace.trim()) || "";
    const key = `${model}|${ws}`;
    const h =
      hist.get(key) ||
      (ws ? undefined : histByModel.get(model)) ||
      histByModel.get(model) ||
      { n: 0, tok: 0, cost: 0 };

    const dailyTok = eventTokenWeight(d);
    const dailyCost = Number(d.estimatedCost) || 0;
    const dailyReq =
      typeof d.requestCount === "number" && d.requestCount > 0
        ? Math.floor(d.requestCount)
        : 1;

    const remTok = Math.max(0, dailyTok - h.tok);
    const remCost = Math.max(0, dailyCost - h.cost);
    const remReq = Math.max(0, dailyReq - h.n);

    // History already covers this daily row
    if (remTok <= 0 && remCost <= 0 && remReq <= 0) continue;
    if (h.tok >= dailyTok && h.n >= dailyReq && dailyTok > 0) continue;

    // Split remainder roughly like the daily row proportions, but force
    // totalTokens === remTok so day floor is exact (no rounding undercount).
    const ratio = dailyTok > 0 ? remTok / dailyTok : 0;
    let remIn = Math.max(0, Math.floor((Number(d.inputTokens) || 0) * ratio));
    let remOut = Math.max(0, Math.floor((Number(d.outputTokens) || 0) * ratio));
    let remCacheR = Math.max(0, Math.floor((Number(d.cacheReadTokens) || 0) * ratio));
    let remCacheW = Math.max(0, Math.floor((Number(d.cacheWriteTokens) || 0) * ratio));
    let parts = remIn + remOut + remCacheR + remCacheW;
    if (remTok > 0 && parts === 0) {
      remIn = remTok;
      parts = remTok;
    } else if (remTok > parts) {
      // Put leftover into input so remTok is exact
      remIn += remTok - parts;
      parts = remTok;
    } else if (parts > remTok && remTok > 0) {
      // Scale down if we overshot (shouldn't with floor, but be safe)
      remIn = remTok;
      remOut = 0;
      remCacheR = 0;
      remCacheW = 0;
      parts = remTok;
    }

    if (parts <= 0 && remCost <= 0 && remReq <= 0) continue;

    const day = (d.timestamp || "").slice(0, 10);
    const agent = d.agent;
    const gapId = `gapfill:${agent}:${day}:${model}:${ws || "nows"}`;
    out.push({
      ...d,
      id: gapId,
      estimated: true,
      inputTokens: remIn,
      outputTokens: remOut,
      cacheReadTokens: remCacheR,
      cacheWriteTokens: remCacheW,
      totalTokens: parts > 0 ? parts : remTok,
      estimatedCost: remCost,
      requestCount: remReq > 0 ? remReq : parts > 0 ? 1 : 0,
      timestamp: d.timestamp,
      sourcePath: d.sourcePath || "gapfill-daily",
    });
  }
  return out;
}

/**
 * Router days: collapse multi-version estimated rollups (unstable ids) to the
 * richest per model, then keep max(daily totals, request totals) for that day.
 * Never drop the higher side — stale daily must not hide fuller request history
 * and request samples must not hide a complete daily rollup.
 *
 * When multi-RQ history is preferred for RECENT EVENTS but is only a partial
 * window, keep those RQs AND gap-fill the daily remainder so all-time totals
 * never oscillate down on rescan.
 */
export function collapseRouterDailyEvents(events: UsageEvent[]): UsageEvent[] {
  if (!Array.isArray(events) || events.length === 0) return events || [];

  type DayBucket = { dailies: UsageEvent[]; requests: UsageEvent[] };
  const nonRouter: UsageEvent[] = [];
  const byAgentDay = new Map<string, DayBucket>();

  for (const e of events) {
    if (!e || typeof e.id !== "string") continue;
    const isRouter =
      e.agent === "9router" ||
      e.agent === "xlabrouter" ||
      e.agent === "routerlab" ||
      e.agent === "litellm";
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
    // Same logical daily rollup rewritten many times → keep richest per
    // day+model+workspace. CRITICAL: do NOT collapse by normalized model name
    // alone — different providers can share a model name (e.g. "gpt-5.5" from
    // 3 providers) and collapsing by name would drop the non-richest providers
    // and lose tokens. Also do NOT collapse by id alone — imported (Gist) events
    // have different ids than fresh scans even for the same data, so id-only
    // collapse would double-count. The workspace field carries the provider,
    // making day+model+workspace the correct dedup key. When workspace is
    // null/empty (provider unknown), use id as key so different providers are
    // never accidentally merged — usage only grows, never shrinks.
    const dailyByKey = new Map<string, UsageEvent>();
    for (const e of bucket.dailies) {
      const model = (typeof e.model === "string" && e.model.trim()) || "mixed";
      const ws = (typeof e.workspace === "string" && e.workspace.trim()) || "";
      const key = ws ? `${model}|${ws}` : `__id__|${e.id}`;
      const prev = dailyByKey.get(key);
      dailyByKey.set(key, prev ? preferRicherEvent(prev, e) : e);
    }
    const dailies = [...dailyByKey.values()];
    const requests = bucket.requests;

    if (dailies.length === 0) {
      out.push(...requests);
      continue;
    }
    if (requests.length === 0) {
      // Drop redundant "mixed" day blob when model-specific rollups already cover the day.
      out.push(...dedupeMixedDailyRollups(dailies));
      continue;
    }

    const dailiesClean = dedupeMixedDailyRollups(dailies);
    const dailyTok = dailiesClean.reduce((a, e) => a + eventTokenWeight(e), 0);
    const reqTok = requests.reduce((a, e) => a + eventTokenWeight(e), 0);
    const dailyCost = dailiesClean.reduce((a, e) => a + (Number(e.estimatedCost) || 0), 0);
    const reqCost = requests.reduce((a, e) => a + (Number(e.estimatedCost) || 0), 0);
    const dailyReq = dailiesClean.reduce((a, e) => {
      const rc = e.requestCount;
      return a + (typeof rc === "number" && rc > 0 ? Math.floor(rc) : 1);
    }, 0);
    const reqReq = requests.reduce((a, e) => {
      const rc = e.requestCount;
      return a + (typeof rc === "number" && rc > 0 ? Math.floor(rc) : 1);
    }, 0);

    // Request rows overshoot a *complete* daily (twin history/RD, reprice, multi-root).
    // Remote dashboards use dailySummary as authority — prefer daily in that case.
    // If daily is tiny/stale (few reqs) and requests are much richer, keep requests.
    // Large/complete VPS dailySummary is token/cost authority (overshoot → keep daily).
    const dailyLooksAuthoritative =
      dailyReq >= 10 ||
      dailyTok >= 100_000 ||
      (dailyCost > 0 && dailyTok >= 10_000);
    // Estimated rows that are only a small residual vs live history (LiteLLM gap-fill
    // after near-complete SpendLogs) must not be treated as the full-day authority —
    // otherwise collapse drops 1k+ RQs and keeps noon-stamped remainders only.
    const dailiesAreResidualOnly =
      requests.length >= 20 &&
      dailyTok > 0 &&
      reqTok >= Math.max(dailyTok * 2, dailyTok + 50_000);
    if (dailiesAreResidualOnly) {
      out.push(...requests);
      out.push(...dailiesClean);
      continue;
    }
    // Near-complete live history matching (or modestly exceeding) full-day dailies:
    // keep individual RQs so local "Today" sees post-noon UTC timestamps.
    // Mid-day growth can make live tokens 5–35% above a stale cached daily.
    // Cap request inflation so zero-token stream probes (1 daily vs 35 empty RQs)
    // still fall through to daily authority.
    if (
      requests.length >= 20 &&
      dailyTok > 0 &&
      reqTok >= dailyTok * 0.9 &&
      reqTok <= dailyTok * 1.35 &&
      (dailyReq <= 0 ||
        (reqReq >= dailyReq * 0.75 &&
          reqReq <= Math.max(dailyReq * 1.25, dailyReq + 10)))
    ) {
      out.push(...requests);
      if (reqTok < dailyTok * 0.98) {
        out.push(...gapFillRouterDayFromDailies(dailiesClean, requests));
      }
      continue;
    }
    const requestsOvershootDaily =
      dailyLooksAuthoritative &&
      ((dailyTok > 0 && reqTok > dailyTok * 1.05) ||
        (dailyCost > 0 && reqCost > dailyCost * 1.15 && reqTok >= dailyTok * 0.9));
    // Zero-token stream probes inflate RQ count while token volume stays inside the
    // daily envelope (RouterLab Today: daily=1, RD≈35 empty successes → still 1 RQ).
    const requestCountInflated =
      dailyReq > 0 &&
      dailyTok > 0 &&
      reqReq > Math.max(dailyReq * 1.5, dailyReq + 5) &&
      reqTok <= dailyTok * 1.05 &&
      reqTok >= dailyTok * 0.5;

    if (requestCountInflated || requestsOvershootDaily) {
      out.push(...dailiesClean);
      continue;
    }

    // Stale/tiny daily but rich request history → keep requests (legacy incomplete rollup).
    if (!dailyLooksAuthoritative && reqTok > dailyTok) {
      out.push(...requests);
      continue;
    }

    // Full request coverage within daily envelope → keep individual RQs for RECENT.
    const requestsMatchDaily =
      !requestsOvershootDaily &&
      !requestCountInflated &&
      dailyTok > 0 &&
      reqTok >= dailyTok * 0.95 &&
      reqTok <= dailyTok * 1.05 &&
      (dailyReq <= 0 || reqReq <= Math.max(dailyReq * 1.25, dailyReq + 3));

    // Multi-RQ sample incomplete vs daily → RQs + gap-fill remainder.
    const wantRequestDetail =
      !requestsOvershootDaily &&
      !requestCountInflated &&
      requests.length >= 2 &&
      (requests.length >= 20 ||
        reqTok >= dailyTok * 0.15 ||
        (dailyReq > 0 && reqReq >= dailyReq * 0.15) ||
        requests.length > dailiesClean.length);

    if (requestsMatchDaily) {
      out.push(...requests);
      continue;
    }

    if (wantRequestDetail && reqTok < dailyTok * 0.98) {
      // Keep individual RQs + daily remainder so totals match remote daily floor.
      out.push(...requests);
      out.push(...gapFillRouterDayFromDailies(dailiesClean, requests));
      continue;
    }

    // Default / overshoot: authoritative daily (matches VPS dashboard stats).
    out.push(...dailiesClean);
  }
  return out;
}

/**
 * When a day has both model-specific daily rollups AND a "mixed" whole-day blob
 * (common after Gist import + local rescan of the same RouterLab history),
 * keep model rows and drop mixed if they already cover ≥95% of mixed tokens.
 * Prevents all-time cost oscillating between ~double-count and de-duped totals.
 */
function dedupeMixedDailyRollups(dailies: UsageEvent[]): UsageEvent[] {
  if (dailies.length < 2) return dailies;
  const mixed = dailies.filter((e) => {
    const m = (typeof e.model === "string" && e.model.trim()) || "";
    return !m || m === "mixed" || m === "unknown";
  });
  const models = dailies.filter((e) => {
    const m = (typeof e.model === "string" && e.model.trim()) || "";
    return m && m !== "mixed" && m !== "unknown";
  });
  if (mixed.length === 0 || models.length === 0) return dailies;

  const modelTok = models.reduce((a, e) => a + eventTokenWeight(e), 0);
  const modelCost = models.reduce((a, e) => a + (Number(e.estimatedCost) || 0), 0);
  const keptMixed: UsageEvent[] = [];
  for (const m of mixed) {
    const mt = eventTokenWeight(m);
    const mc = Number(m.estimatedCost) || 0;
    // Model rows already explain this mixed blob → drop mixed (avoid double count).
    if (mt > 0 && modelTok >= mt * 0.95) continue;
    if (mc > 0 && modelCost >= mc * 0.95 && modelTok >= mt * 0.9) continue;
    keptMixed.push(m);
  }
  return [...models, ...keptMixed];
}

/**
 * Grok stream residuals used unstable ids (peak in hash) → N out=0 rows per
 * session file. Drop those ghosts when a better row exists for the path, and
 * collapse pure out=0 stacks to a single richest residual so
 * enforceMonotonicAgentDays cannot prefer a 21-ghost envelope over 1 good row.
 */
export function dropGrokStaleResiduals(events: UsageEvent[]): UsageEvent[] {
  if (!Array.isArray(events) || events.length === 0) return events || [];

  type PathInfo = {
    hasReal: boolean;
    hasEstOutPos: boolean;
    outZeroEst: UsageEvent[];
  };
  const byPath = new Map<string, PathInfo>();
  const norm = (sp: string) => sp.replace(/\\/g, "/").toLowerCase();

  for (const e of events) {
    if (!e || e.agent !== "grok") continue;
    if (typeof e.sourcePath !== "string" || !e.sourcePath) continue;
    const sp = norm(e.sourcePath);
    if (!sp.endsWith("updates.jsonl")) continue;
    let info = byPath.get(sp);
    if (!info) {
      info = { hasReal: false, hasEstOutPos: false, outZeroEst: [] };
      byPath.set(sp, info);
    }
    if (!e.estimated) info.hasReal = true;
    else if ((Number(e.outputTokens) || 0) > 0) info.hasEstOutPos = true;
    else info.outZeroEst.push(e);
  }

  const dropIds = new Set<string>();
  for (const [, info] of byPath) {
    if (info.outZeroEst.length === 0) continue;
    if (info.hasReal || info.hasEstOutPos) {
      // Better row exists for this session file — drop all out=0 residuals
      for (const g of info.outZeroEst) dropIds.add(g.id);
      continue;
    }
    // Pure out=0 stack (in-progress / old ghosts only): keep single richest
    if (info.outZeroEst.length > 1) {
      let best = info.outZeroEst[0]!;
      let bestW = eventTokenWeight(best);
      for (let i = 1; i < info.outZeroEst.length; i++) {
        const g = info.outZeroEst[i]!;
        const w = eventTokenWeight(g);
        if (w > bestW) {
          best = g;
          bestW = w;
        }
      }
      for (const g of info.outZeroEst) {
        if (g.id !== best.id) dropIds.add(g.id);
      }
    }
  }

  if (dropIds.size === 0) return events;
  return events.filter((e) => !e || !dropIds.has(e.id));
}

/**
 * Per agent×day high-water mark: never replace a richer previous day snapshot
 * with a thinner rescan. Takes the side with more tokens (then cost, then rows).
 * Usage totals can only grow (or stay) across rescans — never silently drop.
 *
 * Grok residual ghosts are stripped from both sides first so a stack of out=0
 * peak residuals cannot beat a single correct residual/usage row on token sum.
 */
export function enforceMonotonicAgentDays(
  prev: UsageEvent[],
  next: UsageEvent[],
): UsageEvent[] {
  if (!prev?.length) return next || [];
  if (!next?.length) return dropGrokStaleResiduals(prev);

  // Strip Grok residual ghosts before envelope compare — otherwise prev with
  // 21× out=0 stream peaks restores after mergeAgentScanLight already cleaned them.
  prev = dropGrokStaleResiduals(prev);
  next = dropGrokStaleResiduals(next);

  /** Envelope weight: ignore Grok estimated out=0 stream residuals (ghost inflation). */
  const monoTokenWeight = (e: UsageEvent): number => {
    if (
      e.agent === "grok" &&
      e.estimated &&
      (Number(e.outputTokens) || 0) === 0 &&
      typeof e.sourcePath === "string" &&
      e.sourcePath.replace(/\\/g, "/").toLowerCase().endsWith("updates.jsonl")
    ) {
      return 0;
    }
    return eventTokenWeight(e);
  };

  type Bucket = {
    events: UsageEvent[];
    tok: number;
    cost: number;
    req: number;
    live: number;
    estOutPos: number;
  };
  const bucketize = (list: UsageEvent[]): Map<string, Bucket> => {
    const map = new Map<string, Bucket>();
    for (const e of list) {
      if (!e || typeof e.agent !== "string") continue;
      const agent = normalizeAgentId(e.agent);
      const day = (e.timestamp || "").slice(0, 10);
      const key = /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${agent}|${day}` : `${agent}|__noday__|${e.id}`;
      let b = map.get(key);
      if (!b) {
        b = { events: [], tok: 0, cost: 0, req: 0, live: 0, estOutPos: 0 };
        map.set(key, b);
      }
      b.events.push({ ...e, agent });
      b.tok += monoTokenWeight(e);
      b.cost += Number(e.estimatedCost) || 0;
      const rc = e.requestCount;
      b.req += typeof rc === "number" && rc > 0 ? Math.floor(rc) : 1;
      if (!e.estimated) b.live += 1;
      else if ((Number(e.outputTokens) || 0) > 0) b.estOutPos += 1;
    }
    return map;
  };

  const prevMap = bucketize(prev);
  const nextMap = bucketize(next);
  const keys = new Set<string>([...prevMap.keys(), ...nextMap.keys()]);
  const out: UsageEvent[] = [];

  const better = (a: Bucket, b: Bucket): Bucket => {
    const aLive = a.live;
    const bLive = b.live;
    const aEst = a.events.length - aLive;
    const bEst = b.events.length - bLive;

    // Prefer day side with real usage / meaningful residual output over pure out=0 ghosts
    // (ghost peak sum used to win envelope and restore 21× out=0 after light merge cleaned them).
    if (aLive !== bLive) return aLive > bLive ? a : b;
    if (a.estOutPos !== b.estOutPos) return a.estOutPos > b.estOutPos ? a : b;

    // Usage only grows: higher token envelope always wins (stale noon-stamped
    // daily must not block fresher SpendLogs / request history for the same day).
    // Multi-root inflation is handled in collapseRouterDailyEvents before mono.
    // Grok residual out=0 weight is 0 so ghost stacks cannot inflate envelope.
    if (a.tok > b.tok * 1.001) return a;
    if (b.tok > a.tok * 1.001) return b;
    if (a.cost > b.cost * 1.001) return a;
    if (b.cost > a.cost * 1.001) return b;

    // Same tokens/cost: pure estimated daily (VPS dailySummary) beats a swarm of
    // live zero-token probes that only inflate request count (e.g. 1 vs 35).
    if (aEst > 0 && aLive === 0 && bLive > 0 && a.req > 0 && b.req > a.req * 1.5) return a;
    if (bEst > 0 && bLive === 0 && aLive > 0 && b.req > 0 && a.req > b.req * 1.5) return b;

    // Same envelope: prefer multi-RQ live detail over pure daily (local Today / RECENT).
    if (bLive >= 20 && aEst > 0 && aLive === 0 && b.req >= a.req * 0.75) return b;
    if (aLive >= 20 && bEst > 0 && bLive === 0 && a.req >= b.req * 0.75) return a;

    // Same tokens/cost — prefer higher request coverage when both sides same kind
    if (a.req > b.req) return a;
    if (b.req > a.req) return b;
    return a.events.length >= b.events.length ? a : b;
  };

  for (const key of keys) {
    const p = prevMap.get(key);
    const n = nextMap.get(key);
    if (p && n) out.push(...better(p, n).events);
    else if (n) out.push(...n.events);
    else if (p) out.push(...p.events);
  }
  // Final strip: whichever side won must not reintroduce Grok residual out=0 stacks
  return dropGrokStaleResiduals(out);
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
    // Router twin exports / multi-root mirrors share content but differ by
    // sourcePath, cache fields, or 1ms timestamps — collapse on second+model+IO.
    const isRouter =
      e.agent === "9router" ||
      e.agent === "xlabrouter" ||
      e.agent === "routerlab" ||
      e.agent === "litellm";
    const key = isRouter
      ? [
          e.agent,
          (e.timestamp || "").slice(0, 19),
          e.model || "",
          e.inputTokens || 0,
          e.outputTokens || 0,
          e.workspace || "",
        ].join("|")
      : [
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
  let events: UsageEvent[] = [];
  try {
    if (await pathExists(p)) {
      const raw = JSON.parse(await readFile(p, "utf8")) as unknown;
      events = sanitizeEvents(raw) || [];
    }
  } catch (err) {
    logError("loadImportedEvents failed:", err instanceof Error ? err.message : err);
  }
  // Legacy fallback: merge pre-rename imported-events.json so usage never drops
  // after the XLab Token → TokenLab rename. Union by id; usage only grows.
  try {
    const lp = legacyImportedEventsPath();
    if (await pathExists(lp)) {
      const legacyRaw = JSON.parse(await readFile(lp, "utf8")) as unknown;
      const legacy = sanitizeEvents(legacyRaw) || [];
      if (legacy.length > 0) {
        events = mergeEventsByIdPreferRicher(events, legacy);
        if (legacy.length > 0 && events.length < legacy.length) {
          // Sanity: never return fewer than legacy
          events = legacy;
        }
      }
    }
  } catch (err) {
    logError("loadImportedEvents legacy fallback failed:", err instanceof Error ? err.message : err);
  }
  return events;
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
  // Legacy fallback candidates — pre-rename xlab-token dir. Included so usage
  // never silently drops after the rename; we union by id (richer wins).
  const legacyCandidates = [
    legacyScanCachePath(),
    `${legacyScanCachePath()}.bak`,
    path.join(legacyDataRoot(), "scan-cache.archive.json"),
  ];
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
  // Union with legacy cache so usage only grows across the rename.
  let legacyBest: UsageEvent[] = [];
  let legacyBestScore = { count: 0, tokens: 0 };
  let legacyBestFrom = "";
  for (const candidate of legacyCandidates) {
    const events = await loadScanCacheCandidate(candidate);
    if (!events || events.length === 0) continue;
    const score = scanCacheScore(events);
    const better =
      score.count > legacyBestScore.count + 50 ||
      (score.count >= legacyBestScore.count - 50 && score.tokens > legacyBestScore.tokens) ||
      (score.count > legacyBestScore.count && score.tokens >= legacyBestScore.tokens * 0.9);
    if (better || legacyBest.length === 0) {
      legacyBest = events;
      legacyBestScore = score;
      legacyBestFrom = candidate;
    }
  }
  if (legacyBest.length > 0) {
    if (best.length === 0) {
      best = legacyBest;
      bestFrom = legacyBestFrom;
      log("loadScanCache: using legacy cache only →", legacyBestFrom, `(${legacyBest.length} events)`);
    } else {
      // Union: richer rows win on id collisions; net count can only grow.
      const union = mergeEventsByIdPreferRicher(best, legacyBest);
      if (union.length >= best.length) {
        log(
          "loadScanCache: merged legacy cache →",
          legacyBestFrom,
          `(best=${best.length} + legacy=${legacyBest.length} → union=${union.length})`,
        );
        best = union;
        bestFrom = bestFrom + " + " + legacyBestFrom;
      }
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
  let clean =
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

    // Full save: never write a thinner all-time snapshot than what is already on disk.
    // (Rescans that flip daily↔partial history used to shrink EST. COST by tens of k$.)
    if (mode === "full") {
      try {
        const existing = await loadScanCache();
        if (existing.length > 0) {
          const merged = enforceMonotonicAgentDays(existing, clean);
          clean = collapseExactUsageDuplicates(
            collapseSourcePathRollups(collapseRouterDailyEvents(merged)),
          );
        }
      } catch (err) {
        logError(
          "saveScanCache: high-water merge failed (continuing with in-memory):",
          err instanceof Error ? err.message : err,
        );
      }
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
        "TokenLab backup file (settings): timezone, pricing, host/port, gist link — same format as Gist/full",
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
      "TokenLab backup file (full): settings + events + periodStats + OpenRouter + mirrors",
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
  return (o.format === BACKUP_FORMAT || o.format === BACKUP_FORMAT_LEGACY) && typeof o.config === "object" && o.config != null;
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
    // XLab Router → RouterLab (canonical agent id)
    const agent = normalizeAgentId(String(e.agent));
    const requestCountRaw = Number(e.requestCount);
    const requestCount =
      Number.isFinite(requestCountRaw) && requestCountRaw > 0
        ? Math.floor(requestCountRaw)
        : undefined;
    out.push({
      id: e.id,
      agent,
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
      ...(requestCount != null ? { requestCount } : {}),
    });
  }
  return out;
}

/** Restore config (+ optional events / openrouter / mirrors). Same file format as Gist. */
export async function restoreBackup(raw: unknown): Promise<RestoreResult> {
  if (!isXlabBackup(raw)) {
    throw new Error("Invalid backup file (expected tokenlab format)");
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
    // Lowercase so case variants of the same model collapse into one rollup
    const modelRaw = normalizeModelName(e.model);
    const model = modelRaw ? modelRaw.toLowerCase() : modelRaw;
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

/** day|agent|model key for collapse / anti-double-count (model case-insensitive) */
export function gistCoverageKey(e: UsageEvent): string {
  const day = (e.timestamp || "").slice(0, 10);
  const model = (normalizeModelName(e.model) || "").toLowerCase();
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
    note: "TokenLab backup file (Gist/period-stats): full project settings + multi-machine usage sum",
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

const GIST_BACKUP_FILENAME = "tokenlab.json";

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": `tokenlab/${VERSION}`,
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
          "User-Agent": `tokenlab/${VERSION}`,
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
  const description = `TokenLab multi-machine · ${machinesLabel} · ${backup.meta?.modelCount || 0} models · ${backup.meta?.agentCount || 0} agents · ${backup.exportedAt} · v${backup.appVersion}`;

  const headers = githubHeaders(token);

  // One secret Gist, one file (tokenlab.json). PATCH = new revision; POST only
  // when no gistId yet or the stored gist was deleted (404).
  let res: Response;
  let updated = false;
  if (prevId) {
    log("Updating existing Gist (PATCH revision):", prevId, "file:", filename);
    res = await fetch(`https://api.github.com/gists/${encodeURIComponent(prevId)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        description,
        files: { [filename]: { content } },
      }),
    });
    updated = res.ok;
    if (res.status === 404) {
      log("Stored gist 404 (deleted) — creating one replacement Gist, not a new file");
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
    log("No gistId in config — creating first Gist with", filename);
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
  // Prevent legacy xlab-token config from resurrecting a deleted gistId on restart
  await syncLegacyGistMeta({
    gistId: gist.id,
    gistUrl: gist.htmlUrl,
    lastBackupAt: backup.exportedAt,
  });
  log(
    updated ? "Gist revised (same link):" : "Gist created (new link once):",
    gist.id,
    gist.htmlUrl,
  );

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
      // Disk load — never trust cold getConfigSync() defaults for gistId
      const cfg = await loadConfig();
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

      log("auto daily Gist backup starting…", events.length, "events", "gistId:", gistId);
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
