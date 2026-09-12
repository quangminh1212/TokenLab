import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";

import path from "node:path";
import { applyPricing } from "../../pricing.js";
import type { UsageEvent } from "../../types.js";
import {
  extractTokenBuckets,
  type TokenBuckets,
} from "../shared/usage-fields.js";
import { parseJsonl, pathExists, readText, stableId, walkFiles } from "../../util.js";

// Claude Code: ~/.claude/projects/<project>/<session>.jsonl
// Assistant messages often include usage: { input_tokens, output_tokens, cache_* }.
// One API response can be written as several assistant rows (one per content
// block), all carrying the same requestId/message.id and repeated usage. Keep
// one logical request, otherwise Claude Code usage is multiplied by block count.

type JsonObject = Record<string, unknown>;

type UsageCandidate = {
  file: string;
  row: JsonObject;
  message: JsonObject;
  buckets: TokenBuckets;
  requestKey: string;
  rowIndex: number;
};

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function requestKeyFor(file: string, row: JsonObject, message: JsonObject, rowIndex: number): string {
  const requestId =
    asNonEmptyString(row.requestId) ||
    asNonEmptyString(row.request_id) ||
    asNonEmptyString(message.requestId) ||
    asNonEmptyString(message.request_id);
  if (requestId) return `request:${requestId}`;

  // Claude Code and compatible bridges repeat message.id on every content
  // block. Do not restrict this to msg_0: routed Claude sessions on this host
  // use ids such as msg_ce..., which have the same repeated-block behavior.
  const messageId = asNonEmptyString(message.id) || asNonEmptyString(row.message_id);
  if (messageId) return `message:${messageId}`;

  // UUID is the last stable identity available for unusual/synthetic rows.
  const uuid = asNonEmptyString(row.uuid);
  return `row:${file}:${uuid || String(rowIndex)}`;
}

function candidateScore(candidate: UsageCandidate): number {
  const b = candidate.buckets;
  return b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens;
}

function isRicherCandidate(next: UsageCandidate, previous: UsageCandidate): boolean {
  const nextOutput = next.buckets.outputTokens;
  const previousOutput = previous.buckets.outputTokens;
  if (nextOutput !== previousOutput) return nextOutput > previousOutput;
  const nextScore = candidateScore(next);
  const previousScore = candidateScore(previous);
  if (nextScore !== previousScore) return nextScore > previousScore;
  // Later content blocks usually carry the final timestamp/metadata while
  // retaining the same usage counters.
  return next.rowIndex > previous.rowIndex;
}

function timestampFromRow(row: JsonObject, message: JsonObject): string {
  const candidates = [row.timestamp, row.ts, message.timestamp, message.ts];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim() && !Number.isNaN(Date.parse(value))) {
      return new Date(value).toISOString();
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      const date = new Date(value > 1e12 ? value : value * 1000);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  return new Date().toISOString();
}

function workspaceFromFile(file: string, roots: string[]): string | null {
  for (const root of roots) {
    const relative = path.relative(root, file);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      continue;
    }
    const parts = relative.split(path.sep);
    if (parts.length < 2) continue;
    const first = parts[0];
    if (first) return first;
  }
  return null;
}

export async function parseClaudeCode(roots: string[]): Promise<UsageEvent[]> {
  const files = new Set<string>();

  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    const projects = path.join(root, "projects");
    const transcripts = path.join(root, "transcripts");
    for (const file of [
      ...(await walkFiles(projects, {
        match: (n) => n.toLowerCase().endsWith(".jsonl"),
      })),
      ...(await walkFiles(transcripts, {
        match: (n) => n.toLowerCase().endsWith(".jsonl"),
      })),
    ]) {
      files.add(file);
    }
  }

  const allRoots = roots.flatMap((root) => [path.join(root, "projects"), path.join(root, "transcripts")]);
  const byRequest = new Map<string, UsageCandidate>();
  const seenUuids = new Set<string>();

  for (const file of files) {
    const text = await readText(file);
    if (!text) continue;
    const rows = parseJsonl(text);
    let rowIndex = 0;
    for (const row of rows) {
      rowIndex += 1;
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const r = row as JsonObject;

      // Exact replay assistant rows can appear when a session is resumed.
      // Delay marking the UUID until after role/usage filtering so a metadata
      // or user row cannot hide a later assistant usage row with the same UUID.
      const uuid = asNonEmptyString(r.uuid);
      if (uuid && seenUuids.has(uuid)) continue;

      const message =
        r.message && typeof r.message === "object" && !Array.isArray(r.message)
          ? (r.message as JsonObject)
          : r;
      const rowType = asNonEmptyString(r.type);
      const messageRole = asNonEmptyString(message.role);
      if ((rowType && rowType !== "assistant") || (!rowType && messageRole && messageRole !== "assistant")) {
        continue;
      }

      const usage =
        message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
          ? message.usage
          : r.usage && typeof r.usage === "object" && !Array.isArray(r.usage)
            ? r.usage
            : null;
      const buckets = extractTokenBuckets(usage);
      if (!buckets) continue;
      if (uuid) seenUuids.add(uuid);

      const candidate: UsageCandidate = {
        file,
        row: r,
        message,
        buckets,
        requestKey: requestKeyFor(file, r, message, rowIndex),
        rowIndex,
      };
      const previous = byRequest.get(candidate.requestKey);
      if (!previous || isRicherCandidate(candidate, previous)) {
        byRequest.set(candidate.requestKey, candidate);
      }
    }
  }

  const events: UsageEvent[] = [];
  for (const candidate of byRequest.values()) {
    const { buckets } = candidate;
    const inputTokens = buckets.inputIncludesCache
      ? Math.max(0, buckets.inputTokens - buckets.cacheReadTokens)
      : buckets.inputTokens;
    const model =
      (typeof candidate.message.model === "string" && candidate.message.model) ||
      (typeof candidate.row.model === "string" && candidate.row.model) ||
      null;
    events.push(
      applyPricing({
        id: stableId("claude-code", candidate.requestKey),
        agent: "claude-code",
        model,
        timestamp: timestampFromRow(candidate.row, candidate.message),
        inputTokens,
        outputTokens: buckets.outputTokens,
        cacheReadTokens: buckets.cacheReadTokens,
        cacheWriteTokens: buckets.cacheWriteTokens,
        workspace: workspaceFromFile(candidate.file, allRoots),
        sourcePath: candidate.file,
        estimated: false,
      }),
    );
  }

  return events;
}


export const agent: AgentModule = {
  id: "claude-code",
  label: "Claude Code",
  roots() {
    const { home, appData, localApp, xdgData, xdgConfig, path, expandHome } = pathEnv();
    return unique([
      expandHome(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude")),
      ...(process.env.CLAUDE_CONFIG_DIRS
        ? process.env.CLAUDE_CONFIG_DIRS.split(path.delimiter).map(expandHome)
        : []),
      path.join(home, ".config", "claude"),
    ]);
  },
  parse: parseClaudeCode,
};
