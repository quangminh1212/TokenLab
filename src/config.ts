import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelRate } from "./types.js";
import { appDataDir, pathExists } from "./util.js";

export interface XlabTokenConfig {
  host?: string;
  port?: number;
  /**
   * IANA timezone for "Today" / "Yesterday" filters (e.g. Asia/Ho_Chi_Minh).
   * Use "local" for the machine timezone, or "UTC".
   */
  timezone?: string;
  pricing?: {
    currency?: string;
    /** Prefer router-reported cost when > 0 (default true). */
    preferRouterCost?: boolean;
    /** USD per 1M tokens overrides, keyed by normalized model name. */
    customRates?: Record<string, ModelRate>;
  };
  /**
   * Background scanning cadence. Scanning walks agent logs on disk, so the
   * defaults are deliberately relaxed (5 min) — every-minute passes kept the
   * CPU and disk busy on large Codex/Claude histories.
   */
  scan?: {
    /** Minutes between two background light scans (1–60). Default 5. */
    intervalMinutes?: number;
    /** When false, no background scan runs (manual Rescan still works). Default true. */
    periodicEnabled?: boolean;
    /**
     * Minutes between two full all-agent scans (5–1440). Default 360 (6h).
     * Light ticks only refresh hot agents; this is the deep historical pass.
     */
    fullIntervalMinutes?: number;
  };
  /** Optional backup destination (GitHub Gist). Token is local-only — never committed. */
  backup?: {
    gistId?: string;
    gistUrl?: string;
    lastBackupAt?: string;
    /** Optional classic PAT with `gist` scope (prefer env XLAB_GITHUB_TOKEN). */
    githubToken?: string;
    /**
     * When true (default) and gistId + token exist, server auto-uploads once per local day.
     * Set false to disable background daily Gist backup.
     */
    autoDaily?: boolean;
  };
}

/** Background light scan cadence (minutes) when config says nothing. */
export const DEFAULT_SCAN_INTERVAL_MINUTES = 5;
/** Full all-agent rescan cadence (minutes) when config says nothing (6h). */
export const DEFAULT_FULL_SCAN_INTERVAL_MINUTES = 360;
/** Guard rails so a hand-edited config.json cannot turn this into a scan loop. */
const MIN_SCAN_INTERVAL_MINUTES = 1;
const MAX_SCAN_INTERVAL_MINUTES = 60;
const MIN_FULL_SCAN_INTERVAL_MINUTES = 5;
const MAX_FULL_SCAN_INTERVAL_MINUTES = 1440;

const DEFAULT_CONFIG: XlabTokenConfig = {
  timezone: "local",
  pricing: {
    currency: "USD",
    preferRouterCost: true,
    customRates: {},
  },
  scan: {
    intervalMinutes: DEFAULT_SCAN_INTERVAL_MINUTES,
    periodicEnabled: true,
    fullIntervalMinutes: DEFAULT_FULL_SCAN_INTERVAL_MINUTES,
  },
};

let cached: XlabTokenConfig | null = null;
/**
 * Frozen, pre-normalized snapshot handed to hot paths (pricing runs per event).
 * Rebuilt only when `cached` is replaced — never cloned per call.
 */
let cachedSyncView: XlabTokenConfig | null = null;

/** Deep-freeze the shallow config layers so hot-path readers cannot mutate the cache. */
function freezeView(cfg: XlabTokenConfig): XlabTokenConfig {
  Object.freeze(cfg.pricing?.customRates);
  Object.freeze(cfg.pricing);
  Object.freeze(cfg.scan);
  Object.freeze(cfg.backup);
  return Object.freeze(cfg);
}

function buildSyncView(c: XlabTokenConfig): XlabTokenConfig {
  const view: XlabTokenConfig = { ...c, timezone: normalizeTimezone(c.timezone) };
  // Shallow copies of nested objects: the frozen view must not alias the mutable
  // `cached` config, otherwise a later saveConfig could mutate what readers hold.
  if (c.pricing) {
    view.pricing = { ...c.pricing, customRates: { ...(c.pricing.customRates || {}) } };
  }
  if (c.scan) view.scan = { ...c.scan };
  if (c.backup) view.backup = { ...c.backup };
  return freezeView(view);
}

export function configPath(): string {
  if (process.env.TOKENLAB_CONFIG) return process.env.TOKENLAB_CONFIG;
  return path.join(
    process.env.TOKENLAB_DATA_DIR || path.join(appDataDir(), "tokenlab"),
    "config.json",
  );
}

/**
 * Normalize timezone for "Today" filters.
 * Stored "UTC" on a non-UTC machine is a common misconfig that undercounts
 * morning usage (e.g. Vietnam UTC+7). Prefer machine local unless forced.
 */
export function normalizeTimezone(tz: string | null | undefined): string {
  const t = (tz && String(tz).trim()) || "local";
  if (t === "UTC" || t === "Etc/UTC") {
    if (process.env.TOKENLAB_FORCE_UTC === "1") return "UTC";
    // getTimezoneOffset: minutes *west* of UTC; 0 only on real UTC hosts
    if (new Date().getTimezoneOffset() !== 0) return "local";
  }
  return t;
}

