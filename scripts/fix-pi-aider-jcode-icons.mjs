/**
 * Replace Pi / Aider / Jcode icons with verified official brand assets.
 * Sources:
 * - Pi: https://pi.dev/favicon.svg (badlogic/pi coding agent mark — not Inflection Pi.ai)
 * - Oh My Pi: omp.sh favicon uses Pi-style mark; we use pi.dev official geometric Pi
 * - Aider: https://github.com/Aider-AI/aider logo.svg (official green wordmark)
 * - Jcode: assets/app-icons/Jcode.icns from 1jehuang/jcode (official app icon)
 */
import sharp from "sharp";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v3 = path.join(root, ".tmp-icons", "verify3");
const out = path.join(root, ".tmp-icons", "fixed");
const agents = path.join(root, "src", "server", "assets", "agents");
const distAgents = path.join(root, "installer", "dist", "server", "assets", "agents");

async function install(name) {
  const src = path.join(out, name);
  await copyFile(src, path.join(agents, name));
  try {
    await copyFile(src, path.join(distAgents, name));
  } catch {
    // dist may not exist in some checkouts
  }
  console.log("installed", name);
}

// --- Pi official geometric mark (pi.dev) ---
const piSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800">
  <rect width="800" height="800" rx="120" fill="#09090b"/>
  <path fill="#ffffff" fill-rule="evenodd" d="
    M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z
    M282.65 282.65 V400 H400 V282.65 Z"/>
  <path fill="#ffffff" d="M517.36 400 H634.72 V634.72 H517.36 Z"/>
</svg>`;
await sharp(Buffer.from(piSvg)).resize(128, 128).png().toFile(path.join(out, "pi.png"));
console.log("pi: official pi.dev geometric Pi mark");

// --- Aider official wordmark on dark square (readable at avatar size) ---
const aiderSvg = await readFile(path.join(v3, "aider-logo.svg"));
const word = await sharp(aiderSvg)
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
  .toFile(path.join(out, "aider.png"));
console.log("aider: official Aider-AI green wordmark");

// --- Jcode official app icon from ICNS extract ---
const jcodeSrc = path.join(v3, "jcode-extract-3.png");
await sharp(jcodeSrc)
  .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(path.join(out, "jcode.png"));
console.log("jcode: official app icon from 1jehuang/jcode ICNS");

await install("pi.png");
await install("aider.png");
await install("jcode.png");

// Write verification notes
await writeFile(
  path.join(out, "VERIFY-pi-aider-jcode.txt"),
  [
    "pi.png     <- pi.dev official geometric Pi (coding agent), NOT Inflection Pi.ai",
    "aider.png  <- Aider-AI/aider website logo.svg green wordmark on dark tile",
    "jcode.png  <- 1jehuang/jcode assets/app-icons/Jcode.icns extracted PNG",
  ].join("\n"),
  "utf8",
);
console.log("done");
