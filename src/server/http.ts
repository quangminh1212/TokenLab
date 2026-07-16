import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, costReport } from "../aggregate.js";
import { detectAgents, scanAll } from "../agents/index.js";
import {
  buildFullBackup,
  buildSettingsBackup,
  loadImportedEvents,
  loadScanCache,
  mergeEventsById,
  mergeEventsByIdPreferRicher,
  mergeLocalPreferOverGistRollups,
  restoreBackup,
  saveImportedEvents,
  saveScanCache,
  uploadBackupToGist,
} from "../backup.js";
import { loadConfig, saveConfig, setCustomRates, configPath, getConfigSync } from "../config.js";
import {
  fetchOpenRouterModels,
  getOpenRouterFetchedAt,
  getOpenRouterModelsSync,
  loadOpenRouterCacheFromDisk,
} from "../openrouter-models.js";
import { BUNDLED_RATES, getRateForModel, guessProvider, listPricingCatalog, repriceEvents } from "../pricing.js";
import { writeHeartbeat } from "../process-guard.js";
import type { AgentStatus, GroupBy, ModelRate, UsageEvent } from "../types.js";
import { filterByPeriod, normalizeModelName, pathExists, startOfDayInTimeZone } from "../util.js";
import { VERSION } from "../version.js";

function configuredTimeZone(): string {
  // getConfigSync already normalizes UTC→local on non-UTC hosts
  const tz = getConfigSync().timezone;
  return (tz && String(tz).trim()) || "local";
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  host?: string;
  port?: number;
  noUi?: boolean;
}

