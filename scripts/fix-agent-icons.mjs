/**
 * Fix broken / wrong agent icons under src/server/assets/agents.
 * Run: node scripts/fix-agent-icons.mjs
 */
import sharp from "sharp";
import { copyFile, mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentsDir = path.join(root, "src", "server", "assets", "agents");
const providersDir = path.join(root, "src", "server", "assets", "providers");
const dlDir = path.join(root, ".tmp-icons", "dl");
const outDir = path.join(root, ".tmp-icons", "fixed");

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function toPng(src, dest, size = 128) {
  await sharp(src)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(dest);
  const meta = await sharp(dest).metadata();
  console.log(`OK ${path.basename(dest)} ${meta.width}x${meta.height}`);
}

async function svgToPng(svg, dest, size = 128) {
  const buf = Buffer.from(svg, "utf8");
  await sharp(buf)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(dest);
  console.log(`SVG ${path.basename(dest)}`);
}

function brandSvg(letter, bg, fg = "#ffffff") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="${bg}"/>
  <text x="64" y="86" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="64" font-weight="700" fill="${fg}">${letter}</text>
</svg>`;
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const jobs = [];

  // Goose — official Block desktop icon (large PNG)
  const gooseSrc = path.join(dlDir, "goose-big.png");
  if (await exists(gooseSrc)) {
    jobs.push(toPng(gooseSrc, path.join(outDir, "goose.png")));
  } else {
    jobs.push(
      svgToPng(
        brandSvg("G", "#1a1a1a"),
        path.join(outDir, "goose.png"),
      ),
    );
  }

  // OpenClaw — provider lobster asset (correct brand)
  const clawSrc = path.join(providersDir, "openclaw.png");
  if (await exists(clawSrc)) {
    jobs.push(toPng(clawSrc, path.join(outDir, "openclaw.png")));
  }

  // Aider — favicon PNG
  const aiderSrc = path.join(dlDir, "fav-aider.png");
  if (await exists(aiderSrc)) {
    jobs.push(toPng(aiderSrc, path.join(outDir, "aider.png")));
  } else {
    jobs.push(svgToPng(brandSvg("A", "#2563eb"), path.join(outDir, "aider.png")));
  }

  // Pi — pi.ai favicon
  const piSrc = path.join(dlDir, "fav-pi.png");
  if (await exists(piSrc)) {
    jobs.push(toPng(piSrc, path.join(outDir, "pi.png")));
  }

  // OpenCodeReview — site favicon (not Alibaba)
  const ocrSrc = path.join(dlDir, "fav-opencodereview.png");
  if (await exists(ocrSrc)) {
    jobs.push(toPng(ocrSrc, path.join(outDir, "opencodereview.png")));
  } else {
    jobs.push(svgToPng(brandSvg("OR", "#0ea5e9"), path.join(outDir, "opencodereview.png")));
  }

  // Jcode / GJC — were empty black squares
  for (const [id, file, bg] of [
    ["jcode", "fav-jcode.png", "#111827"],
    ["gjc", "fav-gjc.png", "#7c3aed"],
    ["codebuff", "fav-codebuff.png", "#000000"],
    ["mux", "fav-mux.png", "#00aa66"],
    ["zcode", "fav-zcode.png", "#1f2937"],
  ]) {
    const src = path.join(dlDir, file);
    if (await exists(src)) {
      jobs.push(toPng(src, path.join(outDir, `${id}.png`)));
    } else {
      jobs.push(
        svgToPng(
          brandSvg(id.slice(0, 2).toUpperCase(), bg),
          path.join(outDir, `${id}.png`),
        ),
      );
    }
  }

  // Claude Code — convert .ico starburst → PNG (better browser support)
  const claudeIco = path.join(agentsDir, "claude-code.ico");
  if (await exists(claudeIco)) {
    jobs.push(toPng(claudeIco, path.join(outDir, "claude-code.png")));
  }

  // Factory Droid — ico → png
  const droidIco = path.join(agentsDir, "droid.ico");
  if (await exists(droidIco)) {
    jobs.push(toPng(droidIco, path.join(outDir, "droid.png")));
  }

  // Trae — clean diamond mark (old file was tiny/weak)
  jobs.push(
    svgToPng(
      `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="#0f172a"/>
  <polygon points="64,20 108,64 64,108 20,64" fill="#22c55e"/>
</svg>`,
      path.join(outDir, "trae.png"),
    ),
  );

  await Promise.all(jobs);

  // Install into agents/
  const install = [
    "goose.png",
    "openclaw.png",
    "aider.png",
    "pi.png",
    "opencodereview.png",
    "jcode.png",
    "gjc.png",
    "codebuff.png",
    "mux.png",
    "claude-code.png",
    "droid.png",
    "zcode.png",
    "trae.png",
  ];
  for (const f of install) {
    const src = path.join(outDir, f);
    if (!(await exists(src))) {
      console.warn("skip missing", f);
      continue;
    }
    await copyFile(src, path.join(agentsDir, f));
    console.log("installed", f);
  }

  // Write map notes for HTML update
  await writeFile(
    path.join(outDir, "MAP.txt"),
    [
      "claude-code: claude-code.png (not .ico)",
      "droid: droid.png (not .ico)",
      "goose, openclaw, aider, pi, opencodereview, jcode, gjc, codebuff, mux, zcode, trae: fixed png",
    ].join("\n"),
    "utf8",
  );
  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
