import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { appDataDir, homeDir } from "../../util.js";
import { applyPricing } from "../../pricing.js";
import type { UsageEvent } from "../../types.js";
import { num, pathExists, readText, stableId } from "../../util.js";
import path from "node:path";

/**
 * QwenCoder Cloud dashboard usage (`https://qwencoder.cloud/dashboard`).
 *
 * Data sources under mirrors/qwencoder (prefer rich → sparse):
 *  1. API dumps: api_v1_dashboard_me_stats.json, …_models_me.json, …_chart.json
 *  2. dashboard-scrape.json (from live Brave page text when session JWT unavailable)
 *  3. usage-daily.json (normalized daily rollups)
 *
 * Pull: `python scripts/pull-qwencoder-usage.py`
 *   - Bearer token: QWENCODER_ACCESS_TOKEN or mirrors/qwencoder/access_token.txt
 *   - Fallback: scrape Brave window via cua-driver when logged in
 */
export function qwenCoderRoots(): string[] {
  const { home, path: p, expandHome } = pathEnv();
  const data =
    process.env.TOKENLAB_DATA_DIR || p.join(appDataDir(), "tokenlab");
  return unique([
    expandHome(process.env.TOKENLAB_QWENCODER_DIR || process.env.QWENCODER_HOME || ""),
    p.join(data, "mirrors", "qwencoder"),
    p.join(homeDir(), ".tokenlab", "mirrors", "qwencoder"),
    p.join(appDataDir(), "xlab-token", "mirrors", "qwencoder"),
  ]);
}

export async function parseQwenCoder(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    if (!(await pathExists(root))) continue;

    // 1) Normalized daily rollups
    const dailyPath = path.join(root, "usage-daily.json");
    if (await pathExists(dailyPath)) {
      for (const e of await parseUsageDaily(dailyPath)) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        events.push(e);
      }
    }

    // 2) Official API model analysis (richest per-model)
    for (const name of [
      "api_v1_dashboard_analysis_models_me.json",
      "dashboard_analysis_models_me.json",
      "models_me.json",
    ]) {
      const fp = path.join(root, name);
      if (!(await pathExists(fp))) continue;
      for (const e of await parseModelsApi(fp)) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        events.push(e);
      }
    }

    // 3) Stats summary (totals when models missing)
    for (const name of ["api_v1_dashboard_me_stats.json", "dashboard_me_stats.json", "stats.json"]) {
      const fp = path.join(root, name);
      if (!(await pathExists(fp))) continue;
      for (const e of await parseStatsApi(fp)) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        events.push(e);
      }
    }

    // 4) Chart series
    for (const name of ["api_v1_dashboard_me_chart.json", "dashboard_me_chart.json", "chart.json"]) {
      const fp = path.join(root, name);
      if (!(await pathExists(fp))) continue;
      for (const e of await parseChartApi(fp)) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        events.push(e);
      }
    }

    // 5) Brave dashboard scrape (when JWT cannot be exported)
    const scrape = path.join(root, "dashboard-scrape.json");
    if (await pathExists(scrape)) {
      for (const e of await parseDashboardScrape(scrape)) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        events.push(e);
      }
    }
  }

  return events;
}

async function parseUsageDaily(file: string): Promise<UsageEvent[]> {
  const text = await readText(file);
  if (!text) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const events: UsageEvent[] = [];
  const daily =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};

  for (const [day, raw] of Object.entries(daily)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const byModel =
      (row.byModel as Record<string, unknown> | undefined) ||
      (row.models as Record<string, unknown> | undefined) ||
      null;

    if (byModel && typeof byModel === "object") {
      for (const [model, mraw] of Object.entries(byModel)) {
        if (!mraw || typeof mraw !== "object") continue;
        const m = mraw as Record<string, unknown>;
        const inputTokens = num(m.inputTokens ?? m.input_tokens ?? m.prompt_tokens ?? m.input);
        const outputTokens = num(m.outputTokens ?? m.output_tokens ?? m.completion_tokens ?? m.output);
        const total = num(m.totalTokens ?? m.total_tokens ?? m.tokens);
        const inT = inputTokens || (outputTokens ? 0 : total);
        const outT = outputTokens;
        if (inT + outT <= 0 && total <= 0) continue;
        const reqs = num(m.requests ?? m.requestCount ?? m.count);
        events.push(
          applyPricing({
            id: stableId("qwencoder", file, day, model, String(inT || total), String(outT)),
            agent: "qwencoder",
            model,
            timestamp: `${day}T12:00:00.000Z`,
            inputTokens: inT || total,
            outputTokens: outT,
            cacheReadTokens: num(m.cacheReadTokens ?? m.cache_read_tokens),
            cacheWriteTokens: num(m.cacheWriteTokens ?? m.cache_write_tokens),
            workspace: null,
            sourcePath: file,
            estimated: true,
            ...(reqs > 0 ? { requestCount: Math.floor(reqs) } : {}),
            ...(num(m.cost ?? m.estimatedCost) > 0
              ? { routerCost: num(m.cost ?? m.estimatedCost) }
              : {}),
          }),
        );
      }
      continue;
    }

    const inputTokens = num(row.inputTokens ?? row.input_tokens);
    const outputTokens = num(row.outputTokens ?? row.output_tokens);
    const total = num(row.totalTokens ?? row.tokens ?? row.total_tokens);
    if (inputTokens + outputTokens + total <= 0) continue;
    events.push(
      applyPricing({
        id: stableId("qwencoder", file, day, "all", String(total || inputTokens)),
        agent: "qwencoder",
        model: "qwencoder",
        timestamp: `${day}T12:00:00.000Z`,
        inputTokens: inputTokens || total,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        workspace: null,
        sourcePath: file,
        estimated: true,
      }),
    );
  }
  return events;
}

