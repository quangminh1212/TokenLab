import esbuild from 'esbuild';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

const entryPoint = 'src/cli.ts';
const outFile = 'installer/dist/bundle.cjs';
const assetsDir = 'installer/dist/server/assets';

// Build the bundle
await esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: outFile,
  external: ['electron'], // Exclude electron if not used
  treeShaking: true,
  minify: false,
  sourcemap: false,
  logLevel: 'info',
  banner: {
    js: `const { fileURLToPath } = require('url');
const path = require('path');
global.__filename = __filename;
global.__dirname = path.dirname(__filename);
import.meta = { url: require('url').pathToFileURL(__filename).href };
`,
  },
});

console.log(`Bundle created: ${outFile}`);

// Ensure assets directory exists
if (!existsSync(assetsDir)) {
  mkdirSync(dirname(assetsDir), { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
}

console.log('Assets directory ready');
