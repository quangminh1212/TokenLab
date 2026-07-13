#!/usr/bin/env node
/**
 * Convert PNG to ICO using sharp and png-to-ico
 * Create a proper multi-size ICO file
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, '..', 'installer', 'electron', 'assets');
const sourceDir = path.join(__dirname, '..', 'src', 'server', 'assets');

const logoPng = path.join(sourceDir, 'logo.png');
const icoPath = path.join(assetsDir, 'icon.ico');
const iconPng = path.join(assetsDir, 'icon.png');

console.log('🔨 Converting PNG to multi-size ICO...');

if (!fs.existsSync(logoPng)) {
  console.error('✗ logo.png not found in src/server/assets/');
  process.exit(1);
}

try {
  // Create a smaller PNG for Electron (256x256 max for better performance)
  console.log('  Creating optimized PNG for Electron...');
  const optimizedPng = await sharp(logoPng)
    .resize(256, 256, { fit: 'cover', position: 'center' })
    .toBuffer();
  fs.writeFileSync(iconPng, optimizedPng);
  console.log('✓ Created optimized icon.png (256x256)');

  // Create multi-size ICO for Windows
  console.log('  Creating multi-size ICO...');
  const icoBuffer = await pngToIco(optimizedPng);
  fs.writeFileSync(icoPath, icoBuffer);
  
  console.log('✓ Successfully created icon.ico (Windows icon)');
  console.log(`  Location: ${icoPath}`);
  console.log(`  Size: ${icoBuffer.length} bytes`);
} catch (error) {
  console.error('✗ Failed to convert PNG to ICO:', error.message);
  console.error('  Details:', error);
  process.exit(1);
}