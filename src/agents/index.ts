import type { AgentId, AgentStatus, UsageEvent } from "../types.js";
import { pathExists } from "../util.js";
import { agent as claude_code } from "./claude-code/index.js";
import { agent as codex } from "./codex/index.js";
import { agent as cursor } from "./cursor/index.js";
import { agent as windsurf } from "./windsurf/index.js";
import { agent as grok } from "./grok/index.js";
import { agent as gemini } from "./gemini/index.js";
import { agent as opencode } from "./opencode/index.js";
import { agent as hermes } from "./hermes/index.js";
import { agent as openclaw } from "./openclaw/index.js";
import { agent as copilot } from "./copilot/index.js";
import { agent as pi } from "./pi/index.js";
import { agent as kimi } from "./kimi/index.js";
import { agent as qwen } from "./qwen/index.js";
import { agent as droid } from "./droid/index.js";
import { agent as amp } from "./amp/index.js";
import { agent as goose } from "./goose/index.js";
import { agent as cline } from "./cline/index.js";
import { agent as roocode } from "./roocode/index.js";
import { agent as kilocode } from "./kilocode/index.js";
import { agent as antigravity } from "./antigravity/index.js";
import { agent as warp } from "./warp/index.js";
import { agent as trae } from "./trae/index.js";
import { agent as zed } from "./zed/index.js";
import { agent as codebuff } from "./codebuff/index.js";
import { agent as mux } from "./mux/index.js";
import { agent as crush } from "./crush/index.js";
import { agent as kiro } from "./kiro/index.js";
import { agent as gjc } from "./gjc/index.js";
import { agent as jcode } from "./jcode/index.js";
import { agent as commandcode } from "./commandcode/index.js";
import { agent as junie } from "./junie/index.js";
import { agent as zcode } from "./zcode/index.js";
import { agent as opencodereview } from "./opencodereview/index.js";
import { agent as codebuddy } from "./codebuddy/index.js";
import { agent as workbuddy } from "./workbuddy/index.js";
import { agent as aider } from "./aider/index.js";
import { agent as agent_continue } from "./continue/index.js";
import { agent as amazon_q } from "./amazon-q/index.js";
import { agent as void_agent } from "./void/index.js";
import { agent as forge } from "./forge/index.js";
import { agent as blackbox } from "./blackbox/index.js";
import { agent as iflow } from "./iflow/index.js";
import { agent as qoder } from "./qoder/index.js";
import { agent as mimocode } from "./mimocode/index.js";
import { agent as codewhale } from "./codewhale/index.js";
import { agent as ollama } from "./ollama/index.js";
import { agent as devin } from "./devin/index.js";
import { agent as nine_router } from "./9router/index.js";
import { agent as xlab_router } from "./xlabrouter/index.js";
import type { AgentModule, AgentPathSpec } from "./shared/types.js";

export type { AgentModule, AgentPathSpec } from "./shared/types.js";

/** All agent modules (one folder each under src/agents/). */
export const AGENTS: AgentModule[] = [
  claude_code,
  codex,
  cursor,
  windsurf,
  grok,
  gemini,
  opencode,
  hermes,
  openclaw,
  copilot,
  pi,
  kimi,
  qwen,
  droid,
  amp,
  goose,
  cline,
  roocode,
  kilocode,
  antigravity,
  warp,
  trae,
  zed,
  codebuff,
  mux,
  crush,
  kiro,
  gjc,
  jcode,
  commandcode,
  junie,
  zcode,
  opencodereview,
  codebuddy,
  workbuddy,
  aider,
  agent_continue,
  devin,
  ollama,
  codewhale,
  mimocode,
  qoder,
  iflow,
  blackbox,
  forge,
  void_agent,
  amazon_q,
  nine_router,
  xlab_router,
];

export const PARSERS: Record<AgentId, AgentModule["parse"] | null> = {
  ...Object.fromEntries(AGENTS.map((a) => [a.id, a.parse])) as Record<AgentId, AgentModule["parse"]>,
  custom: null,
};

