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

export function configPath(): string {
  if (process.env.XLAB_TOKEN_CONFIG) return process.env.XLAB_TOKEN_CONFIG;
  return path.join(
    process.env.XLAB_TOKEN_DATA_DIR || path.join(appDataDir(), "xlab-token"),
    "config.json",
  );
}

export async function loadConfig(): Promise<XlabTokenConfig> {
  if (cached) return cached;
  const p = configPath();
  try {
    if (await pathExists(p)) {
      const raw = await readFile(p, "utf8");
      const parsed = JSON.parse(raw) as XlabTokenConfig;
      cached = mergeConfig(DEFAULT_CONFIG, parsed);
      return cached;
    }
  } catch {
    // fall through
  }
  cached = structuredClone(DEFAULT_CONFIG);
  return cached;
}

export function getConfigSync(): XlabTokenConfig {
  return cached ?? structuredClone(DEFAULT_CONFIG);
}

export async function saveConfig(next: XlabTokenConfig): Promise<XlabTokenConfig> {
  const merged = mergeConfig(DEFAULT_CONFIG, next);
  const p = configPath();
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(merged, null, 2), "utf8");
  cached = merged;
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
    timezone: over.timezone ?? base.timezone ?? "local",
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
