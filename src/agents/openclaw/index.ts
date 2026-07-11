import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";

import path from "node:path";
import { applyPricing } from "../../pricing.js";
import type { UsageEvent } from "../../types.js";
import { parseJsonl, pathExists, readText, stableId, walkFiles } from "../../util.js";
import { extractModel, extractTimestamp, extractTokenBuckets } from "../shared/usage-fields.js";

/**
 * OpenClaw (+ legacy clawdbot / moltbot / moldbot):
 * - ~/.openclaw/agents/<agent>/sessions/*.jsonl
 * - sessions.json index pointing at transcript files
 * Usage from assistant message.usage / modelId
 */
export async function parseOpenClaw(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const seenFiles = new Set<string>();

  for (const root of roots) {
    if (!(await pathExists(root))) continue;

    // Follow sessions.json indexes
    const indexes = await walkFiles(root, {
      maxDepth: 8,
      match: (n) => n === "sessions.json" || n === "session-index.json",
    });
    for (const indexPath of indexes) {
      const text = await readText(indexPath);
      if (!text) continue;
      try {
        const data = JSON.parse(text) as unknown;
        const refs = collectPathRefs(data, path.dirname(indexPath));
        for (const ref of refs) {
          await parseSessionFile(events, ref, seenFiles);
        }
      } catch {
        // ignore bad index
      }
    }

    // Direct walk: agents, sessions, jsonl
    const files = await walkFiles(root, {
      maxDepth: 10,
      match: (n, full) => {
        if (n.endsWith(".jsonl")) return true;
        if (n.endsWith(".json") && /session|transcript|chat|agent/i.test(full)) return true;
        return false;
      },
    });

    for (const file of files) {
      if (path.basename(file) === "sessions.json") continue;
      await parseSessionFile(events, file, seenFiles);
    }
  }

  return events;
}

async function parseSessionFile(
  events: UsageEvent[],
  file: string,
  seen: Set<string>,
): Promise<void> {
  if (seen.has(file)) return;
  seen.add(file);
  if (!(await pathExists(file))) return;
  const text = await readText(file);
  if (!text) return;

  const rows = file.endsWith(".jsonl")
    ? parseJsonl(text)
    : (() => {
        try {
          const d = JSON.parse(text);
          if (Array.isArray(d)) return d;
          if (d && typeof d === "object") {
            const o = d as Record<string, unknown>;
            if (Array.isArray(o.messages)) return o.messages;
            if (Array.isArray(o.events)) return o.events;
            return [d];
          }
        } catch {
          return [];
        }
        return [];
      })();

  let idx = 0;
  let model: string | null = null;
  let workspace: string | null = null;

  for (const row of rows) {
    idx += 1;
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const type = String(r.type ?? r.role ?? r.event ?? "");

    if (type === "model_change" || type === "session_meta" || type === "system") {
      model = extractModel(r, r.message, model) || model;
      if (typeof r.cwd === "string") workspace = r.cwd;
      continue;
    }

    // assistant / message with usage
    const msg = (r.message && typeof r.message === "object" ? r.message : r) as Record<string, unknown>;
    const usage = msg.usage ?? r.usage ?? r.token_usage;
    const buckets = extractTokenBuckets(usage ?? msg);
    if (!buckets) continue;

    model = extractModel(r, msg, model) || model;
    const ts = extractTimestamp(r, msg);

    events.push(
      applyPricing({
        id: stableId("openclaw", file, String(idx), String(buckets.inputTokens), String(buckets.outputTokens)),
        agent: "openclaw",
        model,
        timestamp: ts,
        ...buckets,
        workspace,
        sourcePath: file,
      }),
    );
  }
}

function collectPathRefs(data: unknown, baseDir: string): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (!v) return;
    if (typeof v === "string") {
      if (v.endsWith(".jsonl") || v.endsWith(".json")) {
        out.push(path.isAbsolute(v) ? v : path.resolve(baseDir, v));
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (/path|file|session|transcript/i.test(k) && typeof val === "string") {
          out.push(path.isAbsolute(val) ? val : path.resolve(baseDir, val));
        } else {
          visit(val);
        }
      }
    }
  };
  visit(data);
  return [...new Set(out)];
}


export const agent: AgentModule = {
  id: "openclaw",
  label: "OpenClaw",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      path.join(home, ".openclaw"),
      path.join(home, ".clawdbot"),
      path.join(home, ".moltbot"),
      path.join(home, ".moldbot"),
      path.join(appData, "openclaw"),
      path.join(localApp, "openclaw"),
      path.join(xdgData, "openclaw"),
      path.join(xdgConfig, "openclaw"),
    ]);
  },
  parse: parseOpenClaw,
};
