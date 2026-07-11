import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const from = path.join(root, "src", "server", "dashboard.html");
const toDir = path.join(root, "dist", "server");
const to = path.join(toDir, "dashboard.html");
mkdirSync(toDir, { recursive: true });
cpSync(from, to);
console.log("copied dashboard.html -> dist/server/");
