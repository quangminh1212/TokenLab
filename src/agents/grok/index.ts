import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { applyPricing } from "../../pricing.js";
import type { UsageEvent } from "../../types.js";
import {
  estimateTokensFromChars,
  estimateTokensFromText,
  num,
  parseJsonl,
  pathExists,
  readText,
  stableId,
  walkFiles,
} from "../../util.js";

/**
 * Grok Build CLI: ~/.grok/sessions/<cwd>/<id>/
 *
 * Policy: prefer over-count over missing usage.
 * - Discover sessions via usage.json, summary.json, updates.jsonl, or chat_history.jsonl
 * - Prefer turn_completed.usage (input includes cache; split cache for pricing)
 * - Prefer usage.json's aggregate snapshot over replaying completed turns
 * - Stream totalTokens floor for in-progress turns
 * - Chat text estimate only when no real counters (include synthetics — they are billed)
 */
export async function parseGrok(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const onDiskSessionIds = new Set<string>();

  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    const sessionsRoot = path.join(root, "sessions");
    if (await pathExists(sessionsRoot)) {
      // Discover every session dir that has any artifact (never require summary.json).
      const markers = await walkFiles(sessionsRoot, {
        maxDepth: 14,
        match: (n) =>
          n === "usage.json" ||
          n === "summary.json" ||
          n === "updates.jsonl" ||
          n === "chat_history.jsonl",
      });
      const sessionDirs = unique(markers.map((m) => path.dirname(m)));
      for (const dir of sessionDirs) {
        const id = sessionIdFromDir(dir);
        if (id) onDiskSessionIds.add(id);
      }

      // Parse several sessions at once — sequential I/O was the main Grok scan cost.
      const SESSION_CONC = 4;
      for (let i = 0; i < sessionDirs.length; i += SESSION_CONC) {
        const chunk = sessionDirs.slice(i, i + SESSION_CONC);
        const batches = await Promise.all(chunk.map((dir) => parseGrokSession(dir)));
        for (const batch of batches) {
          for (const e of batch) events.push(e);
        }
      }
    }

    // Grok keeps compact usage for older/pruned sessions here after their
    // session directories are removed. Do not add entries that still have a
    // parseable session directory; those are handled above.
    if (path.basename(root).toLowerCase() === ".grok") {
      events.push(
        ...(await parseGrokSessionMeta(path.join(root, "client-state", "session-meta.json"), onDiskSessionIds)),
      );
    }
  }

  return events;
}

