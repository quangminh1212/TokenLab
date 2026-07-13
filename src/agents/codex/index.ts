import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";

import { stat } from "node:fs/promises";
import path from "node:path";
import { applyPricing } from "../../pricing.js";
import type { UsageEvent } from "../../types.js";
import { parseJsonl, pathExists, readText, stableId, walkFiles } from "../../util.js";
import { extractModel, extractTimestamp, extractTokenBuckets } from "../shared/usage-fields.js";

/** Skip Codex plugin fixtures / temp trees (fake usage with no real timestamps). */
function isNoisePath(full: string): boolean {
  const n = full.replace(/\\/g, "/").toLowerCase();
  const bad = [
    "/.tmp/",
    "/tmp/",
    "/fixtures/",
    "/fixture/",
    "/plugin-eval/",
    "/observed-usage/",
    "/__tests__/",
    "/testdata/",
    "/mocks/",
    "/vendor_imports/",
    "/node_modules/",
  ];
  return bad.some((b) => n.includes(b));
}

// Deep Codex support:
// - ~/.codex/sessions (rollout-*.jsonl date tree)
// - archived / history / session logs
// - token_count events (absolute + cumulative)
// - response.completed / event.usage shapes
// - cwd/workspace from session meta when present
export async function parseCodex(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    if (!(await pathExists(root))) continue;

    // Prefer real session trees; only fall back to root when those are absent
    const preferred = [
      path.join(root, "sessions"),
      path.join(root, "archived_sessions"),
      path.join(root, "session_index"),
      path.join(root, "history"),
      path.join(root, "logs"),
    ];
    const existingPreferred: string[] = [];
    for (const p of preferred) {
      if (await pathExists(p)) existingPreferred.push(p);
    }
    const scanRoots = existingPreferred.length > 0 ? existingPreferred : [root];

    for (const base of scanRoots) {
      if (!(await pathExists(base))) continue;
      if (isNoisePath(base)) continue;
      const files = await walkFiles(base, {
        maxDepth: 12,
        match: (n, full) => {
          if (isNoisePath(full)) return false;
          return (
            n.endsWith(".jsonl") ||
            n.startsWith("rollout-") ||
            (n.includes("session") && (n.endsWith(".json") || n.endsWith(".jsonl")))
          );
        },
      });

      for (const file of files) {
        if (seen.has(file)) continue;
        if (isNoisePath(file)) continue;
        seen.add(file);
        const text = await readText(file);
        if (!text) continue;

        let fileMtime = new Date(0);
        try {
          const st = await stat(file);
          fileMtime = st.mtime;
        } catch {
          // ignore
        }

        if (file.endsWith(".json") && !file.endsWith(".jsonl")) {
          try {
            const data = JSON.parse(text) as unknown;
            collectFromJson(events, data, file, fileMtime);
          } catch {
            // ignore
          }
          continue;
        }

        parseJsonlFile(events, text, file, fileMtime);
      }
    }
  }

  return events;
}

