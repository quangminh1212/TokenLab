#!/usr/bin/env node
/**
 * Comprehensive icon builder for XLab Token
 * Attempts to convert logo to all required formats using available tools
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, '..', 'installer', 'electron', 'assets');
const sourceDir = path.join(__dirname, '..', 'src', 'server', 'assets');

// Ensure assets directory exists
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

// Copy source files
const logoPng = path.join(sourceDir, 'logo.png');

console.log('🔨 Building XLab Token icons...\n');

// Copy PNG for Linux
if (fs.existsSync(logoPng)) {
  const targetPng = path.join(assetsDir, 'icon.png');
  fs.copyFileSync(logoPng, targetPng);
  console.log('✓ Copied logo.png to icon.png (Linux icon)');
} else {
  console.log('✗ logo.png not found in src/server/assets/');
}

// Try to convert to Windows ICO
async function convertToIco() {
  const icoPath = path.join(assetsDir, 'icon.ico');
  
  if (fs.existsSync(icoPath)) {
    console.log('✓ icon.ico already exists (Windows icon)');
    return;
  }

  console.log('📦 Windows ICO icon...');
  console.log('⚠ Could not create icon.ico automatically');
  console.log('  Please convert manually using: https://cloudconvert.com/png-to-ico');
  console.log('  Or download from: https://www.favicon-generator.org/');
}

// Try to convert to macOS ICNS
async function convertToIcns() {
  const icnsPath = path.join(assetsDir, 'icon.icns');
  
  if (fs.existsSync(icnsPath)) {
    console.log('✓ icon.icns already exists (macOS icon)');
    return;
  }

  if (process.platform !== 'darwin') {
    console.log('⚠ Skipping icon.icns (not on macOS)');
    console.log('  Please convert manually using: https://cloudconvert.com/png-to-icns');
    return;
  }

  console.log('📦 Attempting to convert to macOS ICNS...');
  
  try {
    const iconsetDir = path.join(assetsDir, 'icon.iconset');
    if (!fs.existsSync(iconsetDir)) {
      fs.mkdirSync(iconsetDir, { recursive: true });
    }

    const sizes = [16, 32, 128, 256, 512];
    for (const size of sizes) {
      const normal = path.join(iconsetDir, `icon_${size}x${size}.png`);
      const retina = path.join(iconsetDir, `icon_${size}x${size}@2x.png`);
      
      await runCommand('sips', ['-z', String(size), String(size), logoPng, '--out', normal]);
      await runCommand('sips', ['-z', String(size * 2), String(size * 2), logoPng, '--out', retina]);
    }

    await runCommand('iconutil', ['-c', 'icns', iconsetDir]);
    
    // Cleanup
    fs.rmSync(iconsetDir, { recursive: true, force: true });
    
    console.log('✓ Created icon.icns using iconutil (macOS icon)');
  } catch (err) {
    console.log('⚠ Could not create icon.icns automatically');
    console.log('  Please convert manually using: https://cloudconvert.com/png-to-icns');
  }
}

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const process = spawn(cmd, args);
    process.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with code ${code}`));
    });
    process.on('error', reject);
  });
}

// Main execution
async function main() {
  try {
    await convertToIco();
    await convertToIcns();
    
    console.log('\n✨ Icon build complete!\n');
    console.log('Status:');
    console.log(`  Linux (PNG): ${fs.existsSync(path.join(assetsDir, 'icon.png')) ? '✓' : '✗'}`);
    console.log(`  Windows (ICO): ${fs.existsSync(path.join(assetsDir, 'icon.ico')) ? '✓' : '⚠'}`);
    console.log(`  macOS (ICNS): ${fs.existsSync(path.join(assetsDir, 'icon.icns')) ? '✓' : '⚠'}`);
    
    if (!fs.existsSync(path.join(assetsDir, 'icon.ico')) || !fs.existsSync(path.join(assetsDir, 'icon.icns'))) {
      console.log('\nNote: Some icons could not be generated automatically.');
      console.log('The app will still work, but may use default icons on those platforms.');
      console.log('For production builds, manually convert the icons using online tools.');
    }
  } catch (error) {
    console.error('Error building icons:', error);
    process.exit(1);
  }
}

main();