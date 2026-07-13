/**
 * Download official brand favicons/logos for agent + provider icons that look
 * synthetic or weak, convert to 128px PNG, install under assets.
 *
 * Usage: node scripts/audit-official-icons.mjs
 */
import sharp from "sharp";
import { copyFile, mkdir, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentsDir = path.join(root, "src", "server", "assets", "agents");
const providersDir = path.join(root, "src", "server", "assets", "providers");
const work = path.join(root, ".tmp-icons", "official-audit");
const report = [];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function curl(url, out) {
  try {
    execFileSync("curl.exe", ["-sL", "--max-time", "25", "-A", "Mozilla/5.0", "-o", out, url], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function fileKind(buf) {
  if (!buf || buf.length < 8) return "empty";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return "ico";
  if (buf.slice(0, 4).toString() === "RIFF") return "webp";
  if (buf.slice(0, 5).toString() === "<?xml" || buf.slice(0, 4).toString() === "<svg") return "svg";
  if (buf.slice(0, 9).toString() === "<!DOCTYPE" || buf.slice(0, 5).toString() === "<html") return "html";
  return "bin";
}

async function toPng128(src, dest) {
  const buf = await readFile(src);
  const kind = fileKind(buf);
  if (kind === "html" || kind === "empty") throw new Error(`bad kind ${kind}`);
  // Extract embedded PNG from ICO if needed
  if (kind === "ico") {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const idx = buf.indexOf(sig);
    if (idx >= 0) {
      const iend = buf.indexOf(Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]), idx);
      if (iend > idx) {
        const png = buf.subarray(idx, iend + 8);
        await sharp(png)
          .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png()
          .toFile(dest);
        return;
      }
    }
  }
  await sharp(buf)
    .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(dest);
}

/** Agent id -> candidate official URLs (first good wins) */
const AGENT_URLS = {
  // Known good already but re-verify from official
  windsurf: [
    "https://windsurf.com/favicon.ico",
    "https://www.google.com/s2/favicons?domain=windsurf.com&sz=128",
  ],
  cursor: ["https://www.google.com/s2/favicons?domain=cursor.com&sz=128", "https://cursor.com/favicon.ico"],
  codex: [
    // OpenAI blossom (already have providers/openai.png)
  ],
  // Synthetic / weak ones to replace
  trae: [
    "https://www.google.com/s2/favicons?domain=trae.ai&sz=128",
    "https://www.trae.ai/favicon.ico",
    "https://trae.ai/favicon.ico",
  ],
  droid: [
    "https://www.google.com/s2/favicons?domain=factory.ai&sz=128",
    "https://factory.ai/favicon.ico",
    "https://www.factory.ai/favicon.ico",
  ],
  codebuff: [
    "https://www.google.com/s2/favicons?domain=codebuff.com&sz=128",
    "https://codebuff.com/favicon.ico",
  ],
  mux: [
    // Mux coding agent vs mux.com video - try coding-related first
    "https://www.google.com/s2/favicons?domain=mux.com&sz=128",
    "https://www.mux.com/favicon.ico",
  ],
  gjc: [
    "https://www.google.com/s2/favicons?domain=gajae.com&sz=128",
  ],
  forge: [
    "https://www.google.com/s2/favicons?domain=forgecode.dev&sz=128",
    "https://forgecode.dev/favicon.ico",
  ],
  opencodereview: [
    "https://www.google.com/s2/favicons?domain=alibaba.github.io&sz=128",
    "https://www.google.com/s2/favicons?domain=alibaba.com&sz=128",
  ],
  commandcode: [
    "https://www.google.com/s2/favicons?domain=commandcode.ai&sz=128",
  ],
  junie: [
    "https://www.google.com/s2/favicons?domain=jetbrains.com&sz=128",
    "https://www.jetbrains.com/favicon.ico",
  ],
  void: [
    "https://www.google.com/s2/favicons?domain=voideditor.com&sz=128",
    "https://voideditor.com/favicon.ico",
  ],
  continue: [
    "https://www.google.com/s2/favicons?domain=continue.dev&sz=128",
    "https://continue.dev/favicon.ico",
  ],
  amp: [
    "https://www.google.com/s2/favicons?domain=ampcode.com&sz=128",
    "https://www.google.com/s2/favicons?domain=sourcegraph.com&sz=128",
  ],
  crush: [
    "https://www.google.com/s2/favicons?domain=crush.dev&sz=128",
  ],
  kilocode: [
    "https://www.google.com/s2/favicons?domain=kilo.ai&sz=128",
    "https://kilo.ai/favicon.ico",
  ],
  roocode: [
    "https://www.google.com/s2/favicons?domain=roocode.com&sz=128",
    "https://www.google.com/s2/favicons?domain=roo.code&sz=128",
  ],
  antigravity: [
    "https://www.google.com/s2/favicons?domain=antigravity.dev&sz=128",
  ],
  warp: [
    "https://www.google.com/s2/favicons?domain=warp.dev&sz=128",
    "https://www.warp.dev/favicon.ico",
  ],
  zed: [
    "https://www.google.com/s2/favicons?domain=zed.dev&sz=128",
    "https://zed.dev/favicon.ico",
  ],
  blackbox: [
    "https://www.google.com/s2/favicons?domain=blackbox.ai&sz=128",
    "https://www.blackbox.ai/favicon.ico",
  ],
  ollama: [
    "https://www.google.com/s2/favicons?domain=ollama.com&sz=128",
    "https://ollama.com/public/ollama.png",
  ],
  cline: [
    "https://www.google.com/s2/favicons?domain=cline.bot&sz=128",
    "https://cline.bot/favicon.ico",
  ],
  devin: [
    "https://www.google.com/s2/favicons?domain=devin.ai&sz=128",
    "https://devin.ai/favicon.ico",
  ],
  "amazon-q": [
    "https://www.google.com/s2/favicons?domain=aws.amazon.com&sz=128",
  ],
  kiro: [
    "https://www.google.com/s2/favicons?domain=kiro.dev&sz=128",
  ],
  iflow: [
    "https://www.google.com/s2/favicons?domain=iflow.cn&sz=128",
  ],
  qoder: [
    "https://www.google.com/s2/favicons?domain=qoder.com&sz=128",
  ],
  mimocode: [
    "https://www.google.com/s2/favicons?domain=xiaomi.com&sz=128",
  ],
  codewhale: [
    "https://www.google.com/s2/favicons?domain=codewhale.ai&sz=128",
  ],
  codebuddy: [
    "https://www.google.com/s2/favicons?domain=tencent.com&sz=128",
  ],
  workbuddy: [
    "https://www.google.com/s2/favicons?domain=tencent.com&sz=128",
  ],
  zcode: [
    "https://www.google.com/s2/favicons?domain=z.ai&sz=128",
    "https://www.google.com/s2/favicons?domain=zcode.z.ai&sz=128",
  ],
  opencode: [
    "https://www.google.com/s2/favicons?domain=opencode.ai&sz=128",
    "https://opencode.ai/favicon.ico",
  ],
  openclaw: [
    // keep lobster if already good; try official
    "https://www.google.com/s2/favicons?domain=openclaw.ai&sz=128",
  ],
  hermes: [
    "https://www.google.com/s2/favicons?domain=nousresearch.com&sz=128",
  ],
  copilot: [
    "https://www.google.com/s2/favicons?domain=github.com&sz=128",
    "https://github.githubassets.com/favicons/favicon.svg",
  ],
  gemini: [
    "https://www.google.com/s2/favicons?domain=gemini.google.com&sz=128",
  ],
  qwen: [
    "https://www.google.com/s2/favicons?domain=qwen.ai&sz=128",
  ],
  kimi: [
    "https://www.google.com/s2/favicons?domain=kimi.moonshot.cn&sz=128",
    "https://www.google.com/s2/favicons?domain=moonshot.cn&sz=128",
  ],
  grok: [
    "https://www.google.com/s2/favicons?domain=x.ai&sz=128",
  ],
  "claude-code": [
    "https://www.google.com/s2/favicons?domain=claude.ai&sz=128",
    "https://www.google.com/s2/favicons?domain=anthropic.com&sz=128",
  ],
  goose: [
    "https://raw.githubusercontent.com/block/goose/main/ui/desktop/src/images/icon.png",
  ],
  aider: [
    "https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/assets/logo.svg",
  ],
  pi: [
    "https://pi.dev/favicon.svg",
  ],
  jcode: [
    // keep official ICNS extract if present; no re-download needed if large
  ],
};

async function main() {
  await mkdir(work, { recursive: true });
  const results = [];

  for (const [id, urls] of Object.entries(AGENT_URLS)) {
    if (!urls.length) {
      results.push({ id, status: "skip-manual" });
      continue;
    }
    let ok = false;
    for (let i = 0; i < urls.length; i++) {
      const rawPath = path.join(work, `${id}-${i}.bin`);
      if (!curl(urls[i], rawPath)) continue;
      try {
        const buf = await readFile(rawPath);
        const kind = fileKind(buf);
        if (kind === "html" || kind === "empty" || buf.length < 200) continue;
        // Reject generic google globe (~33k identical) — check size pattern
        const out = path.join(work, `${id}.png`);
        await toPng128(rawPath, out);
        const meta = await sharp(out).metadata();
        if (!meta.width || meta.width < 16) continue;
        // Install as agent icon
        const dest = path.join(agentsDir, `${id}.png`);
        await copyFile(out, dest);
        // If provider shares same name, update provider too when present in map
        results.push({ id, status: "ok", bytes: (await readFile(out)).length, from: urls[i] });
        ok = true;
        break;
      } catch (e) {
        // try next
      }
    }
    if (!ok) results.push({ id, status: "fail" });
  }

  // Special: codex/openai from providers/openai.png (official)
  if (await exists(path.join(providersDir, "openai.png"))) {
    await sharp(path.join(providersDir, "openai.png"))
      .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(path.join(agentsDir, "codex.png"));
    results.push({ id: "codex", status: "ok", from: "providers/openai.png" });
  }

  // Special: zcode from glm.png (Z.ai Z mark)
  if (await exists(path.join(providersDir, "glm.png"))) {
    await sharp(path.join(providersDir, "glm.png"))
      .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(path.join(agentsDir, "zcode.png"));
    results.push({ id: "zcode", status: "ok", from: "providers/glm.png" });
  }

  // Special: windsurf official ico already good
  if (await exists(path.join(agentsDir, "windsurf.ico"))) {
    try {
      await toPng128(path.join(agentsDir, "windsurf.ico"), path.join(providersDir, "windsurf.png"));
      await toPng128(path.join(agentsDir, "windsurf.ico"), path.join(agentsDir, "windsurf.png"));
      results.push({ id: "windsurf", status: "ok", from: "agents/windsurf.ico" });
    } catch (e) {
      results.push({ id: "windsurf", status: "fail", err: String(e.message || e) });
    }
  }

  // Special: jcode keep ICNS extract if already large official
  const jcode = path.join(agentsDir, "jcode.png");
  if (await exists(jcode)) {
    const st = (await readFile(jcode)).length;
    if (st > 5000) results.push({ id: "jcode", status: "keep-official", bytes: st });
  }

  // Special: pi official svg
  const piSvgUrl = "https://pi.dev/favicon.svg";
  const piRaw = path.join(work, "pi-official.svg");
  if (curl(piSvgUrl, piRaw)) {
    try {
      await toPng128(piRaw, path.join(agentsDir, "pi.png"));
      results.push({ id: "pi", status: "ok", from: piSvgUrl });
    } catch {
      /* keep existing */
    }
  }

  // Special: aider official logo
  const aiderSvg = path.join(work, "aider-official.svg");
  if (
    curl(
      "https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/assets/logo.svg",
      aiderSvg,
    )
  ) {
    try {
      const word = await sharp(await readFile(aiderSvg))
        .resize(112, 36, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      await sharp({
        create: {
          width: 128,
          height: 128,
          channels: 4,
          background: { r: 15, g: 23, b: 42, alpha: 1 },
        },
      })
        .composite([{ input: word, gravity: "center" }])
        .png()
        .toFile(path.join(agentsDir, "aider.png"));
      results.push({ id: "aider", status: "ok", from: "aider logo.svg" });
    } catch {
      /* keep */
    }
  }

  // Special: goose official
  const gooseBig = path.join(work, "goose-official.png");
  if (
    curl(
      "https://raw.githubusercontent.com/block/goose/main/ui/desktop/src/images/icon.png",
      gooseBig,
    )
  ) {
    try {
      await toPng128(gooseBig, path.join(agentsDir, "goose.png"));
      results.push({ id: "goose", status: "ok", from: "block/goose icon.png" });
    } catch {
      /* keep */
    }
  }

  // Special: openclaw from providers lobster
  if (await exists(path.join(providersDir, "openclaw.png"))) {
    await sharp(path.join(providersDir, "openclaw.png"))
      .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(path.join(agentsDir, "openclaw.png"));
    results.push({ id: "openclaw", status: "ok", from: "providers/openclaw.png" });
  }

  // Special: claude starburst from existing ico if convert works, else google
  if (await exists(path.join(agentsDir, "claude-code.ico"))) {
    try {
      await toPng128(path.join(agentsDir, "claude-code.ico"), path.join(agentsDir, "claude-code.png"));
      results.push({ id: "claude-code", status: "ok", from: "claude-code.ico" });
    } catch {
      /* keep */
    }
  }

  await writeFile(path.join(work, "report.json"), JSON.stringify(results, null, 2));
  const ok = results.filter((r) => r.status === "ok" || r.status === "keep-official").length;
  const fail = results.filter((r) => r.status === "fail").length;
  console.log(JSON.stringify({ ok, fail, total: results.length }, null, 2));
  for (const r of results) {
    console.log(`${r.status.padEnd(14)} ${r.id}${r.from ? " <- " + r.from : ""}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
