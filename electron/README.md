# Electron Desktop App

This directory contains the Electron desktop application for XLab Token.

## Structure

- `main.js` - Main Electron process (handles window creation and server management)
- `preload.js` - Preload script for secure IPC communication
- `assets/` - Application icons and resources

## Development

### Run in development mode

```bash
npm run electron:dev
```

This will start the Electron app with the development dashboard.

## Building

### Build for current platform

```bash
npm run electron:build
```

### Build for specific platforms

**Windows:**
```bash
npm run electron:build:win
```

**macOS:**
```bash
npm run electron:build:mac
```

**Linux:**
```bash
npm run electron:build:linux
```

## Cross-Platform Building

To build for all platforms, you need to run the build commands on each respective platform or use a CI/CD service like GitHub Actions.

### Platform-Specific Notes

**Windows:**
- Builds NSIS installer and portable executable
- Requires `icon.ico` file
- Output: `dist-electron/XLab Token Setup 1.0.4.exe` and `XLab Token 1.0.4.exe`

**macOS:**
- Builds DMG and ZIP archives
- Requires `icon.icns` file
- Supports both x64 and arm64 (Apple Silicon)
- Output: `dist-electron/XLab Token-1.0.4.dmg` and `XLab Token-1.0.4-mac.zip`

**Linux:**
- Builds AppImage, deb, and rpm packages
- Requires `icon.png` file
- Output: `dist-electron/XLab Token-1.0.4.AppImage`, `xlab-token_1.0.4_amd64.deb`, etc.

## Icons

### Generate placeholder icons

```bash
npm run generate-icons
```

This creates a placeholder SVG icon. For production, convert it to the required formats:

- `electron/assets/icon.png` (256x256 PNG for Linux)
- `electron/assets/icon.ico` (256x256 ICO for Windows)  
- `electron/assets/icon.icns` (ICNS for macOS)

### Icon conversion tools

- https://cloudconvert.com/svg-to-png
- https://cloudconvert.com/svg-to-ico
- https://cloudconvert.com/svg-to-icns
- https://www.favicon-generator.org/

## How It Works

1. **Electron Main Process** (`main.js`):
   - Creates a desktop window
   - Starts the Node.js server backend
   - Manages server lifecycle (start/stop)
   - Handles cross-platform differences

2. **Server Integration**:
   - The Electron app spawns the Node.js CLI server
   - Server runs on `http://127.0.0.1:3737`
   - Electron window loads the dashboard from the local server
   - IPC communication for server control

3. **Security**:
   - Context isolation enabled
   - Node integration disabled
   - Secure IPC via preload script

## Troubleshooting

### Server fails to start

- Check if Node.js is installed and accessible
- Verify `dist/cli.js` exists (run `npm run build` first)
- Check console logs for error messages

### Icon not showing

- Ensure icon files exist in `electron/assets/`
- Verify icon format matches platform (PNG/ICO/ICNS)
- On macOS, try removing the icon to use default

### Port already in use

- The app automatically finds an available port
- If issues persist, check for other processes using port 3737

## Platform-Specific Issues

**Windows:**
- May need to run as administrator for first installation
- Antivirus might flag the unsigned executable

**macOS:**
- First run may need to bypass Gatekeeper
- Use `xattr -cr /Applications/XLab\ Token.app` if needed

**Linux:**
- AppImage should work on most distributions
- For deb/rpm, ensure package manager compatibility
