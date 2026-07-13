#!/usr/bin/env node
/**
 * Simple icon generator script
 * This creates placeholder icons for development
 * For production, use proper icon design tools
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, '..', 'electron', 'assets');

// Create a simple SVG icon
const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" fill="#4F46E5" rx="32"/>
  <text x="128" y="140" font-family="Arial, sans-serif" font-size="80" font-weight="bold" fill="white" text-anchor="middle">X</text>
  <text x="128" y="200" font-family="Arial, sans-serif" font-size="40" fill="white" text-anchor="middle">Token</text>
</svg>`;

// Ensure assets directory exists
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

// Write SVG icon
const svgPath = path.join(assetsDir, 'icon.svg');
fs.writeFileSync(svgPath, svgIcon);
console.log('Created placeholder SVG icon:', svgPath);

console.log('\nNote: This is a placeholder icon for development.');
console.log('For production, convert this SVG to proper formats:');
console.log('- icon.png (256x256 PNG for Linux)');
console.log('- icon.ico (256x256 ICO for Windows)');
console.log('- icon.icns (ICNS for macOS)');
console.log('\nRecommended tools:');
console.log('- https://cloudconvert.com/svg-to-png');
console.log('- https://cloudconvert.com/svg-to-ico');
console.log('- https://cloudconvert.com/svg-to-icns');
