import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentId } from "../src/types.js";
import { AGENTS, scanAll } from "../src/agents/index.js";

test("periodic light scans pick up newly written Hermes usage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tokenlab-periodic-hermes-"));
  const hermesRoot = path.join(root, "hermes");
  const sessions = path.join(hermesRoot, "sessions");
  const file = path.join(sessions, "session.jsonl");
  const envKeys = [
    "HERMES_HOME",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
  ];
  const oldEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

  try {
    await mkdir(sessions, { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify({
        timestamp: "2026-10-03T00:30:00.000Z",
        model: "test-model",
        input_tokens: 7,
        output_tokens: 3,
      })}\n`,
    );

    process.env.HERMES_HOME = hermesRoot;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    process.env.LOCALAPPDATA = path.join(root, "local");
    process.env.APPDATA = path.join(root, "roaming");
    process.env.XDG_DATA_HOME = path.join(root, "share");
    process.env.XDG_CONFIG_HOME = path.join(root, "config");

    const http = (await import("../src/server/http.js")) as typeof import("../src/server/http.js") & {
      periodicLightScanEnabled?: () => Partial<Record<AgentId, boolean>>;
    };
    const disabledAgents = Object.fromEntries(
      AGENTS.map(({ id }) => [id, false]),
    ) as Partial<Record<AgentId, boolean>>;
    const enabled = http.periodicLightScanEnabled?.() ?? disabledAgents;
    const events = await scanAll({
      enabled,
      light: true,
      concurrency: 2,
      timeoutMs: 5_000,
    });

    const hermesEvent = events.find(
      (event) => event.agent === "hermes" && event.sourcePath === file,
    );
    assert.deepEqual(
      hermesEvent && {
        agent: hermesEvent.agent,
        model: hermesEvent.model,
        inputTokens: hermesEvent.inputTokens,
        outputTokens: hermesEvent.outputTokens,
        totalTokens: hermesEvent.totalTokens,
      },
      {
        agent: "hermes",
        model: "test-model",
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
      },
    );
  } finally {
    for (const [key, value] of oldEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
