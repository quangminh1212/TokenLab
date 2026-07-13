import sharp from "sharp";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agents = path.join(root, "src", "server", "assets", "agents");
const providers = path.join(root, "src", "server", "assets", "providers");
const dist = path.join(root, "installer", "dist", "server", "assets", "agents");

// ZCode (Z.ai) — use GLM/Zhipu Z mark already in providers
await sharp(path.join(providers, "glm.png"))
  .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(path.join(agents, "zcode.png"));
console.log("zcode.png <- providers/glm.png (Z mark)");

// Open Code Review — Alibaba product; orange OCR tile (not random "S" favicon)
const ocrSvg = Buffer.from(
  `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="#FF6A00"/>
  <text x="64" y="80" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="40" font-weight="800" fill="#ffffff">OCR</text>
</svg>`,
);
await sharp(ocrSvg).png().toFile(path.join(agents, "opencodereview.png"));
console.log("opencodereview.png <- Alibaba-orange OCR mark");

for (const f of ["zcode.png", "opencodereview.png"]) {
  try {
    await copyFile(path.join(agents, f), path.join(dist, f));
    console.log("dist", f);
  } catch {
    // ignore missing dist
  }
}
