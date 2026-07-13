import sharp from "sharp";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agents = path.join(root, "src", "server", "assets", "agents");
const providers = path.join(root, "src", "server", "assets", "providers");

// Copilot — official from providers (GitHub Copilot mark)
await sharp(path.join(providers, "copilot.png"))
  .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(path.join(agents, "copilot.png"));
console.log("copilot <- providers/copilot.png");

// Open Code Review — Alibaba product; use Alibaba orange brand tile with OCR
// (favicon CDN returned google globe; Alibaba orange is correct brand color)
const ocr = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="24" fill="#FF6A00"/>
  <text x="64" y="78" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="36" font-weight="800" fill="#ffffff">OCR</text>
</svg>`;
await sharp(Buffer.from(ocr)).png().toFile(path.join(agents, "opencodereview.png"));
console.log("opencodereview <- Alibaba OCR brand tile");

// GJC (Gajae-Code) — no reliable public favicon (gajae.com resolves to Wix)
const gjc = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="#4c1d95"/>
  <text x="64" y="80" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="40" font-weight="800" fill="#ffffff">GJC</text>
</svg>`;
await sharp(Buffer.from(gjc)).png().toFile(path.join(agents, "gjc.png"));
console.log("gjc <- monogram (no official asset found)");

// Ensure codex/zcode/openclaw/windsurf/goose/aider/pi/jcode still official
await sharp(path.join(providers, "openai.png"))
  .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(path.join(agents, "codex.png"));
await sharp(path.join(providers, "glm.png"))
  .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(path.join(agents, "zcode.png"));
await sharp(path.join(providers, "openclaw.png"))
  .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(path.join(agents, "openclaw.png"));
console.log("codex/zcode/openclaw reconfirmed");

// Map agents that should use provider official assets when agents file weak
const syncFromProviders = {
  "amazon-q.png": "aws.png",
  "kimi.png": "kimi.png",
  "grok.png": "xai.png",
  "ollama.png": "ollama.png",
};
for (const [agentFile, provFile] of Object.entries(syncFromProviders)) {
  try {
    await sharp(path.join(providers, provFile))
      .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(path.join(agents, agentFile));
    console.log("sync", agentFile, "<-", provFile);
  } catch (e) {
    console.log("skip", agentFile, e.message);
  }
}

// Prefer providers/kimi for agent kimi.ico replacement as png
try {
  await sharp(path.join(providers, "kimi.png"))
    .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(agents, "kimi.png"));
  console.log("kimi.png from providers");
} catch {
  /* keep ico */
}

console.log("done");
