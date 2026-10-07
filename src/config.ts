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

const DEFAULT_CONFIG: XlabTokenConfig = {
  timezone: "local",
  pricing: {
    currency: "USD",
    preferRouterCost: true,
    customRates: {},
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
    backup: {
      ...base.backup,
      ...over.backup,
    },
  };
}