async function parseGrokSession(dir: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const summaryPath = path.join(dir, "summary.json");
  let summary: Record<string, unknown> = {};
  // readText already returns null when missing — skip extra pathExists
  const summaryText = await readText(summaryPath);
  if (summaryText) {
    try {
      summary = JSON.parse(summaryText) as Record<string, unknown>;
    } catch {
      summary = {};
    }
  }

  const info = (summary.info ?? {}) as Record<string, unknown>;
  const model =
    (typeof summary.current_model_id === "string" && summary.current_model_id) ||
    (typeof summary.model === "string" && summary.model) ||
    "grok-4.5";
  const workspace =
    (typeof info.cwd === "string" && info.cwd) ||
    (typeof summary.git_root_dir === "string" && summary.git_root_dir) ||
    decodeWorkspaceFromSessionPath(dir) ||
    null;
  let ts =
    (typeof summary.updated_at === "string" && summary.updated_at) ||
    (typeof summary.last_active_at === "string" && summary.last_active_at) ||
    (typeof summary.created_at === "string" && summary.created_at) ||
    "";
  if (!ts) {
    ts =
      (await mtimeIso(path.join(dir, "updates.jsonl"))) ||
      (await mtimeIso(path.join(dir, "chat_history.jsonl"))) ||
      (await mtimeIso(summaryPath)) ||
      new Date().toISOString();
  }
  const sessionId =
    (typeof info.id === "string" && info.id) || path.basename(dir);

  // 1) Grok's persisted session snapshot is authoritative for completed usage.
  // The live updates stream can contain the same completed turn plus a newer
  // in-progress turn, so only retain estimated residuals from that stream.
  const usagePath = path.join(dir, "usage.json");
  const usageSnapshot = await readGrokUsageSnapshot(usagePath, {
    sessionId,
    model,
    workspace,
    fallbackTs: ts,
  });

  // 2) Real usage/residuals from updates.jsonl
  let hadRealUsage = false;
  const updatesPath = path.join(dir, "updates.jsonl");
  let fromUpdates: UsageEvent[] = [];
  // parseUpdatesUsage no-ops on missing file via stream error → empty; check first
  if (await pathExists(updatesPath)) {
    fromUpdates = await parseUpdatesUsage(updatesPath, {
      sessionId,
      model,
      workspace,
      fallbackTs: ts,
    });
  }

  // 2a) Legacy turns[] usage.json export — per-turn events are the
  // authoritative source when present (never emit session rollup too).
  const persisted = await parsePersistedUsage(usagePath, {
    sessionId,
    model,
    workspace,
    fallbackTs: ts,
  });
  const realUpdates = fromUpdates.filter((e) => !e.estimated);
  if (
    persisted.events.length > 0 &&
    (realUpdates.length === 0 || persistedUsageIsRicher(persisted, realUpdates))
  ) {
    events.push(...persisted.events);
    // Keep only usage written after the persisted rollup (active turn only).
    if (persisted.updatedAt) {
      events.push(
        ...fromUpdates.filter((e) => isAfterTimestamp(e.timestamp, persisted.updatedAt!)),
      );
    }
  } else if (fromUpdates.length > 0) {
    const latestRealTs = latestEventTimestamp(fromUpdates.filter((e) => !e.estimated));
    const snapshotTs = usageSnapshot ? Date.parse(usageSnapshot.timestamp) : NaN;
    // If usage.json is older than a completed update, the update file is the
    // safer complete source for this session. Otherwise the snapshot already
    // includes those completed rows and only residuals must be added.
    if (!usageSnapshot || (latestRealTs != null && (!Number.isFinite(snapshotTs) || latestRealTs > snapshotTs + 1000))) {
      events.push(...fromUpdates);
    } else {
      events.push(...fromUpdates.filter((e) => e.estimated));
    }
  }
  hadRealUsage = events.some((e) => !e.estimated);

  if (usageSnapshot && !hadRealUsage) {
    events.unshift(usageSnapshot);
    hadRealUsage = true;
  }

  // 3) Explicit usage on summary
  const usage = (summary.usage ?? summary.token_usage) as Record<string, unknown> | undefined;
  if (!hadRealUsage && usage) {
    const buckets = bucketsFromUsage(usage);
    if (buckets) {
      const { routerCost, ...tokenBuckets } = buckets;
      events.push(
        applyPricing({
          id: stableId("grok", sessionId, "usage"),
          agent: "grok",
          model,
          timestamp: ts,
          ...tokenBuckets,
          ...(routerCost != null ? { routerCost } : {}),
          workspace,
          sourcePath: summaryPath,
        }),
      );
      hadRealUsage = true;
    }
  }

  // 4) Chat text estimate only when no real counters
  if (hadRealUsage) return events;

  const chatPath = path.join(dir, "chat_history.jsonl");
  const chatText = await readText(chatPath);
  if (!chatText) return events;

  // Cumulative context chars → each assistant turn prices full history (over-count friendly)
  let contextChars = 0;
  let turn = 0;
  let emitted = 0;
  for (const row of parseJsonl(chatText)) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const type = String(r.type ?? r.role ?? "");
    // Count ALL text including synthetic injects / system / tool results when stored as text
    const content = extractText(r.content);
    if (!content) continue;
    if (
      type === "user" ||
      type === "human" ||
      type === "system" ||
      type === "tool_result" ||
      type === "tool"
    ) {
      contextChars += content.length;
      continue;
    }
    if (type === "assistant" || type === "ai" || type === "model" || type === "reasoning") {
      turn += 1;
      const inputTokens = estimateTokensFromChars(contextChars);
      const outputTokens = estimateTokensFromText(content);
      contextChars += content.length; // stays in context for later turns
      if (inputTokens + outputTokens <= 0) continue;
      const rowTs =
        (typeof r.timestamp === "string" && r.timestamp) ||
        (typeof r.created_at === "string" && r.created_at) ||
        (typeof r.ts === "string" && r.ts) ||
        ts;
      events.push(
        applyPricing({
          id: stableId("grok", sessionId, "turn", String(turn), String(inputTokens), String(outputTokens)),
          agent: "grok",
          model,
          timestamp: rowTs,
          inputTokens,
          outputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          workspace,
          sourcePath: chatPath,
          estimated: true,
        }),
      );
      emitted += 1;
    }
  }

  if (emitted === 0) {
    let userChars = 0;
    let assistantChars = 0;
    for (const row of parseJsonl(chatText)) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const type = String(r.type ?? r.role ?? "");
      const content = extractText(r.content);
      if (!content) continue;
      if (type === "user" || type === "human" || type === "system") userChars += content.length;
      if (type === "assistant" || type === "ai" || type === "model" || type === "reasoning") {
        assistantChars += content.length;
      }
    }
    if (userChars + assistantChars === 0) return events;
    const inputTokens = estimateTokensFromChars(userChars);
    const outputTokens = estimateTokensFromChars(assistantChars);
    events.push(
      applyPricing({
        id: stableId("grok", sessionId, "est", String(inputTokens), String(outputTokens)),
        agent: "grok",
        model,
        timestamp: ts,
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        workspace,
        sourcePath: chatPath,
        estimated: true,
      }),
    );
  }
  return events;
}

