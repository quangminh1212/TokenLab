/**
 * After global `npm i -g xlab-token`: enable login autostart + start dashboard.
 * Never fails the install (always exit 0).
 *
 * Skip when:
 * - not a global install
 * - CI / XLAB_TOKEN_SKIP_POSTINSTALL=1
 * - dist/cli.js missing (source tree without build)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli.js");

function shouldRun() {
  if (process.env.XLAB_TOKEN_SKIP_POSTINSTALL === "1") return false;
  if (process.env.CI === "true" || process.env.CI === "1") return false;
  // npm sets this for `npm install -g`
  if (String(process.env.npm_config_global) !== "true") return false;
  if (!existsSync(cli)) return false;
  return true;
}

function main() {
  if (!shouldRun()) {
    process.exit(0);
  }
  try {
    spawnSync(process.execPath, [cli, "setup", "--from-postinstall"], {
      stdio: "inherit",
      windowsHide: true,
      env: process.env,
      cwd: root,
    });
  } catch {
    // ignore — must not fail npm install
  }
  process.exit(0);
}

main();