function parseJsonlFile(
  events: UsageEvent[],
  text: string,
  file: string,
  fileMtime: Date,
): void {
  const rows = parseJsonl(text);
  let idx = 0;
  let lastIn = 0;
  let lastOut = 0;
  let lastCr = 0;
  let lastCw = 0;
  let model: string | null = null;
  let workspace: string | null = null;
  let cumulativeMode: boolean | null = null;

  for (const row of rows) {
    idx += 1;
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const type = String(r.type ?? r.event_type ?? r.kind ?? "");

    // session metadata
    model = extractModel(r, r.payload, r.message, model) || model;
    workspace =
      pickString(r, ["cwd", "workdir", "workspace", "project"]) ||
      pickString(r.payload, ["cwd", "workdir", "workspace"]) ||
      workspace;

    if (type === "model_change" || type === "session_meta") {
      model = extractModel(r, r.payload, model) || model;
      continue;
    }

    const usageObj = findUsageObject(r, type);
    if (!usageObj) continue;

    const buckets = extractTokenBuckets(usageObj);
    if (!buckets) continue;

    let { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = buckets;

    // Detect cumulative counters (common in Codex token_count streams)
    const looksCumulative =
      cumulativeMode === true ||
      (inputTokens >= lastIn &&
        outputTokens >= lastOut &&
        (inputTokens > lastIn || outputTokens > lastOut) &&
        (lastIn > 0 || lastOut > 0 || type.includes("token")));

    if (looksCumulative && (inputTokens >= lastIn || outputTokens >= lastOut)) {
      cumulativeMode = true;
      const dIn = Math.max(0, inputTokens - lastIn);
      const dOut = Math.max(0, outputTokens - lastOut);
      const dCr = Math.max(0, cacheReadTokens - lastCr);
      const dCw = Math.max(0, cacheWriteTokens - lastCw);
      lastIn = inputTokens;
      lastOut = outputTokens;
      lastCr = cacheReadTokens;
      lastCw = cacheWriteTokens;
      inputTokens = dIn;
      outputTokens = dOut;
      cacheReadTokens = dCr;
      cacheWriteTokens = dCw;
    } else if (cumulativeMode !== true) {
      // per-call absolute values
      lastIn = 0;
      lastOut = 0;
      lastCr = 0;
      lastCw = 0;
    }

    if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0) continue;

    // Prefer event time; never use "now" for fixtures-without-ts (causes perpetual "Just now")
    const ts = extractTimestamp(r, r.payload, usageObj, fileMtime);
    const rowModel = extractModel(r, r.payload, usageObj, model);

    events.push(
      applyPricing({
        // Stable id without wall-clock "now" so rescans do not multiply rows
        id: stableId("codex", file, String(idx), String(inputTokens), String(outputTokens)),
        agent: "codex",
        model: rowModel,
        timestamp: ts,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        workspace,
        sourcePath: file,
      }),
    );
  }
}

function findUsageObject(r: Record<string, unknown>, type: string): unknown {
  const payload = (r.payload && typeof r.payload === "object" ? r.payload : null) as Record<
    string,
    unknown
  > | null;
  const info = payload && payload.info && typeof payload.info === "object" ? (payload.info as Record<string, unknown>) : null;
  const response =
    payload && payload.response && typeof payload.response === "object"
      ? (payload.response as Record<string, unknown>)
      : r.response && typeof r.response === "object"
        ? (r.response as Record<string, unknown>)
        : null;

  const candidates = [
    r.usage,
    r.token_count,
    r.tokenCount,
    payload?.usage,
    payload?.token_count,
    payload?.tokenCount,
    info?.usage,
    info?.token_count,
    response?.usage,
    // whole payload if event type hints tokens
    type.includes("token") || type.includes("usage") ? payload : null,
    type.includes("token") || type.includes("usage") ? r : null,
  ];

  for (const c of candidates) {
    if (c && typeof c === "object" && extractTokenBuckets(c)) return c;
  }
  return null;
}

function collectFromJson(
  events: UsageEvent[],
  data: unknown,
  file: string,
  fileMtime: Date,
): void {
  if (Array.isArray(data)) {
    data.forEach((row, i) => {
      if (!row || typeof row !== "object") return;
      const r = row as Record<string, unknown>;
      const buckets = extractTokenBuckets(r.usage ?? r.token_count ?? r);
      if (!buckets) return;
      events.push(
        applyPricing({
          id: stableId("codex", file, "json", String(i), String(buckets.inputTokens)),
          agent: "codex",
          model: extractModel(r),
          timestamp: extractTimestamp(r, fileMtime),
          ...buckets,
          workspace: pickString(r, ["cwd", "workspace"]),
          sourcePath: file,
        }),
      );
    });
    return;
  }
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.events)) collectFromJson(events, o.events, file, fileMtime);
    if (Array.isArray(o.sessions)) collectFromJson(events, o.sessions, file, fileMtime);
  }
}

function pickString(obj: unknown, keys: string[]): string | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    if (typeof o[k] === "string" && (o[k] as string).trim()) return (o[k] as string).trim();
  }
  return null;
}


export const agent: AgentModule = {
  id: "codex",
  label: "OpenAI Codex",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      expandHome(process.env.CODEX_HOME || path.join(home, ".codex")),
      path.join(home, ".codex"),
      path.join(xdgConfig, "codex"),
      path.join(appData, "Codex"),
      path.join(localApp, "Codex"),
    ]);
  },
  parse: parseCodex,
};
