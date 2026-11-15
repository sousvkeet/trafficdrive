// Preload script runs in an isolated context with access to a limited subset
// of Node.js APIs. We use contextBridge to safely expose a small IPC surface
// to the renderer (index.html):
//   - window size (resolution display)
//   - the per-launch API token the local backend requires on every request
//   - a native file picker for choosing a custom browser executable
const { contextBridge, ipcRenderer } = require('electron');

let apiToken = '';
try {
  apiToken = ipcRenderer.sendSync('td-get-api-token') || '';
} catch (_) {}

contextBridge.exposeInMainWorld('trafficdrive', {
  // Returns { success, width, height } for the current window's content size.
  getWindowSize: () => ipcRenderer.invoke('get-window-size'),
  apiToken,
});

contextBridge.exposeInMainWorld('electronAPI', {
  // Resolves to the selected file path, or '' when cancelled.
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
});

window.addEventListener('DOMContentLoaded', () => {
  console.log('TrafficDrive desktop shell loaded.');
});
