import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Transform } from "node:stream";
import * as zlib from "node:zlib";
import { applyPricing } from "../../pricing.js";
import type { UsageEvent } from "../../types.js";
import { pathEnv, unique } from "../shared/env.js";
import type { AgentModule } from "../shared/types.js";
import { extractModel, extractTimestamp, extractTokenBuckets } from "../shared/usage-fields.js";
import { stableId, walkFiles } from "../../util.js";

type ZstdModule = { createZstdDecompress?: () => Transform };
type DshEvent = Record<string, unknown> & {
  type?: unknown;
  seq?: unknown;
  time?: unknown;
  cwd?: unknown;
  data?: unknown;
};

const SESSION_FILE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/i;

function dshRoots(): string[] {
  const { home, expandHome, path: p } = pathEnv();
  const configuredHome = process.env.DSH_HOME?.trim();
  const dshHome = expandHome(configuredHome || p.join(home, ".dsh"));
  return unique([p.join(dshHome, "sessions")]);
}

async function latestSessionFiles(roots: string[]): Promise<string[]> {
  const latest = new Map<string, { file: string; version: number; raw: boolean }>();

  for (const root of roots) {
    const files = await walkFiles(root, {
      maxDepth: 12,
      match: (name) => SESSION_FILE.test(name),
    });

    for (const file of files) {
      const match = SESSION_FILE.exec(path.basename(file));
      if (!match) continue;

      const version = Number(match[1] ?? 0);
      const raw = !file.toLowerCase().endsWith(".zstd");
      const sessionDir = path.resolve(path.dirname(file));
      const previous = latest.get(sessionDir);
      if (
        !previous ||
        version > previous.version ||
        (version === previous.version && raw && !previous.raw)
      ) {
        latest.set(sessionDir, { file, version, raw });
      }
    }
  }

  return [...latest.values()].map(({ file }) => file);
}

async function parseSessionFile(
  file: string,
  createZstdDecompress: (() => Transform) | undefined,
): Promise<UsageEvent[]> {
  const compressed = file.toLowerCase().endsWith(".zstd");
  if (compressed && !createZstdDecompress) {
    throw new Error("Reading DSH .zstd sessions requires Node.js 22.15 or newer");
  }

  const fileStream = createReadStream(file);
  const input = compressed ? fileStream.pipe(createZstdDecompress!()) : fileStream;
  const lines = createInterface({ input, crlfDelay: Infinity });
  const events: UsageEvent[] = [];
  let workspace: string | null = null;
  let currentModel: string | null = null;
  let lineNumber = 0;

  try {
    for await (const line of lines) {
      lineNumber += 1;
      let parsed: DshEvent;
      try {
        parsed = JSON.parse(line) as DshEvent;
      } catch {
        continue;
      }

      if (parsed.type === "session") {
        workspace = typeof parsed.cwd === "string" ? parsed.cwd : workspace;
        continue;
      }

      const data =
        parsed.data && typeof parsed.data === "object"
          ? (parsed.data as Record<string, unknown>)
          : null;
      if (!data) continue;

      if (parsed.type === "request/context") {
        currentModel = extractModel(data) ?? currentModel;
        continue;
      }

      if (parsed.type !== "assistant/message" && parsed.type !== "assistant/attempt") {
        continue;
      }

      const message =
        data.message && typeof data.message === "object"
          ? (data.message as Record<string, unknown>)
          : null;
      const buckets = extractTokenBuckets(data.usage ?? message?.usage);
      if (!buckets) continue;

      const source =
        message?.source && typeof message.source === "object"
          ? (message.source as Record<string, unknown>)
          : null;
      const model = extractModel(source, data) ?? currentModel;
      if (model) currentModel = model;

      events.push(
        applyPricing({
          id: stableId("dsh", file, String(parsed.seq ?? lineNumber)),
          agent: "dsh",
          model,
          timestamp: extractTimestamp(parsed, message),
          ...buckets,
          requestCount: 1,
          workspace,
          sourcePath: file,
        }),
      );
    }
  } finally {
    lines.close();
    fileStream.destroy();
    if (input !== fileStream) input.destroy();
  }

  return events;
}

export async function parseDsh(roots: string[]): Promise<UsageEvent[]> {
  const files = await latestSessionFiles(roots);
  const zstd = (zlib as unknown as ZstdModule).createZstdDecompress;
  if (files.some((file) => file.toLowerCase().endsWith(".zstd")) && !zstd) {
    throw new Error("Reading DSH .zstd sessions requires Node.js 22.15 or newer");
  }

  const events: UsageEvent[] = [];
  for (const file of files) {
    try {
      events.push(...(await parseSessionFile(file, zstd)));
    } catch (error) {
      if (error instanceof Error && error.message.includes("requires Node.js")) {
        throw error;
      }
      // Ignore a damaged or partially written session and keep the other history.
    }
  }
  return events;
}

export const agent: AgentModule = {
  id: "dsh",
  label: "DeepSeek Harness CLI",
  roots: dshRoots,
  parse: parseDsh,
};
