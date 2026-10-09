import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
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
/** Session file list from the last light walk. A new session folder changes the shape. */
const dshLightIndex = new Map<string, { shape: string; files: string[] }>();

function dshIndexKey(roots: string[]): string {
  return roots
    .map((root) => path.resolve(root).toLowerCase())
    .sort()
    .join("|");
}

/** Root mtime plus each project folder mtime. An append does not change this. */
async function dshTreeShape(roots: string[]): Promise<string> {
  const parts: string[] = [];
  for (const root of roots) {
    try {
      const st = await stat(root);
      parts.push(`r|${root}|${Math.floor(st.mtimeMs)}`);
      const entries = await readdir(root, { withFileTypes: true });
      const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
      parts.push(`n|${root}|${dirs.length}`);
      for (const name of dirs) {
        try {
          const child = await stat(path.join(root, name));
          parts.push(`d|${root}|${name}|${Math.floor(child.mtimeMs)}`);
        } catch {
          parts.push(`d|${root}|${name}|missing`);
        }
      }
    } catch {
      parts.push(`r|${root}|missing`);
    }
  }
  return parts.join("\n");
}

async function dshLightFiles(roots: string[], cutoff: number): Promise<string[]> {
  const key = dshIndexKey(roots);
  const shape = await dshTreeShape(roots);
  const cached = dshLightIndex.get(key);
  if (cached && cached.shape === shape) return cached.files;
  const files = await latestSessionFiles(roots, cutoff);
  dshLightIndex.set(key, { shape, files });
  return files;
}

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

/**
 * DSH sessions report prompt usage in two shapes:
 *
 *  A) cache-aware — `{ inputTokens, outputTokens, cacheReadTokens, totalTokens }`
 *     where `totalTokens = inputTokens + cacheReadTokens + outputTokens`.
 *  B) legacy — `{ inputTokens, outputTokens, totalTokens }` with no cache field,
 *     and the invariant `totalTokens = inputTokens + outputTokens`.
 *
 * Shape B is ~99.5% of recorded rows, so it produced `cacheReadTokens = 0` for
 * almost everything and the dashboard's CACHE $ column read "—".
 *
 * DSH does not record the split in shape B, but the cache-aware rows state the
 * rule outright: **the cache read equals the previous turn's whole prompt.**
 * Verified on 68 consecutive cache-aware turns, where
 * `cacheRead(n) ≈ inputTokens(n-1) + cacheReadTokens(n-1)`.
 *
 * The split below only decides how the SAME prompt total is displayed between
 * Input $ and Cache $. It deliberately does not change the money: this gateway
 * bills `cost = inputPer1M * prompt + outputPer1M * output` (7153/7153 billed
 * LiteLLM rows exact), i.e. a cache read costs the same as fresh input, and the
 * rate table sets `cacheReadPer1M === inputPer1M` so the two parts re-add to the
 * provider's total either way.
 */
function splitLegacyPromptUsage(
  promptTokens: number,
  previousPromptTokens: number | null,
): { inputTokens: number; cacheReadTokens: number } {
  const prompt = Math.max(0, promptTokens);
  if (previousPromptTokens == null || previousPromptTokens <= 0) {
    // First turn of a session: nothing to re-read from cache yet.
    return { inputTokens: prompt, cacheReadTokens: 0 };
  }
  // A cache read can never exceed the prompt the provider was given.
  const cacheReadTokens = Math.max(0, Math.min(Math.floor(previousPromptTokens), prompt));
  return { inputTokens: prompt - cacheReadTokens, cacheReadTokens };
}

async function parseSessionFile(
  file: string,
  decompress: ((buffer: Buffer) => Buffer) | undefined,
): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  let workspace: string | null = null;
  let currentModel: string | null = null;
  let lineNumber = 0;
  /**
   * Whole prompt (fresh + cache) of the previous assistant turn in this session.
   * Used to reconstruct the cache read for legacy rows — see splitLegacyPromptUsage.
   */
  let previousPromptTokens: number | null = null;

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

    // `compaction/summary` is a real model call too — it carries its own usage
    // and must be billed, otherwise every context compaction's tokens vanish.
    const isSummary = parsed.type === "compaction/summary";
    if (
      parsed.type !== "assistant/message" &&
      parsed.type !== "assistant/attempt" &&
      !isSummary
    ) {
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

    // Normalise both shapes into explicit fresh-input + cache-read buckets, then
    // remember this turn's whole prompt for the next one. Cache is priced at the
    // input rate, so splitting here preserves the provider's billed total.
    const reported = buckets.inputIncludesCache === true || buckets.cacheReadTokens > 0;
    const split: { inputTokens: number; cacheReadTokens: number } = reported
      ? { inputTokens: buckets.inputTokens, cacheReadTokens: buckets.cacheReadTokens }
      : splitLegacyPromptUsage(buckets.inputTokens, previousPromptTokens);
    previousPromptTokens = split.inputTokens + split.cacheReadTokens;

    events.push(
      applyPricing({
        id: stableId("dsh", file, String(parsed.seq ?? lineNumber)),
        agent: "dsh",
        model,
        timestamp: extractTimestamp(parsed, message),
        inputTokens: split.inputTokens,
        outputTokens: buckets.outputTokens,
        cacheReadTokens: split.cacheReadTokens,
        cacheWriteTokens: buckets.cacheWriteTokens,
        requestCount: 1,
        workspace,
        sourcePath: file,
        // A cache-aware row told us the number outright; a reconstructed legacy
        // row is a carried-forward estimate, so it must not claim to be measured.
        cacheReported: reported,
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
  const files = await dshLightFiles(roots, cutoff);
  const changed: Array<{ file: string; key: string; sig: string }> = [];
  for (const file of files) {
    let sig = "";
    try {
      const st = await stat(file);
      sig = `${st.size}`;
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
      let stored = item.sig;
      try {
        const after = await stat(item.file);
        stored = `${after.size}`;
      } catch {
        /* keep the signature taken before the read */
      }
      dshLightSig.set(item.key, stored);
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