type GrokUsageSnapshotContext = {
  sessionId: string;
  model: string;
  workspace: string | null;
  fallbackTs: string;
};

async function readGrokUsageSnapshot(
  usagePath: string,
  ctx: GrokUsageSnapshotContext,
): Promise<UsageEvent | null> {
  const text = await readText(usagePath);
  if (!text) return null;
  try {
    const root = JSON.parse(text) as Record<string, unknown>;
    const session = (root.session ?? root.usage ?? root) as Record<string, unknown>;
    if (!session || typeof session !== "object") return null;
    const buckets = bucketsFromUsage(session);
    if (!buckets) return null;

    const turns = Array.isArray(root.turns) ? root.turns : [];
    const lastTurn = [...turns]
      .reverse()
      .find((turn) => turn && typeof turn === "object") as Record<string, unknown> | undefined;
    const timestamp =
      (typeof root.updatedAt === "string" && root.updatedAt) ||
      (typeof lastTurn?.endedAt === "string" && lastTurn.endedAt) ||
      ctx.fallbackTs;
    const model =
      (typeof session.primaryModelId === "string" && session.primaryModelId) ||
      modelFromUsage(session, ctx.model);
    const { routerCost, requestCount, ...tokenBuckets } = buckets;
    return applyPricing({
      id: stableId("grok", ctx.sessionId, "usage"),
      agent: "grok",
      model,
      timestamp,
      ...tokenBuckets,
      ...(routerCost != null ? { routerCost } : {}),
      ...(requestCount != null ? { requestCount } : {}),
      workspace: ctx.workspace,
      sourcePath: usagePath,
      estimated: false,
    });
  } catch {
    return null;
  }
}

async function parseGrokSessionMeta(
  metaPath: string,
  onDiskSessionIds: Set<string>,
): Promise<UsageEvent[]> {
  const text = await readText(metaPath);
  if (!text) return [];
  try {
    const root = JSON.parse(text) as Record<string, unknown>;
    const events: UsageEvent[] = [];
    for (const [sessionId, value] of Object.entries(root)) {
      if (onDiskSessionIds.has(sessionId)) continue;
      const entry = value as Record<string, unknown> | null;
      const usage = entry?.usage as Record<string, unknown> | undefined;
      if (!usage || typeof usage !== "object") continue;
      const buckets = bucketsFromUsage(usage);
      if (!buckets) continue;
      const { routerCost, requestCount, ...tokenBuckets } = buckets;
      const model = modelFromUsage(usage, "grok-4.5");
      const timestamp = timestampFromSessionId(sessionId) || (await mtimeIso(metaPath));
      if (!timestamp) continue;
      events.push(
        applyPricing({
          id: stableId("grok", sessionId, "usage"),
          agent: "grok",
          model,
          timestamp,
          ...tokenBuckets,
          ...(routerCost != null ? { routerCost } : {}),
          ...(requestCount != null ? { requestCount } : {}),
          workspace: null,
          // Tag the session id so a later snapshot can replace old per-turn
          // rows for the same pruned session during cache merge.
          sourcePath: `${metaPath}#${sessionId}`,
          estimated: false,
        }),
      );
    }
    return events;
  } catch {
    return [];
  }
}

