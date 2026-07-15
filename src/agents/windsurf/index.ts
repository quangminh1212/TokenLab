import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique, vscodeGlobalStorage } from "../shared/env.js";

import { createDecipheriv } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { applyPricing } from "../../pricing.js";
import type { UsageEvent } from "../../types.js";
import { parseJsonl, pathExists, readText, stableId, walkFiles } from "../../util.js";
import { extractModel, extractTimestamp, extractTokenBuckets } from "../shared/usage-fields.js";

/**
 * Windsurf / Codeium
 * --------------------
 * Local roots:
 *   - ~/.codeium/windsurf  (cascade sessions, settings)
 *   - %APPDATA%/Windsurf   (VS Code-fork user data when IDE is installed)
 *
 * Cascade stores chats as AES-256-GCM encrypted .pb files. The key is a
 * hardcoded global constant inside language_server (same for every install):
 *   "safeCodeiumworldKeYsecretBalloon"
 * Layout: [12-byte nonce][ciphertext][16-byte GCM tag] → CortexTrajectory protobuf.
 *
 * After decrypt we extract per-session model + Input/Output/Cached floats from
 * Token Usage blocks. Fallback: size heuristic (estimated:true) if decrypt fails.
 *
 * Ref: https://github.com/dayearleo/windsurf-local-user-data-decryption
 */

/** Hardcoded AES-256 key shipped in every Windsurf language_server binary. */
const CASCADE_AES_KEY = Buffer.from("safeCodeiumworldKeYsecretBalloon", "utf8");
export async function parseWindsurf(roots: string[]): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    if (!(await pathExists(root))) continue;

    // 1) Plain JSON / JSONL usage artifacts
    events.push(...(await parseJsonArtifacts(root, seen)));

    // 2) VS Code-style SQLite (state.vscdb, etc.)
    events.push(...(await parseSqliteArtifacts(root, seen)));

    // 3) Encrypted cascade sessions → estimated usage
    events.push(...(await parseCascadeSessions(root, seen)));
  }

  return events;
}

async function parseJsonArtifacts(root: string, seen: Set<string>): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const files = await walkFiles(root, {
    maxDepth: 14,
    match: (name, full) => {
      const lower = name.toLowerCase();
      const pathLower = full.toLowerCase();
      if (lower.endsWith(".pb") || lower.endsWith(".lock")) return false;
      if (lower.endsWith(".jsonl")) return true;
      if (lower.includes("usage") && (lower.endsWith(".json") || lower.endsWith(".jsonl"))) return true;
      if (lower.includes("cascade") && lower.endsWith(".json")) return true;
      if (pathLower.includes(`${path.sep}logs${path.sep}`) && (lower.endsWith(".json") || lower.endsWith(".log")))
        return true;
      if (
        lower.endsWith(".json") &&
        (lower.includes("chat") ||
          lower.includes("transcript") ||
          lower.includes("session") ||
          lower.includes("token") ||
          lower.includes("billing") ||
          pathLower.includes("globalstorage") ||
          pathLower.includes("workspacestorage"))
      )
        return true;
      return false;
    },
  });

  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await readText(file);
    if (!text) continue;

    const rows = file.endsWith(".jsonl")
      ? parseJsonl(text)
      : (() => {
          try {
            const data = JSON.parse(text);
            if (Array.isArray(data)) return data;
            if (data && typeof data === "object") {
              const o = data as Record<string, unknown>;
              if (Array.isArray(o.messages)) return o.messages;
              if (Array.isArray(o.events)) return o.events;
              if (Array.isArray(o.usage)) return o.usage;
              if (Array.isArray(o.sessions)) return o.sessions;
              return [data];
            }
          } catch {
            return [];
          }
          return [];
        })();

    let idx = 0;
    for (const row of rows) {
      idx += 1;
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const buckets = extractTokenBuckets(
        r.usage ?? r.tokenUsage ?? r.token_usage ?? r.credits ?? r.token_count ?? r,
      );
      if (!buckets) continue;

      events.push(
        applyPricing({
          id: stableId(
            "windsurf",
            file,
            String(idx),
            String(buckets.inputTokens),
            String(buckets.outputTokens),
          ),
          agent: "windsurf",
          model: extractModel(r, r.usage, r.message),
          timestamp: extractTimestamp(r, r.usage, r.message),
          ...buckets,
          workspace:
            typeof r.cwd === "string"
              ? r.cwd
              : typeof r.workspace === "string"
                ? r.workspace
                : null,
          sourcePath: file,
        }),
      );
    }
  }

  return events;
}

