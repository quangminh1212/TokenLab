import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import fs from "node:fs";
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
  return [...byId.values()];
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

export async function loadScanCache(): Promise<UsageEvent[]> {
  const p = scanCachePath();
  try {
    if (!(await pathExists(p))) return [];
    const raw = JSON.parse(await readFile(p, "utf8")) as unknown;
    return sanitizeEvents(raw) || [];
  } catch (err) {
    logError("loadScanCache failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

export async function saveScanCache(events: UsageEvent[]): Promise<void> {
  const p = scanCachePath();
  await mkdir(path.dirname(p), { recursive: true });
  const clean = sanitizeEvents(events) || [];
  await writeFile(p, JSON.stringify(clean), "utf8");
  log("saveScanCache:", clean.length, "→", p);
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

/** GitHub Gist hard-ish limit; keep headroom under 100MB API max */
const GIST_MAX_BYTES = 50 * 1024 * 1024;

/** Compact usage rows for Gist (drop long source paths). */
function compactEventsForGist(events: UsageEvent[]): UsageEvent[] {
  return events.map((e) => ({
    id: e.id,
    agent: e.agent,
    model: e.model,
    timestamp: e.timestamp,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    cacheReadTokens: e.cacheReadTokens,
    cacheWriteTokens: e.cacheWriteTokens,
    totalTokens: e.totalTokens,
    estimatedCost: e.estimatedCost,
    currency: e.currency || "USD",
    pricingStatus: e.pricingStatus,
    workspace: e.workspace ?? null,
    sourcePath: e.sourcePath?.startsWith("backup") ? e.sourcePath : "scan",
    estimated: e.estimated,
  }));
}

/**
 * Full-project backup tuned for Gist: config + all usage events + compact daily mirrors.
 * OpenRouter catalog is omitted (can re-fetch); request-level jsonl never included.
 */
export async function buildGistFullBackup(events: UsageEvent[]): Promise<XlabBackup> {
  const full = await buildFullBackup({
    events,
    includeMirrors: true,
    note: "XLab Token full usage backup (daily-first events + settings + compact mirrors)",
  });
  full.events = compactEventsForGist(full.events || []);
  // Catalog is re-fetchable and large — drop from Gist to leave room for usage
  delete full.openrouter;
  full.meta = {
    ...full.meta,
    eventCount: full.events.length,
    openrouterModelCount: 0,
    note:
      (full.meta?.note || "") +
      " · openrouter catalog omitted (refresh from network after restore)",
  };
  return full;
}

/**
 * Create or update a secret GitHub Gist with **full project usage**
 * (settings + custom rates + all scanned usage events + compact daily mirrors).
 */
export async function uploadBackupToGist(opts: {
  token?: string | null;
  gistId?: string | null;
  public?: boolean;
  eventCountHint?: number;
  saveToken?: boolean;
  /** @deprecated Gist always uploads full usage when events are provided */
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

  // Always prefer full usage on Gist when we have the event cache
  let backup: XlabBackup;
  let scope: BackupScope = "full";
  if (opts.events && opts.events.length >= 0) {
    backup = await buildGistFullBackup(opts.events);
    scope = "full";
  } else {
    backup = buildSettingsBackup({
      eventCountHint: opts.eventCountHint,
      note: "Settings only — no usage cache available at upload time; Rescan then backup again",
    });
    scope = "settings";
  }
  log("Backup built, scope:", scope, "events:", backup.events?.length ?? 0);

  // Compact JSON (no pretty-print) to maximize room for usage rows
  let content = JSON.stringify(backup);
  let size = Buffer.byteLength(content, "utf8");

  // If still huge: drop mirrors, keep all events
  if (size > GIST_MAX_BYTES && backup.mirrors && Object.keys(backup.mirrors).length) {
    backup = {
      ...backup,
      mirrors: undefined,
      meta: {
        ...backup.meta,
        mirrorFileCount: 0,
        mirrorBytes: 0,
        note: (backup.meta?.note || "") + " · mirrors omitted (size)",
      },
    };
    content = JSON.stringify(backup);
    size = Buffer.byteLength(content, "utf8");
  }

  if (size > GIST_MAX_BYTES) {
    throw new Error(
      `Full usage backup is ${Math.round(size / 1024 / 1024)}MB (limit ~${Math.round(GIST_MAX_BYTES / 1024 / 1024)}MB). ` +
        `Use Export full download instead, or reduce history.`,
    );
  }

  const filename = "xlab-token-backup.json";
  const description = `XLab Token full usage · ${backup.events?.length || 0} events · ${backup.exportedAt} · v${backup.appVersion}`;

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

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": `xlab-token/${VERSION}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const res = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, {
    method: "GET",
    headers,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logError("GitHub Gist download failed:", res.status, text.slice(0, 240));
    throw new Error(`GitHub Gist API ${res.status}: ${text.slice(0, 240) || res.statusText}`);
  }

  const data = (await res.json()) as {
    files?: Record<string, { content?: string }>;
    html_url?: string;
  };
  const filename = "xlab-token-backup.json";
  const file = data.files?.[filename] ?? Object.values(data.files || {})[0];
  if (!file || !file.content) {
    logError("Gist has no usable backup file");
    throw new Error("Gist has no usable backup file.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(file.content);
  } catch (err) {
    logError("Failed to parse backup JSON:", err instanceof Error ? err.message : err);
    throw new Error("Failed to parse backup JSON from Gist.");
  }

  if (!isXlabBackup(raw)) {
    logError("Downloaded file is not a valid XLab backup");
    throw new Error("Downloaded file is not a valid XLab backup.");
  }

  log("Backup downloaded, events:", raw.events?.length ?? 0, "scope:", raw.scope);
  const restored = await restoreBackup(raw);
  log("Backup restored, scope:", restored.scope);

  // Save gist metadata to config if not present
  const cfg = await loadConfig();
  if (!cfg.backup?.gistId && gistId) {
    await saveConfig({
      ...cfg,
      backup: {
        ...cfg.backup,
        gistId,
        gistUrl: data.html_url,
      },
    });
    log("Saved gist metadata to config");
  }

  return { backup: raw, restored };
}