function sessionIdFromDir(dir: string): string | null {
  const base = path.basename(dir);
  return base && base !== "sessions" ? base : null;
}

function timestampFromSessionId(sessionId: string): string | null {
  const compact = sessionId.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(compact)) return null;
  const ms = Number.parseInt(compact.slice(0, 12), 16);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function latestEventTimestamp(events: UsageEvent[]): number | null {
  let latest: number | null = null;
  for (const event of events) {
    const ms = Date.parse(event.timestamp);
    if (!Number.isFinite(ms)) continue;
    if (latest == null || ms > latest) latest = ms;
  }
  return latest;
}

/** Best-effort workspace from encoded session folder path. */
function decodeWorkspaceFromSessionPath(dir: string): string | null {
  // .../sessions/C%3A%5CDev%5CXLab_Token/<id>
  const parent = path.basename(path.dirname(dir));
  if (!parent || parent === "sessions") return null;
  try {
    const decoded = decodeURIComponent(parent);
    if (decoded.includes(":") || decoded.startsWith("/") || decoded.startsWith("\\")) return decoded;
  } catch {
    /* ignore */
  }
  return null;
}

async function mtimeIso(file: string): Promise<string | null> {
  try {
    if (!(await pathExists(file))) return null;
    const st = await stat(file);
    return st.mtime.toISOString();
  } catch {
    return null;
  }
}

/** Peak stream totals + cache reads + output-ish chars per prompt_id. */
type PromptPeak = { total: number; cached: number; outChars: number };

