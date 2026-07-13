#!/usr/bin/env node
// CommonJS wrapper for ESM module
const path = require('path');
const { fileURLToPath } = require('url');

// Try multiple possible paths for the dist folder
const possiblePaths = [
  path.join(__dirname, 'installer', 'dist', 'cli.js'),
  path.join(__dirname, '..', 'installer', 'dist', 'cli.js'),
  path.join(process.cwd(), 'installer', 'dist', 'cli.js'),
  path.join(__dirname, 'cli.js'), // If bundled together
];

async function main() {
  for (const distPath of possiblePaths) {
    try {
      const distUrl = `file://${distPath}`;
      await import(distUrl);
      return; // Success
    } catch (err) {
      if (err.code !== 'ERR_MODULE_NOT_FOUND') {
        throw err;
      }
      // Try next path
    }
  }
  throw new Error('Could not find cli.js in any expected location');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