async function parseModelsApi(file: string): Promise<UsageEvent[]> {
  const text = await readText(file);
  if (!text) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const root = unwrapData(data);
  const list = extractModelList(root);
  if (!list.length) return [];

  const ts = extractAsOf(root) || new Date().toISOString();
  const events: UsageEvent[] = [];
  for (const m of list) {
    const model = String(m.model ?? m.name ?? m.id ?? "unknown");
    const inputTokens = num(
      m.inputTokens ?? m.input_tokens ?? m.prompt_tokens ?? m.input ?? m.promptTokens,
    );
    const outputTokens = num(
      m.outputTokens ?? m.output_tokens ?? m.completion_tokens ?? m.output ?? m.completionTokens,
    );
    const total = num(m.totalTokens ?? m.total_tokens ?? m.tokens ?? m.token ?? m.usage);
    const inT = inputTokens || (outputTokens > 0 ? 0 : total);
    const outT = outputTokens;
    if (inT + outT + total <= 0) continue;
    const reqs = num(m.requests ?? m.requestCount ?? m.count ?? m.success_count);
    events.push(
      applyPricing({
        id: stableId("qwencoder", file, "models", model, String(inT || total), String(outT)),
        agent: "qwencoder",
        model,
        timestamp: ts,
        inputTokens: inT || total,
        outputTokens: outT,
        cacheReadTokens: num(m.cacheReadTokens ?? m.cache_read_tokens),
        cacheWriteTokens: num(m.cacheWriteTokens ?? m.cache_write_tokens),
        workspace: null,
        sourcePath: file,
        estimated: true,
        ...(reqs > 0 ? { requestCount: Math.floor(reqs) } : {}),
      }),
    );
  }
  return events;
}

async function parseStatsApi(file: string): Promise<UsageEvent[]> {
  const text = await readText(file);
  if (!text) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const root = unwrapData(data);
  if (!root) return [];

  // Prefer nested models if present
  const nested = extractModelList(root);
  if (nested.length) return parseModelsApi(file);

  const inputTokens = num(
    root.inputTokens ?? root.input_tokens ?? root.prompt_tokens ?? root.totalInputTokens,
  );
  const outputTokens = num(
    root.outputTokens ?? root.output_tokens ?? root.completion_tokens ?? root.totalOutputTokens,
  );
  const total = num(
    root.totalTokens ?? root.total_tokens ?? root.tokensUsed ?? root.tokens_used ?? root.tokens,
  );
  if (inputTokens + outputTokens + total <= 0) return [];

  const reqs = num(root.requests ?? root.requestCount ?? root.total_requests ?? root.success_requests);
  const ts = extractAsOf(root) || new Date().toISOString();
  return [
    applyPricing({
      id: stableId("qwencoder", file, "stats", String(total || inputTokens)),
      agent: "qwencoder",
      model: "qwencoder",
      timestamp: ts,
      inputTokens: inputTokens || total,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      workspace: null,
      sourcePath: file,
      estimated: true,
      ...(reqs > 0 ? { requestCount: Math.floor(reqs) } : {}),
    }),
  ];
}

