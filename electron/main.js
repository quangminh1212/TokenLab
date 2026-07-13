const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

let mainWindow;
let serverProcess;
let serverPort = 3737;
let serverHost = '127.0.0.1';

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
      
      serverProcess = spawn('node', [serverPath, ...args], {
        stdio: 'inherit',
        shell: true
      });

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
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    },
    icon: path.join(__dirname, 'assets', 'icon.png')
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
    serverProcess.kill('SIGTERM');
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
