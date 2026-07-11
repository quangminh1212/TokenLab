import { cpSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverSrc = path.join(root, "src", "server");
const serverDist = path.join(root, "dist", "server");
mkdirSync(serverDist, { recursive: true });

const files = ["dashboard.html", "agents.html", "settings.html", "styles.css"];
for (const name of files) {
  const from = path.join(serverSrc, name);
  if (!existsSync(from)) {
    console.warn("skip missing", name);
    continue;
  }
  cpSync(from, path.join(serverDist, name));
  console.log(`copied ${name} -> dist/server/`);
}

const assetsFrom = path.join(serverSrc, "assets");
const assetsTo = path.join(serverDist, "assets");
if (existsSync(assetsFrom)) {
  mkdirSync(assetsTo, { recursive: true });
  cpSync(assetsFrom, assetsTo, { recursive: true });
  console.log("copied assets/ -> dist/server/assets/");
}