export function agentPathSpecs(): AgentPathSpec[] {
  return AGENTS.map((a) => ({
    id: a.id,
    label: a.label,
    roots: a.roots(),
  }));
}

export type ScanAllOptions = {
  enabled?: Partial<Record<AgentId, boolean>>;
  /** Max agents parsed at once (default 4). */
  concurrency?: number;
  /** Soft timeout per agent; on timeout keep partial empty for that agent (default 25s). */
  timeoutMs?: number;
  /** Called after each agent finishes so the server can stream progressive totals. */
  onAgentDone?: (info: { agent: AgentId; events: UsageEvent[]; durationMs: number; error?: string }) => void;
};

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (!ms || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Scan all enabled agents. Runs parsers in parallel (bounded concurrency) so a
 * single heavy agent (9router/devin) does not block the rest for tens of seconds.
 * Does not sort the full list (callers that need newest-first sort a slice).
 */
export async function scanAll(
  enabledOrOpts?: Partial<Record<AgentId, boolean>> | ScanAllOptions,
): Promise<UsageEvent[]> {
  const opts: ScanAllOptions =
    enabledOrOpts && ("enabled" in enabledOrOpts || "concurrency" in enabledOrOpts || "timeoutMs" in enabledOrOpts || "onAgentDone" in enabledOrOpts)
      ? (enabledOrOpts as ScanAllOptions)
      : { enabled: enabledOrOpts as Partial<Record<AgentId, boolean>> | undefined };

  const enabled = opts.enabled;
  const concurrency = Math.max(1, Math.min(8, opts.concurrency ?? 4));
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const onAgentDone = opts.onAgentDone;

  type Job = { id: AgentId; label: string; roots: string[]; parse: (roots: string[]) => Promise<UsageEvent[]> };
  const jobs: Job[] = [];

  for (const mod of AGENTS) {
    if (enabled && enabled[mod.id] === false) continue;
    const roots: string[] = [];
    for (const r of mod.roots()) {
      if (await pathExists(r)) roots.push(r);
    }
    if (roots.length === 0) continue;
    if (!mod.parse) continue;
    jobs.push({ id: mod.id, label: mod.label, roots, parse: mod.parse });
  }

  const all: UsageEvent[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < jobs.length) {
      const i = cursor++;
      const job = jobs[i]!;
      const t0 = Date.now();
      try {
        const batch = await withTimeout(job.parse(job.roots), timeoutMs, `parser ${job.id}`);
        for (const e of batch) all.push(e);
        onAgentDone?.({ agent: job.id, events: batch, durationMs: Date.now() - t0 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[xlab-token] parser " + job.id + " failed:", msg);
        onAgentDone?.({ agent: job.id, events: [], durationMs: Date.now() - t0, error: msg });
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, jobs.length || 1) }, () => worker());
  await Promise.all(workers);
  return all;
}

export async function detectAgents(events: UsageEvent[] = []): Promise<AgentStatus[]> {
  // O(n) counts + last timestamp — avoid storing 100k+ event arrays per agent
  const counts = new Map<string, number>();
  const lastAt = new Map<string, string>();
  for (const e of events) {
    counts.set(e.agent, (counts.get(e.agent) ?? 0) + 1);
    const prev = lastAt.get(e.agent);
    if (!prev || e.timestamp > prev) lastAt.set(e.agent, e.timestamp);
  }

  const out: AgentStatus[] = [];
  for (const mod of AGENTS) {
    const paths: string[] = [];
    for (const r of mod.roots()) {
      if (await pathExists(r)) paths.push(r);
    }
    out.push({
      id: mod.id,
      label: mod.label,
      detected: paths.length > 0,
      enabled: true,
      paths,
      lastEventAt: lastAt.get(mod.id) ?? null,
      eventCount: counts.get(mod.id) ?? 0,
    });
  }
  return out;
}