async function parseSqliteArtifacts(root: string, seen: Set<string>): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const dbs = await walkFiles(root, {
    maxDepth: 10,
    match: (n) =>
      n === "state.vscdb" ||
      n.endsWith(".vscdb") ||
      n === "state.db" ||
      n === "storage.db" ||
      (n.endsWith(".db") && !n.includes("lock")),
  });

  for (const dbPath of dbs) {
    if (seen.has(dbPath)) continue;
    seen.add(dbPath);
    events.push(...(await parseWindsurfSqlite(dbPath)));
  }
  return events;
}

async function parseWindsurfSqlite(dbPath: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
      ).map((t) => t.name);

      // VS Code ItemTable key/value store
      if (tables.some((t) => t.toLowerCase() === "itemtable")) {
        const rows = db
          .prepare(`SELECT key, value FROM ItemTable`)
          .all() as Array<{ key: string; value: unknown }>;
        let i = 0;
        for (const row of rows) {
          i += 1;
          const key = String(row.key ?? "");
          if (!/usage|token|cascade|chat|billing|credit|model/i.test(key)) continue;
          const value = coerceSqliteValue(row.value);
          if (value == null) continue;
          pushUsageFromUnknown(events, value, dbPath, `item:${key}:${i}`);
        }
      }

      // Generic tables with token columns
      for (const table of tables) {
        if (/sqlite_/i.test(table)) continue;
        try {
          const cols = (
            db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>
          ).map((c) => c.name);
          const colset = new Set(cols.map((c) => c.toLowerCase()));
          const hasTokens =
            [...colset].some((c) => /token|usage|credit|cost/.test(c)) ||
            (colset.has("key") && colset.has("value"));
          if (!hasTokens) continue;

          const sample = db.prepare(`SELECT * FROM ${quoteIdent(table)} LIMIT 5000`).all() as Array<
            Record<string, unknown>
          >;
          let i = 0;
          for (const row of sample) {
            i += 1;
            const buckets = extractTokenBuckets(row);
            if (buckets) {
              events.push(
                applyPricing({
                  id: stableId("windsurf", dbPath, table, String(i), String(buckets.inputTokens)),
                  agent: "windsurf",
                  model: extractModel(row),
                  timestamp: extractTimestamp(row),
                  ...buckets,
                  workspace: null,
                  sourcePath: dbPath,
                }),
              );
              continue;
            }
            // key/value blob
            if (row.value != null) {
              const value = coerceSqliteValue(row.value);
              if (value) pushUsageFromUnknown(events, value, dbPath, `${table}:${i}`);
            }
          }
        } catch {
          // table variance
        }
      }
    } finally {
      db.close();
    }
  } catch {
    // node:sqlite unavailable or locked
  }
  return events;
}

function pushUsageFromUnknown(
  events: UsageEvent[],
  value: unknown,
  sourcePath: string,
  tag: string,
): void {
  const candidates: unknown[] = [];
  if (Array.isArray(value)) candidates.push(...value);
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (Array.isArray(o.messages)) candidates.push(...o.messages);
    else if (Array.isArray(o.events)) candidates.push(...o.events);
    else if (Array.isArray(o.usage)) candidates.push(...o.usage);
    else candidates.push(value);
  } else return;

  let i = 0;
  for (const c of candidates) {
    i += 1;
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    const buckets = extractTokenBuckets(r.usage ?? r.tokenUsage ?? r.token_usage ?? r);
    if (!buckets) continue;
    events.push(
      applyPricing({
        id: stableId("windsurf", sourcePath, tag, String(i), String(buckets.inputTokens)),
        agent: "windsurf",
        model: extractModel(r),
        timestamp: extractTimestamp(r),
        ...buckets,
        workspace: null,
        sourcePath,
      }),
    );
  }
}

/**
 * Decrypt + parse cascade/*.pb (and light implicit fallback).
 * Prefer real Token Usage metrics from decrypted CortexTrajectory protobuf.
 */
