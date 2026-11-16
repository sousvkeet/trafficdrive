const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const crypto = require('crypto');

// Per-launch secret shared only with our own dashboard (via preload.js).
// The backend rejects any /api request without it, so websites can't drive
// the local API.
const API_TOKEN = crypto.randomBytes(32).toString('hex');

// True only for our local dashboard page (file://), not remote content.
function isTrustedSender(event) {
  try {
    const url = (event.senderFrame && event.senderFrame.url) || '';
    return url.startsWith('file://');
  } catch (_) {
    return false;
  }
}

// Keep a global reference of the window object so it isn't garbage collected.
let mainWindow;

// --- Backend server --------------------------------------------------------
// The dashboard (index.html) talks to a REST API on localhost:3000 to start
// / stop / pause traffic campaigns. We start that server inside the Electron
// main process so the user doesn't need to run a separate Node process.
let backendServer = null;
let serverModule = null;

async function startBackend() {
  try {
    // Load the server module (doesn't start listening yet)
    serverModule = require('./server.js');
    console.log('[Backend] Server module loaded.');

    // Start the server asynchronously
    // publishConnectionInfo lets local tools (the MCP server) attach to this
    // running app; set TD_NO_CONNECTION_FILE=1 to turn that off.
    // proxyAutomation: keep working proxies loaded (saved across restarts, topped up when too few)
    backendServer = await serverModule.startServer({ token: API_TOKEN, publishConnectionInfo: true, proxyAutomation: true });
    console.log('[Backend] Server started on port 3000.');
  } catch (err) {
    console.error('[Backend] Failed to start server:', err.message);
    // Don't crash the app if server fails - continue without backend
    backendServer = null;
  }
}

function stopBackend() {
  if (backendServer) {
    try { backendServer.close(); } catch (_) {}
    backendServer = null;
  }
  serverModule = null;
}

// --- Main window -----------------------------------------------------------

function createWindow() {
  try {
    console.log('[Main] Creating main window...');
    mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1100,
      minHeight: 700,
      title: 'TrafficDrive v5.9',
      backgroundColor: '#1a1a1a',
      autoHideMenuBar: true,
      icon: path.join(__dirname, 'logo.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      },
      show: false // Don't show until ready-to-show fires
    });

    let hasShown = false;

    // Show window when the page is loaded
    mainWindow.once('ready-to-show', () => {
      console.log('[Main] Window ready to show');
      if (mainWindow && !hasShown) {
        hasShown = true;
        mainWindow.show();
        mainWindow.focus();
      }
    });

    // Fallback: show window after 5 seconds even if ready-to-show never fires
    setTimeout(() => {
      if (mainWindow && !hasShown) {
        console.log('[Main] Showing window via fallback timer');
        hasShown = true;
        mainWindow.show();
        mainWindow.focus();
      }
    }, 5000);

    // Handle page load errors — retry once, then show error page
    let loadRetries = 0;
    const MAX_RETRIES = 2;

    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      console.error('[Main] Load failed:', errorCode, errorDescription);

      // Skip aborted navigations (errorCode -3) — these are normal during reloads
      if (errorCode === -3) return;

      if (loadRetries < MAX_RETRIES && mainWindow) {
        loadRetries++;
        console.log(`[Main] Retrying load (${loadRetries}/${MAX_RETRIES})...`);
        setTimeout(() => {
          if (!mainWindow) return;
          const indexPath = path.join(__dirname, 'index.html');
          const fileUrl = require('url').pathToFileURL(indexPath).toString();
          mainWindow.loadURL(fileUrl).catch(() => {});
        }, 500);
      } else if (mainWindow) {
        console.error('[Main] Max retries reached, showing error page');
        mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
          '<html><body style="background:#1a1a1a;color:#f0f0ff;font-family:sans-serif;' +
          'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0">' +
          '<h1 style="color:#a78bfa">NGF NOMI TOOLS</h1>' +
          '<p style="color:#9090b0;margin:10px 0">Failed to load the dashboard.</p>' +
          '<p style="color:#555570;font-size:13px">Please restart the application.</p>' +
          '<p style="color:#555570;font-size:12px;margin-top:20px">Error: ' + errorDescription + ' (' + errorCode + ')</p>' +
          '</body></html>'
        )).catch(() => {});
        if (!hasShown) {
          hasShown = true;
          mainWindow.show();
          mainWindow.focus();
        }
      }
    });

    // Load the dashboard — use loadURL with encoded path to handle spaces in directory name
    const indexPath = path.join(__dirname, 'index.html');
    const fileUrl = require('url').pathToFileURL(indexPath).toString();
    console.log('[Main] Loading:', fileUrl);

    mainWindow.loadURL(fileUrl).then(() => {
      console.log('[Main] Dashboard loaded successfully');
    }).catch(err => {
      console.error('[Main] loadURL failed:', err.message);
    });

    // Open external links in the user's default browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    // Never let the dashboard window itself navigate to remote content — that
    // page would get the preload bridge (and the API token).
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith('file://') || url.startsWith('data:')) return;
      event.preventDefault();
      if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    });

    // Diagnostics
    mainWindow.webContents.on('render-process-gone', (event, details) => {
      console.error('[Main] Renderer process gone:', details.reason, details.exitCode);
    });
    mainWindow.webContents.on('preload-error', (event, preloadPath, error) => {
      console.error('[Main] Preload error:', preloadPath, error.message);
    });
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      console.log(`[Renderer] ${message}`);
    });
    mainWindow.webContents.on('did-finish-load', () => {
      console.log('[Main] Page finished loading');
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
      console.log('[Main] Window closed');
    });

    console.log('[Main] Window created');
  } catch (err) {
    console.error('[Main] Error creating window:', err);
    throw err;
  }
}

// --- Menu ------------------------------------------------------------------

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- App lifecycle ---------------------------------------------------------

// Registered before any window exists: preload.js reads the token
// synchronously as the dashboard loads.
ipcMain.on('td-get-api-token', (event) => {
  event.returnValue = isTrustedSender(event) ? API_TOKEN : '';
});

app.whenReady().then(async () => {
  // IPC: native file picker for "Add custom browser" (window.prompt() is not
  // supported in Electron, so the old fallback did nothing).
  ipcMain.handle('open-file-dialog', async (event) => {
    if (!isTrustedSender(event)) return '';
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const filters = process.platform === 'win32'
      ? [{ name: 'Programs', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }]
      : [{ name: 'All files', extensions: ['*'] }];
    const result = await dialog.showOpenDialog(win, {
      title: 'Select browser executable',
      properties: ['openFile'],
      filters,
    });
    return result.canceled || !result.filePaths.length ? '' : result.filePaths[0];
  });

  // IPC: return the main window's content size for resolution display
  ipcMain.handle('get-window-size', () => {
    if (mainWindow) {
      const size = mainWindow.getContentSize();
      return { success: true, width: size[0], height: size[1] };
    }
    return { success: false, width: 1280, height: 800 };
  });

  // Start the backend first so the dashboard's first API calls (saved
  // schedules, browser detection, proxies) don't race the server startup.
  // startBackend() never throws; the window opens even if it fails.
  await startBackend();

  // Launch the main dashboard window
  createWindow();

  buildMenu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
