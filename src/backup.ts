import type { XlabTokenConfig } from "./config.js";
import { getConfigSync, loadConfig, saveConfig } from "./config.js";
import { VERSION } from "./version.js";

export const BACKUP_FORMAT = "xlab-token-backup" as const;
export const BACKUP_FORMAT_VERSION = 1 as const;

export interface XlabBackup {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  appVersion: string;
  exportedAt: string;
  platform?: string;
  /** Portable settings + custom model rates (no usage event logs). */
  config: {
    timezone?: string;
    pricing?: XlabTokenConfig["pricing"];
  };
  /** Optional last known gist destination (id only). */
  meta?: {
    note?: string;
    eventCountHint?: number;
  };
}

export function buildBackup(opts?: {
  eventCountHint?: number;
  note?: string;
}): XlabBackup {
  const cfg = getConfigSync();
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: VERSION,
    exportedAt: new Date().toISOString(),
    platform: process.platform,
    config: {
      timezone: cfg.timezone || "local",
      pricing: {
        currency: cfg.pricing?.currency || "USD",
        preferRouterCost: cfg.pricing?.preferRouterCost !== false,
        customRates: { ...(cfg.pricing?.customRates || {}) },
      },
    },
    meta: {
      note: opts?.note || "XLab Token settings & custom model rates",
      eventCountHint: opts?.eventCountHint,
    },
  };
}

export function isXlabBackup(raw: unknown): raw is XlabBackup {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  return o.format === BACKUP_FORMAT && typeof o.config === "object" && o.config != null;
}

/** Merge backup config into current config (replace custom rates when provided). */
export async function restoreBackup(raw: unknown): Promise<{
  ok: true;
  config: XlabTokenConfig;
  customRateCount: number;
}> {
  if (!isXlabBackup(raw)) {
    throw new Error("Invalid backup file (expected xlab-token-backup format)");
  }
  const prev = await loadConfig();
  const incoming = raw.config || {};
  const rates = incoming.pricing?.customRates;
  const next = await saveConfig({
    ...prev,
    timezone:
      typeof incoming.timezone === "string" && incoming.timezone.trim()
        ? incoming.timezone.trim()
        : prev.timezone,
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
  });
  return {
    ok: true,
    config: next,
    customRateCount: Object.keys(next.pricing?.customRates || {}).length,
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

/**
 * Create or update a secret GitHub Gist with the backup JSON.
 * Token: body token | XLAB_GITHUB_TOKEN | GITHUB_TOKEN | config.backup.githubToken
 * Scope: gist
 */
export async function uploadBackupToGist(opts: {
  token?: string | null;
  gistId?: string | null;
  public?: boolean;
  eventCountHint?: number;
  saveToken?: boolean;
}): Promise<{ backup: XlabBackup; gist: GistUploadResult }> {
  const token = githubToken(opts.token);
  if (!token) {
    throw new Error(
      "Missing GitHub token. Pass token, set XLAB_GITHUB_TOKEN / GITHUB_TOKEN, or save one in Settings.",
    );
  }

  const backup = buildBackup({ eventCountHint: opts.eventCountHint });
  const content = JSON.stringify(backup, null, 2);
  const filename = "xlab-token-backup.json";
  const description = `XLab Token backup · ${backup.exportedAt} · v${backup.appVersion}`;

  const prevId =
    (opts.gistId && String(opts.gistId).trim()) ||
    getConfigSync().backup?.gistId ||
    "";

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": `xlab-token/${VERSION}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };

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
    // If gist missing/deleted, create a new one
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

  // Persist gist id (+ optional token) for next update
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

  return { backup, gist };
}
