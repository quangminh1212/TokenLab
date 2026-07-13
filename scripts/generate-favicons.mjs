#!/usr/bin/env node
/**
 * Generate favicon files from project logo
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, '..', 'src', 'server', 'assets');
const logoPng = path.join(assetsDir, 'logo.png');

console.log('🔨 Generating favicons from project logo...');

if (!fs.existsSync(logoPng)) {
  console.error('✗ logo.png not found in src/server/assets/');
  process.exit(1);
}

try {
  // Generate different sizes for favicon
  const sizes = [16, 32, 48, 192];
  
  for (const size of sizes) {
    const outputFile = path.join(assetsDir, `favicon-${size}x${size}.png`);
    await sharp(logoPng)
      .resize(size, size, { fit: 'cover', position: 'center' })
      .toFile(outputFile);
    console.log(`✓ Generated favicon-${size}x${size}.png`);
  }

  // Generate main favicon (32x32)
  await sharp(logoPng)
    .resize(32, 32, { fit: 'cover', position: 'center' })
    .toFile(path.join(assetsDir, 'favicon.png'));
  console.log('✓ Generated favicon.png (32x32)');

  // Generate apple-touch-icon (180x180)
  await sharp(logoPng)
    .resize(180, 180, { fit: 'cover', position: 'center' })
    .toFile(path.join(assetsDir, 'apple-touch-icon.png'));
  console.log('✓ Generated apple-touch-icon.png (180x180)');

  // Generate android-chrome icon (192x192)
  await sharp(logoPng)
    .resize(192, 192, { fit: 'cover', position: 'center' })
    .toFile(path.join(assetsDir, 'android-chrome-192x192.png'));
  console.log('✓ Generated android-chrome-192x192.png (192x192)');

  console.log('\n✨ All favicons generated successfully!');
  console.log('These will be used in the web dashboard title bar.');
} catch (error) {
  console.error('✗ Failed to generate favicons:', error.message);
  process.exit(1);
}