export async function loadConfig(): Promise<XlabTokenConfig> {
  if (cached) return cached;
  const p = configPath();
  try {
    if (await pathExists(p)) {
      const raw = await readFile(p, "utf8");
      const parsed = JSON.parse(raw) as XlabTokenConfig;
      const mergedCfg = mergeConfig(DEFAULT_CONFIG, parsed);
      setCachedConfig(mergedCfg);
      // Persist migration UTC → local once so Settings/API stay consistent
      if (parsed.timezone === "UTC" || parsed.timezone === "Etc/UTC") {
        const fixed = normalizeTimezone(parsed.timezone);
        if (fixed !== "UTC") {
          mergedCfg.timezone = fixed;
          cachedSyncView = null;
          try {
            await writeFile(p, JSON.stringify(mergedCfg, null, 2), "utf8");
          } catch {
            /* best-effort */
          }
        }
      }
      return mergedCfg;
    }
  } catch {
    // fall through
  }
  const fallback = structuredClone(DEFAULT_CONFIG);
  setCachedConfig(fallback);
  return fallback;
}

/**
 * Hot-path config read (called ~3× per event during pricing).
 * Returns a cached frozen view — no structuredClone per call. Previously this
 * cloned the entire DEFAULT_CONFIG on every invocation, which dominated scan CPU.
 */
export function getConfigSync(): XlabTokenConfig {
  if (cachedSyncView) return cachedSyncView;
  cachedSyncView = buildSyncView(cached ?? DEFAULT_CONFIG);
  return cachedSyncView;
}

/** Invalidate derived views after any config mutation. */
function setCachedConfig(next: XlabTokenConfig | null): void {
  cached = next;
  cachedSyncView = null;
}

function clampMinutes(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Resolved background light-scan cadence in minutes (clamped, never NaN). */
export function scanIntervalMinutes(): number {
  return clampMinutes(
    getConfigSync().scan?.intervalMinutes,
    MIN_SCAN_INTERVAL_MINUTES,
    MAX_SCAN_INTERVAL_MINUTES,
    DEFAULT_SCAN_INTERVAL_MINUTES,
  );
}

/** Resolved full all-agent rescan cadence in minutes. */
export function fullScanIntervalMinutes(): number {
  return clampMinutes(
    getConfigSync().scan?.fullIntervalMinutes,
    MIN_FULL_SCAN_INTERVAL_MINUTES,
    MAX_FULL_SCAN_INTERVAL_MINUTES,
    DEFAULT_FULL_SCAN_INTERVAL_MINUTES,
  );
}

/** Background scanning master switch (default on). */
export function scanPeriodicEnabled(): boolean {
  return getConfigSync().scan?.periodicEnabled !== false;
}

/** Normalize a stored scan block: clamp values, drop junk, keep defaults for missing. */
export function normalizeScanConfig(
  scan: XlabTokenConfig["scan"] | undefined,
): NonNullable<XlabTokenConfig["scan"]> {
  return {
    intervalMinutes: clampMinutes(
      scan?.intervalMinutes,
      MIN_SCAN_INTERVAL_MINUTES,
      MAX_SCAN_INTERVAL_MINUTES,
      DEFAULT_SCAN_INTERVAL_MINUTES,
    ),
    fullIntervalMinutes: clampMinutes(
      scan?.fullIntervalMinutes,
      MIN_FULL_SCAN_INTERVAL_MINUTES,
      MAX_FULL_SCAN_INTERVAL_MINUTES,
      DEFAULT_FULL_SCAN_INTERVAL_MINUTES,
    ),
    periodicEnabled: scan?.periodicEnabled !== false,
  };
}

/**
 * Drop the memoized config so the next `loadConfig()` re-reads from disk.
 *
 * Needed by tests that point TOKENLAB_CONFIG at a fixture: `loadConfig` caches
 * on first call, so without this a later test silently keeps the first
 * fixture's pricing.
 */
export function resetConfigCache(): void {
  setCachedConfig(null);
}

export async function saveConfig(next: XlabTokenConfig): Promise<XlabTokenConfig> {
  const merged = mergeConfig(DEFAULT_CONFIG, next);
  merged.timezone = normalizeTimezone(merged.timezone);
  const p = configPath();
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(merged, null, 2), "utf8");
  setCachedConfig(merged);
  return merged;
}

export async function setCustomRates(
  rates: Record<string, ModelRate>,
  replace = false,
): Promise<XlabTokenConfig> {
  const cfg = await loadConfig();
  const prev = cfg.pricing?.customRates || {};
  const customRates = replace ? { ...rates } : { ...prev, ...rates };
  // Drop empty keys
  for (const [k, v] of Object.entries(customRates)) {
    if (!k.trim() || !v || typeof v.inputPer1M !== "number" || typeof v.outputPer1M !== "number") {
      delete customRates[k];
    }
  }
  return saveConfig({
    ...cfg,
    pricing: {
      ...cfg.pricing,
      customRates,
    },
  });
}

function mergeConfig(base: XlabTokenConfig, over: XlabTokenConfig): XlabTokenConfig {
  return {
    ...base,
    ...over,
    timezone: normalizeTimezone(over.timezone ?? base.timezone ?? "local"),
    pricing: {
      ...base.pricing,
      ...over.pricing,
      customRates: {
        ...(base.pricing?.customRates || {}),
        ...(over.pricing?.customRates || {}),
      },
    },
    scan: normalizeScanConfig({ ...base.scan, ...over.scan }),
    backup: {
      ...base.backup,
      ...over.backup,
    },
  };
}
