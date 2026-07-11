import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { UsageEvent } from "./types.js";

export function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

export function homeDir(): string {
  return process.env.USERPROFILE || process.env.HOME || process.cwd();
}

export function appDataDir(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA || path.join(homeDir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(homeDir(), "Library", "Application Support");
  }
  return process.env.XDG_CONFIG_HOME || path.join(homeDir(), ".config");
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