function notePromptPeak(line: string, promptPeak: Map<string, PromptPeak>): void {
  const pm = line.match(/"promptId"\s*:\s*"([^"]+)"/) ?? line.match(/"prompt_id"\s*:\s*"([^"]+)"/);
  const promptId = pm?.[1];
  if (!promptId) return;

  const prev = promptPeak.get(promptId) ?? { total: 0, cached: 0, outChars: 0 };
  let changed = false;

  if (
    line.includes("totalTokens") ||
    line.includes("cachedReadTokens") ||
    line.includes("cached_input_tokens") ||
    line.includes("cachedInputTokens") ||
    line.includes("cache_read_input_tokens") ||
    line.includes("cacheReadInputTokens") ||
    line.includes("cached_tokens") ||
    line.includes("cache_read_tokens")
  ) {
    const tm = line.match(/"totalTokens"\s*:\s*(\d+)/);
    if (tm) {
      const tt = Number(tm[1]);
      if (Number.isFinite(tt) && tt > prev.total) {
        prev.total = tt;
        changed = true;
      }
    }
    // Stream meta sometimes reports cache hits before turn_completed.usage
    const cm = line.match(
      /"(?:cachedReadTokens|cached_input_tokens|cachedInputTokens|cache_read_input_tokens|cacheReadInputTokens|cached_tokens|cache_read_tokens)"\s*:\s*(\d+)/,
    );
    if (cm) {
      const cr = Number(cm[1]);
      if (Number.isFinite(cr) && cr > prev.cached) {
        prev.cached = cr;
        changed = true;
      }
    }
  }

  // In-progress turns: estimate output from streamed model text (no usage yet).
  // Count agent thought/message + tool_call args (model-generated). Never tool results.
  const isThoughtOrMsg =
    line.includes("agent_thought_chunk") ||
    line.includes("agent_message_chunk") ||
    line.includes("AgentThoughtChunk") ||
    line.includes("AgentMessageChunk");
  // Exact tool_call only — not tool_call_update (tool results = input context)
  const isToolCall = /"sessionUpdate"\s*:\s*"tool_call"(?![_a-zA-Z])/.test(line);
  if (isThoughtOrMsg || isToolCall) {
    let add = 0;
    if (isThoughtOrMsg) {
      for (const m of line.matchAll(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
        add += (m[1] ?? "").length;
      }
    }
    if (isToolCall) {
      try {
        const row = JSON.parse(line) as {
          params?: { update?: { rawInput?: unknown; title?: unknown } };
        };
        const u = row.params?.update;
        if (u?.rawInput != null) {
          add +=
            typeof u.rawInput === "string"
              ? u.rawInput.length
              : JSON.stringify(u.rawInput).length;
        } else if (typeof u?.title === "string") {
          add += u.title.length;
        }
      } catch {
        /* ignore bad line */
      }
    }
    if (add > 0) {
      prev.outChars += add;
      changed = true;
    }
  }

  if (changed) promptPeak.set(promptId, prev);
}

/** Stable per-prompt id so residual → turn_completed.usage replaces in place (no ghost rows). */
function turnEventId(sessionId: string, promptId: string): string {
  return stableId("grok", sessionId, "tc", promptId);
}

function peakToOutputTokens(peak: PromptPeak): number {
  if (peak.outChars <= 0) return 0;
  // Same char heuristic as chat estimate — prefer slight over-count vs 0.
  return estimateTokensFromChars(peak.outChars);
}

/** Stream updates.jsonl and emit one event per turn_completed with usage. */
async function parseUpdatesUsage(
  updatesPath: string,
  ctx: {
    sessionId: string;
    model: string;
    workspace: string | null;
    fallbackTs: string;
  },
): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  let idx = 0;
  let maxStreamTokens = 0;
  let maxStreamCached = 0;
  let maxStreamTs = ctx.fallbackTs;
  const promptPeak = new Map<string, PromptPeak>();
  /** Prompts already billed with real turn_completed.usage — never residual again. */
  const completedWithUsage = new Set<string>();
  /** Prompts already emitted (usage or usage-less tc) — residual must not re-emit same id. */
  const emittedPromptIds = new Set<string>();

  const stream = createReadStream(updatesPath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      notePromptPeak(line, promptPeak);
      // Stream meta after turn_completed can re-add peaks for completed prompts
      // (same promptId on later tool/meta lines). Never residual those again.
      for (const id of completedWithUsage) promptPeak.delete(id);
      for (const id of emittedPromptIds) promptPeak.delete(id);

      // Session-level stream floor (in-progress turns)
      if (!line.includes('"sessionUpdate":"turn_completed"') && !line.includes('"sessionUpdate": "turn_completed"')) {
        if (line.includes("totalTokens")) {
          const m = line.match(/"totalTokens"\s*:\s*(\d+)/);
          if (m) {
            const tt = Number(m[1]);
            if (Number.isFinite(tt) && tt > maxStreamTokens) maxStreamTokens = tt;
          }
        }
        if (
          line.includes("cachedReadTokens") ||
          line.includes("cached_input_tokens") ||
          line.includes("cachedInputTokens") ||
          line.includes("cache_read_input_tokens") ||
          line.includes("cacheReadInputTokens") ||
          line.includes("cached_tokens") ||
          line.includes("cache_read_tokens")
        ) {
          const cm = line.match(
            /"(?:cachedReadTokens|cached_input_tokens|cachedInputTokens|cache_read_input_tokens|cacheReadInputTokens|cached_tokens|cache_read_tokens)"\s*:\s*(\d+)/,
          );
          if (cm) {
            const cr = Number(cm[1]);
            if (Number.isFinite(cr) && cr > maxStreamCached) maxStreamCached = cr;
          }
        }
        continue;
      }

      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const params = row.params as Record<string, unknown> | undefined;
      const update = params?.update as Record<string, unknown> | undefined;
      if (!update) continue;

      if (update.sessionUpdate !== "turn_completed") continue;

      idx += 1;

      const promptId =
        (typeof update.prompt_id === "string" && update.prompt_id) ||
        (typeof update.promptId === "string" && update.promptId) ||
        String(idx);

      const ts = timestampFromUpdate(row, ctx.fallbackTs);
      maxStreamTs = ts;

      const usage = update.usage as Record<string, unknown> | undefined;
      const buckets =
        usage && typeof usage === "object" ? bucketsFromUsage(usage) : null;

      if (buckets) {
        const modelUsage = usage!.modelUsage as Record<string, unknown> | undefined;
        let model = ctx.model;
        if (modelUsage && typeof modelUsage === "object") {
          const keys = Object.keys(modelUsage);
          if (keys.length === 1 && keys[0]) model = keys[0];
          else if (keys.length > 1) {
            let best = keys[0];
            let bestTot = -1;
            for (const k of keys) {
              const mu = modelUsage[k] as Record<string, unknown> | undefined;
              const t = num(mu?.totalTokens ?? mu?.inputTokens);
              if (t > bestTot) {
                bestTot = t;
                best = k;
              }
            }
            if (best) model = best;
          }
        }

        const { routerCost, ...tokenBuckets } = buckets;
        events.push(
          applyPricing({
            id: turnEventId(ctx.sessionId, promptId),
            agent: "grok",
            model,
            timestamp: ts,
            ...tokenBuckets,
            ...(routerCost != null ? { routerCost } : {}),
            workspace: ctx.workspace,
            sourcePath: updatesPath,
            estimated: false,
          }),
        );
        promptPeak.delete(promptId);
        completedWithUsage.add(promptId);
        emittedPromptIds.add(promptId);
        continue;
      }

      // Newer Grok CLI: turn_completed without usage — bill peak stream tokens + cache
      const peak = promptPeak.get(promptId) ?? { total: 0, cached: 0, outChars: 0 };
      if (peak.total <= 0 && peak.cached <= 0 && peak.outChars <= 0) continue;
      const cacheRead = Math.min(peak.cached, peak.total || peak.cached);
      const uncached = Math.max(0, (peak.total || cacheRead) - cacheRead);
      const outEst = peakToOutputTokens(peak);

      events.push(
        applyPricing({
          // Same id family as real usage so a later usage row replaces this estimate.
          id: turnEventId(ctx.sessionId, promptId),
          agent: "grok",
          model: ctx.model,
          timestamp: ts,
          inputTokens: uncached,
          outputTokens: outEst,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: 0,
          workspace: ctx.workspace,
          sourcePath: updatesPath,
          estimated: true,
        }),
      );
      promptPeak.delete(promptId);
      emittedPromptIds.add(promptId);
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  // Residual in-progress prompts only — never re-bill completed promptIds.
  // Stable id per prompt so rescan updates in place; real usage wins via preferRicher.
  if (promptPeak.size > 0) {
    for (const [promptId, peak] of promptPeak) {
      if (completedWithUsage.has(promptId) || emittedPromptIds.has(promptId)) continue;
      if (peak.total <= 0 && peak.cached <= 0 && peak.outChars <= 0) continue;
      const cacheRead = Math.min(peak.cached, peak.total || peak.cached);
      const uncached = Math.max(0, (peak.total || cacheRead) - cacheRead);
      const outEst = peakToOutputTokens(peak);
      events.push(
        applyPricing({
          id: turnEventId(ctx.sessionId, promptId),
          agent: "grok",
          model: ctx.model,
          timestamp: maxStreamTs,
          inputTokens: uncached,
          outputTokens: outEst,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: 0,
          workspace: ctx.workspace,
          sourcePath: updatesPath,
          estimated: true,
        }),
      );
    }
  } else if (events.length === 0 && (maxStreamTokens > 0 || maxStreamCached > 0)) {
    // No prompt ids in stream meta — session-level floor only (stable id, no peak)
    const cacheRead = Math.min(maxStreamCached, maxStreamTokens || maxStreamCached);
    const uncached = Math.max(0, (maxStreamTokens || cacheRead) - cacheRead);
    events.push(
      applyPricing({
        id: stableId("grok", ctx.sessionId, "stream-floor"),
        agent: "grok",
        model: ctx.model,
        timestamp: maxStreamTs,
        inputTokens: uncached,
        outputTokens: 0,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: 0,
        workspace: ctx.workspace,
        sourcePath: updatesPath,
        estimated: true,
      }),
    );
  }
  return events;
}

/**
 * Grok turn_completed.usage (real CLI shape):
 * - inputTokens = FULL prompt (includes cache hits)
 * - cachedReadTokens = cache hit portion of input
 * - cacheCreationTokens = cache write / creation tokens
 * - outputTokens already includes reasoningTokens when both present
 *   (totalTokens ≈ inputTokens + outputTokens)
 * - costUsdTicks = official USD × 1e10 (prefer over table rates)
 */
function bucketsFromUsage(usage: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Official cost from Grok CLI when present (USD). */
  routerCost?: number;
  /** Grok session/model-call count when the source provides it. */
  requestCount?: number;
} | null {
  const fullInput = num(
    usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokens,
  );
  let output = num(
    usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens ?? usage.completionTokens,
  );
  // Reasoning is usually already folded into outputTokens (total = input + output).
  // Only fill from reasoning when output is missing or clearly smaller than reasoning alone.
  const reasoning = num(
    usage.reasoningTokens ??
      usage.reasoning_tokens ??
      usage.reasoning_output_tokens ??
      usage.reasoningOutputTokens ??
      usage.thinking_tokens ??
      usage.thinkingOutputTokens,
  );
  if (reasoning > 0) {
    if (output <= 0) output = reasoning;
    else if (reasoning > output) output = reasoning;
    // else: reasoning ⊆ output — do NOT double-count
  }

  const cacheRead = num(
    usage.cachedReadTokens ??
      usage.cached_input_tokens ??
      usage.cachedInputTokens ??
      usage.cache_read_input_tokens ??
      usage.cacheReadInputTokens ??
      usage.cache_read_tokens ??
      usage.cacheReadTokens ??
      usage.cached_tokens ??
      usage.cached_content_token_count ??
      usage.cachedContentTokenCount,
  );
  // Grok CLI field is cacheCreationTokens (not cache_creation_input_tokens)
  const cacheWrite = num(
    usage.cacheCreationTokens ??
      usage.cache_creation_tokens ??
      usage.cache_creation_input_tokens ??
      usage.cache_write_input_tokens ??
      usage.cacheWriteInputTokens ??
      usage.cacheWriteTokens ??
      usage.cache_write_tokens ??
      usage.cachedWriteTokens,
  );

  const uncached = Math.max(0, fullInput - cacheRead);

  if (uncached + output + cacheRead + cacheWrite <= 0) return null;

  // Grok CLI reports cost as integer ticks: USD = costUsdTicks / 1e10
  const ticks = num(usage.costUsdTicks ?? usage.cost_usd_ticks);
  const routerCost = ticks > 0 ? ticks / 1e10 : undefined;
  const calls = num(usage.modelCalls ?? usage.model_calls ?? usage.apiCalls ?? usage.api_calls);

  return {
    inputTokens: uncached,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    ...(routerCost != null ? { routerCost } : {}),
    ...(calls > 0 ? { requestCount: Math.floor(calls) } : {}),
  };
}

function modelFromUsage(usage: Record<string, unknown>, fallback: string): string {
  const primary = usage.primaryModelId ?? usage.primary_model_id;
  if (typeof primary === "string" && primary) return primary;
  const modelUsage = usage.modelUsage as Record<string, unknown> | undefined;
  if (!modelUsage || typeof modelUsage !== "object") return fallback;
  const keys = Object.keys(modelUsage);
  if (keys.length === 0) return fallback;
  if (keys.length === 1 && keys[0]) return keys[0];
  let best = keys[0] || fallback;
  let bestTotal = -1;
  for (const key of keys) {
    const row = modelUsage[key] as Record<string, unknown> | undefined;
    const total = num(row?.totalTokens ?? row?.inputTokens ?? row?.input_tokens);
    if (total > bestTotal) {
      bestTotal = total;
      best = key;
    }
  }
  return best;
}

function timestampFromUpdate(row: Record<string, unknown>, fallback: string): string {
  const t = row.timestamp;
  if (typeof t === "number" && Number.isFinite(t) && t > 0) {
    const ms = t > 1e12 ? t : t * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof t === "string" && t.trim() && !Number.isNaN(Date.parse(t))) {
    return new Date(t).toISOString();
  }
  const params = row.params as Record<string, unknown> | undefined;
  const update = params?.update as Record<string, unknown> | undefined;
  const meta = (update?._meta ?? params?._meta ?? row._meta) as Record<string, unknown> | undefined;
  for (const key of ["agentTimestampMs", "streamStartMs", "turnStartMs"] as const) {
    const v = meta?.[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 1e11) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return fallback;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
        }
        return "";
      })
      .join("");
  }
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
  }
  return "";
}