async function parseCascadeSessions(root: string, seen: Set<string>): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const cascadeDirs = [
    path.join(root, "cascade"),
    path.join(root, "windsurf", "cascade"),
  ];

  let decryptedAny = false;

  for (const dir of cascadeDirs) {
    if (!(await pathExists(dir))) continue;
    const files = await walkFiles(dir, {
      maxDepth: 3,
      match: (n) => n.endsWith(".pb"),
    });

    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);

      let st;
      try {
        st = await stat(file);
      } catch {
        continue;
      }
      if (st.size < 512) continue;

      const sessionId = path.basename(file, ".pb");
      const timestamp = st.mtime.toISOString();
      const real = await tryParseEncryptedTrajectory(file, st.size);

      if (real && (real.inputTokens > 0 || real.outputTokens > 0 || real.cacheReadTokens > 0)) {
        decryptedAny = true;
        events.push(
          applyPricing({
            id: stableId(
              "windsurf",
              "cascade",
              sessionId,
              String(real.inputTokens),
              String(real.outputTokens),
              String(real.cacheReadTokens),
            ),
            agent: "windsurf",
            model: real.model,
            timestamp,
            inputTokens: real.inputTokens,
            outputTokens: real.outputTokens,
            cacheReadTokens: real.cacheReadTokens,
            cacheWriteTokens: 0,
            workspace: null,
            sourcePath: file,
          }),
        );
        continue;
      }

      // Decrypt failed or empty metrics → size heuristic
      const totalTokens = Math.max(1, Math.round(st.size / 12));
      const inputTokens = Math.round(totalTokens * 0.6);
      const outputTokens = Math.max(1, totalTokens - inputTokens);
      events.push(
        applyPricing({
          id: stableId("windsurf", "cascade", sessionId, String(st.size), timestamp),
          agent: "windsurf",
          model: real?.model || "windsurf-cascade",
          timestamp,
          inputTokens,
          outputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          workspace: null,
          sourcePath: file,
          estimated: true,
        }),
      );
    }
  }

  // Implicit trajectories often embed copies of cascade Token Usage — skip when
  // cascade decrypt already produced real events to avoid double-counting.
  if (!decryptedAny) {
    const implicitDir = path.join(root, "implicit");
    if (await pathExists(implicitDir)) {
      const files = await walkFiles(implicitDir, {
        maxDepth: 2,
        match: (n) => n.endsWith(".pb"),
      });
      for (const file of files) {
        if (seen.has(file)) continue;
        seen.add(file);
        let st;
        try {
          st = await stat(file);
        } catch {
          continue;
        }
        if (st.size < 2048) continue;

        const sessionId = path.basename(file, ".pb");
        const timestamp = st.mtime.toISOString();
        const real = await tryParseEncryptedTrajectory(file, st.size);
        if (real && (real.inputTokens > 0 || real.outputTokens > 0 || real.cacheReadTokens > 0)) {
          events.push(
            applyPricing({
              id: stableId(
                "windsurf",
                "implicit",
                sessionId,
                String(real.inputTokens),
                String(real.outputTokens),
                String(real.cacheReadTokens),
              ),
              agent: "windsurf",
              model: real.model,
              timestamp,
              inputTokens: real.inputTokens,
              outputTokens: real.outputTokens,
              cacheReadTokens: real.cacheReadTokens,
              cacheWriteTokens: 0,
              workspace: null,
              sourcePath: file,
            }),
          );
          continue;
        }

        const totalTokens = Math.max(1, Math.round(st.size / 24));
        const inputTokens = Math.round(totalTokens * 0.7);
        const outputTokens = Math.max(1, totalTokens - inputTokens);
        events.push(
          applyPricing({
            id: stableId("windsurf", "implicit", sessionId, String(st.size), timestamp),
            agent: "windsurf",
            model: "windsurf-cascade",
            timestamp,
            inputTokens,
            outputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            workspace: null,
            sourcePath: file,
            estimated: true,
          }),
        );
      }
    }
  }

  return events;
}

