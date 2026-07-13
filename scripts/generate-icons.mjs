#!/usr/bin/env node
/**
 * Icon generator script for XLab Token
 * This script copies the project logo to the required icon formats
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, '..', 'installer', 'electron', 'assets');
const sourceDir = path.join(__dirname, '..', 'src', 'server', 'assets');

// Ensure assets directory exists
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

// Copy existing logo files
const logoPng = path.join(sourceDir, 'logo.png');

if (fs.existsSync(logoPng)) {
  const targetPng = path.join(assetsDir, 'icon.png');
  fs.copyFileSync(logoPng, targetPng);
  console.log('✓ Copied logo.png to icon.png (Linux icon)');
} else {
  console.log('✗ logo.png not found in src/server/assets/');
}

console.log('\nIcon files prepared for development!');
console.log('\nFor production, you need to convert the SVG/ PNG to:');
console.log('- icon.ico (256x256 ICO for Windows)');
console.log('- icon.icns (ICNS for macOS)');
console.log('\nRecommended conversion tools:');
console.log('- https://cloudconvert.com/png-to-ico');
console.log('- https://cloudconvert.com/png-to-icns');
console.log('- https://www.favicon-generator.org/');
console.log('\nOr use ImageMagick:');
console.log('  magick convert icon.png -define icon:auto-resize=256,128,96,64,48,32,16 icon.ico');
console.log('  (For macOS, use iconutil or online converter)');