import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  decryptCascadePb,
  extractCascadeUsage,
  extractDominantModel,
  extractLabeledFloats,
} from "../src/agents/windsurf/index.js";

const KEY = Buffer.from("safeCodeiumworldKeYsecretBalloon", "utf8");

/** Build a minimal protobuf-ish blob with Token Usage labels + float values. */
function buildFakeTrajectory(): Buffer {
  const parts: Buffer[] = [];
  const pushLabelFloat = (label: string, value: number) => {
    parts.push(Buffer.from(label, "utf8"));
    const f = Buffer.alloc(5);
    f[0] = 0x15; // field 2, wire type 5 (fixed32)
    f.writeFloatLE(value, 1);
    parts.push(f);
  };
  parts.push(Buffer.from("model slug glm-5-2 appears often glm-5-2 glm-5-2 ", "utf8"));
  pushLabelFloat("Input tokens", 14231);
  pushLabelFloat("Output tokens", 1151);
  pushLabelFloat("Cached input tokens", 134023);
  pushLabelFloat("Input tokens", 1000);
  pushLabelFloat("Output tokens", 200);
  pushLabelFloat("Cached input tokens", 500);
  return Buffer.concat(parts);
}

function encryptCascade(plaintext: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, body, tag]);
}

test("decryptCascadePb unwraps AES-256-GCM cascade layout", () => {
  const plain = Buffer.from("hello cascade trajectory");
  const ct = encryptCascade(plain);
  const out = decryptCascadePb(ct);
  assert.ok(out);
  assert.equal(out!.toString("utf8"), "hello cascade trajectory");
});

test("decryptCascadePb rejects garbage", () => {
  assert.equal(decryptCascadePb(Buffer.alloc(40, 7)), null);
  assert.equal(decryptCascadePb(Buffer.alloc(10)), null);
});

test("extractLabeledFloats reads Input/Output/Cached after 0x15 tag", () => {
  const plain = buildFakeTrajectory();
  assert.deepEqual(
    extractLabeledFloats(plain, "Input tokens").map((n) => Math.round(n)),
    [14231, 1000],
  );
  assert.deepEqual(
    extractLabeledFloats(plain, "Output tokens").map((n) => Math.round(n)),
    [1151, 200],
  );
  assert.deepEqual(
    extractLabeledFloats(plain, "Cached input tokens").map((n) => Math.round(n)),
    [134023, 500],
  );
});

test("extractDominantModel picks most frequent slug", () => {
  const plain = buildFakeTrajectory();
  assert.equal(extractDominantModel(plain), "glm-5-2");
});

test("extractCascadeUsage sums metrics and model", () => {
  const plain = buildFakeTrajectory();
  const u = extractCascadeUsage(plain);
  assert.equal(u.model, "glm-5-2");
  assert.equal(u.inputTokens, 15231);
  assert.equal(u.outputTokens, 1351);
  assert.equal(u.cacheReadTokens, 134523);
});

test("round-trip encrypt → decrypt → extractCascadeUsage", () => {
  const plain = buildFakeTrajectory();
  const ct = encryptCascade(plain);
  const dec = decryptCascadePb(ct);
  assert.ok(dec);
  const u = extractCascadeUsage(dec!);
  assert.equal(u.model, "glm-5-2");
  assert.equal(u.inputTokens, 15231);
  assert.equal(u.cacheReadTokens, 134523);
});

test("parseWindsurf counts both cascade and independent implicit sessions", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { parseWindsurf } = await import("../src/agents/windsurf/index.js");

  const root = await mkdtemp(path.join(tmpdir(), "xlab-ws-"));
  try {
    const cascadeDir = path.join(root, "cascade");
    const implicitDir = path.join(root, "implicit");
    await mkdir(cascadeDir, { recursive: true });
    await mkdir(implicitDir, { recursive: true });

    // Build trajectory + pad so encrypted size clears the 512-byte cascade floor
    const buildPlain = (model: string, input: number, output: number, cache: number) => {
      const parts: Buffer[] = [];
      const push = (label: string, v: number) => {
        parts.push(Buffer.from(label, "utf8"));
        const f = Buffer.alloc(5);
        f[0] = 0x15;
        f.writeFloatLE(v, 1);
        parts.push(f);
      };
      parts.push(Buffer.from(`model ${model} ${model} ${model} `, "utf8"));
      push("Input tokens", input);
      push("Output tokens", output);
      push("Cached input tokens", cache);
      parts.push(Buffer.alloc(600, 0x61)); // pad
      return Buffer.concat(parts);
    };
    // Cascade session A
    const plainA = buildPlain("glm-5-2", 1000, 100, 500);
    // Implicit session B (different UUID) — must not be dropped when cascade decrypts
    const plainB = buildPlain("kimi-k2-7", 2000, 200, 800);

    await writeFile(path.join(cascadeDir, "sess-a.pb"), encryptCascade(plainA));
    await writeFile(path.join(implicitDir, "sess-b.pb"), encryptCascade(plainB));

    const events = await parseWindsurf([root]);
    assert.equal(events.length, 2);
    const cascade = events.find((e) => e.sourcePath.includes("cascade"));
    const implicit = events.find((e) => e.sourcePath.includes("implicit"));
    assert.ok(cascade);
    assert.ok(implicit);
    assert.equal(cascade!.inputTokens, 1000);
    assert.equal(implicit!.inputTokens, 2000);
    assert.equal(implicit!.model, "kimi-k2-7");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