export async function startServer(opts: ServerOptions = {}): Promise<{ close: () => Promise<void>; port: number; host: string }> {
  await loadConfig();
  const host = opts.host || process.env.XLAB_TOKEN_HOST || "127.0.0.1";
  const port = Number(opts.port || process.env.XLAB_TOKEN_PORT || 3737);
  const noUi = opts.noUi || process.env.XLAB_TOKEN_NO_UI === "1";
  const startedAt = Date.now();

  let cache: UsageEvent[] = [];
  /** Events from other machines / restore — survive local rescan (merged by id). */
  let importedEvents: UsageEvent[] = await loadImportedEvents();
  /** Last local scan snapshot — unioned so incomplete/timeout passes never wipe known usage. */
  const diskScanCache = await loadScanCache();
  cache = mergeLocalPreferOverGistRollups(diskScanCache, importedEvents);
  if (diskScanCache.length > 0) {
    console.log(`[xlab-token] loaded ${diskScanCache.length} cached scan events`);
  }
  if (importedEvents.length > 0) {
    console.log(`[xlab-token] loaded ${importedEvents.length} imported events`);
  }
  if (cache.length > 0) {
    console.log(`[xlab-token] warm cache ready: ${cache.length} events (scan + import)`);
  }
  let scanning = false;
  let scanCacheSaveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSaveScanCache = (): void => {
    if (scanCacheSaveTimer) clearTimeout(scanCacheSaveTimer);
    scanCacheSaveTimer = setTimeout(() => {
      scanCacheSaveTimer = null;
      void saveScanCache(cache).catch((err) => {
        console.warn(
          "[xlab-token] save scan cache failed:",
          err instanceof Error ? err.message : err,
        );
      });
    }, 2_000);
    scanCacheSaveTimer.unref?.();
  };
  /** Shared promise so concurrent /api/scan waits for the in-flight scan (not empty cache). */
  let scanPromise: Promise<number> | null = null;
  /** Bumps after each completed scan so UIs can reload when cache fills. */
  let scanRevision = 0;
  let scanUpdatedAt = 0;
  /** Bumps when pricing rates change so UIs can refresh costs in realtime. */
  let pricingRevision = 1;
  let pricingUpdatedAt = Date.now();
  /** SSE clients (pricing + scan status). */
  const streamListeners = new Set<ServerResponse>();

  function broadcastStream(payload: Record<string, unknown>): void {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of streamListeners) {
      try {
        res.write(data);
      } catch {
        streamListeners.delete(res);
      }
    }
  }

  function bumpPricing(reason = "update"): void {
    pricingRevision += 1;
    pricingUpdatedAt = Date.now();
    broadcastStream({
      type: "pricing",
      revision: pricingRevision,
      updatedAt: pricingUpdatedAt,
      reason,
      eventCount: cache.length,
      scanning,
      scanRevision,
    });
  }

  function bumpScan(reason = "scan"): void {
    scanRevision += 1;
    scanUpdatedAt = Date.now();
    broadcastStream({
      type: "scan",
      revision: scanRevision,
      updatedAt: scanUpdatedAt,
      reason,
      eventCount: cache.length,
      scanning: false,
      pricingRevision,
    });
  }

  /**
   * Rescan local agent usage into memory.
   * - full: true  → historical full pass (long per-agent cap, default 5 min). Used on boot +
   *                 manual /api/scan so heavy agents are not cut off mid-history, but cannot hang forever.
   * - full: false → periodic refresh with soft timeout (keeps UI snappy).
   */
  async function rescan(opts: { full?: boolean } = {}): Promise<number> {
    // Coalesce concurrent rescans — never return mid-scan empty cache to callers.
    if (scanPromise) return scanPromise;
    const full = opts.full === true;
    scanning = true;
    // Keep previous cache visible until first progressive batch arrives
    broadcastStream({
      type: "scan",
      revision: scanRevision,
      updatedAt: Date.now(),
      reason: full ? "start-full" : "start",
      eventCount: cache.length,
      scanning: true,
      pricingRevision,
    });
    if (full) {
      console.log("[xlab-token] full historical scan started (all agent usage on disk)…");
    }
    scanPromise = (async () => {
      const prev = cache;
      const byAgent = new Map<string, UsageEvent[]>();
      const agentStats: Array<{ agent: string; events: number; durationMs: number; error?: string }> = [];
      // Seed with previous events so UI does not flash to 0 while scanning
      for (const e of prev) {
        const list = byAgent.get(e.agent) ?? [];
        list.push(e);
        byAgent.set(e.agent, list);
      }
      const rebuild = (): void => {
        const scanned: UsageEvent[] = [];
        for (const list of byAgent.values()) {
          for (const e of list) scanned.push(e);
        }
        // Keep imported + local. Drop Gist day/hour rollups when local already
        // covers the same day×agent×model (avoids double-count after restore).
        cache = mergeLocalPreferOverGistRollups(scanned, importedEvents);
      };
      try {
        // Parallel parsers + progressive cache so Dashboard is not stuck at 0 for 20s+
        // Full boot/manual scan: no timeout — read complete history so nothing is missed.
        // Periodic: longer soft timeout; results are always UNIONED with previous so a
        // short/partial pass never deletes usage we already discovered.
        await scanAll({
          concurrency: full ? 3 : 4,
          // Full: no timeout (0) — wait for every agent so large Grok logs are never cut.
          // Periodic: long soft timeout; results always unioned with previous.
          timeoutMs: full ? 0 : 300_000,
          onAgentDone: ({ agent, events, durationMs, error }) => {
            // Long agent parsers can block the event loop; refresh hang watchdog.
            writeHeartbeat();
            const prevForAgent = byAgent.get(agent) ?? [];
            if (error && events.length === 0) {
              // Timeout/crash with nothing parsed — keep previous (never wipe)
            } else if (events.length === 0 && prevForAgent.length > 0) {
              // Parser returned empty but we already had data — keep previous
              // (empty often means path flaky / lock, not "agent deleted history")
            } else {
              // Union scan + previous for this agent; prefer richer rows on same id.
              // Full and periodic both keep history — never shrink all-time totals.
              byAgent.set(agent, mergeEventsByIdPreferRicher(events, prevForAgent));
              rebuild();
              // Persist progressive results so restart never loses a long in-flight scan.
              scheduleSaveScanCache();
            }
            agentStats.push({
              agent,
              events: (byAgent.get(agent) ?? events).length,
              durationMs,
              error: error || undefined,
            });
            // Touch scanUpdatedAt so UIs polling health reload when tokens change
            // even if eventCount stays the same mid-scan.
            scanUpdatedAt = Date.now();
            broadcastStream({
              type: "scan",
              revision: scanRevision,
              updatedAt: scanUpdatedAt,
              reason: "progress",
              agent,
              durationMs,
              error: error || null,
              eventCount: cache.length,
              scanning: true,
              pricingRevision,
            });
            if (full) {
              const kept = (byAgent.get(agent) ?? []).length;
              const status = error
                ? `error: ${error} (kept ${kept})`
                : `${events.length} new → ${kept} total`;
              console.log(`[xlab-token]   ${agent}: ${status} (${durationMs}ms)`);
            }
          },
        });
        rebuild();
        bumpScan(full ? "complete-full" : "complete");
        scheduleSaveScanCache();
        if (full) {
          const failed = agentStats.filter((s) => s.error);
          console.log(
            `[xlab-token] full historical scan done: ${cache.length} events` +
              ` from ${agentStats.length} agents` +
              (failed.length ? ` (${failed.length} failed: ${failed.map((f) => f.agent).join(", ")})` : ""),
          );
        }
        return cache.length;
      } catch (err) {
        // Keep last progressive cache rather than wiping
        bumpScan("error");
        throw err;
      } finally {
        scanning = false;
        scanPromise = null;
      }
    })();
    return scanPromise;
  }

  // Do NOT block listen on the full scan — large agent datasets (100k+ events)
  // take many seconds and race with hot-reload port reclaim on Windows.
  const dashboardPath = path.join(__dirname, "dashboard.html");
  const agentsPagePath = path.join(__dirname, "agents.html");
  const settingsPagePath = path.join(__dirname, "settings.html");
  const pricingPagePath = path.join(__dirname, "pricing.html");
  const stylesPath = path.join(__dirname, "styles.css");

  /** In-memory file cache (mtime-aware) so page switches do not re-read disk every time. */
  const textFileCache = new Map<string, { mtimeMs: number; size: number; body: string; etag: string }>();
  const binFileCache = new Map<string, { mtimeMs: number; size: number; body: Buffer; etag: string }>();

  async function readTextCached(filePath: string): Promise<{ body: string; etag: string; mtimeMs: number }> {
    const st = await stat(filePath);
    const hit = textFileCache.get(filePath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      return { body: hit.body, etag: hit.etag, mtimeMs: hit.mtimeMs };
    }
    const body = await readFile(filePath, "utf8");
    const etag = `W/"${st.mtimeMs.toString(16)}-${st.size.toString(16)}"`;
    textFileCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, body, etag });
    return { body, etag, mtimeMs: st.mtimeMs };
  }

  async function readBinCached(filePath: string): Promise<{ body: Buffer; etag: string; mtimeMs: number }> {
    const st = await stat(filePath);
    const hit = binFileCache.get(filePath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      return { body: hit.body, etag: hit.etag, mtimeMs: hit.mtimeMs };
    }
    const body = await readFile(filePath);
    const etag = `W/"${st.mtimeMs.toString(16)}-${st.size.toString(16)}"`;
    // Cap binary cache to avoid holding huge unexpected files (icons are tiny)
    if (body.length <= 2 * 1024 * 1024) {
      binFileCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, body, etag });
    }
    return { body, etag, mtimeMs: st.mtimeMs };
  }

  function sendCachedText(
    req: IncomingMessage,
    res: ServerResponse,
    file: { body: string; etag: string },
    contentType: string,
    cacheControl: string,
  ): void {
    if (req.headers["if-none-match"] === file.etag) {
      res.writeHead(304, {
        ETag: file.etag,
        "Cache-Control": cacheControl,
      });
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType,
      ETag: file.etag,
      "Cache-Control": cacheControl,
      "Content-Length": Buffer.byteLength(file.body, "utf8"),
    });
    res.end(file.body);
  }

  /**
   * detectAgents hits the filesystem for every agent root — cache path probes
   * and only recompute event counts from memory between probes (cheap O(n)).
   */
  let agentsStatusCache: {
    at: number;
    eventCount: number;
    agents: AgentStatus[];
  } | null = null;
  let agentsStatusPromise: Promise<AgentStatus[]> | null = null;
  const AGENTS_PATH_TTL_MS = 8_000;

  function refreshAgentEventCounts(base: AgentStatus[]): AgentStatus[] {
    const counts = new Map<string, number>();
    const lastAt = new Map<string, string>();
    for (const e of cache) {
      counts.set(e.agent, (counts.get(e.agent) ?? 0) + 1);
      const prev = lastAt.get(e.agent);
      if (!prev || e.timestamp > prev) lastAt.set(e.agent, e.timestamp);
    }
    return base.map((a) => ({
      ...a,
      eventCount: counts.get(a.id) ?? 0,
      lastEventAt: lastAt.get(a.id) ?? null,
    }));
  }

  async function getAgentsStatus(force = false): Promise<AgentStatus[]> {
    const now = Date.now();
    if (
      !force &&
      agentsStatusCache &&
      now - agentsStatusCache.at < AGENTS_PATH_TTL_MS
    ) {
      // Paths still valid — refresh counts without disk I/O
      if (agentsStatusCache.eventCount === cache.length) {
        return agentsStatusCache.agents;
      }
      const agents = refreshAgentEventCounts(agentsStatusCache.agents);
      agentsStatusCache = { at: agentsStatusCache.at, eventCount: cache.length, agents };
      return agents;
    }
    if (!force && agentsStatusPromise) return agentsStatusPromise;
    agentsStatusPromise = detectAgents(cache)
      .then((agents) => {
        agentsStatusCache = {
          at: Date.now(),
          eventCount: cache.length,
          agents,
        };
        return agents;
      })
      .finally(() => {
        agentsStatusPromise = null;
      });
    return agentsStatusPromise;
  }

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      json(res, 500, {
        error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) },
      });
    }
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/api/health") {
      const agents = await getAgentsStatus();
      const timezone = configuredTimeZone();
      return json(res, 200, {
        ok: true,
        version: VERSION,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        agentsDetected: agents.filter((a) => a.detected).map((a) => a.id),
        eventCount: cache.length,
        scanning,
        scanRevision,
        scanUpdatedAt,
        pricingRevision,
        pricingUpdatedAt,
        timezone,
        todayStartsAt: startOfDayInTimeZone(timezone).toISOString(),
      });
    }

    if (req.method === "GET" && pathname === "/api/stats") {
      const since = url.searchParams.get("since");
      const until = url.searchParams.get("until");
      const groupBy = (url.searchParams.get("groupBy") || "agent") as GroupBy;
      const sort = (url.searchParams.get("sort") || "cost") as "tokens" | "cost";
      if (!["agent", "model", "day", "hour"].includes(groupBy)) {
        return json(res, 400, {
          error: { code: "INVALID_QUERY", message: "groupBy must be one of: agent, model, day, hour" },
        });
      }
      const events = filterByPeriod(cache, since, until, configuredTimeZone());
      return json(res, 200, aggregate(events, groupBy, sort, since, until));
    }

    if (req.method === "GET" && pathname === "/api/cost") {
      const since = url.searchParams.get("since");
      const until = url.searchParams.get("until");
      const events = filterByPeriod(cache, since, until, configuredTimeZone());
      return json(res, 200, costReport(events, since, until));
    }

    if (req.method === "GET" && pathname === "/api/events") {
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") || 100)));
      const agent = url.searchParams.get("agent");
      const since = url.searchParams.get("since");
      const until = url.searchParams.get("until");
      let list = filterByPeriod(cache, since, until, configuredTimeZone());
      if (agent) list = list.filter((e) => e.agent === agent);
      // Newest first by timestamp (scan order is not chronological)
      list = list
        .slice()
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, limit);
      return json(res, 200, { events: list, count: list.length });
    }

    if (req.method === "GET" && pathname === "/api/agents") {
      return json(res, 200, { agents: await getAgentsStatus() });
    }

    if (req.method === "POST" && pathname === "/api/scan") {
      const t0 = Date.now();
      // Manual refresh always does a full historical pass (no per-agent timeout).
      // async=1: start scan in background and return immediately (UI stays responsive)
      const asyncMode =
        url.searchParams.get("async") === "1" ||
        url.searchParams.get("wait") === "0";
      if (asyncMode) {
        void rescan({ full: true }).catch((err) => {
          console.error("[xlab-token] async scan failed:", err instanceof Error ? err.message : err);
        });
        return json(res, 202, {
          ok: true,
          accepted: true,
          full: true,
          scanning: true,
          eventCount: cache.length,
          scanRevision,
        });
      }
      const n = await rescan({ full: true });
      return json(res, 200, {
        ok: true,
        full: true,
        eventsIngested: n,
        durationMs: Date.now() - t0,
      });
    }

    if (req.method === "GET" && pathname === "/api/pricing") {
      const models = [
        ...new Set(
          cache
            .map((e) => normalizeModelName(e.model) || e.model || "")
            .filter(Boolean) as string[],
        ),
      ];
      const cfg = await loadConfig();
      const forceOr = url.searchParams.get("refreshOpenRouter") === "1";
      // Auto-refresh stale OpenRouter catalog (>6h) so Model page stays complete
      const fetchedAt = getOpenRouterFetchedAt();
      const stale = !fetchedAt || Date.now() - fetchedAt > 6 * 60 * 60 * 1000;
      if (forceOr || getOpenRouterModelsSync().length === 0 || stale) {
        try {
          await fetchOpenRouterModels({ force: forceOr || stale });
        } catch {
          // keep empty / stale; UI can show offline
        }
      }
      const openrouter = getOpenRouterModelsSync();
      const custom = cfg.pricing?.customRates || {};
      type CatalogRow = {
        id: string;
        name: string;
        provider: string;
        slug: string;
        contextLength: number;
        modality: string;
        free: boolean;
        source: "custom" | "openrouter" | "bundled" | "seen";
        inputPer1M: number;
        outputPer1M: number;
        cacheReadPer1M?: number;
        cacheWritePer1M?: number;
        created?: number;
      };
      // Merge OpenRouter rows with effective rates (custom overrides)
      const openrouterCatalog: CatalogRow[] = openrouter.map((m) => {
        const cKey = m.id.toLowerCase();
        const sKey = m.slug.toLowerCase();
        const cust = custom[cKey] || custom[sKey];
        return {
          id: m.id,
          name: m.name,
          provider: m.provider,
          slug: m.slug,
          contextLength: m.contextLength,
          modality: m.modality,
          free: m.free,
          source: cust ? ("custom" as const) : ("openrouter" as const),
          inputPer1M: cust?.inputPer1M ?? m.inputPer1M,
          outputPer1M: cust?.outputPer1M ?? m.outputPer1M,
          cacheReadPer1M: cust?.cacheReadPer1M ?? m.cacheReadPer1M,
          cacheWritePer1M: cust?.cacheWritePer1M ?? m.cacheWritePer1M,
          created: m.created,
        };
      });

      // Index existing catalog for merge
      const byId = new Map(openrouterCatalog.map((m) => [m.id.toLowerCase(), m]));
      const bySlug = new Map<string, CatalogRow>();
      for (const m of openrouterCatalog) {
        if (m.slug) bySlug.set(m.slug.toLowerCase(), m);
      }

      const addSynthetic = (
        rawName: string,
        source: "bundled" | "seen" | "custom",
      ): void => {
        const name = String(rawName || "").trim();
        if (!name || name === "default") return;
        // skip router aggregate placeholders
        if (/^9router-/i.test(name) || name === "mixed" || name === "XLab") return;
        const norm = normalizeModelName(name) || name;
        const key = norm.toLowerCase();
        if (byId.has(key) || bySlug.has(key)) return;
        // also skip if any OR id ends with /slug
        for (const id of byId.keys()) {
          if (id.endsWith("/" + key) || id === key) return;
        }
        const { rate, source: rateSource } = getRateForModel(name);
        const provider = guessProvider(norm);
        const slug = norm.includes("/") ? norm.slice(norm.indexOf("/") + 1) : norm;
        const id = norm.includes("/") ? norm : `${provider}/${slug}`;
        if (byId.has(id.toLowerCase())) return;
        const cust = custom[key] || custom[id.toLowerCase()] || custom[slug.toLowerCase()];
        const entry: CatalogRow = {
          id,
          name: norm,
          provider,
          slug,
          contextLength: 0,
          modality: "text->text",
          free:
            (cust?.inputPer1M ?? rate.inputPer1M) === 0 &&
            (cust?.outputPer1M ?? rate.outputPer1M) === 0,
          source: cust
            ? "custom"
            : rateSource === "bundled"
              ? "bundled"
              : source === "custom"
                ? "custom"
                : source,
          inputPer1M: cust?.inputPer1M ?? rate.inputPer1M,
          outputPer1M: cust?.outputPer1M ?? rate.outputPer1M,
          cacheReadPer1M: cust?.cacheReadPer1M ?? rate.cacheReadPer1M,
          cacheWritePer1M: cust?.cacheWritePer1M ?? rate.cacheWritePer1M,
          created: 0,
        };
        openrouterCatalog.push(entry);
        byId.set(id.toLowerCase(), entry);
        bySlug.set(slug.toLowerCase(), entry);
      };

      // Bundled offline rates first, then models seen in local usage
      for (const k of Object.keys(BUNDLED_RATES)) addSynthetic(k, "bundled");
      for (const k of Object.keys(custom)) addSynthetic(k, "custom");
      for (const m of models) addSynthetic(m, "seen");

      // Newest OpenRouter first, then synthetic (created=0) alphabetically
      openrouterCatalog.sort(
        (a, b) => (b.created || 0) - (a.created || 0) || a.name.localeCompare(b.name),
      );

      return json(res, 200, {
        configPath: configPath(),
        currency: cfg.pricing?.currency || "USD",
        preferRouterCost: cfg.pricing?.preferRouterCost !== false,
        customRates: custom,
        catalog: listPricingCatalog(models as string[]),
        openrouter: openrouterCatalog,
        openrouterCount: openrouterCatalog.length,
        openrouterFetchedAt: getOpenRouterFetchedAt(),
        seenModels: models.sort((a, b) => a.localeCompare(b)),
        pricingRevision,
        pricingUpdatedAt,
      });
    }

    if (req.method === "POST" && pathname === "/api/models/refresh") {
      try {
        const models = await fetchOpenRouterModels({ force: true });
        return json(res, 200, {
          ok: true,
          count: models.length,
          fetchedAt: getOpenRouterFetchedAt(),
        });
      } catch (err) {
        return json(res, 502, {
          error: {
            code: "OPENROUTER_FETCH",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    // Server-Sent Events: pricing + scan completion for multi-tab / dashboard
    if (req.method === "GET" && pathname === "/api/pricing/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write(
        `data: ${JSON.stringify({
          type: "hello",
          revision: pricingRevision,
          pricingRevision,
          scanRevision,
          scanning,
          updatedAt: pricingUpdatedAt,
          eventCount: cache.length,
        })}\n\n`,
      );
      streamListeners.add(res);
      const keepAlive = setInterval(() => {
        try {
          res.write(`: ping ${Date.now()}\n\n`);
        } catch {
          clearInterval(keepAlive);
          streamListeners.delete(res);
        }
      }, 15000);
      keepAlive.unref?.();
      req.on("close", () => {
        clearInterval(keepAlive);
        streamListeners.delete(res);
      });
      return;
    }

    if (req.method === "PUT" && pathname === "/api/pricing") {
      const body = await readJsonBody(req);
      const ratesIn = (body?.customRates || body?.rates || {}) as Record<string, Partial<ModelRate>>;
      const replace = body?.replace === true;
      const live = body?.live === true;
      const normalized: Record<string, ModelRate> = {};
      for (const [rawKey, rawVal] of Object.entries(ratesIn)) {
        const key = (normalizeModelName(rawKey) || rawKey).trim().toLowerCase();
        if (!key || !rawVal || typeof rawVal !== "object") continue;
        const inputPer1M = Number(rawVal.inputPer1M);
        const outputPer1M = Number(rawVal.outputPer1M);
        if (!Number.isFinite(inputPer1M) || !Number.isFinite(outputPer1M)) continue;
        normalized[key] = {
          inputPer1M,
          outputPer1M,
          cacheReadPer1M:
            rawVal.cacheReadPer1M != null && Number.isFinite(Number(rawVal.cacheReadPer1M))
              ? Number(rawVal.cacheReadPer1M)
              : undefined,
          cacheWritePer1M:
            rawVal.cacheWritePer1M != null && Number.isFinite(Number(rawVal.cacheWritePer1M))
              ? Number(rawVal.cacheWritePer1M)
              : undefined,
        };
      }
      const cfg = await setCustomRates(normalized, replace);
      // Force table reprice so new rates apply immediately to all events
      cache = repriceEvents(cache, { forceTable: true });
      bumpPricing(live ? "live" : "save");
      const totals = aggregate(cache, "agent", "cost", null, null).totals;
      return json(res, 200, {
        ok: true,
        live: Boolean(live),
        customRates: cfg.pricing?.customRates || {},
        eventCount: cache.length,
        pricingRevision,
        pricingUpdatedAt,
        totals: {
          estimatedCost: totals.estimatedCost,
          totalTokens: totals.totalTokens,
          eventCount: totals.eventCount,
        },
      });
    }

    // HTML: ETag + short private cache so nav back/forward and quick switches are instant
    const htmlCacheControl = "private, max-age=15, must-revalidate";
    if (!noUi && req.method === "GET" && (pathname === "/" || pathname === "/index.html" || pathname === "/dashboard")) {
      const file = await readTextCached(dashboardPath);
      sendCachedText(req, res, file, "text/html; charset=utf-8", htmlCacheControl);
      return;
    }

    if (!noUi && req.method === "GET" && (pathname === "/agents" || pathname === "/agents.html")) {
      const file = await readTextCached(agentsPagePath);
      sendCachedText(req, res, file, "text/html; charset=utf-8", htmlCacheControl);
      return;
    }

    if (!noUi && req.method === "GET" && (pathname === "/settings" || pathname === "/settings.html")) {
      const file = await readTextCached(settingsPagePath);
      sendCachedText(req, res, file, "text/html; charset=utf-8", htmlCacheControl);
      return;
    }

    if (
      !noUi &&
      req.method === "GET" &&
      (pathname === "/model" ||
        pathname === "/model.html" ||
        pathname === "/pricing" ||
        pathname === "/pricing.html")
    ) {
      const file = await readTextCached(pricingPagePath);
      sendCachedText(req, res, file, "text/html; charset=utf-8", htmlCacheControl);
      return;
    }

    if (req.method === "GET" && pathname === "/api/config") {
      const cfg = await loadConfig();
      // Never echo full GitHub token to the browser
      const hasToken = Boolean(cfg.backup?.githubToken || process.env.XLAB_GITHUB_TOKEN || process.env.GITHUB_TOKEN);
      return json(res, 200, {
        ...cfg,
        configPath: configPath(),
        backup: {
          gistId: cfg.backup?.gistId || null,
          gistUrl: cfg.backup?.gistUrl || null,
          lastBackupAt: cfg.backup?.lastBackupAt || null,
          hasGithubToken: hasToken,
        },
      });
    }

    // Backup: ?scope=settings|full (default full for download)
    if (req.method === "GET" && pathname === "/api/backup") {
      const scope = url.searchParams.get("scope") === "settings" ? "settings" : "full";
      if (scope === "settings") {
        return json(res, 200, buildSettingsBackup({ eventCountHint: cache.length }));
      }
      try {
        const includeMirrors = url.searchParams.get("mirrors") !== "0";
        const backup = await buildFullBackup({
          events: cache,
          includeMirrors,
        });
        return json(res, 200, backup);
      } catch (err) {
        return json(res, 500, {
          error: {
            code: "BACKUP_FAILED",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    if (req.method === "POST" && pathname === "/api/backup/gist") {
      const body = await readJsonBody(req);
      try {
        const result = await uploadBackupToGist({
          token: typeof body.token === "string" ? body.token : null,
          gistId: typeof body.gistId === "string" ? body.gistId : null,
          public: body.public === true,
          eventCountHint: cache.length,
          saveToken: body.saveToken === true,
          // Period stats: by model + by agent for Today/24h/7D/30D/All
          scope: "period-stats",
          events: cache,
        });
        return json(res, 200, {
          ok: true,
          gist: result.gist,
          scope: result.scope,
          exportedAt: result.backup.exportedAt,
          customRateCount: Object.keys(result.backup.config.pricing?.customRates || {}).length,
          eventCount:
            result.backup.meta?.sourceEventCount ||
            result.backup.meta?.eventCount ||
            result.backup.events?.length ||
            0,
          rollupEventCount:
            result.backup.meta?.rollupEventCount || result.backup.events?.length || 0,
          modelCount: result.backup.meta?.modelCount || 0,
          agentCount: result.backup.meta?.agentCount || 0,
          machineId: result.backup.meta?.machineId || null,
          machines: result.backup.meta?.machines || [],
          mirrorFileCount: result.backup.meta?.mirrorFileCount || 0,
        });
      } catch (err) {
        return json(res, 400, {
          error: {
            code: "GIST_BACKUP_FAILED",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    if (req.method === "POST" && pathname === "/api/backup/restore") {
      const body = await readJsonBody(req);
      const payload = (body.backup && typeof body.backup === "object" ? body.backup : body) as unknown;
      try {
        const result = await restoreBackup(payload);
        // Restore usage: merge Gist rollups / full events into import + cache
        if (result.events && result.events.length > 0) {
          // Persist so the next local rescan does not drop other-machine events
          importedEvents = mergeEventsByIdPreferRicher(importedEvents, result.events);
          await saveImportedEvents(importedEvents);
          // Prefer real local rows over Gist rollups for the same day×agent×model
          cache = repriceEvents(mergeLocalPreferOverGistRollups(cache, importedEvents), {
            forceTable: result.config.pricing?.preferRouterCost === false,
          });
          bumpScan("restore");
        } else {
          cache = repriceEvents(cache, {
            forceTable: result.config.pricing?.preferRouterCost === false,
          });
        }
        bumpPricing("restore");
        return json(res, 200, {
          ok: true,
          scope: result.scope,
          customRateCount: result.customRateCount,
          eventCount: cache.length,
          eventsRestored: result.events?.length || 0,
          openrouterRestored: result.openrouterRestored,
          mirrorsRestored: result.mirrorsRestored,
          timezone: result.config.timezone || "local",
        });
      } catch (err) {
        return json(res, 400, {
          error: {
            code: "RESTORE_FAILED",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    if (req.method === "PUT" && pathname === "/api/config") {
      const body = await readJsonBody(req);
      const prev = await loadConfig();
      const bodyPricing =
        body.pricing && typeof body.pricing === "object"
          ? (body.pricing as Record<string, unknown>)
          : {};
      const bodyRates = bodyPricing.customRates;
      const bodyTz =
        typeof body.timezone === "string" && body.timezone.trim()
          ? body.timezone.trim()
          : prev.timezone;
      const next = await saveConfig({
        ...prev,
        timezone: bodyTz || "local",
        pricing: {
          ...prev.pricing,
          ...bodyPricing,
          // never wipe custom rates via this endpoint unless explicitly provided
          customRates:
            bodyRates && typeof bodyRates === "object"
              ? (bodyRates as NonNullable<typeof prev.pricing>["customRates"])
              : prev.pricing?.customRates,
        },
      });
      // Reprice when preferRouterCost flips
      cache = repriceEvents(cache, { forceTable: next.pricing?.preferRouterCost === false });
      bumpPricing("config");
      return json(res, 200, {
        ok: true,
        ...next,
        configPath: configPath(),
        todayStartsAt: startOfDayInTimeZone(next.timezone || "local").toISOString(),
      });
    }

    if (!noUi && req.method === "GET" && pathname === "/styles.css") {
      try {
        const file = await readTextCached(stylesPath);
        // Revalidate each nav (ETag → 304) but keep body in memory for fast hits
        sendCachedText(req, res, file, "text/css; charset=utf-8", "public, max-age=0, must-revalidate");
        return;
      } catch {
        return json(res, 404, { error: { code: "NOT_FOUND", message: "styles.css not found" } });
      }
    }

    if (!noUi && req.method === "GET" && pathname.startsWith("/assets/")) {
      const rel = decodeURIComponent(pathname.slice("/assets/".length)).replace(/\\/g, "/");
      if (!rel || rel.includes("..") || path.isAbsolute(rel) || !/^[a-zA-Z0-9._/-]+$/.test(rel)) {
        return json(res, 400, { error: { code: "BAD_PATH", message: "Invalid asset path" } });
      }
      const assetsRoot = path.join(__dirname, "assets");
      const file = path.resolve(assetsRoot, rel);
      if (!file.startsWith(assetsRoot + path.sep) && file !== assetsRoot) {
        return json(res, 400, { error: { code: "BAD_PATH", message: "Invalid asset path" } });
      }
      try {
        const data = await readBinCached(file);
        const cacheControl = "public, max-age=3600, must-revalidate";
        if (req.headers["if-none-match"] === data.etag) {
          res.writeHead(304, { ETag: data.etag, "Cache-Control": cacheControl });
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": contentTypeFor(path.basename(file)),
          ETag: data.etag,
          "Cache-Control": cacheControl,
          "Content-Length": data.body.length,
        });
        res.end(data.body);
        return;
      } catch {
        return json(res, 404, { error: { code: "NOT_FOUND", message: "Asset not found" } });
      }
    }

    json(res, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
  }

  // Bind immediately (retry on EADDRINUSE — common with tsx watch on Windows)
  await listenWithRetry(server, port, host, 40, 150);

  // Warm OpenRouter model catalog (disk then network) so Model page is never empty
  void loadOpenRouterCacheFromDisk()
    .then(() => fetchOpenRouterModels({ force: false }))
    .then((list) => {
      console.log(`[xlab-token] OpenRouter models ready: ${list.length}`);
    })
    .catch((err) => {
      console.warn(
        "[xlab-token] OpenRouter models fetch failed:",
        err instanceof Error ? err.message : err,
      );
    });

  // Refresh VPS router mirrors (best-effort) before first scan so remote usage is not stale.
  void Promise.resolve()
    .then(async () => {
      const { spawn } = await import("node:child_process");
      const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/sync-vps-mirrors.py");
      if (!(await pathExists(script))) return;
      await new Promise<void>((resolve) => {
        const child = spawn("python", [script], { stdio: "ignore", windowsHide: true });
        child.on("error", () => resolve());
        child.on("exit", () => resolve());
        setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
          resolve();
        }, 120_000).unref?.();
      });
    })
    .catch(() => {
      /* optional */
    })
    .finally(() => {
      void rescan({ full: true }).catch((err) => {
        console.error("[xlab-token] initial full scan failed:", err instanceof Error ? err.message : err);
      });
    });

  let periodicTick = 0;
  const timer = setInterval(() => {
    periodicTick += 1;
    // Full thorough pass every 10 ticks (≈5 min) — catches heavy agents that need minutes.
    const doFull = periodicTick % 10 === 0;
    void rescan({ full: doFull }).catch((err) => {
      console.error(
        "[xlab-token] periodic scan failed:",
        err instanceof Error ? err.message : err,
      );
    });
  }, 30_000);
  timer.unref?.();

  return {
    host,
    port,
    close: async () => {
      clearInterval(timer);
      if (scanCacheSaveTimer) {
        clearTimeout(scanCacheSaveTimer);
        scanCacheSaveTimer = null;
      }
      try {
        // Flush immediately on shutdown — do not rely on the 2s debounce timer.
        await saveScanCache(cache);
      } catch (err) {
        console.warn(
          "[xlab-token] final scan cache save failed:",
          err instanceof Error ? err.message : err,
        );
      }
      try {
        server.closeAllConnections?.();
      } catch {
        // Node < 18.2 may not have closeAllConnections
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // hard-stop hang if peers keep sockets open
        setTimeout(() => resolve(), 800).unref?.();
      });
    },
  };
}

function contentTypeFor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".ico")) return "image/x-icon";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

/** Kill other processes listening on `port` (Windows/Linux) so hot-reload can rebind. */
async function forceFreePort(port: number): Promise<boolean> {
  const { execSync } = await import("node:child_process");
  let freed = false;
  try {
    if (process.platform === "win32") {
      const out = execSync("netstat -ano", { encoding: "utf8" });
      const pids = new Set<number>();
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes(`:${port}`) || !/LISTENING/i.test(line)) continue;
        const m = line.trim().match(/(\d+)\s*$/);
        if (!m) continue;
        const pid = Number(m[1]);
        if (pid > 0 && pid !== process.pid) pids.add(pid);
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
          console.warn(`[xlab-token] freed port ${port} (stopped PID ${pid})`);
          freed = true;
        } catch {
          // ignore access denied / already gone
        }
      }
    } else {
      try {
        const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, { encoding: "utf8" });
        for (const raw of out.split(/\s+/)) {
          const pid = Number(raw.trim());
          if (!pid || pid === process.pid) continue;
          try {
            process.kill(pid, "SIGKILL");
            console.warn(`[xlab-token] freed port ${port} (stopped PID ${pid})`);
            freed = true;
          } catch {
            // ignore
          }
        }
      } catch {
        // lsof empty / missing
      }
    }
  } catch {
    // netstat/lsof failed
  }
  return freed;
}

async function listenWithRetry(
  server: ReturnType<typeof createServer>,
  port: number,
  host: string,
  attempts: number,
  delayMs: number,
): Promise<void> {
  let lastErr: unknown;
  let freedOnce = false;
  for (let i = 0; i < attempts; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({ port, host, exclusive: true });
      });
      return;
    } catch (err) {
      lastErr = err;
      const code = err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : "";
      // Must close before re-listen on the same Server instance
      try {
        server.close();
      } catch {
        // ignore
      }
      if (code !== "EADDRINUSE" || i === attempts - 1) break;
      if (i === 0 || (i + 1) % 5 === 0) {
        console.warn(
          `[xlab-token] port ${host}:${port} busy (EADDRINUSE), retry ${i + 1}/${attempts}…`,
        );
      }
      // After a few failures, force-kill the occupant (stale node from previous watch run)
      if (!freedOnce && i >= 2) {
        freedOnce = true;
        await forceFreePort(port);
        await new Promise((r) => setTimeout(r, 300));
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `Cannot bind ${host}:${port} — ${msg}. Run: netstat -ano | findstr :${port}  then taskkill /F /PID <pid>`,
  );
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  // Compact JSON — pretty-print roughly doubles payload for large event lists
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(data, "utf8"),
  });
  res.end(data);
}
