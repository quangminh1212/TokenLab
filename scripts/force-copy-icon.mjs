#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceLogo = path.join(__dirname, '..', 'src', 'server', 'assets', 'logo.png');
const targetIcon = path.join(__dirname, '..', 'installer', 'electron', 'assets', 'icon.png');

console.log('Force copying icon...');
console.log('Source:', sourceLogo);
console.log('Target:', targetIcon);

try {
  // Remove existing file if exists
  if (fs.existsSync(targetIcon)) {
    fs.unlinkSync(targetIcon);
    console.log('Removed existing icon.png');
  }
  
  // Copy the file
  fs.copyFileSync(sourceLogo, targetIcon);
  console.log('✓ Copied logo.png to icon.png');
  
  const stats = fs.statSync(targetIcon);
  console.log('File size:', stats.size, 'bytes');
  console.log('Modified time:', stats.mtime);
} catch (error) {
  console.error('✗ Failed to copy icon:', error.message);
  process.exit(1);
}