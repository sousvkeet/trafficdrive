// AppPaths.js — where TrafficDrive keeps its files. Shared by the backend and
// the MCP server (which must locate api.json without loading the backend).
const path = require('path');
const os = require('os');

// Windows keeps the historical %LOCALAPPDATA%\NGF NOMI TOOLS location. Other
// platforms used to get that Windows-style path under ~, where saving silently
// failed (the folder never existed) — so schedules were never persisted.
// TD_DATA_DIR overrides everything (tests, portable installs).
function appDataDir() {
  if (process.env.TD_DATA_DIR) return process.env.TD_DATA_DIR;
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'NGF NOMI TOOLS');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'NGF NOMI TOOLS');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'NGF NOMI TOOLS');
}

// Connection file written by the running app (url, token, pid) so local tools
// can attach to it. Owner-only permissions.
function connectionFile() {
  return path.join(appDataDir(), 'api.json');
}

module.exports = { appDataDir, connectionFile };
