import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, costReport } from "../aggregate.js";
import { detectAgents, scanAll } from "../agents/index.js";
import { loadConfig, saveConfig, setCustomRates, configPath } from "../config.js";
import {
  fetchOpenRouterModels,
  getOpenRouterFetchedAt,
  getOpenRouterModelsSync,
  loadOpenRouterCacheFromDisk,
} from "../openrouter-models.js";
import { listPricingCatalog, repriceEvents } from "../pricing.js";
import type { GroupBy, ModelRate, UsageEvent } from "../types.js";
import { filterByPeriod, normalizeModelName } from "../util.js";
import { VERSION } from "../version.js";

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
  let scanning = false;
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

  async function rescan(): Promise<number> {
    // Coalesce concurrent rescans — never return mid-scan empty cache to callers.
    if (scanPromise) return scanPromise;
    scanning = true;
    broadcastStream({
      type: "scan",
      revision: scanRevision,
      updatedAt: Date.now(),
      reason: "start",
      eventCount: cache.length,
      scanning: true,
      pricingRevision,
    });
    scanPromise = (async () => {
      try {
        cache = await scanAll();
        bumpScan("complete");
        return cache.length;
      } catch (err) {
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
      const agents = await detectAgents(cache);
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
      const events = filterByPeriod(cache, since, until);
      return json(res, 200, aggregate(events, groupBy, sort, since, until));
    }

    if (req.method === "GET" && pathname === "/api/cost") {
      const since = url.searchParams.get("since");
      const until = url.searchParams.get("until");
      const events = filterByPeriod(cache, since, until);
      return json(res, 200, costReport(events, since, until));
    }

    if (req.method === "GET" && pathname === "/api/events") {
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") || 100)));
      const agent = url.searchParams.get("agent");
      const since = url.searchParams.get("since");
      const until = url.searchParams.get("until");
      let list = filterByPeriod(cache, since, until);
      if (agent) list = list.filter((e) => e.agent === agent);
      // Newest first by timestamp (scan order is not chronological)
      list = list
        .slice()
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, limit);
      return json(res, 200, { events: list, count: list.length });
    }

    if (req.method === "GET" && pathname === "/api/agents") {
      return json(res, 200, { agents: await detectAgents(cache) });
    }

    if (req.method === "POST" && pathname === "/api/scan") {
      const t0 = Date.now();
      const n = await rescan();
      return json(res, 200, { ok: true, eventsIngested: n, durationMs: Date.now() - t0 });
    }

    if (req.method === "GET" && pathname === "/api/pricing") {
      const models = [...new Set(cache.map((e) => normalizeModelName(e.model) || e.model || "").filter(Boolean))];
      const cfg = await loadConfig();
      const forceOr = url.searchParams.get("refreshOpenRouter") === "1";
      if (forceOr || getOpenRouterModelsSync().length === 0) {
        try {
          await fetchOpenRouterModels({ force: forceOr });
        } catch {
          // keep empty / stale; UI can show offline
        }
      }
      const openrouter = getOpenRouterModelsSync();
      const custom = cfg.pricing?.customRates || {};
      // Merge OpenRouter rows with effective rates (custom overrides)
      const openrouterCatalog = openrouter.map((m) => {
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

    if (!noUi && req.method === "GET" && (pathname === "/" || pathname === "/index.html" || pathname === "/dashboard")) {
      const html = await readFile(dashboardPath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (!noUi && req.method === "GET" && (pathname === "/agents" || pathname === "/agents.html")) {
      const html = await readFile(agentsPagePath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (!noUi && req.method === "GET" && (pathname === "/settings" || pathname === "/settings.html")) {
      const html = await readFile(settingsPagePath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
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
      const html = await readFile(pricingPagePath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && pathname === "/api/config") {
      const cfg = await loadConfig();
      return json(res, 200, {
        ...cfg,
        configPath: configPath(),
      });
    }

    if (req.method === "PUT" && pathname === "/api/config") {
      const body = await readJsonBody(req);
      const prev = await loadConfig();
      const bodyPricing =
        body.pricing && typeof body.pricing === "object"
          ? (body.pricing as Record<string, unknown>)
          : {};
      const bodyRates = bodyPricing.customRates;
      const next = await saveConfig({
        ...prev,
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
      return json(res, 200, { ok: true, ...next, configPath: configPath() });
    }

    if (!noUi && req.method === "GET" && pathname === "/styles.css") {
      try {
        const css = await readFile(stylesPath, "utf8");
        res.writeHead(200, {
          "Content-Type": "text/css; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(css);
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
        const data = await readFile(file);
        res.writeHead(200, {
          "Content-Type": contentTypeFor(path.basename(file)),
          "Cache-Control": "public, max-age=3600",
        });
        res.end(data);
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

  // Initial scan + periodic refresh in background
  void rescan().catch((err) => {
    console.error("[xlab-token] initial scan failed:", err instanceof Error ? err.message : err);
  });
  const timer = setInterval(() => {
    void rescan();
  }, 60_000);
  timer.unref?.();

  return {
    host,
    port,
    close: async () => {
      clearInterval(timer);
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
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
}
