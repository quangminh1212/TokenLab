import type { AgentId, AgentStatus, UsageEvent } from "../types.js";
import { agentPathSpecs } from "../paths.js";
import { pathExists } from "../util.js";
import { parseClaudeCode } from "./claude-code.js";
import { parseCodex } from "./codex.js";
import { parseCursor } from "./cursor.js";
import { parseGemini } from "./gemini.js";
import { parseGrok } from "./grok.js";
import { parseOpenCode } from "./opencode.js";
import { parseWindsurf } from "./windsurf.js";

export type ParserFn = (roots: string[]) => Promise<UsageEvent[]>;

const PARSERS: Record<AgentId, ParserFn | null> = {
  "claude-code": parseClaudeCode,
  codex: parseCodex,
  cursor: parseCursor,
  windsurf: parseWindsurf,
  grok: parseGrok,
  gemini: parseGemini,
  opencode: parseOpenCode,
  copilot: null, // path detect only for now
  custom: null,
};

export async function scanAll(enabled?: Partial<Record<AgentId, boolean>>): Promise<UsageEvent[]> {
  const specs = agentPathSpecs();
  const all: UsageEvent[] = [];

  for (const spec of specs) {
    if (enabled && enabled[spec.id] === false) continue;
    const parser = PARSERS[spec.id];
    if (!parser) continue;
    const existingRoots: string[] = [];
    for (const r of spec.roots) {
      if (await pathExists(r)) existingRoots.push(r);
    }
    if (existingRoots.length === 0) continue;
    try {
      const events = await parser(existingRoots);
      all.push(...events);
    } catch (err) {
      console.error(`[xlab-token] parser ${spec.id} failed:`, err instanceof Error ? err.message : err);
    }
  }

  // stable sort by time
  all.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return all;
}

export async function detectAgents(events: UsageEvent[] = []): Promise<AgentStatus[]> {
  const specs = agentPathSpecs();
  const byAgent = new Map<string, UsageEvent[]>();
  for (const e of events) {
    const list = byAgent.get(e.agent) ?? [];
    list.push(e);
    byAgent.set(e.agent, list);
  }

  const out: AgentStatus[] = [];
  for (const spec of specs) {
    const paths: string[] = [];
    for (const r of spec.roots) {
      if (await pathExists(r)) paths.push(r);
    }
    const list = byAgent.get(spec.id) ?? [];
    const last = list.length
      ? list.map((e) => e.timestamp).sort().at(-1) ?? null
      : null;
    out.push({
      id: spec.id,
      label: spec.label,
      detected: paths.length > 0,
      enabled: PARSERS[spec.id] != null,
      paths,
      lastEventAt: last,
      eventCount: list.length,
    });
  }
  return out;
}

export { PARSERS };