/** AES-256-GCM unwrap of a cascade/implicit .pb file. */
export function decryptCascadePb(ciphertext: Buffer): Buffer | null {
  if (ciphertext.length < 12 + 16) return null;
  try {
    const nonce = ciphertext.subarray(0, 12);
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const body = ciphertext.subarray(12, ciphertext.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", CASCADE_AES_KEY, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return null;
  }
}

/**
 * Token Usage metric layout in CortexTrajectory protobuf (UI stats):
 *   ... "Input tokens" 0x15 <float32 LE> ...
 * Field 2 wire-type 5 (fixed32) holds the value; omitted when zero.
 */
export function extractLabeledFloats(plaintext: Buffer, label: string): number[] {
  const needle = Buffer.from(label, "utf8");
  const out: number[] = [];
  let idx = 0;
  while ((idx = plaintext.indexOf(needle, idx)) !== -1) {
    const pos = idx + needle.length;
    if (pos + 5 <= plaintext.length && plaintext[pos] === 0x15) {
      const f = plaintext.readFloatLE(pos + 1);
      if (Number.isFinite(f) && f >= 0 && f < 50_000_000) out.push(f);
    }
    idx = pos;
  }
  return out;
}

/** Dominant model slug from decrypted trajectory (glm-5-2, kimi-k2-7, swe-1-6, …). */
export function extractDominantModel(plaintext: Buffer): string | null {
  const counts = new Map<string, number>();
  const re = /\b((?:claude|gpt|gemini|swe|glm|kimi|o[1-9])[-a-z0-9]{2,40})\b/gi;
  const ascii = plaintext.toString("latin1");
  let m: RegExpExecArray | null;
  while ((m = re.exec(ascii))) {
    const s = m[1].toLowerCase();
    if (s.length < 5 || s.length > 36) continue;
    if (/[^a-z0-9\-]/.test(s)) continue;
    if (/^(claude|gpt|gemini|swe|glm|kimi)$/.test(s)) continue;
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

export function extractCascadeUsage(plaintext: Buffer): {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
} {
  const inputs = extractLabeledFloats(plaintext, "Input tokens");
  const outputs = extractLabeledFloats(plaintext, "Output tokens");
  const caches = extractLabeledFloats(plaintext, "Cached input tokens");
  const sum = (xs: number[]) => xs.reduce((a, b) => a + Math.round(b), 0);
  return {
    model: extractDominantModel(plaintext),
    inputTokens: sum(inputs),
    outputTokens: sum(outputs),
    cacheReadTokens: sum(caches),
  };
}

async function tryParseEncryptedTrajectory(
  file: string,
  _size: number,
): Promise<{
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
} | null> {
  try {
    const raw = await readFile(file);
    const plain = decryptCascadePb(raw);
    if (!plain) return null;
    const usage = extractCascadeUsage(plain);
    return {
      model: usage.model || "windsurf-cascade",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
    };
  } catch {
    return null;
  }
}

function coerceSqliteValue(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === "string") {
    const t = value.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try {
        return JSON.parse(t);
      } catch {
        return null;
      }
    }
    return null;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    try {
      const t = Buffer.from(value).toString("utf8").trim();
      if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
        return JSON.parse(t);
      }
    } catch {
      return null;
    }
  }
  if (typeof value === "object") return value;
  return null;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export const agent: AgentModule = {
  id: "windsurf",
  label: "Windsurf",
  roots() {
    const { home, appData, localApp, xdgConfig, xdgData, path } = pathEnv();
    return unique([
      path.join(home, ".codeium", "windsurf"),
      path.join(home, ".codeium"),
      path.join(home, ".windsurf"),
      path.join(appData, "Windsurf"),
      path.join(appData, "Windsurf", "User"),
      path.join(appData, "Windsurf", "User", "globalStorage"),
      path.join(appData, "Windsurf", "User", "workspaceStorage"),
      path.join(appData, "Windsurf - Insiders"),
      path.join(localApp, "Windsurf"),
      path.join(localApp, "Programs", "Windsurf"),
      // Linux XDG / portable
      path.join(xdgConfig, "Windsurf"),
      path.join(xdgData, "Windsurf"),
      path.join(xdgConfig, "Windsurf - Insiders"),
      // Extension host leftovers under VS Code family (Win/macOS/Linux)
      ...vscodeGlobalStorage("codeium.windsurf", "codeium.codeium"),
    ]);
  },
  parse: parseWindsurf,
};
