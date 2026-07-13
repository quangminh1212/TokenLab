#!/usr/bin/env node
/**
 * Convert PNG to ICO using sharp and png-to-ico
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, '..', 'electron', 'assets');
const sourceDir = path.join(__dirname, '..', 'src', 'server', 'assets');

const logoPng = path.join(sourceDir, 'logo.png');
const icoPath = path.join(assetsDir, 'icon.ico');

console.log('🔨 Converting PNG to ICO...');

if (!fs.existsSync(logoPng)) {
  console.error('✗ logo.png not found in src/server/assets/');
  process.exit(1);
}

try {
  // First, resize to square 256x256
  console.log('  Resizing to 256x256...');
  const resizedBuffer = await sharp(logoPng)
    .resize(256, 256, { fit: 'cover', position: 'center' })
    .toBuffer();

  // Convert to ICO
  console.log('  Converting to ICO...');
  const icoBuffer = await pngToIco(resizedBuffer);
  fs.writeFileSync(icoPath, icoBuffer);
  
  console.log('✓ Successfully created icon.ico (Windows icon)');
  console.log(`  Location: ${icoPath}`);
  console.log(`  Size: ${icoBuffer.length} bytes`);
} catch (error) {
  console.error('✗ Failed to convert PNG to ICO:', error.message);
  console.error('  Details:', error);
  process.exit(1);
}