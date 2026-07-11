import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, costReport } from "../aggregate.js";
import { detectAgents, scanAll } from "../parsers/index.js";
import type { GroupBy, UsageEvent } from "../types.js";
import { filterByPeriod } from "../util.js";
import { VERSION } from "../version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  host?: string;
  port?: number;
  noUi?: boolean;
}

export async function startServer(opts: ServerOptions = {}): Promise<{ close: () => Promise<void>; port: number; host: string }> {
  const host = opts.host || process.env.XLAB_TOKEN_HOST || "127.0.0.1";
  const port = Number(opts.port || process.env.XLAB_TOKEN_PORT || 3737);
  const noUi = opts.noUi || process.env.XLAB_TOKEN_NO_UI === "1";
  const startedAt = Date.now();

  let cache: UsageEvent[] = [];
  let scanning = false;

  async function rescan(): Promise<number> {
    if (scanning) return cache.length;
    scanning = true;
    try {
      cache = await scanAll();
      return cache.length;
    } finally {
      scanning = false;
    }
  }

  await rescan();

  const dashboardPath = path.join(__dirname, "dashboard.html");

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
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        agentsDetected: agents.filter((a) => a.detected).map((a) => a.id),
        eventCount: cache.length,
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
      let list = cache;
      if (agent) list = list.filter((e) => e.agent === agent);
      return json(res, 200, { events: list.slice(-limit).reverse(), count: list.length });
    }

    if (req.method === "GET" && pathname === "/api/agents") {
      return json(res, 200, { agents: await detectAgents(cache) });
    }

    if (req.method === "POST" && pathname === "/api/scan") {
      const t0 = Date.now();
      const n = await rescan();
      return json(res, 200, { ok: true, eventsIngested: n, durationMs: Date.now() - t0 });
    }

    if (!noUi && req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = await readFile(dashboardPath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    json(res, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
  }

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.on("error", reject);
  });

  // background refresh every 60s
  const timer = setInterval(() => {
    void rescan();
  }, 60_000);
  timer.unref?.();

  return {
    host,
    port,
    close: async () => {
      clearInterval(timer);
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
}