function validTimestamp(value: unknown): string | null {
  if (typeof value === "string" && value.trim() && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function persistedUsageIsRicher(
  persisted: PersistedGrokUsage,
  updates: UsageEvent[],
): boolean {
  let updateTokens = 0;
  let updateCost = 0;
  for (const e of updates) {
    updateTokens += Number(e.totalTokens) || 0;
    updateCost += Number(e.estimatedCost) || 0;
  }
  if (persisted.tokenWeight > updateTokens * 1.001) return true;
  if (updateTokens > persisted.tokenWeight * 1.001) return false;
  return persisted.routerCost > updateCost * 1.001;
}

function isAfterTimestamp(timestamp: string, boundary: string): boolean {
  const a = Date.parse(timestamp);
  const b = Date.parse(boundary);
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

// ===== Best-of-both merge: persisted usage.json turns[] (from feat branch) =====

type PersistedGrokUsage = {
  events: UsageEvent[];
  updatedAt: string | null;
  tokenWeight: number;
  routerCost: number;
};

async function parsePersistedUsage(
  file: string,
  ctx: {
    sessionId: string;
    model: string;
    workspace: string | null;
    fallbackTs: string;
  },
): Promise<PersistedGrokUsage> {
  const empty: PersistedGrokUsage = {
    events: [],
    updatedAt: null,
    tokenWeight: 0,
    routerCost: 0,
  };
  const text = await readText(file);
  if (!text) return empty;

  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
    raw = parsed as Record<string, unknown>;
  } catch {
    return empty;
  }

  const updatedAt = validTimestamp(raw.updatedAt) || validTimestamp(raw.updated_at);
  const turns = Array.isArray(raw.turns) ? raw.turns : [];
  const events: UsageEvent[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) continue;
    const row = turn as Record<string, unknown>;
    const buckets = bucketsFromUsage(row);
    if (!buckets) continue;
    const { routerCost, ...tokenBuckets } = buckets;
    const turnNumber =
      typeof row.turnNumber === "number" || typeof row.turn_number === "number"
        ? String(row.turnNumber ?? row.turn_number)
        : String(i + 1);
    const timestamp =
      validTimestamp(row.endedAt) ||
      validTimestamp(row.ended_at) ||
      validTimestamp(row.updatedAt) ||
      updatedAt ||
      ctx.fallbackTs;
    events.push(
      applyPricing({
        id: stableId("grok", ctx.sessionId, "usage-turn", turnNumber),
        agent: "grok",
        model: modelFromUsage(row, ctx.model),
        timestamp,
        ...tokenBuckets,
        ...(routerCost != null ? { routerCost } : {}),
        workspace: ctx.workspace,
        sourcePath: file,
        estimated: false,
      }),
    );
  }

  // If the export has no per-turn list, retain the session rollup as one
  // event. Never emit both session and turns: session is cumulative.
  if (events.length === 0) {
    const session =
      raw.session && typeof raw.session === "object" && !Array.isArray(raw.session)
        ? (raw.session as Record<string, unknown>)
        : null;
    if (session) {
      const buckets = bucketsFromUsage(session);
      if (buckets) {
        const { routerCost, ...tokenBuckets } = buckets;
        events.push(
          applyPricing({
            id: stableId("grok", ctx.sessionId, "usage-session"),
            agent: "grok",
            model: modelFromUsage(session, ctx.model),
            timestamp: updatedAt || ctx.fallbackTs,
            ...tokenBuckets,
            ...(routerCost != null ? { routerCost } : {}),
            workspace: ctx.workspace,
            sourcePath: file,
            estimated: false,
          }),
        );
      }
    }
  }

  let tokenWeight = 0;
  let routerCost = 0;
  for (const e of events) {
    tokenWeight += Number(e.totalTokens) || 0;
    // applyPricing stores a positive router-reported cost in estimatedCost;
    // UsageEvent intentionally has no separate routerCost field.
    routerCost += Number(e.estimatedCost) || 0;
  }
  return { events, updatedAt, tokenWeight, routerCost };
}
export const agent: AgentModule = {
  id: "grok",
  label: "Grok (xAI)",
  roots() {
    const { home, appData, path: p } = pathEnv();
    return unique([p.join(home, ".grok"), p.join(appData, "Grok")]);
  },
  parse: parseGrok,
};
