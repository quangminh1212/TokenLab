import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { UsageEvent } from "./types.js";

export function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
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
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (!options.match || options.match(entry.name, full)) out.push(full);
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
  return Math.max(1, Math.ceil(text.length / 4));
}

export function parseSince(since?: string | null): Date | null {
  if (!since) return null;
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

export function filterByPeriod(
  events: UsageEvent[],
  since?: string | null,
  until?: string | null,
): UsageEvent[] {
  const s = parseSince(since);
  const u = until ? new Date(until) : null;
  return events.filter((e) => {
    const t = new Date(e.timestamp).getTime();
    if (Number.isNaN(t)) return false;
    if (s && t < s.getTime()) return false;
    if (u && !Number.isNaN(u.getTime()) && t > u.getTime()) return false;
    return true;
  });
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
