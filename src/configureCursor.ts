/**
 * Configure Cursor's OpenAI Base URL Override
 * This script modifies Cursor's SQLite database to set the proxy URL
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const PROXY_URL = 'http://localhost:4000/v1';

function getCursorDbPath(): string {
    const home = os.homedir();
    const platform = os.platform();

    if (platform === 'win32') {
        return path.join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    } else if (platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    } else {
        return path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    }
}

function configureCursorProxy(): void {
    const dbPath = getCursorDbPath();

    console.log('🔮 TokenSage - Configure Cursor Proxy\n');
    console.log(`Database path: ${dbPath}`);

    if (!fs.existsSync(dbPath)) {
        console.error('❌ Cursor database not found. Is Cursor installed?');
        process.exit(1);
    }

    // Create backup
    const backupPath = dbPath + '.tokensage-backup';
    if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(dbPath, backupPath);
        console.log(`✅ Backup created: ${backupPath}`);
    }

    try {
        const db = new Database(dbPath);

        // Check current schema
        console.log('\n📊 Database schema:');
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        console.log('Tables:', tables.map((t: any) => t.name).join(', '));

        // Check ItemTable structure
        const columns = db.prepare("PRAGMA table_info(ItemTable)").all();
        console.log('\nItemTable columns:', columns.map((c: any) => c.name).join(', '));

        // Look for existing OpenAI settings
        console.log('\n🔍 Searching for OpenAI settings...');
        const openaiSettings = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE '%openai%' OR key LIKE '%OpenAI%' OR key LIKE '%baseUrl%' OR key LIKE '%base_url%'").all();

        if (openaiSettings.length > 0) {
            console.log('Found settings:');
            for (const setting of openaiSettings as any[]) {
                console.log(`  - ${setting.key}: ${setting.value?.substring(0, 100)}...`);
            }
        } else {
            console.log('No existing OpenAI settings found.');
        }

        // Look for cursor-specific settings
        console.log('\n🔍 Searching for Cursor AI settings...');
        const cursorSettings = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE '%cursor%' OR key LIKE '%aiProvider%' OR key LIKE '%model%'").all();

        if (cursorSettings.length > 0) {
            console.log('Found Cursor settings:');
            for (const setting of cursorSettings as any[]) {
                const value = setting.value?.length > 200 ? setting.value?.substring(0, 200) + '...' : setting.value;
                console.log(`  - ${setting.key}: ${value}`);
            }
        }

        // Try to find the settings blob
        console.log('\n🔍 Searching for settings storage...');
        const allKeys = db.prepare("SELECT key FROM ItemTable").all();
        console.log(`Total keys in database: ${allKeys.length}`);

        // Look for common patterns
        const patterns = ['storage', 'settings', 'config', 'api', 'provider'];
        for (const pattern of patterns) {
            const matches = (allKeys as any[]).filter(k => k.key.toLowerCase().includes(pattern));
            if (matches.length > 0 && matches.length < 20) {
                console.log(`\nKeys containing '${pattern}':`);
                matches.forEach(m => console.log(`  - ${m.key}`));
            }
        }

        db.close();

        console.log('\n⚠️ Cursor stores settings in a complex blob format.');
        console.log('Manual configuration is recommended:');
        console.log('');
        console.log('╔═════════════════════════════════════════════════════════════╗');
        console.log('║  MANUAL CONFIGURATION STEPS:                                ║');
        console.log('╠═════════════════════════════════════════════════════════════╣');
        console.log('║  1. Open Cursor                                             ║');
        console.log('║  2. Press Ctrl+Shift+J (or Cmd+Shift+J on Mac)              ║');
        console.log('║  3. Click on "Models" tab                                   ║');
        console.log('║  4. Find "OpenAI API Key" section                           ║');
        console.log('║  5. Click "More" or expand arrow                            ║');
        console.log('║  6. In "Override OpenAI Base URL" field, enter:             ║');
        console.log(`║     ${PROXY_URL.padEnd(47)}║`);
        console.log('║  7. Restart Cursor                                          ║');
        console.log('╚═════════════════════════════════════════════════════════════╝');

    } catch (error) {
        console.error('❌ Error:', (error as Error).message);

        // Check if Cursor is running
        console.log('\n💡 Tip: Close Cursor before running this script.');
    }
}

configureCursorProxy();
