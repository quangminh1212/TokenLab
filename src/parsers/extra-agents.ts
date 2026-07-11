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

export async function parseCodebuff(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "codebuff",
    match: (n) => n.endsWith(".jsonl") || n.endsWith(".json") || n.includes("usage"),
  });
}

export async function parseMux(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "mux",
    match: (n, full) =>
      n.endsWith(".jsonl") ||
      n.endsWith(".json") ||
      full.includes(`${path.sep}sessions${path.sep}`),
  });
}

export async function parseCrush(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "crush",
    match: (n) => n.endsWith(".jsonl") || n.endsWith(".json") || n === "projects.json",
  });
}

export async function parseKiro(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "kiro",
    match: (n, full) =>
      n.endsWith(".jsonl") ||
      n.endsWith(".json") ||
      full.toLowerCase().includes("kiro") ||
      full.includes(`${path.sep}sessions${path.sep}`),
  });
}

export async function parseGjc(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "gjc",
    match: (n, full) =>
      n.endsWith(".jsonl") ||
      n.endsWith(".json") ||
      full.includes(`${path.sep}sessions${path.sep}`),
  });
}

export async function parseJcode(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "jcode",
    match: (n) =>
      n.startsWith("session_") ||
      n.endsWith(".jsonl") ||
      n.endsWith(".json") ||
      n.includes("journal"),
  });
}

export async function parseCommandCode(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "commandcode",
    match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
  });
}

export async function parseJunie(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "junie",
    match: (n) =>
      n === "events.jsonl" || n.endsWith(".jsonl") || n.endsWith(".json") || n.includes("usage"),
  });
}

export async function parseZcode(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "zcode",
    match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
  });
}

export async function parseOpenCodeReview(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "opencodereview",
    match: (n) => n.endsWith(".jsonl") || n.endsWith(".json"),
  });
}

export async function parseCodeBuddy(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "codebuddy",
    match: (n) => n.endsWith(".jsonl") || n.endsWith(".json") || n.includes("usage"),
  });
}

export async function parseWorkBuddy(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "workbuddy",
    match: (n) => n.endsWith(".jsonl") || n.endsWith(".json") || n.includes("usage"),
  });
}

export async function parseAider(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "aider",
    match: (n) =>
      n.endsWith(".jsonl") ||
      n.endsWith(".json") ||
      n.includes("usage") ||
      n.includes("analytics") ||
      n.includes("history"),
  });
}

export async function parseContinue(roots: string[]): Promise<UsageEvent[]> {
  return parseGenericJsonl(roots, {
    agent: "continue",
    match: (n, full) =>
      n.endsWith(".jsonl") ||
      n.endsWith(".json") ||
      full.includes(`${path.sep}sessions${path.sep}`) ||
      full.includes(`${path.sep}dev_data${path.sep}`) ||
      n.includes("usage") ||
      n.includes("token"),
  });
}
