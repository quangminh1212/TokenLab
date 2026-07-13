import sharp from "sharp";
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".tmp-icons", "fixed");
const agents = path.join(root, "src", "server", "assets", "agents");

async function svgPng(name, svg) {
  await sharp(Buffer.from(svg)).png().toFile(path.join(out, `${name}.png`));
  console.log("svg", name);
}

// Aider official SVG logo (downloaded)
const aiderSvg = await readFile(path.join(root, ".tmp-icons", "dl2", "a3"));
await sharp(aiderSvg)
  .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(path.join(out, "aider.png"));
console.log("aider logo");

// Distinct monogram brands for obscure agents
await svgPng(
  "jcode",
  `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#0f172a"/><text x="64" y="84" text-anchor="middle" font-family="Segoe UI,Arial" font-size="56" font-weight="700" fill="#38bdf8">Jc</text></svg>`,
);
await svgPng(
  "gjc",
  `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#4c1d95"/><text x="64" y="84" text-anchor="middle" font-family="Segoe UI,Arial" font-size="48" font-weight="700" fill="#f5f3ff">GJC</text></svg>`,
);
await svgPng(
  "codebuff",
  `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#09090b"/><circle cx="48" cy="52" r="10" fill="#fafafa"/><circle cx="80" cy="52" r="10" fill="#fafafa"/><rect x="40" y="78" width="48" height="8" rx="4" fill="#fafafa"/></svg>`,
);
await svgPng(
  "mux",
  `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#111827"/><text x="64" y="86" text-anchor="middle" font-family="Segoe UI,Arial" font-size="44" font-weight="800" fill="#22c55e">mux</text></svg>`,
);
await svgPng(
  "trae",
  `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#0f172a"/><polygon points="64,22 106,64 64,106 22,64" fill="#22c55e"/></svg>`,
);
await svgPng(
  "droid",
  `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#0a0a0a"/><g fill="#ffffff" transform="translate(64 64)"><polygon points="0,-36 10,-10 36,0 10,10 0,36 -10,10 -36,0 -10,-10"/></g></svg>`,
);

const files = [
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
for (const f of files) {
  await copyFile(path.join(out, f), path.join(agents, f));
  console.log("-> agents/" + f);
}
console.log("all installed");
