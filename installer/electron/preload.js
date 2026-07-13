const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  getServerInfo: () => ipcRenderer.invoke('get-server-info'),
  restartServer: () => ipcRenderer.invoke('restart-server'),
  onServerEvent: (callback) => ipcRenderer.on('server-event', callback),
  removeServerEventListener: (callback) => ipcRenderer.removeListener('server-event', callback)
});
