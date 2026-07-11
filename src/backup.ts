import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { XlabTokenConfig } from "./config.js";
import { getConfigSync, loadConfig, saveConfig } from "./config.js";
import {
  getOpenRouterFetchedAt,
  getOpenRouterModelsSync,
  openrouterCachePath,
  type OpenRouterModelEntry,
} from "./openrouter-models.js";
import type { UsageEvent } from "./types.js";
import { appDataDir, pathExists } from "./util.js";
import { VERSION } from "./version.js";

export const BACKUP_FORMAT = "xlab-token-backup" as const;
/** v1 = settings only · v2 = full project data */
export const BACKUP_FORMAT_VERSION = 2 as const;

export type BackupScope = "settings" | "full";

export interface XlabBackup {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  appVersion: string;
  exportedAt: string;
  platform?: string;
  scope: BackupScope;
  /** Settings + custom model rates */
  config: {
    timezone?: string;
    pricing?: XlabTokenConfig["pricing"];
  };
  /** Scanned usage events (full scope) */
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
    openrouterModelCount?: number;
    mirrorFileCount?: number;
    mirrorBytes?: number;
  };
}

export function dataRoot(): string {
  return process.env.XLAB_TOKEN_DATA_DIR || path.join(appDataDir(), "xlab-token");
}

export function mirrorsRoot(): string {
  return path.join(dataRoot(), "mirrors");
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

/** Soft cap for mirror inclusion in JSON export (GitHub Gist / browser). */
const MIRROR_MAX_TOTAL_BYTES = 25 * 1024 * 1024; // 25 MB
const MIRROR_MAX_FILE_BYTES = 8 * 1024 * 1024; // skip single files > 8 MB

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
    const full = path.join(root, ...rel.split("/"));
    try {
      const st = await stat(full);
      if (st.size > MIRROR_MAX_FILE_BYTES) {
        skipped.push(`${rel} (${Math.round(st.size / 1024 / 1024)}MB)`);
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
  const cfg = getConfigSync();
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: VERSION,
    exportedAt: new Date().toISOString(),
    platform: process.platform,
    scope: "settings",
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
      eventCount: opts?.eventCountHint,
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
    note: opts.note || "XLab Token full project backup",
  });
  base.scope = "full";

  // Events (in-memory scan cache)
  base.events = opts.events.map((e) => ({ ...e }));

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

/** Restore config (+ optional events / openrouter / mirrors). */
export async function restoreBackup(raw: unknown): Promise<RestoreResult> {
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

  const events = sanitizeEvents(raw.events);
  const openrouterRestored = await restoreOpenrouter(raw.openrouter);
  const mirrorsRestored = await restoreMirrors(raw.mirrors);
  const scope: BackupScope =
    raw.scope === "full" || (events && events.length > 0) || openrouterRestored || mirrorsRestored > 0
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

/** Gist practical soft limit for API content size */
const GIST_SOFT_MAX_BYTES = 900_000; // ~0.9 MB text

/**
 * Create or update a secret GitHub Gist.
 * Default scope is settings (small). Full is only uploaded if it fits Gist size.
 */
export async function uploadBackupToGist(opts: {
  token?: string | null;
  gistId?: string | null;
  public?: boolean;
  eventCountHint?: number;
  saveToken?: boolean;
  /** Prefer settings-only for Gist unless explicitly full and small enough */
  scope?: BackupScope;
  events?: UsageEvent[];
}): Promise<{ backup: XlabBackup; gist: GistUploadResult; scope: BackupScope }> {
  const token = githubToken(opts.token);
  if (!token) {
    throw new Error(
      "Missing GitHub token. Pass token, set XLAB_GITHUB_TOKEN / GITHUB_TOKEN, or save one in Settings.",
    );
  }

  let backup: XlabBackup;
  let scope: BackupScope = opts.scope === "full" ? "full" : "settings";
  if (scope === "full" && opts.events) {
    backup = await buildFullBackup({ events: opts.events, includeMirrors: false });
    const size = Buffer.byteLength(JSON.stringify(backup), "utf8");
    if (size > GIST_SOFT_MAX_BYTES) {
      // Fall back to settings-only for Gist
      backup = buildSettingsBackup({
        eventCountHint: opts.events.length,
        note: `Settings only (full export was ${Math.round(size / 1024)}KB — use Download for full project)`,
      });
      scope = "settings";
    }
  } else {
    backup = buildSettingsBackup({ eventCountHint: opts.eventCountHint });
    scope = "settings";
  }

  const content = JSON.stringify(backup, null, 2);
  const filename = "xlab-token-backup.json";
  const description = `XLab Token ${scope} backup · ${backup.exportedAt} · v${backup.appVersion}`;

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

  return { backup, gist, scope };
}
