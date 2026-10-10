import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentId, UsageEvent } from "../src/types.js";
import { AGENTS, scanAll } from "../src/agents/index.js";
import { parseCodexLight } from "../src/agents/codex/index.js";
import { agent as dshAgent } from "../src/agents/dsh/index.js";
import { parseRouterUsageLight } from "../src/agents/shared/router-light.js";
import { applyPeriodicLightDelta } from "../src/server/http.js";

function lightEvent(partial: Pick<UsageEvent, "id" | "agent" | "timestamp" | "sourcePath"> & Partial<UsageEvent>): UsageEvent {
  const inputTokens = partial.inputTokens ?? 1;
  const outputTokens = partial.outputTokens ?? 1;
  return {
    model: "m",
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: inputTokens + outputTokens,
    estimatedCost: 0,
    currency: "USD",
    pricingStatus: "priced",
    workspace: null,
    ...partial,
  };
}

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

test("periodic light scan skips unchanged Hermes files and keeps the first read", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tokenlab-periodic-hermes-skip-"));
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
        timestamp: "2026-10-03T01:00:00.000Z",
        model: "test-model",
        input_tokens: 11,
        output_tokens: 4,
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
    const enabled = http.periodicLightScanEnabled?.();
    const first = await scanAll({ enabled, light: true, concurrency: 1, timeoutMs: 5_000 });
    const second = await scanAll({ enabled, light: true, concurrency: 1, timeoutMs: 5_000 });
    const picked = first.find((event) => event.agent === "hermes" && event.sourcePath === file);
    assert.equal(picked?.inputTokens, 11);
    assert.equal(picked?.outputTokens, 4);
    assert.equal(
      second.filter((event) => event.agent === "hermes").length,
      0,
    );
    await writeFile(
      file,
      `${JSON.stringify({
        timestamp: "2026-10-03T01:00:00.000Z",
        model: "test-model",
        input_tokens: 11,
        output_tokens: 4,
      })}\n${JSON.stringify({
        timestamp: "2026-10-03T02:00:00.000Z",
        model: "test-model",
        input_tokens: 6,
        output_tokens: 1,
      })}\n`,
    );
    const third = await scanAll({ enabled, light: true, concurrency: 1, timeoutMs: 5_000 });
    assert.deepEqual(
      third
        .filter((event) => event.agent === "hermes" && event.sourcePath === file)
        .map((event) => event.inputTokens)
        .sort((a, b) => a - b),
      [6, 11],
    );
  } finally {
    for (const [key, value] of oldEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("light delta replaces only the Codex file that was reread", () => {
  const prev = [
    lightEvent({ id: "b", agent: "codex", timestamp: "2026-10-08T00:00:01.000Z", sourcePath: "C:\\sessions\\b.jsonl", inputTokens: 2, outputTokens: 2 }),
    lightEvent({ id: "a-old", agent: "codex", timestamp: "2026-10-08T00:00:02.000Z", sourcePath: "C:\\sessions\\a.jsonl", inputTokens: 3, outputTokens: 1 }),
    lightEvent({ id: "h", agent: "hermes", timestamp: "2026-10-08T00:00:03.000Z", sourcePath: "C:\\hermes\\s.jsonl", inputTokens: 4, outputTokens: 4 }),
  ];
  const fresh = new Map<string, UsageEvent[]>([
    ["codex", [
      lightEvent({ id: "a-mid", agent: "codex", timestamp: "2026-10-08T00:00:01.500Z", sourcePath: "C:/sessions/a.jsonl ← mirror", inputTokens: 5, outputTokens: 5 }),
      lightEvent({ id: "a-new", agent: "codex", timestamp: "2026-10-08T00:00:04.000Z", sourcePath: "C:/sessions/a.jsonl", inputTokens: 6, outputTokens: 1 }),
    ]],
  ]);
  const applied = applyPeriodicLightDelta(prev, null, fresh);
  assert.deepEqual(applied.events.map((event) => event.id), ["b", "a-mid", "h", "a-new"]);
  assert.equal(applied.timestampsMs.length, applied.events.length);
  assert.equal(applied.events[1]?.inputTokens, 5);
});

test("light delta keeps a richer Codex row that lives outside the reread file", () => {
  const prev = [
    lightEvent({ id: "same", agent: "codex", timestamp: "2026-10-08T00:00:01.000Z", sourcePath: "C:\\other\\keep.jsonl", inputTokens: 50, outputTokens: 50 }),
  ];
  const fresh = new Map<string, UsageEvent[]>([
    ["codex", [
      lightEvent({ id: "same", agent: "codex", timestamp: "2026-10-08T00:00:02.000Z", sourcePath: "C:\\sessions\\hot.jsonl", inputTokens: 1, outputTokens: 1 }),
    ]],
  ]);
  const applied = applyPeriodicLightDelta(prev, [Date.parse(prev[0]!.timestamp)], fresh);
  assert.equal(applied.events.length, 1);
  assert.equal(applied.events[0]?.inputTokens, 50);
  assert.equal(applied.events[0]?.sourcePath, "C:\\other\\keep.jsonl");
});

test("light delta keeps router history and prefers the richer same id", () => {
  const prev = [
    lightEvent({ id: "old", agent: "9router", timestamp: "2026-10-07T00:00:01.000Z", sourcePath: "db", inputTokens: 2, outputTokens: 2 }),
    lightEvent({ id: "same", agent: "9router", timestamp: "2026-10-08T00:00:01.000Z", sourcePath: "db", inputTokens: 1, outputTokens: 1 }),
    lightEvent({ id: "codex-stay", agent: "codex", timestamp: "2026-10-08T00:00:03.000Z", sourcePath: "rollout.jsonl", inputTokens: 9, outputTokens: 9 }),
  ];
  const fresh = new Map<string, UsageEvent[]>([
    ["9router", [
      lightEvent({ id: "same", agent: "9router", timestamp: "2026-10-08T00:00:01.000Z", sourcePath: "db", inputTokens: 8, outputTokens: 8 }),
      lightEvent({ id: "new", agent: "9router", timestamp: "2026-10-08T00:00:02.000Z", sourcePath: "db", inputTokens: 3, outputTokens: 3 }),
    ]],
  ]);
  const applied = applyPeriodicLightDelta(prev, null, fresh);
  assert.deepEqual(applied.events.map((event) => event.id), ["old", "same", "new", "codex-stay"]);
  assert.equal(applied.events.find((event) => event.id === "same")?.inputTokens, 8);
});

test("light delta upgrades an unchanged cache row to the measured variant", () => {
  const prev = [
    lightEvent({
      id: "same-cache",
      agent: "9router",
      timestamp: "2026-10-08T00:00:01.000Z",
      sourcePath: "db",
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 900,
    }),
  ];
  const fresh = new Map<string, UsageEvent[]>([
    [
      "9router",
      [
        lightEvent({
          id: "same-cache",
          agent: "9router",
          timestamp: "2026-10-08T00:00:01.000Z",
          sourcePath: "db",
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 900,
          cacheReported: true,
        }),
      ],
    ],
  ]);
  const applied = applyPeriodicLightDelta(prev, null, fresh);
  assert.equal(applied.events[0]?.cacheReported, true);
});

test("light delta drops a same-machine gist rollup covered by the fresh row", () => {
  const prev = [
    lightEvent({
      id: "gist",
      agent: "codex",
      timestamp: "2026-10-08T00:00:01.000Z",
      sourcePath: "backup:gist-daily",
      model: "m",
      inputTokens: 100,
      outputTokens: 0,
    }),
    lightEvent({
      id: "foreign",
      agent: "codex",
      timestamp: "2026-10-08T00:00:01.000Z",
      sourcePath: "backup:gist-daily:other-host",
      model: "m",
      inputTokens: 40,
      outputTokens: 0,
    }),
  ];
  const fresh = new Map<string, UsageEvent[]>([
    ["codex", [
      lightEvent({ id: "live", agent: "codex", timestamp: "2026-10-08T00:00:02.000Z", sourcePath: "C:\\sessions\\a.jsonl", model: "m", inputTokens: 4, outputTokens: 1 }),
    ]],
  ]);
  const applied = applyPeriodicLightDelta(prev, null, fresh);
  assert.deepEqual(applied.events.map((event) => event.id), ["foreign", "live"]);
});

test("light delta applies a large Codex cache without collapsing it", () => {
  const prev: UsageEvent[] = [];
  const prevTs: number[] = [];
  for (let i = 0; i < 40_000; i += 1) {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    prev.push(lightEvent({
      id: `c${i}`,
      agent: "codex",
      timestamp,
      sourcePath: `C:\\sessions\\file-${i % 100}.jsonl`,
      inputTokens: 1,
      outputTokens: 1,
    }));
    prevTs.push(Date.parse(timestamp));
  }
  const freshRows: UsageEvent[] = [];
  for (let i = 0; i < 10; i += 1) {
    freshRows.push(lightEvent({
      id: `fresh${i}`,
      agent: "codex",
      timestamp: new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString(),
      sourcePath: "C:\\sessions\\file-0.jsonl",
      inputTokens: 2,
      outputTokens: 2,
    }));
  }
  const started = Date.now();
  const applied = applyPeriodicLightDelta(prev, prevTs, new Map([["codex", freshRows]]));
  const elapsed = Date.now() - started;
  assert.equal(applied.events.length, 40_000 - 400 + 10);
  assert.equal(applied.events.some((event) => event.id === "c1"), true);
  assert.equal(applied.events.some((event) => event.id === "c0"), false);
  assert.equal(applied.events.at(-1)?.id, "fresh9");
  assert.ok(elapsed < 2_500, `delta took ${elapsed}ms`);
});

test("dsh light scan reads a changed session once and skips the next identical pass", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tokenlab-dsh-light-"));
  const sessionDir = path.join(root, "sessions", "s1");
  const file = path.join(sessionDir, "session.jsonl");
  const oldHome = process.env.DSH_HOME;
  const line = (seq: number, input: number): string =>
    JSON.stringify({
      type: "assistant/message",
      seq,
      time: "2026-10-08T00:00:00.000Z",
      data: { usage: { input_tokens: input, output_tokens: 2 } },
    });
  try {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(file, `${line(1, 3)}\n`);
    process.env.DSH_HOME = root;
    const roots = dshAgent.roots();
    const first = await dshAgent.parseLight!(roots);
    const second = await dshAgent.parseLight!(roots);
    assert.equal(first.length, 1);
    assert.equal(first[0]?.inputTokens, 3);
    assert.equal(second.length, 0);
    await writeFile(file, `${line(1, 3)}\n${line(2, 9)}\n`);
    const third = await dshAgent.parseLight!(roots);
    // Turn 1 is fresh input (nothing cached yet). Turn 2's prompt of 9 re-reads
    // turn 1's prompt of 3 from cache, so only the 6-token growth is fresh input.
    // Asserting [3, 9] fed the cache back in as input and left cacheReadTokens at
    // 0, which is what made the dashboard show "—" under CACHE $.
    assert.deepEqual(
      third.map((event) => event.inputTokens).sort((a, b) => a - b),
      [3, 6],
    );
    assert.deepEqual(
      third.map((event) => event.cacheReadTokens ?? 0).sort((a, b) => a - b),
      [0, 3],
    );
    const sessionDir2 = path.join(root, "sessions", "s2");
    await mkdir(sessionDir2, { recursive: true });
    await writeFile(path.join(sessionDir2, "session.jsonl"), `${line(1, 4)}\n`);
    const fourth = await dshAgent.parseLight!(roots);
    // A brand-new session has nothing to re-read, so its first turn is all input.
    assert.deepEqual(fourth.map((event) => event.inputTokens), [4]);
    assert.deepEqual(fourth.map((event) => event.cacheReadTokens ?? 0), [0]);
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("codex light scan does not walk an old session tree again", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tokenlab-codex-light-"));
  const now = new Date();
  const day = path.join(
    root,
    "sessions",
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  );
  const oldDir = path.join(root, "sessions", "2020", "01", "01");
  const record = (input: number, stamp: string): string =>
    JSON.stringify({
      timestamp: stamp,
      type: "token_usage_record",
      payload: { type: "token_usage_record", usage: { input_tokens: input, output_tokens: 2 } },
    });
  try {
    await mkdir(day, { recursive: true });
    await mkdir(oldDir, { recursive: true });
    const current = path.join(day, "rollout-2026-10-08T10-00-00-current.jsonl");
    await writeFile(current, `${record(5, "2026-10-08T10:00:00.000Z")}\n`);
    for (const name of ["11-00-00-b", "12-00-00-c", "13-00-00-d"]) {
      await writeFile(path.join(day, `rollout-2026-10-08T${name}.jsonl`), "");
    }
    const oldFile = path.join(oldDir, "rollout-2020-01-01T00-00-00-old.jsonl");
    await writeFile(oldFile, `${record(99, "2020-01-01T00:00:00.000Z")}\n`);
    const oldTime = new Date("2020-01-01T00:00:00.000Z");
    await utimes(oldFile, oldTime, oldTime);

    const first = await parseCodexLight([root]);
    assert.deepEqual(first.map((event) => event.inputTokens), [5]);

    await writeFile(oldFile, `${record(99, "2026-10-08T12:00:00.000Z")}\n`);
    const second = await parseCodexLight([root]);
    assert.equal(second.length, 0);

    await writeFile(
      current,
      `${record(5, "2026-10-08T10:00:00.000Z")}\n${record(8, "2026-10-08T10:00:02.000Z")}\n`,
    );
    const third = await parseCodexLight([root]);
    assert.deepEqual(third.map((event) => event.inputTokens).sort((a, b) => a - b), [5, 8]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("router light scan reads a usage file once until it changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tokenlab-router-light-"));
  const usage = path.join(root, "usage.json");
  const body = (input: number): string =>
    JSON.stringify({
      history: [{
        timestamp: "2026-10-08T00:00:00.000Z",
        model: "test-model",
        input_tokens: input,
        output_tokens: 2,
      }],
    });
  try {
    await writeFile(usage, body(3));
    const first = await parseRouterUsageLight([root], "9router");
    const second = await parseRouterUsageLight([root], "9router");
    assert.equal(first.length, 1);
    assert.equal(first[0]?.inputTokens, 3);
    assert.equal(second.length, 0);
    await writeFile(usage, body(30));
    const third = await parseRouterUsageLight([root], "9router");
    assert.equal(third.length, 1);
    assert.equal(third[0]?.inputTokens, 30);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
