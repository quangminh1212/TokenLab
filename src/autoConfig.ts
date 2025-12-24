#!/usr/bin/env node
/**
 * TokenSage Auto-Config
 * Automatically configure Cursor/Windsurf to use the proxy
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PROXY_URL = 'http://localhost:4000/v1';

interface ConfigResult {
    success: boolean;
    message: string;
    path?: string;
}

// Get user's home directory
const HOME_DIR = os.homedir();

// IDE config paths
const CONFIG_PATHS = {
    cursor: {
        windows: path.join(HOME_DIR, 'AppData', 'Roaming', 'Cursor', 'User', 'settings.json'),
        mac: path.join(HOME_DIR, 'Library', 'Application Support', 'Cursor', 'User', 'settings.json'),
        linux: path.join(HOME_DIR, '.config', 'Cursor', 'User', 'settings.json'),
    },
    windsurf: {
        windows: path.join(HOME_DIR, 'AppData', 'Roaming', 'Windsurf', 'User', 'settings.json'),
        mac: path.join(HOME_DIR, 'Library', 'Application Support', 'Windsurf', 'User', 'settings.json'),
        linux: path.join(HOME_DIR, '.config', 'Windsurf', 'User', 'settings.json'),
    },
    vscode: {
        windows: path.join(HOME_DIR, 'AppData', 'Roaming', 'Code', 'User', 'settings.json'),
        mac: path.join(HOME_DIR, 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
        linux: path.join(HOME_DIR, '.config', 'Code', 'User', 'settings.json'),
    },
};

function getPlatform(): 'windows' | 'mac' | 'linux' {
    const platform = os.platform();
    if (platform === 'win32') return 'windows';
    if (platform === 'darwin') return 'mac';
    return 'linux';
}

function configureIDE(ide: 'cursor' | 'windsurf' | 'vscode'): ConfigResult {
    const platform = getPlatform();
    const configPath = CONFIG_PATHS[ide][platform];

    if (!fs.existsSync(configPath)) {
        return {
            success: false,
            message: `${ide} settings file not found at ${configPath}`,
        };
    }

    try {
        // Read current settings
        const content = fs.readFileSync(configPath, 'utf-8');
        const settings = JSON.parse(content);

        // Add/update proxy settings
        // Note: Cursor uses internal settings for OpenAI Base URL
        // We can set http.proxy for general proxy support
        settings['http.proxy'] = 'http://localhost:4000';
        settings['http.proxyStrictSSL'] = false;

        // For Continue extension (if installed)
        settings['continue.proxyUrl'] = 'http://localhost:4000';

        // Create backup
        const backupPath = configPath + '.tokensage-backup';
        if (!fs.existsSync(backupPath)) {
            fs.copyFileSync(configPath, backupPath);
        }

        // Write updated settings
        fs.writeFileSync(configPath, JSON.stringify(settings, null, 2));

        return {
            success: true,
            message: `${ide} configured successfully`,
            path: configPath,
        };
    } catch (error) {
        return {
            success: false,
            message: `Failed to configure ${ide}: ${(error as Error).message}`,
        };
    }
}

function createEnvFile(): ConfigResult {
    const envContent = `# TokenSage Proxy Environment Variables
# Add these to your shell profile or run before starting your IDE

# For OpenAI-compatible APIs
OPENAI_BASE_URL=http://localhost:4000/v1
OPENAI_API_BASE=http://localhost:4000/v1

# For Anthropic
ANTHROPIC_BASE_URL=http://localhost:4000/v1

# For other tools
LLM_PROXY_URL=http://localhost:4000
`;

    const envPath = path.join(process.cwd(), '.env.proxy');
    fs.writeFileSync(envPath, envContent);

    return {
        success: true,
        message: 'Environment file created',
        path: envPath,
    };
}

function printInstructions(): void {
    console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║                    🔮 TokenSage Auto-Config Complete                       ║
╠═══════════════════════════════════════════════════════════════════════════╣
║                                                                           ║
║  IMPORTANT: Cursor stores OpenAI Base URL in its internal database.       ║
║  You need to configure it manually in Cursor Settings:                    ║
║                                                                           ║
║  ┌─────────────────────────────────────────────────────────────────────┐  ║
║  │  1. Open Cursor                                                     │  ║
║  │  2. Press Ctrl+Shift+J (or Cmd+Shift+J on Mac) to open Settings     │  ║
║  │  3. Go to "Models" tab                                              │  ║
║  │  4. Scroll down to "Override OpenAI Base URL"                       │  ║
║  │  5. Enter: http://localhost:4000/v1                                 │  ║
║  │  6. Save and restart Cursor                                         │  ║
║  └─────────────────────────────────────────────────────────────────────┘  ║
║                                                                           ║
║  For Windsurf:                                                            ║
║  ┌─────────────────────────────────────────────────────────────────────┐  ║
║  │  1. Open Windsurf Settings                                          │  ║
║  │  2. Find API Configuration section                                  │  ║
║  │  3. Set Base URL to: http://localhost:4000/v1                       │  ║
║  └─────────────────────────────────────────────────────────────────────┘  ║
║                                                                           ║
║  Alternative: Start Cursor from terminal with env vars:                   ║
║  ┌─────────────────────────────────────────────────────────────────────┐  ║
║  │  Windows PowerShell:                                                │  ║
║  │  $env:OPENAI_BASE_URL="http://localhost:4000/v1"; cursor            │  ║
║  │                                                                     │  ║
║  │  Windows CMD:                                                       │  ║
║  │  set OPENAI_BASE_URL=http://localhost:4000/v1 && cursor             │  ║
║  │                                                                     │  ║
║  │  Linux/Mac:                                                         │  ║
║  │  OPENAI_BASE_URL=http://localhost:4000/v1 cursor                    │  ║
║  └─────────────────────────────────────────────────────────────────────┘  ║
║                                                                           ║
║  Dashboard: http://localhost:4001                                         ║
║  Proxy: http://localhost:4000                                             ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
`);
}

async function main(): Promise<void> {
    console.log('🔮 TokenSage Auto-Config\n');

    const ides = ['cursor', 'windsurf', 'vscode'] as const;
    const results: ConfigResult[] = [];

    for (const ide of ides) {
        const result = configureIDE(ide);
        results.push(result);
        console.log(`${result.success ? '✅' : '⚠️'} ${ide}: ${result.message}`);
    }

    // Create env file
    const envResult = createEnvFile();
    console.log(`${envResult.success ? '✅' : '⚠️'} Env file: ${envResult.message}`);

    printInstructions();
}

main().catch(console.error);