async function parseChartApi(file: string): Promise<UsageEvent[]> {
  const text = await readText(file);
  if (!text) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const root = unwrapData(data);
  if (!root) return [];

  const events: UsageEvent[] = [];
  // Common shapes: { series: [{date, input, output, model?}] } or { points: [...] }
  const series =
    (Array.isArray(root.series) && root.series) ||
    (Array.isArray(root.points) && root.points) ||
    (Array.isArray(root.data) && root.data) ||
    (Array.isArray(root) ? root : null);

  if (!Array.isArray(series)) return events;

  for (const pt of series) {
    if (!pt || typeof pt !== "object") continue;
    const p = pt as Record<string, unknown>;
    const day = String(p.date ?? p.day ?? p.label ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const model = String(p.model ?? p.name ?? "qwencoder");
    const inputTokens = num(p.input ?? p.inputTokens ?? p.input_tokens ?? p.prompt_tokens);
    const outputTokens = num(p.output ?? p.outputTokens ?? p.output_tokens ?? p.completion_tokens);
    const total = num(p.tokens ?? p.totalTokens ?? p.total);
    if (inputTokens + outputTokens + total <= 0) continue;
    const reqs = num(p.requests ?? p.requestCount);
    events.push(
      applyPricing({
        id: stableId("qwencoder", file, "chart", day, model, String(inputTokens || total)),
        agent: "qwencoder",
        model,
        timestamp: `${day}T12:00:00.000Z`,
        inputTokens: inputTokens || total,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        workspace: null,
        sourcePath: file,
        estimated: true,
        ...(reqs > 0 ? { requestCount: Math.floor(reqs) } : {}),
      }),
    );
  }
  return events;
}

/**
 * Parse Brave dashboard scrape written by pull-qwencoder-usage.py.
 * Shape: { scrapedAt, periodDays, totals, models: [{model, requests, tokens, pct}] }
 */
async function parseDashboardScrape(file: string): Promise<UsageEvent[]> {
  const text = await readText(file);
  if (!text) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  const scrapedAt =
    typeof d.scrapedAt === "string" && d.scrapedAt
      ? d.scrapedAt
      : new Date().toISOString();
  const models = Array.isArray(d.models) ? d.models : [];
  const events: UsageEvent[] = [];

  // Prefer per-model rows
  for (const raw of models) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const model = String(m.model ?? m.name ?? "").trim();
    if (!model) continue;
    const tokens = num(m.tokens ?? m.totalTokens ?? m.total_tokens);
    const inputTokens = num(m.inputTokens ?? m.input_tokens);
    const outputTokens = num(m.outputTokens ?? m.output_tokens);
    const inT = inputTokens || (outputTokens ? 0 : tokens);
    const outT = outputTokens;
    if (inT + outT + tokens <= 0) continue;
    const reqs = num(m.requests ?? m.requestCount);
    events.push(
      applyPricing({
        id: stableId("qwencoder", file, "scrape", model, String(inT || tokens), scrapedAt.slice(0, 10)),
        agent: "qwencoder",
        model,
        timestamp: scrapedAt,
        inputTokens: inT || tokens,
        outputTokens: outT,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        workspace: null,
        sourcePath: file,
        estimated: true,
        ...(reqs > 0 ? { requestCount: Math.floor(reqs) } : {}),
      }),
    );
  }

  // If models empty but totals present
  if (events.length === 0 && d.totals && typeof d.totals === "object") {
    const t = d.totals as Record<string, unknown>;
    const tokens = num(t.tokensUsed ?? t.totalTokens ?? t.tokens);
    const reqs = num(t.requests ?? t.successRequests);
    if (tokens > 0) {
      events.push(
        applyPricing({
          id: stableId("qwencoder", file, "scrape-total", String(tokens), scrapedAt.slice(0, 10)),
          agent: "qwencoder",
          model: "qwencoder",
          timestamp: scrapedAt,
          inputTokens: tokens,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          workspace: null,
          sourcePath: file,
          estimated: true,
          ...(reqs > 0 ? { requestCount: Math.floor(reqs) } : {}),
        }),
      );
    }
  }

  return events;
}

function unwrapData(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (o.data && typeof o.data === "object" && !Array.isArray(o.data)) {
    return o.data as Record<string, unknown>;
  }
  return o;
}

function extractModelList(root: Record<string, unknown> | null): Array<Record<string, unknown>> {
  if (!root) return [];
  for (const key of ["models", "items", "list", "byModel", "breakdown", "data"]) {
    const v = root[key];
    if (Array.isArray(v)) {
      return v.filter((x) => x && typeof x === "object") as Array<Record<string, unknown>>;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.entries(v as Record<string, unknown>).map(([model, rest]) => {
        if (rest && typeof rest === "object") {
          return { model, ...(rest as Record<string, unknown>) };
        }
        return { model, tokens: rest };
      });
    }
  }
  return [];
}

function extractAsOf(root: Record<string, unknown>): string | null {
  for (const k of ["asOf", "as_of", "updatedAt", "updated_at", "timestamp", "time"]) {
    const v = root[k];
    if (typeof v === "string" && v.trim()) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    if (typeof v === "number" && Number.isFinite(v) && v > 1e9) {
      const ms = v > 1e12 ? v : v * 1000;
      return new Date(ms).toISOString();
    }
  }
  return null;
}

export const agent: AgentModule = {
  id: "qwencoder",
  label: "QwenCoder Cloud",
  roots: qwenCoderRoots,
  parse: parseQwenCoder,
};
