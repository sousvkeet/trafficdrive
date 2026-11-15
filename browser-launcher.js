// browser-launcher.js
// Minimal Playwright browser launcher used by all traffic modules.
//
// Exposes `launchBrowser(opts)` which returns a Playwright Browser instance.
// Supports an optional custom Chromium/Edge/Chrome executable path so users
// can target a specific browser binary; otherwise falls back to the bundled
// Playwright Chromium build.
//
// If the exact Chromium revision Playwright expects is missing (e.g. disk
// was too full to download it), we automatically scan the ms-playwright
// cache for any complete chromium-* build and use that instead. We also fall
// back to the system-installed Google Chrome / Microsoft Edge as a last
// resort so the app works even with zero Playwright browsers downloaded.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Cache the resolved fallback path so we only scan the filesystem once.
let _cachedFallbackPath = null;

/**
 * When running inside a packaged Electron app (built with electron-builder),
 * the bundled Chromium browser is shipped under `process.resourcesPath/chromium`.
 * This avoids requiring the user to download Playwright browsers separately.
 * Returns the path to the bundled chrome.exe, or null when not packaged / missing.
 */
function findBundledBrowser() {
  try {
    const candidates = [];
    // Packaged Electron app: electron-builder copies extraResources to
    // process.resourcesPath.
    if (process && process.resourcesPath) {
      for (const sub of ['chrome-win64', 'chrome-win']) {
        candidates.push(path.join(process.resourcesPath, 'chromium', sub, 'chrome.exe'));
      }
    }
    // Dev mode: check the local bundled-chromium folder.
    for (const sub of ['chrome-win64', 'chrome-win']) {
      candidates.push(path.join(__dirname, 'bundled-chromium', sub, 'chrome.exe'));
    }
    for (const exe of candidates) {
      const dll = path.join(path.dirname(exe), 'chrome.dll');
      if (fs.existsSync(exe) && fs.existsSync(dll)) return exe;
    }
  } catch (_) {}
  return null;
}

/**
 * Scan the ms-playwright cache for any complete chromium-* build and return
 * the path to its chrome.exe. Returns null if none found.
 */
// Where Playwright keeps downloaded browsers on this OS.
function playwrightCacheDir() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') {
    return process.env.PLAYWRIGHT_BROWSERS_PATH;
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
}

// Executable locations inside one chromium-<rev> folder, per OS. Each entry
// is [exe, sanityFile] — the sanity file proves it's a complete build.
function chromiumLayouts(dir) {
  if (process.platform === 'win32') {
    return ['chrome-win64', 'chrome-win'].map(sub => [
      path.join(dir, sub, 'chrome.exe'), path.join(dir, sub, 'chrome.dll'),
    ]);
  }
  if (process.platform === 'darwin') {
    return ['chrome-mac-arm64', 'chrome-mac', 'chrome-mac-x64'].map(sub => {
      const exe = path.join(dir, sub, 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
      return [exe, exe];
    });
  }
  return ['chrome-linux64', 'chrome-linux'].map(sub => {
    const exe = path.join(dir, sub, 'chrome');
    return [exe, exe];
  });
}

function findCachedChromium() {
  if (_cachedFallbackPath !== null) return _cachedFallbackPath;
  // Previously only the Windows cache path was scanned, so this fallback
  // never worked on Linux/WSL or macOS.
  const cacheDir = playwrightCacheDir();
  let found = null;
  try {
    if (!fs.existsSync(cacheDir)) return null;
    const dirs = fs.readdirSync(cacheDir)
      .filter(d => /^chromium-\d+$/.test(d))
      .sort((a, b) => {
        // Prefer the highest revision number (most recent).
        const na = parseInt(a.replace('chromium-', ''), 10);
        const nb = parseInt(b.replace('chromium-', ''), 10);
        return nb - na;
      });
    for (const d of dirs) {
      for (const [exe, sanity] of chromiumLayouts(path.join(cacheDir, d))) {
        if (fs.existsSync(exe) && fs.existsSync(sanity)) {
          found = exe;
          break;
        }
      }
      if (found) break;
    }
  } catch (_) {}
  _cachedFallbackPath = found;
  return found;
}

/**
 * Look for a system-installed Chrome / Chromium / Edge binary as a last resort.
 */
function findSystemBrowser() {
  let candidates;
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates = [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
  } else if (process.platform === 'darwin') {
    candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  } else {
    candidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge',
    ];
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

/**
 * Launch a Chromium-based browser.
 *
 * @param {Object} opts
 * @param {boolean} [opts.headless=true]  - run headless or visible
 * @param {string} [opts.customBrowserPath] - path to a custom browser executable
 * @param {string[]} [opts.args] - extra Chromium launch args
 * @param {Function} [opts.onLog] - log callback (msg) => void
 * @param {string} [opts.sessionId] - label used in log messages
 * @returns {Promise<import('playwright').Browser>}
 */
async function launchBrowser(opts = {}) {
  const {
    headless = true,
    customBrowserPath,
    args = [],
    onLog = () => {},
    sessionId = 'Session',
  } = opts;

  const launchOptions = {
    headless: !!headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      ...args,
    ],
  };

  // Priority 1: explicit custom browser path from the user.
  if (customBrowserPath && typeof customBrowserPath === 'string' && customBrowserPath.trim()) {
    launchOptions.executablePath = customBrowserPath.trim();
    onLog(`[${sessionId}] Using custom browser: ${customBrowserPath}`);
  }

  // Priority 1b: when running inside a packaged app, prefer the browser we
  // shipped alongside the app (extraResources) so no separate download is
  // required. This is skipped if the user explicitly set a custom path.
  if (!launchOptions.executablePath) {
    const bundled = findBundledBrowser();
    if (bundled) {
      launchOptions.executablePath = bundled;
      onLog(`[${sessionId}] Using bundled browser: ${bundled}`);
    }
  }

  let lastErr = null;
  try {
    const browser = await chromium.launch(launchOptions);
    return browser;
  } catch (err) {
    lastErr = err;
    onLog(`[${sessionId}] Primary browser launch failed: ${err.message}`);
  }

  // Priority 2: fall back to any complete cached Playwright Chromium build.
  if (launchOptions.executablePath) {
    delete launchOptions.executablePath;
  }
  const cached = findCachedChromium();
  if (cached) {
    onLog(`[${sessionId}] Falling back to cached Chromium build: ${cached}`);
    try {
      launchOptions.executablePath = cached;
      return await chromium.launch(launchOptions);
    } catch (err) {
      lastErr = err;
      onLog(`[${sessionId}] Cached Chromium failed: ${err.message}`);
      delete launchOptions.executablePath;
    }
  }

  // Priority 3: fall back to system Chrome / Edge.
  const sysBrowser = findSystemBrowser();
  if (sysBrowser) {
    onLog(`[${sessionId}] Falling back to system browser: ${sysBrowser}`);
    try {
      launchOptions.executablePath = sysBrowser;
      return await chromium.launch(launchOptions);
    } catch (err) {
      lastErr = err;
      onLog(`[${sessionId}] System browser failed: ${err.message}`);
    }
  }

  throw lastErr || new Error('No usable Chromium browser found');
}

module.exports = { launchBrowser, chromium, findBundledBrowser, findCachedChromium, findSystemBrowser };
