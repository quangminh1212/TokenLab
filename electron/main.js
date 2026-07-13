const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');

let mainWindow;
let serverProcess;
let serverPort = 3737;
let serverHost = '127.0.0.1';

// Get platform-specific icon
function getIconPath() {
  const iconDir = path.join(__dirname, 'assets');
  
  if (process.platform === 'win32') {
    const winIcon = path.join(iconDir, 'icon.ico');
    if (fs.existsSync(winIcon)) return winIcon;
  } else if (process.platform === 'darwin') {
    const macIcon = path.join(iconDir, 'icon.icns');
    if (fs.existsSync(macIcon)) return macIcon;
  }
  
  // Default to PNG for Linux and fallback
  const pngIcon = path.join(iconDir, 'icon.png');
  return fs.existsSync(pngIcon) ? pngIcon : undefined;
}

// Check if port is available
function isPortAvailable(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, host, () => {
      server.once('close', () => resolve(true));
      server.close();
    });
    server.on('error', () => resolve(false));
  });
}

// Find available port
async function findAvailablePort(startPort, host) {
  let port = startPort;
  while (!(await isPortAvailable(port, host))) {
    port++;
  }
  return port;
}

// Start the Node.js server
async function startServer() {
  return new Promise(async (resolve, reject) => {
    try {
      // Find available port
      serverPort = await findAvailablePort(serverPort, serverHost);
      
      const serverPath = path.join(__dirname, '..', 'dist', 'cli.js');
      const args = ['serve', '--host', serverHost, '--port', String(serverPort), '--no-tray'];
      
      console.log('Starting server on', serverHost + ':' + serverPort);
      console.log('Server path:', serverPath);
      
      // Use platform-specific node executable
      const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node';
      const spawnOptions = {
        stdio: 'inherit',
        detached: false
      };

      // On Windows, we might need shell: true for proper path resolution
      if (process.platform === 'win32') {
        spawnOptions.shell = true;
      }

      serverProcess = spawn(nodeCmd, [serverPath, ...args], spawnOptions);

      serverProcess.on('error', (err) => {
        console.error('Failed to start server:', err);
        reject(err);
      });

      serverProcess.on('exit', (code) => {
        console.log('Server exited with code:', code);
        if (code !== 0) {
          reject(new Error(`Server exited with code ${code}`));
        }
      });

      // Wait for server to be ready
      let attempts = 0;
      const maxAttempts = 30;
      
      const checkServer = async () => {
        if (await isPortAvailable(serverPort, serverHost)) {
          // Port is still available, server not ready yet
          if (attempts < maxAttempts) {
            attempts++;
            setTimeout(checkServer, 500);
          } else {
            reject(new Error('Server failed to start'));
          }
        } else {
          // Port is in use, server is ready
          console.log('Server is ready on', serverHost + ':' + serverPort);
          resolve({ host: serverHost, port: serverPort });
        }
      };

      setTimeout(checkServer, 1000);
    } catch (err) {
      reject(err);
    }
  });
}

function createWindow() {
  const iconPath = process.platform === 'win32' 
    ? path.join(__dirname, 'assets', 'icon.ico')
    : path.join(__dirname, 'assets', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'XLab Token',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    }
  });

  // Load the app
  mainWindow.loadURL(`http://${serverHost}:${serverPort}/`);

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    await startServer();
    createWindow();
  } catch (err) {
    console.error('Failed to start app:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopServer();
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  stopServer();
});

function stopServer() {
  if (serverProcess) {
    console.log('Stopping server...');
    try {
      // Use platform-specific signal
      if (process.platform === 'win32') {
        serverProcess.kill();
      } else {
        serverProcess.kill('SIGTERM');
      }
    } catch (err) {
      console.error('Error stopping server:', err);
    }
    serverProcess = null;
  }
}

// IPC handlers
ipcMain.handle('get-server-info', () => {
  return { host: serverHost, port: serverPort };
});

ipcMain.handle('restart-server', async () => {
  stopServer();
  await startServer();
  mainWindow.loadURL(`http://${serverHost}:${serverPort}/`);
  return { host: serverHost, port: serverPort };
});
