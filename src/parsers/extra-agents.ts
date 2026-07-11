import path from "node:path";
import type { UsageEvent } from "../types.js";
import { parseGenericJsonl } from "./generic-jsonl.js";

export async function parsePi(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "pi",
    match: (n, full) =>
      n.endsWith(".jsonl") ||
      (full.includes(`${path.sep}sessions${path.sep}`) && n.endsWith(".json")),
  });
}

export async function parseKimi(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "kimi",
    match: (n) => n === "wire.jsonl" || n.endsWith(".jsonl") || n.includes("usage"),
  });
}

export async function parseQwen(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "qwen",
    match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
  });
}

export async function parseDroid(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "droid",
    match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
  });
}

export async function parseAmp(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "amp",
    match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
  });
}

export async function parseGoose(roots: string[]): Promise<UsageEvent[]> {
  // Goose primarily uses SQLite; JSONL fallback if present
  return parseGenericJsonl(roots, {
    agent: "goose",
    match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
  });
}

export async function parseCline(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "cline",
    match: (n) =>
      n === "ui_messages.json" ||
      n.includes("api_req") ||
      n.endsWith(".jsonl") ||
      n.endsWith(".json"),
  });
}

export async function parseRooCode(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "roocode",
    match: (n) => n === "ui_messages.json" || n.endsWith(".jsonl") || n.endsWith(".json"),
  });
}

export async function parseKiloCode(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "kilocode",
    match: (n) => n.endsWith(".jsonl") || n.endsWith(".json") || n.endsWith(".db") === false,
  });
}

export async function parseAntigravity(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "antigravity",
    match: (n, full) =>
      n.endsWith(".json") ||
      n.endsWith(".jsonl") ||
      full.toLowerCase().includes("antigravity"),
  });
}

export async function parseCopilot(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "copilot",
    match: (n, full) =>
      n.endsWith(".jsonl") ||
      full.includes(`${path.sep}otel${path.sep}`) ||
      n.includes("usage") ||
      n.includes("transcript"),
  });
}

export async function parseWarp(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "warp",
    match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
  });
}

export async function parseTrae(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "trae",
    match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
  });
}

export async function parseZed(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "zed",
    match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
  });
}
