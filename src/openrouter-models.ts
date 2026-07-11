import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelRate } from "./types.js";
import { appDataDir, pathExists } from "./util.js";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
/** Refresh at most once per 12 hours unless forced. */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export interface OpenRouterModelEntry {
  id: string;
  name: string;
  /** provider slug, e.g. openai */
  provider: string;
  /** model slug without provider, e.g. gpt-4o */
  slug: string;
  contextLength: number;
  modality: string;
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
  free: boolean;
  created?: number;
}

interface CacheFile {
  fetchedAt: number;
  models: OpenRouterModelEntry[];
}

let memory: CacheFile | null = null;
let inflight: Promise<OpenRouterModelEntry[]> | null = null;

export function openrouterCachePath(): string {
  if (process.env.XLAB_TOKEN_OPENROUTER_CACHE) return process.env.XLAB_TOKEN_OPENROUTER_CACHE;
  return path.join(
    process.env.XLAB_TOKEN_DATA_DIR || path.join(appDataDir(), "xlab-token"),
    "openrouter-models.json",
  );
}

/** OpenRouter API prices are USD per token → convert to USD per 1M tokens. */
export function perTokenToPer1M(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  // Dynamic / variable pricing is marked -1 by OpenRouter
  if (n < 0) return 0;
  return Math.round(n * 1_000_000 * 1e6) / 1e6;
}

function parseEntry(raw: Record<string, unknown>): OpenRouterModelEntry | null {
  const id = String(raw.id || "").trim();
  if (!id || id.startsWith("~")) return null; // skip redirect aliases
  const name = String(raw.name || id).trim();
  const slash = id.indexOf("/");
  const provider = slash > 0 ? id.slice(0, slash) : "other";
  const slug = slash > 0 ? id.slice(slash + 1) : id;
  const pricing = (raw.pricing && typeof raw.pricing === "object" ? raw.pricing : {}) as Record<
    string,
    unknown
  >;
  const inputPer1M = perTokenToPer1M(pricing.prompt);
  const outputPer1M = perTokenToPer1M(pricing.completion);
  const cacheRead =
    pricing.input_cache_read != null ? perTokenToPer1M(pricing.input_cache_read) : undefined;
  const cacheWrite =
    pricing.input_cache_write != null ? perTokenToPer1M(pricing.input_cache_write) : undefined;
  const arch =
    raw.architecture && typeof raw.architecture === "object"
      ? (raw.architecture as Record<string, unknown>)
      : {};
  const modality = String(arch.modality || "text->text");
  const contextLength = Number(raw.context_length) || 0;
  const free = inputPer1M === 0 && outputPer1M === 0;
  return {
    id,
    name,
    provider,
    slug,
    contextLength,
    modality,
    inputPer1M,
    outputPer1M,
    cacheReadPer1M: cacheRead,
    cacheWritePer1M: cacheWrite,
    free,
    created: Number(raw.created) || undefined,
  };
}

async function readDiskCache(): Promise<CacheFile | null> {
  try {
    const p = openrouterCachePath();
    if (!(await pathExists(p))) return null;
    const raw = JSON.parse(await readFile(p, "utf8")) as CacheFile;
    if (!raw || !Array.isArray(raw.models) || !raw.fetchedAt) return null;
    return raw;
  } catch {
    return null;
  }
}

async function writeDiskCache(cache: CacheFile): Promise<void> {
  const p = openrouterCachePath();
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(cache), "utf8");
}

export async function fetchOpenRouterModels(opts: { force?: boolean } = {}): Promise<OpenRouterModelEntry[]> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      if (!opts.force && memory && Date.now() - memory.fetchedAt < CACHE_TTL_MS) {
        return memory.models;
      }
      if (!opts.force) {
        const disk = await readDiskCache();
        if (disk && Date.now() - disk.fetchedAt < CACHE_TTL_MS && disk.models.length > 0) {
          memory = disk;
          return disk.models;
        }
      }

      const res = await fetch(OPENROUTER_MODELS_URL, {
        headers: { Accept: "application/json", "User-Agent": "xlab-token" },
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) {
        throw new Error(`OpenRouter models HTTP ${res.status}`);
      }
      const body = (await res.json()) as { data?: unknown[] };
      const list = Array.isArray(body.data) ? body.data : [];
      const models: OpenRouterModelEntry[] = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const entry = parseEntry(item as Record<string, unknown>);
        if (entry) models.push(entry);
      }
      models.sort((a, b) => (b.created || 0) - (a.created || 0) || a.id.localeCompare(b.id));
      const cache: CacheFile = { fetchedAt: Date.now(), models };
      memory = cache;
      await writeDiskCache(cache).catch(() => {});
      return models;
    } catch (err) {
      // Fall back to stale cache if network fails
      if (memory?.models?.length) return memory.models;
      const disk = await readDiskCache();
      if (disk?.models?.length) {
        memory = disk;
        return disk.models;
      }
      throw err;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Sync snapshot (may be empty until first fetch). */
export function getOpenRouterModelsSync(): OpenRouterModelEntry[] {
  return memory?.models || [];
}

export function getOpenRouterFetchedAt(): number {
  return memory?.fetchedAt || 0;
}

/** Warm cache from disk without network (startup). */
export async function loadOpenRouterCacheFromDisk(): Promise<number> {
  if (memory?.models?.length) return memory.models.length;
  const disk = await readDiskCache();
  if (disk?.models?.length) {
    memory = disk;
    return disk.models.length;
  }
  return 0;
}

function rateFromEntry(e: OpenRouterModelEntry): ModelRate {
  return {
    inputPer1M: e.inputPer1M,
    outputPer1M: e.outputPer1M,
    cacheReadPer1M: e.cacheReadPer1M,
    cacheWritePer1M: e.cacheWritePer1M,
  };
}

/**
 * Match usage model names against OpenRouter ids/slugs.
 * Prefer exact id, then slug, then longest slug contained in the name.
 */
export function lookupOpenRouterRate(
  model: string | null | undefined,
): { key: string; rate: ModelRate; entry: OpenRouterModelEntry } | null {
  const models = getOpenRouterModelsSync();
  if (!models.length || !model) return null;
  const raw = String(model).trim().toLowerCase();
  if (!raw) return null;

  // Exact full id
  for (const e of models) {
    if (e.id.toLowerCase() === raw) return { key: e.id, rate: rateFromEntry(e), entry: e };
  }

  // Bare slug or provider/slug without exact case
  const bare = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  // Prefer non-free paid variant when multiple match slug
  let slugHit: OpenRouterModelEntry | null = null;
  for (const e of models) {
    if (e.slug.toLowerCase() === bare || e.slug.toLowerCase() === raw) {
      if (!slugHit || (slugHit.free && !e.free)) slugHit = e;
    }
  }
  if (slugHit) return { key: slugHit.id, rate: rateFromEntry(slugHit), entry: slugHit };

  // Longest slug contained in raw (min 6 chars)
  let best: OpenRouterModelEntry | null = null;
  for (const e of models) {
    const s = e.slug.toLowerCase();
    if (s.length < 6) continue;
    if (raw.includes(s) || raw.replace(/_/g, "-").includes(s)) {
      if (!best || e.slug.length > best.slug.length || (best.free && !e.free)) best = e;
    }
  }
  if (best) return { key: best.id, rate: rateFromEntry(best), entry: best };
  return null;
}
