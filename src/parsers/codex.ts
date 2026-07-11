import path from "node:path";
import { applyPricing } from "../pricing.js";
import type { UsageEvent } from "../types.js";
import { parseJsonl, pathExists, readText, stableId, walkFiles } from "../util.js";
import { extractModel, extractTimestamp, extractTokenBuckets } from "./usage-fields.js";

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

    const scanRoots = [
      path.join(root, "sessions"),
      path.join(root, "archived_sessions"),
      path.join(root, "session_index"),
      path.join(root, "history"),
      path.join(root, "logs"),
      root,
    ];

    for (const base of scanRoots) {
      if (!(await pathExists(base))) continue;
      const files = await walkFiles(base, {
        maxDepth: 12,
        match: (n) =>
          n.endsWith(".jsonl") ||
          n.startsWith("rollout-") ||
          (n.includes("session") && (n.endsWith(".json") || n.endsWith(".jsonl"))),
      });

      for (const file of files) {
        if (seen.has(file)) continue;
        seen.add(file);
        const text = await readText(file);
        if (!text) continue;

        if (file.endsWith(".json") && !file.endsWith(".jsonl")) {
          try {
            const data = JSON.parse(text) as unknown;
            collectFromJson(events, data, file);
          } catch {
            // ignore
          }
          continue;
        }

        parseJsonlFile(events, text, file);
      }
    }
  }

  return events;
}

function parseJsonlFile(events: UsageEvent[], text: string, file: string): void {
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

    const ts = extractTimestamp(r, r.payload, usageObj);
    const rowModel = extractModel(r, r.payload, usageObj, model);

    events.push(
      applyPricing({
        id: stableId("codex", file, String(idx), String(inputTokens), String(outputTokens), ts),
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

function collectFromJson(events: UsageEvent[], data: unknown, file: string): void {
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
          timestamp: extractTimestamp(r),
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
    if (Array.isArray(o.events)) collectFromJson(events, o.events, file);
    if (Array.isArray(o.sessions)) collectFromJson(events, o.sessions, file);
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
