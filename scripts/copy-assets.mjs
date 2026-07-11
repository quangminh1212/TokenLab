import { cpSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverSrc = path.join(root, "src", "server");
const serverDist = path.join(root, "dist", "server");
mkdirSync(serverDist, { recursive: true });

const dashboardFrom = path.join(serverSrc, "dashboard.html");
const dashboardTo = path.join(serverDist, "dashboard.html");
cpSync(dashboardFrom, dashboardTo);
console.log("copied dashboard.html -> dist/server/");

const assetsFrom = path.join(serverSrc, "assets");
const assetsTo = path.join(serverDist, "assets");
if (existsSync(assetsFrom)) {
  mkdirSync(assetsTo, { recursive: true });
  cpSync(assetsFrom, assetsTo, { recursive: true });
  console.log("copied assets/ -> dist/server/assets/");
}
