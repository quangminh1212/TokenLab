import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import * as zlib from "node:zlib";
import { applyPricing } from "../../pricing.js";
import type { UsageEvent } from "../../types.js";
import { pathEnv, unique } from "../shared/env.js";
import type { AgentModule } from "../shared/types.js";
import { extractModel, extractTimestamp, extractTokenBuckets } from "../shared/usage-fields.js";
import { stableId, walkFiles } from "../../util.js";

type DshEvent = Record<string, unknown> & {
  type?: unknown;
  seq?: unknown;
  time?: unknown;
  cwd?: unknown;
  data?: unknown;
};

const SESSION_FILE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/i;
const ZSTD_MAGIC = 0xfd2fb528;
const LIGHT_HISTORY_MS = 30 * 24 * 60 * 60 * 1_000;
/** Unchanged session files are not decompressed again on the next minute tick. */
const dshLightSig = new Map<string, string>();

function dshSigKey(file: string): string {
  return process.platform === "win32" ? file.toLowerCase() : file;
}

interface ZstdFrameRange {
  start: number;
  end: number;
}

/** Find complete frames in DSH's concatenated-frame session format. */
function scanZstdFrames(buffer: Buffer): ZstdFrameRange[] {
  const frames: ZstdFrameRange[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`Invalid DSH Zstandard frame at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) break;

    const descriptor = buffer.readUInt8(offset++);
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`Invalid DSH Zstandard frame header at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const hasChecksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag;
    const frameHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < frameHeaderBytes) break;
    offset += frameHeaderBytes;

    let complete = false;
    while (!complete) {
      if (buffer.length - offset < 3) return frames;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const isLastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`Invalid DSH Zstandard block at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return frames;
      offset += payloadBytes;
      complete = isLastBlock;
    }

    if (hasChecksum) {
      if (buffer.length - offset < 4) return frames;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }

  return frames;
}

type ZstdApi = { zstdDecompressSync?: (buffer: Buffer) => Buffer };

async function* readSessionLines(
  file: string,
  decompress?: (buffer: Buffer) => Buffer,
): AsyncGenerator<string> {
  if (!file.toLowerCase().endsWith(".zstd")) {
    const fileStream = createReadStream(file);
    const lines = createInterface({ input: fileStream, crlfDelay: Infinity });
    try {
      for await (const line of lines) yield line;
    } finally {
      lines.close();
      fileStream.destroy();
    }
    return;
  }

  if (!decompress) {
    throw new Error("Reading DSH .zstd sessions requires Node.js 22.15 or newer");
  }

  const source = await readFile(file);
  let pending = "";
  for (const { start, end } of scanZstdFrames(source)) {
    pending += decompress(source.subarray(start, end)).toString("utf8");
    const completeLines = pending.split("\n");
    pending = completeLines.pop() ?? "";
    for (const line of completeLines) yield line.endsWith("\r") ? line.slice(0, -1) : line;
  }
  // A final non-newline-terminated fragment belongs to a torn append and is ignored.
}

function dshRoots(): string[] {
  const { home, expandHome, path: p } = pathEnv();
  const configuredHome = process.env.DSH_HOME?.trim();
  const dshHome = expandHome(configuredHome || p.join(home, ".dsh"));
  return unique([p.join(dshHome, "sessions")]);
}

async function latestSessionFiles(roots: string[], modifiedAfter?: number): Promise<string[]> {
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

  const files = [...latest.values()].map(({ file }) => file);
  if (modifiedAfter === undefined) return files;

  const recent = await Promise.all(
    files.map(async (file) => {
      try {
        return (await stat(file)).mtimeMs >= modifiedAfter ? file : null;
      } catch {
        return null;
      }
    }),
  );
  return recent.filter((file): file is string => file !== null);
}

async function parseSessionFile(
  file: string,
  decompress: ((buffer: Buffer) => Buffer) | undefined,
): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  let workspace: string | null = null;
  let currentModel: string | null = null;
  let lineNumber = 0;

  for await (const line of readSessionLines(file, decompress)) {
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

  return events;
}

async function parseDshFiles(roots: string[], modifiedAfter?: number): Promise<UsageEvent[]> {
  const files = await latestSessionFiles(roots, modifiedAfter);
  const decompress = (zlib as unknown as ZstdApi).zstdDecompressSync;
  if (files.some((file) => file.toLowerCase().endsWith(".zstd")) && !decompress) {
    throw new Error("Reading DSH .zstd sessions requires Node.js 22.15 or newer");
  }

  const events: UsageEvent[] = [];
  for (const file of files) {
    try {
      events.push(...(await parseSessionFile(file, decompress)));
    } catch (error) {
      if (error instanceof Error && error.message.includes("requires Node.js")) {
        throw error;
      }
      // Ignore a damaged or partially written session and keep the other history.
    }
  }
  return events;
}

export async function parseDsh(roots: string[]): Promise<UsageEvent[]> {
  return parseDshFiles(roots);
}

async function parseDshLight(roots: string[]): Promise<UsageEvent[]> {
  const cutoff = Date.now() - LIGHT_HISTORY_MS;
  const files = await latestSessionFiles(roots, cutoff);
  const changed: Array<{ file: string; key: string; sig: string }> = [];
  for (const file of files) {
    let sig = "";
    try {
      const st = await stat(file);
      sig = `${st.size}|${Math.trunc(st.mtimeMs)}`;
    } catch {
      continue;
    }
    const key = dshSigKey(file);
    if (dshLightSig.get(key) === sig) continue;
    changed.push({ file, key, sig });
  }
  if (changed.length === 0) return [];

  const decompress = (zlib as unknown as ZstdApi).zstdDecompressSync;
  if (changed.some((item) => item.file.toLowerCase().endsWith(".zstd")) && !decompress) {
    throw new Error("Reading DSH .zstd sessions requires Node.js 22.15 or newer");
  }

  const events: UsageEvent[] = [];
  for (const item of changed) {
    try {
      events.push(...(await parseSessionFile(item.file, decompress)));
      dshLightSig.set(item.key, item.sig);
    } catch (error) {
      if (error instanceof Error && error.message.includes("requires Node.js")) {
        throw error;
      }
    }
  }
  return events.filter((event) => Date.parse(event.timestamp) >= cutoff);
}

export const agent: AgentModule = {
  id: "dsh",
  label: "DeepSeek Harness",
  roots: dshRoots,
  parse: parseDsh,
  parseLight: parseDshLight,
};
