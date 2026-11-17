// server.js
// NGF NOMI TOOLS backend server — wires the 4 traffic modules to the dashboard's
// REST API on http://localhost:3000.
//
// Endpoints (all match what index.html calls):
//   POST /api/organic/start    → Organic Search.js   (startOrganicSearch)
//   POST /api/direct/start     → Directtraffic.js    (startDirectTraffic)
//   POST /api/referral/start   → SocialTraffic.js    (startSocialTraffic)
//   POST /api/gmaps/start      → Google map traffic.js (startGoogleMapsTraffic)
//   POST /api/stop/:id         → stop a specific campaign
//   POST /api/stop-all         → stop all campaigns
//   POST /api/pause/:id        → pause a campaign
//   POST /api/resume/:id       → resume a campaign
//   GET  /api/logs/:id         → poll logs for a campaign
//   GET  /api/proxies          → return loaded proxies
//   POST /api/proxies/load     → store proxies
//   POST /api/proxies/validate → validate proxies
//   POST /api/autorestart/enable  → enable auto-restart
//   POST /api/autorestart/disable → disable auto-restart
//   GET  /api/browsers/detect  → detect installed browsers
//   GET  /api/health           → health check
//
// Security: every /api request must carry the per-launch API token (header
// `X-TD-Token`, or `?token=` for EventSource). main.js generates the token
// and hands it to the dashboard through the preload bridge. Requests from web
// origins are rejected outright, so a website the user (or a traffic session)
// visits cannot drive this API.

const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const extractZip = require('extract-zip'); // Browser zip extraction
const PrivacyCatalog = require('./PrivacyCatalog.js');
const LibraryCatalog = require('./LibraryCatalog.js');

// --- App data directory ------------------------------------------------------
const { appDataDir } = require('./AppPaths.js');

// Write JSON atomically (temp file + rename) and create the folder first.
function writeJsonFile(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}
function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

// --- API auth --------------------------------------------------------------
let apiToken = process.env.TD_API_TOKEN || '';

// The dashboard is loaded from file://, which Chromium reports as Origin
// "null" (some Electron builds send "file://"). Anything else is a web page.
function isAllowedOrigin(origin) {
  return !origin || origin === 'null' || origin === 'file://';
}

// Blocks DNS-rebinding: only accept requests addressed to this machine.
function isAllowedHost(host) {
  const h = String(host || '').toLowerCase();
  return h === `localhost:${PORT}` || h === `127.0.0.1:${PORT}` || h === `[::1]:${PORT}`;
}

function tokenMatches(candidate) {
  if (!apiToken || typeof candidate !== 'string' || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(apiToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function corsHeaders(req) {
  const origin = req && req.headers ? req.headers.origin : undefined;
  if (!origin || !isAllowedOrigin(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-TD-Token',
    'Vary': 'Origin',
  };
}

// Only http(s) URLs may be handed to browsers / downloaders. Returns the
// normalised URL string or '' when invalid.
function safeHttpUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.toString() : '';
  } catch (_) {
    return '';
  }
}

// --- Traffic modules -------------------------------------------------------
// Lazy-loaded to avoid blocking startup
let directTraffic = null;
let organicSearch = null;
let googleMapsTraffic = null;
let socialTraffic = null;

function getDirectTraffic() {
  if (!directTraffic) directTraffic = require('./Directtraffic.js');
  return directTraffic;
}

function getOrganicSearch() {
  if (!organicSearch) organicSearch = require('./Organic Search.js');
  return organicSearch;
}

function getGoogleMapsTraffic() {
  if (!googleMapsTraffic) googleMapsTraffic = require('./Google map traffic.js');
  return googleMapsTraffic;
}

function getSocialTraffic() {
  if (!socialTraffic) socialTraffic = require('./SocialTraffic.js');
  return socialTraffic;
}

// --- State -----------------------------------------------------------------
// processId → { emitter, logs: [], status, type, config }
const processes = new Map();

// In-memory proxy store (populated by /api/proxies/load)
let loadedProxies = [];

// Mirrors the dashboard's Auto-Loop toggle. The dashboard drives the loop
// itself (it restarts the campaign when polling reports `completed`); the
// flag is kept here so other clients can read it via /api/health.
let autoRestartEnabled = false;

// Prevent unhandled rejections/exceptions from crashing the server
process.on('unhandledRejection', (reason) => {
  console.error('[NGF NOMI TOOLS] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[NGF NOMI TOOLS] Uncaught exception:', err.message);
});

// RPA state — holds the recording browser/context/page and actions
const rpaState = { browser: null, context: null, page: null, actions: [], recording: false };

const RPA_ACTION_TYPES = ['click', 'input', 'key', 'scroll', 'navigate'];
const MAX_RPA_ACTIONS = 20000;

function sanitizeRpaActions(actions) {
  if (!Array.isArray(actions)) throw httpError(400, 'actions must be an array');
  if (actions.length > MAX_RPA_ACTIONS) throw httpError(400, `Too many actions (max ${MAX_RPA_ACTIONS})`);
  const out = [];
  for (const a of actions) {
    if (!a || typeof a !== 'object' || !RPA_ACTION_TYPES.includes(a.type)) continue;
    const clean = { type: a.type };
    for (const k of ['selector', 'value', 'key', 'url']) if (typeof a[k] === 'string') clean[k] = a[k].slice(0, 2000);
    for (const k of ['x', 'y', 'ts']) if (Number.isFinite(Number(a[k]))) clean[k] = Number(a[k]);
    out.push(clean);
  }
  return out;
}

function loadRpaRecordings() {
  const data = readJsonFile(RPA_RECORDINGS_FILE, { recordings: [] });
  return Array.isArray(data.recordings) ? data.recordings : [];
}
function saveRpaRecordings(list) { writeJsonFile(RPA_RECORDINGS_FILE, { recordings: list }); }
function rpaRecordingMeta(r) {
  return { id: r.id, name: r.name, date: r.date, duration: r.duration || 0, actionCount: (r.actions || []).length };
}
function saveRpaRecording({ name, actions, duration }) {
  const clean = sanitizeRpaActions(actions);
  const list = loadRpaRecordings();
  const rec = {
    id: 'rec_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
    name: String(name || '').trim().slice(0, 120) || 'recording_' + Date.now(),
    date: new Date().toISOString(),
    duration: Number(duration) || 0,
    actions: clean,
  };
  list.unshift(rec);
  saveRpaRecordings(list);
  return rec;
}

// Replays recorded actions in a fresh browser. Shared by POST /api/rpa/play (waits for the
// result) and the "rpa" campaign mode (runs in the background and can be paused / stopped).
//   opts: { speed, headless, shouldStop(), isPaused(), onLog(msg, type), onBrowser(browser) }
async function replayActions(actions, opts = {}) {
  const speed = opts.speed > 0 ? opts.speed : 1;
  const shouldStop = opts.shouldStop || (() => false);
  const isPaused = opts.isPaused || (() => false);
  const log = opts.onLog || (() => {});
  // Waits in short slices so Stop / Pause take effect promptly.
  const pause = async (ms) => {
    const end = Date.now() + ms;
    while (!shouldStop() && Date.now() < end) await new Promise(r => setTimeout(r, Math.min(200, Math.max(1, end - Date.now()))));
    while (isPaused() && !shouldStop()) await new Promise(r => setTimeout(r, 200));
  };
  let browser = null;
  let played = 0;
  try {
    const { chromium } = require('playwright');
    const browserPath = findCachedChromiumSafe();
    const launchOpts = { headless: !!opts.headless };
    if (browserPath) launchOpts.executablePath = browserPath;
    browser = await chromium.launch(launchOpts);
    if (opts.onBrowser) opts.onBrowser(browser);
    const context = await browser.newContext();
    const page = await context.newPage();
    const firstUrl = safeHttpUrl((actions.find(a => a.url) || {}).url) || 'https://www.google.com';
    log(`Opening ${firstUrl}`);
    try { await page.goto(firstUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (_) {}
    let lastTs = actions[0] && actions[0].ts ? actions[0].ts : 0;
    for (const action of actions) {
      if (shouldStop()) break;
      // Delay based on the recorded timestamps (scaled by speed, clamped).
      const actualDelay = action.ts ? (action.ts - lastTs) : 100;
      lastTs = action.ts || lastTs;
      await pause(Math.max(50, Math.min(actualDelay / speed, 5000)));
      if (shouldStop()) break;
      try {
        const actionUrl = safeHttpUrl(action.url);
        if (action.type === 'navigate') {
          // The previous click may already have navigated there.
          if (actionUrl && page.url() !== actionUrl) {
            await page.waitForURL(actionUrl, { timeout: 3000 }).catch(() => {});
            if (page.url() !== actionUrl) {
              try { await page.goto(actionUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (_) {}
            }
          }
          played++;
          continue;
        }
        // Make sure we're on the page the action was recorded on.
        if (actionUrl && actionUrl !== page.url()) {
          await page.waitForURL(actionUrl, { timeout: 5000 }).catch(() => {});
          if (page.url() !== actionUrl) {
            try { await page.goto(actionUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (_) {}
          }
        }
        if (action.type === 'click') {
          await page.mouse.click(Number(action.x) || 0, Number(action.y) || 0);
        } else if (action.type === 'input' && action.selector) {
          try {
            await page.click(action.selector, { timeout: 5000 });
            await page.fill(action.selector, String(action.value || ''));
          } catch (_) {
            // Fallback: try typing into focused element
            try { await page.keyboard.type(String(action.value || '')); } catch (_) {}
          }
        } else if (action.type === 'key' && action.key) {
          try { await page.press(action.selector || 'body', action.key, { timeout: 5000 }); } catch (_) {
            try { await page.keyboard.press(action.key); } catch (_) {}
          }
        } else if (action.type === 'scroll') {
          // page.evaluate takes ONE argument — the old (x, y) form always threw.
          await page.evaluate(({ x, y }) => window.scrollTo(x, y), { x: Number(action.x) || 0, y: Number(action.y) || 0 });
        }
        played++;
        if (played % 25 === 0) log(`${played}/${actions.length} actions replayed`);
      } catch (_) {}
    }
    if (!shouldStop()) await pause(3000);
    return { actionsPlayed: played };
  } finally {
    if (browser) browser.close().catch(() => {});
  }
}

function buildRpaConfig(body) {
  const speed = Math.min(10, Math.max(0.25, parseFloat(body.speed) > 0 ? parseFloat(body.speed) : 1));
  let actions, name, recordingId = null;
  if (body.recordingId) {
    const rec = loadRpaRecordings().find(r => r.id === body.recordingId);
    if (!rec) throw httpError(404, 'Recording not found');
    actions = rec.actions; name = rec.name; recordingId = rec.id;
  } else {
    actions = sanitizeRpaActions(body.actions || []);
    name = 'inline actions';
  }
  if (!actions.length) throw httpError(400, 'The recording has no actions to replay');
  return {
    sessions: 1, threads: 1, headless: !!body.headless, speed, actions, recordingId, recordingName: name,
    targetLabel: `RPA replay: ${name}`, privacyFeatures: [], privacyLevel: 'standard',
  };
}

// A replay as a campaign: same lifecycle as the traffic modes (status / stats / summary / log,
// pause, resume, stop), so it can be scheduled, looped, listed and watched like any other.
function startRpaReplay(config) {
  const emitter = new (require('events'))();
  let stopped = false, paused = false, browser = null;
  const stats = (o) => emitter.emit('stats', { total: 1, completed: 0, running: 0, pending: 0, failed: 0, stopped: 0, activeBrowsers: 0, remaining: 0, progress: 0, ...o });
  emitter.on('stop', async () => {
    stopped = true;
    emitter.emit('status', 'stopped');
    emitter.emit('log', 'Stop signal received. Closing the replay browser...');
    try { if (browser) await browser.close(); } catch (_) {}
  });
  emitter.on('pause', () => { paused = true; emitter.emit('status', 'paused'); emitter.emit('log', 'Replay paused.'); });
  emitter.on('resume', () => { paused = false; emitter.emit('status', 'running'); emitter.emit('log', 'Replay resumed.'); });
  setImmediate(async () => {
    emitter.emit('status', 'running');
    stats({ running: 1, activeBrowsers: 1, remaining: 1 });
    emitter.emit('log', `Replaying "${config.recordingName}" (${config.actions.length} actions, ${config.speed}x)`);
    try {
      const r = await replayActions(config.actions, {
        speed: config.speed, headless: config.headless,
        shouldStop: () => stopped, isPaused: () => paused,
        onLog: (m) => emitter.emit('log', m), onBrowser: (b) => { browser = b; },
      });
      if (stopped) { stats({ stopped: 1 }); emitter.emit('summary', { completed: 0, pending: 0, failed: 0, stopped: 1, totalProcessed: 0, remaining: 0 }); return; }
      emitter.emit('log', `Replay complete (${r.actionsPlayed} actions).`);
      stats({ completed: 1, progress: 100 });
      emitter.emit('summary', { completed: 1, pending: 0, failed: 0, stopped: 0, totalProcessed: 1, remaining: 0, actionsPlayed: r.actionsPlayed });
      emitter.emit('status', 'completed');
    } catch (e) {
      if (stopped) return;
      emitter.emit('log', `Replay failed: ${e.message}`, 'error');
      stats({ failed: 1 });
      emitter.emit('summary', { completed: 0, pending: 0, failed: 1, stopped: 0, totalProcessed: 1, remaining: 0 });
      emitter.emit('status', 'failed');
    }
  });
  return emitter;
}

async function closeRpaBrowser() {
  const browser = rpaState.browser;
  rpaState.browser = null;
  rpaState.context = null;
  rpaState.page = null;
  if (browser) {
    try { await browser.close(); } catch (_) {}
  }
}

// Injected into every page of the recording context (top frame only).
// Pushes each action to Node via the exposed __rpaPush binding.
function rpaRecorderScript() {
  if (window.top !== window || window.__rpaInstalled) return;
  window.__rpaInstalled = true;
  const push = (a) => {
    try {
      if (typeof window.__rpaPush === 'function') {
        window.__rpaPush(Object.assign({ ts: Date.now(), url: location.href }, a));
      }
    } catch (_) {}
  };
  const esc = (v) => (window.CSS && CSS.escape) ? CSS.escape(String(v)) : String(v).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  const selectorFor = (el) => {
    if (!el || !el.tagName) return 'body';
    if (el.id) return '#' + esc(el.id);
    let sel = el.tagName.toLowerCase();
    const name = el.getAttribute && el.getAttribute('name');
    if (name) sel += '[name="' + String(name).replace(/["\\]/g, '\\$&') + '"]';
    else if (el.classList && el.classList.length) sel += '.' + esc(el.classList[0]);
    return sel;
  };
  let pendingInput = null;
  let inputTimer = null;
  const flushInput = () => {
    if (inputTimer) { clearTimeout(inputTimer); inputTimer = null; }
    if (pendingInput) { push(pendingInput); pendingInput = null; }
  };
  window.__rpaFlush = flushInput;
  document.addEventListener('click', (e) => {
    flushInput();
    push({ type: 'click', selector: selectorFor(e.target), x: e.clientX, y: e.clientY });
  }, true);
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el || !('value' in el)) return;
    pendingInput = { type: 'input', selector: selectorFor(el), value: el.value, ts: Date.now(), url: location.href };
    if (inputTimer) clearTimeout(inputTimer);
    inputTimer = setTimeout(flushInput, 500);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') {
      flushInput(); // typed text must be recorded before the key that submits it
      push({ type: 'key', key: e.key, selector: selectorFor(e.target) });
    }
  }, true);
  let scrollTimer = null;
  window.addEventListener('scroll', () => {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => push({ type: 'scroll', x: window.scrollX, y: window.scrollY }), 500);
  }, true);
  window.addEventListener('pagehide', flushInput, true);
}

// Schedule state — persisted to disk
const SCHEDULE_FILE = path.join(appDataDir(), 'schedule.json');
const RPA_RECORDINGS_FILE = path.join(appDataDir(), 'rpa-recordings.json');
const DISCOVERY_FILE = path.join(appDataDir(), 'api.json');
const SETTINGS_FILE = path.join(appDataDir(), 'settings.json');
const SAVED_CAMPAIGNS_FILE = path.join(appDataDir(), 'saved-campaigns.json');
let scheduleState = {};
let savedSchedules = [];
let scheduleLoaded = false;

function loadScheduleData() {
  if (scheduleLoaded) return;
  scheduleState = readJsonFile(SCHEDULE_FILE, {});
  savedSchedules = Array.isArray(scheduleState.savedSchedules) ? scheduleState.savedSchedules : [];
  scheduleLoaded = true;
}

function persistSchedules() {
  try { writeJsonFile(SCHEDULE_FILE, { ...scheduleState, savedSchedules }); } catch (e) { console.error('[schedule] save failed:', e.message); }
}

// --- Server-side scheduler -----------------------------------------------------
// Schedules saved with runner:'server' (created through the API / MCP) are run
// by the backend itself, so they fire even when no dashboard is open.
// Schedules the dashboard creates have no runner and stay dashboard-driven.
const SCHEDULER_TICK_MS = 5000;
const MISSED_GRACE_MS = 5 * 60 * 1000; // a one-shot that is >5 min overdue (app was off) is skipped
let schedulerTimer = null;

// Next time (ms epoch, strictly after `from`) this schedule should run, or null.
function computeNextRun(sched, from) {
  if (sched.type === 'delay') {
    const secs = (sched.delayHours || 0) * 3600 + (sched.delayMinutes || 0) * 60 + (sched.delaySeconds || 0);
    return (sched.createdAt || from) + secs * 1000;
  }
  if (sched.type === 'datetime') {
    const t = new Date(sched.datetime).getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (sched.type === 'recurring') {
    const days = Array.isArray(sched.days) ? sched.days.map(Number) : [];
    const [hh, mm] = String(sched.recurTime || '09:00').split(':').map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i <= 7; i++) {
      const d = new Date(from);
      d.setDate(d.getDate() + i);
      d.setHours(hh, mm, 0, 0);
      if (days.includes(d.getDay()) && d.getTime() > from) return d.getTime();
    }
  }
  return null;
}

// The campaign request a schedule starts. Schedules made by the dashboard only
// store a handful of fields — map them to a start request.
function scheduleRequest(sched) {
  if (sched.request && typeof sched.request === 'object') return { mode: sched.request.mode || sched.trafficMode, ...sched.request };
  const mode = sched.trafficMode || 'direct';
  const req = { mode, url: sched.url, sessions: sched.sessions, threads: sched.threads, headless: !!sched.headless };
  if (mode === 'organic') req.keyword = sched.keyword;
  if (mode === 'referral') req.platform = sched.refPlatform;
  if (mode === 'gmaps') { req.businessName = sched.keyword; req.website = sched.url; }
  return req;
}

async function runSchedule(sched, reason) {
  const req = scheduleRequest(sched);
  const proc = await startCampaignVerified(String(req.mode || ''), req, 'schedule');
  sched.lastRunAt = Date.now();
  sched.lastProcessId = proc.id;
  sched.runCount = (sched.runCount || 0) + 1;
  delete sched.lastError;
  pushLog(proc, `Started by schedule "${sched.name || sched.id}" (${reason})`, 'info');
  return proc;
}

function schedulerTick() {
  loadScheduleData();
  const now = Date.now();
  let changed = false;
  for (const sched of savedSchedules) {
    if (sched.runner !== 'server' || !sched.enabled || !sched.nextRunAt || sched.nextRunAt > now) continue;
    const overdue = now - sched.nextRunAt;
    changed = true;
    if (sched.type !== 'recurring' && overdue > MISSED_GRACE_MS) {
      sched.enabled = false; sched.nextRunAt = null; sched.lastError = 'Missed: the app was not running at the scheduled time';
      continue;
    }
    try {
      if (sched.type === 'recurring' && overdue > MISSED_GRACE_MS) sched.lastError = 'Skipped one missed run (app was not running)';
      else {
        // starting may take a moment (the proxies are checked first), so the tick does not wait for it
        runSchedule(sched, sched.type === 'recurring' ? 'recurring' : 'scheduled')
          .then(() => persistSchedules(), (e) => { sched.lastError = e.message; persistSchedules(); });
      }
    } catch (e) {
      sched.lastError = e.message;
    }
    if (sched.type === 'recurring') sched.nextRunAt = computeNextRun(sched, now);
    else { sched.enabled = false; sched.nextRunAt = null; }
  }
  if (changed) persistSchedules();
}

function startScheduler() {
  if (schedulerTimer) return;
  schedulerTick();
  schedulerTimer = setInterval(schedulerTick, SCHEDULER_TICK_MS);
  if (schedulerTimer.unref) schedulerTimer.unref();
}

// Validate + normalise a schedule from the API. Throws httpError(400).
function prepareSchedule(body, existing) {
  const sched = { ...(existing || {}), ...body };
  sched.id = body.id || (existing && existing.id) || ('sched_' + Date.now());
  sched.enabled = body.enabled !== false;
  sched.savedAt = Date.now();
  if (sched.runner !== 'server') return sched; // dashboard-managed: store as given
  sched.createdAt = Date.now();
  if (!['delay', 'datetime', 'recurring'].includes(sched.type)) throw httpError(400, 'type must be delay, datetime or recurring');
  if (!sched.request || typeof sched.request !== 'object') throw httpError(400, 'request (the campaign to run) is required');
  const mode = String(sched.request.mode || '');
  if (!CAMPAIGN_MODES[mode]) throw httpError(400, `request.mode must be one of: ${Object.keys(CAMPAIGN_MODES).join(', ')}`);
  CAMPAIGN_MODES[mode].build(sched.request); // fail now, not at run time
  sched.trafficMode = mode;
  if (sched.type === 'delay') {
    const total = (sched.delayHours || 0) * 3600 + (sched.delayMinutes || 0) * 60 + (sched.delaySeconds || 0);
    if (!(total > 0)) throw httpError(400, 'delay must be greater than zero');
  } else if (sched.type === 'datetime') {
    const t = new Date(sched.datetime).getTime();
    if (!Number.isFinite(t)) throw httpError(400, 'datetime is not a valid date');
    if (t <= Date.now()) throw httpError(400, 'datetime is in the past');
  } else if (!Array.isArray(sched.days) || !sched.days.length || !/^\d{1,2}:\d{2}$/.test(String(sched.recurTime || ''))) {
    throw httpError(400, 'recurring needs days (0=Sun..6=Sat) and recurTime "HH:MM"');
  }
  sched.nextRunAt = sched.enabled ? computeNextRun(sched, Date.now()) : null;
  delete sched.lastError;
  return sched;
}

// --- Proxy scraping helpers -----------------------------------------------
// Fetches free proxy lists from multiple public sources and returns an
// array of { type, host, port, username, password, raw } records.

const MAX_REDIRECTS = 5;

// --- Proxies: parsing, sources, validation ----------------------------------
// Parsing lives in ProxyTools.js, the list of download sources in ProxySources.js and the checker in
// ProxyValidator.js. Each proxy in the list can carry status ('working' | 'dead'), ms and checkedAt once checked.
const ProxyTools = require('./ProxyTools.js');
const ProxySources = require('./ProxySources.js');
const { ValidationJob } = require('./ProxyValidator.js');
const { createProxyAutomation } = require('./ProxyAutomation.js');
const proxySources = ProxySources.createSourceStore(path.join(appDataDir(), 'proxy-sources.json'));

const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

// Only the fields we know, validated — never whatever a client sent (that includes status/ms).
function cleanProxyRecord(p) {
  if (!p || typeof p !== 'object') return null;
  const host = typeof p.host === 'string' ? p.host.trim() : '';
  const port = parseInt(p.port, 10);
  if (!host || !ProxyTools.validHost(host) || !(port >= 1 && port <= 65535)) return null;
  const type = ProxyTools.SCHEMES.includes(String(p.type).toLowerCase()) ? String(p.type).toLowerCase() : 'http';
  const str = (v) => (typeof v === 'string' && v ? v.slice(0, 200) : null);
  return { type, host, port, username: str(p.username), password: str(p.password), raw: `${host}:${port}` };
}

function addToProxyList(records) {
  const seen = new Set(loadedProxies.map(ProxyTools.dedupeKey));
  let added = 0, invalid = 0;
  for (const r of records) {
    const p = cleanProxyRecord(r);
    if (!p) { invalid++; continue; }
    const k = ProxyTools.dedupeKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    loadedProxies.push(p);
    added++;
  }
  return { added, invalid, duplicates: records.length - added - invalid };
}

function proxyStats() {
  let working = 0, dead = 0, sum = 0;
  for (const p of loadedProxies) {
    if (p.status === 'working') { working++; if (typeof p.ms === 'number') sum += p.ms; } else if (p.status === 'dead') dead++;
  }
  return { total: loadedProxies.length, working, dead, unchecked: loadedProxies.length - working - dead, avgMs: working ? Math.round(sum / working) : null };
}

const validationJobs = new Map();
let activeValidation = null;
let validationSeq = 0;

function validationOptions(body) {
  const secs = body.timeoutSeconds !== undefined ? Math.round(Number(body.timeoutSeconds) * 1000) : body.timeoutMs;
  const stop = clampInt(body.stopAfterWorking, 1, 1000000, 0);
  return {
    concurrency: clampInt(body.concurrency, 1, 500, 500),
    timeoutMs: clampInt(secs, 1000, 30000, 5000),
    stopAfterWorking: stop || null,
    removeDead: body.removeDead !== undefined ? !!body.removeDead : true,
    onlyUnchecked: !!body.onlyUnchecked,
  };
}

// Download the proxy sources that are switched on (or the given ids) and add what they contain. Used by the Scrape
// button and by the automation; only one runs at a time.
let scrapeRunning = false;
async function scrapeSourcesNow(ids) {
  const all = proxySources.list();
  const chosen = ids ? all.filter((x) => ids.includes(x.id)) : all.filter((x) => x.enabled);
  if (!chosen.length) throw httpError(400, ids ? 'None of those sources exist' : 'No sources are switched on — switch at least one on first');
  if (scrapeRunning) throw httpError(409, 'Proxy sources are being downloaded already');
  scrapeRunning = true;
  try {
    return await ProxySources.scrapeSources(chosen, {
      onResult: (x) => proxySources.recordRun(x.id, { at: Date.now(), ok: x.ok && !x.error, count: x.count, error: x.error, ms: x.ms }),
    });
  } finally { scrapeRunning = false; }
}

// Something changed in the proxy list → save the working ones (debounced) so they are there next time.
function proxiesChanged() { if (typeof proxyAutomation !== 'undefined') proxyAutomation.changed(); }

// What each proxy did the last time it was asked to open a site, kept for a while so that starting several campaigns
// to the same site does not check the same proxies again. key: "<proxy>|<site>" (site is an origin, or "generic").
const VERIFY_TTL_MS = 20 * 60 * 1000;
const verifyCache = new Map();
const proxyCacheKey = (p) => `${p.type}://${String(p.host).toLowerCase()}:${p.port}`;
function rememberCheck(p, r, site) {
  verifyCache.set(proxyCacheKey(p) + '|' + site, { ok: !!r.ok, at: Date.now(), ms: r.ms || 0 });
  if (verifyCache.size > 200000) { let n = 0; for (const k of verifyCache.keys()) { verifyCache.delete(k); if (++n >= 20000) break; } }
}
function cachedCheck(p, site) {
  const k = proxyCacheKey(p) + '|' + site;
  const v = verifyCache.get(k);
  if (!v) return null;
  if (Date.now() - v.at > VERIFY_TTL_MS) { verifyCache.delete(k); return null; }
  return v;
}

// The address a check should open through each proxy. Anything that is not a public web address is refused for an AI
// assistant, so the checker cannot be used to probe the user's own network.
function parseTestUrl(raw, fromMcp) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const url = normalizeUrlInput(raw, false, 'Test address');          // 400 for anything that is not an http(s) address
  if (fromMcp) {
    try { ProxySources.assertFetchable(url); } catch (e) { throw httpError(400, `${e.message} (assistants may only test public web addresses)`); }
  }
  return url;
}

// Start checking either the proxies given in the request (nothing is removed) or the loaded list.
function beginValidation(body, { mcp = false } = {}) {
  if (activeValidation && activeValidation.status === 'running') { const e = new Error('A proxy check is already running'); e.status = 409; throw e; }
  const opts = validationOptions(body);
  opts.testUrl = parseTestUrl(body.testUrl, mcp);
  if (opts.testUrl && typeof proxyAutomation !== 'undefined') proxyAutomation.noteTestUrl(opts.testUrl);
  opts.onResult = rememberCheck;
  let subject, onLoaded = false;
  if (Array.isArray(body.proxies) && body.proxies.length) {
    subject = body.proxies.map(cleanProxyRecord).filter(Boolean);
    opts.removeDead = false;
  } else if (Array.isArray(body.subject)) {
    // (internal) these loaded proxies only — used by the background re-check
    onLoaded = true;
    const inList = new Set(loadedProxies);
    subject = body.subject.filter((p) => inList.has(p));
  } else {
    onLoaded = true;
    // "already checked" means checked FOR THIS ADDRESS: a proxy that only passed a general check (or was checked against
    // another site) has not shown that it can open this one, so it is checked again.
    const site = opts.testUrl ? new URL(opts.testUrl).origin : null;
    subject = opts.onlyUnchecked ? loadedProxies.filter((p) => !(p.status && (p.checkedFor || null) === site)) : loadedProxies.slice();
    opts.skipped = loadedProxies.length - subject.length;
  }
  if (!subject.length) {
    const e = new Error(onLoaded && opts.onlyUnchecked && loadedProxies.length ? `Every proxy has already been checked${opts.testUrl ? ' for this address' : ''}` : 'There are no proxies to check');
    e.status = 400; throw e;
  }
  opts.onFinish = (job) => {
    // Only a completed check of the loaded list removes dead proxies (a cancelled or failed one never does).
    if (onLoaded && opts.removeDead && job.status === 'done') {
      const before = loadedProxies.length;
      loadedProxies = loadedProxies.filter((p) => p.status !== 'dead');
      job.removed = before - loadedProxies.length;
    }
    if (onLoaded) proxiesChanged();
  };
  const job = new ValidationJob('val_' + (++validationSeq), subject, opts);
  validationJobs.set(job.id, job);
  activeValidation = job;
  while (validationJobs.size > 5) validationJobs.delete(validationJobs.keys().next().value);
  return job;
}

// --- Browser install manager ----------------------------------------------
// Downloads browser installers/zip archives, extracts them, and tracks
// progress via SSE. Installed browsers are stored in a known directory and
// detected by /api/browsers/detect.

const BROWSER_INSTALL_DIR = path.join(appDataDir(), 'browsers');
const BROWSER_REGISTRY_FILE = path.join(BROWSER_INSTALL_DIR, 'registry.json');

// In-memory progress state for active downloads, keyed by browser id.
// Each entry: { id, name, status, percent, downloaded, total, speed, error }
const browserInstallProgress = new Map();
// Last known state of every install this session (kept after it finishes, unlike the map above),
// so a client that polls instead of listening to the progress stream can see the outcome.
const browserInstallStatus = new Map();
// SSE clients waiting for progress updates
const browserProgressClients = new Set();

// Custom browsers added by the user (persisted in registry.json)
let customBrowsers = [];
let browserRegistryLoaded = false;

function ensureInstallDir() {
  try {
    if (!fs.existsSync(BROWSER_INSTALL_DIR)) {
      fs.mkdirSync(BROWSER_INSTALL_DIR, { recursive: true });
    }
  } catch (_) {}
}

function loadBrowserRegistry() {
  if (browserRegistryLoaded) return;
  try {
    ensureInstallDir();
    if (fs.existsSync(BROWSER_REGISTRY_FILE)) {
      const data = JSON.parse(fs.readFileSync(BROWSER_REGISTRY_FILE, 'utf8'));
      customBrowsers = Array.isArray(data.customBrowsers) ? data.customBrowsers : [];
    }
    browserRegistryLoaded = true;
  } catch (_) {}
}

function saveBrowserRegistry() {
  try {
    ensureInstallDir();
    fs.writeFileSync(BROWSER_REGISTRY_FILE, JSON.stringify({ customBrowsers }, null, 2));
  } catch (_) {}
}

loadBrowserRegistry();

function broadcastBrowserProgress(data) {
  // Keep the replay map (sent to newly connected SSE clients) in sync, and
  // drop finished installs so reconnecting clients don't see stale progress.
  if (data && data.id) {
    browserInstallStatus.set(data.id, { ...data, updatedAt: new Date().toISOString() });
    if (data.status === 'complete' || data.status === 'error') browserInstallProgress.delete(data.id);
    else browserInstallProgress.set(data.id, data);
  }
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of browserProgressClients) {
    try { client.write(msg); } catch (_) {}
  }
}

// Download a file with progress tracking. Returns a Promise that resolves
// with the local file path on completion.
function downloadWithProgress(url, destPath, browserId, browserName, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      reject(new Error('Only http(s) downloads are supported'));
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    let totalBytes = 0;
    let downloadedBytes = 0;
    let lastEmit = 0;
    let startTime = Date.now();

    const req = lib.get(url, { timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      // Follow redirects (bounded; Location may be relative)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) { reject(new Error('Too many redirects')); return; }
        let next;
        try { next = new URL(res.headers.location, url).toString(); } catch (e) { reject(e); return; }
        downloadWithProgress(next, destPath, browserId, browserName, redirectsLeft - 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.on('error', reject);
      totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      const stream = fs.createWriteStream(destPath);
      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        const now = Date.now();
        // Emit progress at most every 300ms
        if (now - lastEmit > 300 || downloadedBytes === totalBytes) {
          lastEmit = now;
          const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
          const elapsed = (now - startTime) / 1000;
          const speed = elapsed > 0 ? downloadedBytes / elapsed : 0;
          const data = {
            id: browserId,
            name: browserName,
            status: 'downloading',
            percent,
            downloaded: downloadedBytes,
            total: totalBytes,
            speed,
          };
          browserInstallProgress.set(browserId, data);
          broadcastBrowserProgress(data);
        }
      });
      res.pipe(stream);
      stream.on('finish', () => {
        stream.close();
        resolve(destPath);
      });
      stream.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
    req.on('error', reject);
  });
}

// Extract a zip archive to a target directory.
async function extractZipArchive(zipPath, targetDir) {
  try {
    await extractZip(zipPath, { dir: targetDir });
    return true;
  } catch (e) {
    // Fallback: try using PowerShell's Expand-Archive. Paths are passed via
    // environment variables, never spliced into the command text, so a
    // quote in a path cannot inject PowerShell code.
    try {
      const { execFileSync } = require('child_process');
      execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -LiteralPath $env:TD_ZIP_PATH -DestinationPath $env:TD_DEST_DIR -Force',
      ], { timeout: 120000, env: { ...process.env, TD_ZIP_PATH: zipPath, TD_DEST_DIR: targetDir } });
      return true;
    } catch (_) {
      throw e;
    }
  }
}

// Find the browser executable inside an extracted directory.
function findBrowserExe(dir, browserId) {
  try {
    // Common executable names by browser type
    const exeNames = {
      'chrome': ['chrome.exe', 'chrome-win64\\chrome.exe', 'chrome-win\\chrome.exe'],
      'chromium': ['chrome.exe', 'chrome-win64\\chrome.exe', 'chrome-win\\chrome.exe'],
      'edge': ['msedge.exe'],
      'brave': ['brave.exe'],
      'vivaldi': ['vivaldi.exe'],
      'opera': ['opera.exe'],
      'opera-gx': ['opera.exe'],
      'firefox': ['firefox.exe'],
      'waterfox': ['waterfox.exe'],
      'librewolf': ['librewolf.exe'],
      'thorium': ['thorium.exe', 'chrome.exe'],
      'ungoogled': ['chrome.exe', 'chrome-win64\\chrome.exe'],
    };
    const names = exeNames[browserId] || ['chrome.exe', 'firefox.exe', 'msedge.exe'];
    // First, try direct paths
    for (const n of names) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return p;
    }
    // Then, search recursively (limited depth)
    function search(d, depth) {
      if (depth > 3) return '';
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            const r = search(path.join(d, entry.name), depth + 1);
            if (r) return r;
          } else {
            for (const n of names) {
              if (entry.name === path.basename(n)) return path.join(d, entry.name);
            }
          }
        }
      } catch (_) {}
      return '';
    }
    return search(dir, 0);
  } catch (_) {
    return '';
  }
}

// Install a browser: download → extract → find exe → register
async function installBrowserTask(id, name, url) {
  ensureInstallDir();
  const browserDir = path.join(BROWSER_INSTALL_DIR, id);
  const archivePath = path.join(BROWSER_INSTALL_DIR, id + '.zip');

  // Check if already installed
  const registry = getInstalledBrowsers();
  const existing = registry.find(b => b.id === id && b.path && fs.existsSync(b.path));
  if (existing) {
    broadcastBrowserProgress({ id, name, status: 'complete' });
    return;
  }

  try {
    // Step 1: Download
    broadcastBrowserProgress({ id, name, status: 'downloading', percent: 0, downloaded: 0, total: 0, speed: 0 });
    await downloadWithProgress(url, archivePath, id, name);

    // Step 2: Extract
    broadcastBrowserProgress({ id, name, status: 'extracting' });
    if (!fs.existsSync(browserDir)) fs.mkdirSync(browserDir, { recursive: true });
    const ext = path.extname(url).toLowerCase();
    if (ext === '.zip' || url.includes('.zip')) {
      await extractZipArchive(archivePath, browserDir);
    } else if (ext === '.exe') {
      // For .exe installers, just keep the installer — user can run it
      // Move it to the browser dir
      fs.copyFileSync(archivePath, path.join(browserDir, path.basename(url)));
    } else {
      // Try zip extraction as fallback
      await extractZipArchive(archivePath, browserDir);
    }

    // Step 3: Find executable
    const exePath = findBrowserExe(browserDir, id);

    // Clean up archive
    try { fs.unlinkSync(archivePath); } catch (_) {}

    if (!exePath) {
      // Previously this reported "complete" even though nothing usable was
      // registered (e.g. an .exe installer was downloaded).
      throw new Error(`Downloaded, but no browser executable was found in ${browserDir}. If this is an installer, run it from that folder.`);
    }

    // Register the browser
    const installed = getInstalledBrowsers();
    const idx = installed.findIndex(b => b.id === id);
    const entry = { id, name, path: exePath, dir: browserDir, installedAt: new Date().toISOString() };
    if (idx >= 0) installed[idx] = entry;
    else installed.push(entry);
    saveInstalledBrowsers(installed);

    broadcastBrowserProgress({ id, name, status: 'complete' });
  } catch (e) {
    broadcastBrowserProgress({ id, name, status: 'error', error: e.message });
  }
}

// Installed browsers registry (separate from custom browsers)
const INSTALLED_BROWSERS_FILE = path.join(BROWSER_INSTALL_DIR, 'installed.json');
let installedBrowsersCache = null;

function getInstalledBrowsers() {
  if (installedBrowsersCache !== null) return installedBrowsersCache;
  try {
    ensureInstallDir();
    if (fs.existsSync(INSTALLED_BROWSERS_FILE)) {
      installedBrowsersCache = JSON.parse(fs.readFileSync(INSTALLED_BROWSERS_FILE, 'utf8'));
      return installedBrowsersCache;
    }
  } catch (_) {}
  installedBrowsersCache = [];
  return installedBrowsersCache;
}

function saveInstalledBrowsers(list) {
  try {
    ensureInstallDir();
    fs.writeFileSync(INSTALLED_BROWSERS_FILE, JSON.stringify(list, null, 2));
    installedBrowsersCache = list; // Update cache
  } catch (_) {}
}

// System-installed browser detection — scans common paths for all
// browsers in the BROWSERS list.
function detectSystemBrowsers() {
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');

  const paths = {
    'chromium': [findCachedChromiumSafe()],
    'chrome': [
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
    'chrome-beta': [
      path.join(programFiles, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'),
    ],
    'chrome-dev': [
      path.join(programFiles, 'Google', 'Chrome Dev', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome Dev', 'Application', 'chrome.exe'),
    ],
    'chrome-canary': [
      path.join(programFiles, 'Google', 'Chrome SxS', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome SxS', 'Application', 'chrome.exe'),
    ],
    'edge': [
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
    'edge-beta': [
      path.join(programFilesX86, 'Microsoft', 'Edge Beta', 'Application', 'msedge.exe'),
    ],
    'edge-dev': [
      path.join(programFilesX86, 'Microsoft', 'Edge Dev', 'Application', 'msedge.exe'),
    ],
    'edge-canary': [
      path.join(programFilesX86, 'Microsoft', 'Edge SxS', 'Application', 'msedge.exe'),
    ],
    'brave': [
      path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ],
    'brave-beta': [
      path.join(programFiles, 'BraveSoftware', 'Brave-Browser-Beta', 'Application', 'brave.exe'),
      path.join(programFilesX86, 'BraveSoftware', 'Brave-Browser-Beta', 'Application', 'brave.exe'),
    ],
    'brave-nightly': [
      path.join(programFiles, 'BraveSoftware', 'Brave-Browser-Nightly', 'Application', 'brave.exe'),
      path.join(programFilesX86, 'BraveSoftware', 'Brave-Browser-Nightly', 'Application', 'brave.exe'),
    ],
    'vivaldi': [
      path.join(localAppData, 'Vivaldi', 'Application', 'vivaldi.exe'),
      path.join(programFiles, 'Vivaldi', 'Application', 'vivaldi.exe'),
    ],
    'opera': [
      path.join(localAppData, 'Programs', 'Opera', 'opera.exe'),
      path.join(programFiles, 'Opera', 'opera.exe'),
    ],
    'opera-gx': [
      path.join(localAppData, 'Programs', 'Opera GX', 'opera.exe'),
      path.join(programFiles, 'Opera GX', 'opera.exe'),
    ],
    'firefox': [
      path.join(programFiles, 'Mozilla Firefox', 'firefox.exe'),
      path.join(programFilesX86, 'Mozilla Firefox', 'firefox.exe'),
    ],
    'firefox-beta': [
      path.join(programFiles, 'Mozilla Firefox', 'firefox.exe'),
      path.join(programFilesX86, 'Mozilla Firefox', 'firefox.exe'),
    ],
    'firefox-dev': [
      path.join(programFiles, 'Firefox Developer Edition', 'firefox.exe'),
      path.join(programFilesX86, 'Firefox Developer Edition', 'firefox.exe'),
    ],
    'firefox-nightly': [
      path.join(programFiles, 'Nightly', 'firefox.exe'),
      path.join(programFilesX86, 'Nightly', 'firefox.exe'),
    ],
    'waterfox': [
      path.join(programFiles, 'Waterfox', 'waterfox.exe'),
      path.join(programFilesX86, 'Waterfox', 'waterfox.exe'),
    ],
    'librewolf': [
      path.join(programFiles, 'LibreWolf', 'librewolf.exe'),
      path.join(programFilesX86, 'LibreWolf', 'librewolf.exe'),
    ],
    'thorium': [
      path.join(programFiles, 'Thorium', 'thorium.exe'),
      path.join(programFilesX86, 'Thorium', 'thorium.exe'),
    ],
    'maxthon': [
      path.join(programFiles, 'Maxthon', 'Maxthon.exe'),
      path.join(programFilesX86, 'Maxthon', 'Maxthon.exe'),
    ],
    'slimjet': [
      path.join(programFiles, 'Slimjet', 'slimjet.exe'),
      path.join(programFilesX86, 'Slimjet', 'slimjet.exe'),
    ],
  };

  const detected = [];
  for (const [id, candidatePaths] of Object.entries(paths)) {
    for (const p of candidatePaths) {
      if (p && safeExists(p)) {
        detected.push({ id, path: p });
        break;
      }
    }
  }
  return detected;
}
// The Organic Search module expects engine objects with:
//   { id, name, homepage, searchUrl (with {query} placeholder), enabled }
const SEARCH_ENGINES = {
  google: {
    id: 'google', name: 'Google',
    homepage: 'https://www.google.com',
    searchUrl: 'https://www.google.com/search?q={query}',
    enabled: true,
  },
  bing: {
    id: 'bing', name: 'Bing',
    homepage: 'https://www.bing.com',
    searchUrl: 'https://www.bing.com/search?q={query}',
    enabled: true,
  },
  yahoo: {
    id: 'yahoo', name: 'Yahoo',
    homepage: 'https://search.yahoo.com',
    searchUrl: 'https://search.yahoo.com/search?p={query}',
    enabled: true,
  },
  duckduckgo: {
    id: 'duckduckgo', name: 'DuckDuckGo',
    homepage: 'https://duckduckgo.com',
    searchUrl: 'https://duckduckgo.com/?q={query}',
    enabled: true,
  },
  yandex: {
    id: 'yandex', name: 'Yandex',
    homepage: 'https://yandex.com',
    searchUrl: 'https://yandex.com/search/?text={query}',
    enabled: true,
  },
  ask: {
    id: 'ask', name: 'Ask',
    homepage: 'https://www.ask.com',
    searchUrl: 'https://www.ask.com/web?q={query}',
    enabled: true,
  },
};

// --- Social platform definitions ------------------------------------------
// SocialTraffic.js expects { id, name, url } objects.
const SOCIAL_PLATFORMS = {
  facebook: { id: 'facebook', name: 'Facebook', url: 'https://www.facebook.com' },
  youtube: { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com' },
  tiktok: { id: 'tiktok', name: 'TikTok', url: 'https://www.tiktok.com' },
  instagram: { id: 'instagram', name: 'Instagram', url: 'https://www.instagram.com' },
  twitter: { id: 'twitter', name: 'X (Twitter)', url: 'https://twitter.com' },
  reddit: { id: 'reddit', name: 'Reddit', url: 'https://www.reddit.com' },
  linkedin: { id: 'linkedin', name: 'LinkedIn', url: 'https://www.linkedin.com' },
  pinterest: { id: 'pinterest', name: 'Pinterest', url: 'https://www.pinterest.com' },
};

// --- Helpers ---------------------------------------------------------------

function sendJSON(res, statusCode, data) {
  if (res.headersSent) { try { res.end(); } catch (_) {} return; }
  const body = statusCode === 204 ? '' : JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    ...corsHeaders(res.req),
  });
  res.end(body);
}

const MAX_BODY_BYTES = 20 * 1024 * 1024; // proxy lists / RPA recordings can be large

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    let aborted = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (aborted) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        reject(new Error('Request body too large'));
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (aborted) return;
      if (!data) return resolve({});
      try {
        const parsed = JSON.parse(data);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Wrap a plain proxy array into the { useProxies, proxies, workingProxies }
// shape the traffic modules expect.
function normalizeProxies(raw) {
  if (!raw) return { useProxies: false, proxies: [], workingProxies: [] };
  if (Array.isArray(raw)) {
    return { useProxies: raw.length > 0, proxies: raw, workingProxies: [] };
  }
  // Already an object — ensure required fields exist.
  return {
    useProxies: !!raw.useProxies,
    proxies: raw.proxies || [],
    workingProxies: raw.workingProxies || [],
  };
}

// --- Campaign registry -------------------------------------------------------
const TERMINAL_STATUSES = new Set(['completed', 'stopped', 'failed', 'error']);
const MAX_LOGS_PER_PROCESS = 2000;
// Finished campaigns are kept briefly so clients can fetch the final
// logs/status, then removed so memory doesn't grow with every run.
const FINISHED_PROCESS_TTL_MS = 10 * 60 * 1000;
const MAX_THREADS = Math.max(1, toInt(process.env.TD_MAX_THREADS, 50));
const MAX_SESSIONS = Math.max(1, toInt(process.env.TD_MAX_SESSIONS, 100000));

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

// --- Shared config helpers ---------------------------------------------------

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function toPositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Dashboard "Delay Time (seconds)" min/max → wait between sessions per thread.
function sessionDelayConfig(body) {
  let min = parseFloat(body.delayMin);
  let max = parseFloat(body.delayMax);
  min = Number.isFinite(min) && min > 0 ? min : 0;
  max = Number.isFinite(max) && max > 0 ? max : min;
  if (max < min) [min, max] = [max, min];
  return { sessionDelayMinMs: Math.round(min * 1000), sessionDelayMaxMs: Math.round(max * 1000) };
}

function parseKeywords(body) {
  const raw = body.keyword !== undefined && body.keyword !== null && body.keyword !== ''
    ? body.keyword
    : body.keywords;
  const list = Array.isArray(raw) ? raw : String(raw || '').split('\n');
  return list.map(k => String(k).trim()).filter(Boolean);
}

// The traffic modules understand 'down-only' | 'up-down' | anything else =
// random natural scrolling. The dashboard sends 'down' | 'up' | 'both', which
// never matched, so "Down" silently behaved like random scrolling.
function mapScrollDirection(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'down' || v === 'down-only') return 'down-only';
  if (v === 'both' || v === 'up-down') return 'up-down';
  return 'random';
}

// Accepts "example.com" or a full URL; only http(s) is allowed.
function normalizeUrlInput(value, required, label) {
  let raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) {
    if (required) throw httpError(400, `${label || 'URL'} is required`);
    return '';
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = 'https://' + raw;
  const safe = safeHttpUrl(raw);
  if (!safe) throw httpError(400, `${label || 'URL'} must be an http(s) URL`);
  return safe;
}

// Proxies for a campaign: an explicit list wins (the dashboard always sends
// one); otherwise API callers can ask for the proxies loaded on the backend.
function resolveProxies(body) {
  if (body.proxies !== undefined && body.proxies !== null) return normalizeProxies(body.proxies);
  if (body.useLoadedProxies) return normalizeProxies(loadedProxies.filter((p) => p.status !== 'dead'));
  return normalizeProxies(null);
}

// Settings shared by every traffic mode.
function commonConfig(body) {
  const privacy = PrivacyCatalog.resolve(body);
  const scrollDirection = mapScrollDirection(body.scrollDirection);
  return {
    sessions: Math.min(toPositiveInt(body.sessions, 1), MAX_SESSIONS),
    threads: Math.min(toPositiveInt(body.threads, 1), MAX_THREADS),
    headless: !!body.headless,
    proxy: body.proxy || null,
    userAgents: Array.isArray(body.userAgents) ? body.userAgents.filter(u => typeof u === 'string' && u.trim()) : [],
    uaAutoRotate: !!(body.uaAutoRotate || body.uaMode === 'rotate'),
    device: ['desktop', 'mobile', 'tablet'].includes(body.device) ? body.device : 'desktop',
    customBrowserPath: body.customBrowserPath || '',
    browserEngine: body.browserEngine || 'chromium',
    scrollLinkSystem: body.scrollLinkSystem || false,
    scrollMode: body.scrollMode || 'natural',
    scrollDirection,
    scrollDistance: parseInt(body.scrollDistance, 10) || 800,
    scrollDuration: parseInt(body.scrollDuration, 10) || 5000,
    scrollDownWaitMs: parseInt(body.scrollDownWaitMs, 10) || 1500,
    scrollUpWaitMs: parseInt(body.scrollUpWaitMs, 10) || 1500,
    scrollingInternalPagesEnabled: body.internalLinkNavigation || body.scrollLinkSystem || false,
    internalPagesCount: parseInt(body.internalLinkCount, 10) || 0,
    internalScrollMode: scrollDirection,
    internalPageWaitMs: parseInt(body.internalLinkReadTime, 10) || 3000,
    visitTimeMs: parseInt(body.visitTimeMs, 10) || 20000,
    viewportWidth: parseInt(body.viewportWidth, 10) || 1280,
    viewportHeight: parseInt(body.viewportHeight, 10) || 800,
    autoRotateResolutions: body.autoRotateResolutions || null,
    proxies: resolveProxies(body),
    privacyFeatures: privacy.features,
    privacyLevel: privacy.level,
    autoClickPopAds: body.autoClickPopAds !== undefined ? !!body.autoClickPopAds : true,
    popAdClicks: Math.min(Math.max(parseInt(body.popAdClicks, 10) || 1, 1), 5),
    popAdDelayMs: Math.max(parseInt(body.popAdDelayMs, 10) || 2000, 500),
    popAdStayTimeMs: Math.max(parseInt(body.popAdStayTimeMs, 10) || 8000, 2000),
    popAdAutoClose: body.popAdAutoClose !== undefined ? !!body.popAdAutoClose : true,
    ...sessionDelayConfig(body),
  };
}

// --- Config builders -------------------------------------------------------

// A search engine the user defined: { name, searchUrl | url }. The URL may contain {query};
// otherwise "https://site/search?q=" style URLs get the query appended, and a bare site gets /search?q=.
function customEngineFrom(input) {
  if (!input || typeof input !== 'object') return null;
  let raw = String(input.searchUrl || input.url || '').trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = 'https://' + raw;
  const probe = safeHttpUrl(raw.replace('{query}', 'x'));
  if (!probe) throw httpError(400, 'customEngine URL must be an http(s) URL');
  const u = new URL(probe);
  let searchUrl;
  if (raw.includes('{query}')) searchUrl = raw;
  else if (u.search && /=$/.test(u.search)) searchUrl = probe + '{query}';
  else searchUrl = u.origin + '/search?q={query}';
  return { id: 'custom', name: String(input.name || u.hostname).trim().slice(0, 60) || u.hostname, homepage: u.origin, searchUrl, enabled: true };
}

function buildOrganicConfig(body) {
  const engineId = (body.engine || 'google').toLowerCase();
  const engineObj = customEngineFrom(body.customEngine) || SEARCH_ENGINES[engineId] || SEARCH_ENGINES.google;
  // All keywords (one per line); each session picks one at random.
  const keywords = parseKeywords(body);
  return {
    ...commonConfig(body),
    targetUrl: normalizeUrlInput(body.url || body.targetUrl, true, 'URL'),
    keywords,
    searchEngines: [engineObj],
    assignedEngine: engineObj,
    maxPages: toPositiveInt(body.maxPages, 1),
    mixedModeEnabled: false,
    distributionStrategy: 'random',
    internalLinkNavigation: body.internalLinkNavigation || false,
    articlesToRead: body.articlesToRead || 0,
    internalLinkVisitTimeMs: parseInt(body.internalLinkVisitTimeMs, 10) || 10000,
    proxyWarmupMs: parseInt(body.proxyWarmupMs, 10) || 15000,
  };
}

function buildDirectConfig(body) {
  return {
    ...commonConfig(body),
    targetUrl: normalizeUrlInput(body.url || body.targetUrl, true, 'URL'),
  };
}

function buildReferralConfig(body) {
  // Referral Traffic = SocialTraffic.js with the selected platform.
  const platformId = (body.platform || 'random').toLowerCase();
  let platforms;
  if (platformId === 'random') {
    platforms = Object.values(SOCIAL_PLATFORMS);
  } else {
    const p = SOCIAL_PLATFORMS[platformId];
    platforms = p ? [p] : Object.values(SOCIAL_PLATFORMS);
  }
  const behaviors = ['platform_then_target', 'link_then_target', 'platform_then_link_then_target'];
  return {
    ...commonConfig(body),
    targetUrl: normalizeUrlInput(body.url || body.targetUrl, true, 'URL'),
    socialPlatforms: platforms,
    // SocialTraffic.js treats both values as SECONDS. The old defaults were
    // milliseconds (5000 / 2000), which became 83-minute / 33-minute waits.
    socialStayTime: parseFloat(body.socialStayTime) > 0 ? parseFloat(body.socialStayTime) : 5,
    socialRedirectDelay: parseFloat(body.socialRedirectDelay) >= 0 ? parseFloat(body.socialRedirectDelay) : 2,
    socialLaunchBehavior: behaviors.includes(body.socialLaunchBehavior) ? body.socialLaunchBehavior : 'platform_then_target',
  };
}

function buildGmapsConfig(body) {
  const businessName = String(body.restaurant || body.businessName || '').trim();
  if (!businessName) throw httpError(400, 'Business name is required');
  return {
    ...commonConfig(body),
    businessName,
    keyword: body.keyword || businessName,
    targetUrl: normalizeUrlInput(body.website || body.targetUrl, false, 'Website URL'),
    mapsLoadWaitMs: parseInt(body.mapsLoadWaitMs, 10) || 8000,
    searchResultWaitMs: parseInt(body.searchResultWaitMs, 10) || 8000,
    websiteLoadWaitMs: parseInt(body.websiteLoadWaitMs, 10) || 5000,
    typingDelayMs: parseInt(body.typingDelayMs, 10) || 80,
    stepRetryAttempts: parseInt(body.stepRetryAttempts, 10) || 5,
    stepRetryDelayMs: parseInt(body.stepRetryDelayMs, 10) || 5000,
  };
}

const CAMPAIGN_MODES = {
  organic: { label: 'Organic Search', build: buildOrganicConfig, start: (c) => getOrganicSearch().startOrganicSearch(c) },
  direct: { label: 'Direct Traffic', build: buildDirectConfig, start: (c) => getDirectTraffic().startDirectTraffic(c) },
  referral: { label: 'Referral Traffic', build: buildReferralConfig, start: (c) => getSocialTraffic().startSocialTraffic(c) },
  gmaps: { label: 'Google Maps', build: buildGmapsConfig, start: (c) => getGoogleMapsTraffic().startGoogleMapsTraffic(c) },
  rpa: { label: 'RPA Replay', build: buildRpaConfig, start: (c) => startRpaReplay(c) },
};

// --- Saved campaigns ----------------------------------------------------------
// The Campaigns page: reusable campaign definitions the dashboard and AI assistants share.
// { id, name, mode, url, keywords[], sessions, category, options{} (any other start option),
//   createdAt, lastRunAt, runCount, lastProcessId }
function loadSavedCampaigns() {
  const d = readJsonFile(SAVED_CAMPAIGNS_FILE, { campaigns: [] });
  return Array.isArray(d.campaigns) ? d.campaigns : [];
}
function persistSavedCampaigns(list) { writeJsonFile(SAVED_CAMPAIGNS_FILE, { campaigns: list }); }

function parseKeywordList(v) {
  if (Array.isArray(v)) return v.map(k => String(k).trim()).filter(Boolean);
  const text = String(v || '');
  return (text.includes('\n') ? text.split('\n') : text.split(',')).map(k => k.trim()).filter(Boolean);
}

// The start request a saved campaign stands for (overrides win).
function savedCampaignRequest(t, overrides) {
  const req = { ...(t.options || {}), mode: t.mode, ...(overrides || {}) };
  if (req.sessions === undefined && t.sessions) req.sessions = t.sessions;
  if (t.mode === 'gmaps') { req.businessName = req.businessName || t.name; req.website = req.website || t.url; }
  else if (t.mode !== 'rpa') {
    req.url = req.url || t.url;
    if (t.mode === 'organic' && !req.keywords) req.keywords = t.keywords;
  }
  return req;
}

function prepareSavedCampaign(body, existing) {
  const name = String(body.name === undefined && existing ? existing.name : body.name || '').trim();
  if (!name) throw httpError(400, 'A campaign needs a name');
  if (name.length > 120) throw httpError(400, 'Name is too long (max 120 characters)');
  const mode = String(body.mode || (existing && existing.mode) || '');
  if (!CAMPAIGN_MODES[mode]) throw httpError(400, `mode must be one of: ${Object.keys(CAMPAIGN_MODES).join(', ')}`);
  const options = body.options !== undefined ? body.options : (existing && existing.options) || {};
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw httpError(400, 'options must be an object');
  if (JSON.stringify(options).length > 20000) throw httpError(400, 'options are too large');
  const category = String(body.category || (existing && existing.category) || 'business').toLowerCase();
  if (!/^[a-z0-9_-]{1,40}$/.test(category)) throw httpError(400, 'category must be a short word (letters, digits, - _)');
  const t = {
    ...(existing || {}),
    id: (existing && existing.id) || 'camp_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
    name, mode, category,
    url: String(body.url !== undefined ? body.url : (existing && existing.url) || '').trim().slice(0, 2048),
    keywords: parseKeywordList(body.keywords !== undefined ? body.keywords : (existing && existing.keywords) || []),
    sessions: Math.min(toPositiveInt(body.sessions !== undefined ? body.sessions : (existing && existing.sessions), 1000), MAX_SESSIONS),
    options,
    createdAt: (existing && existing.createdAt) || Date.now(), runCount: (existing && existing.runCount) || 0,
  };
  CAMPAIGN_MODES[mode].build(savedCampaignRequest(t)); // reject unusable definitions now, not at run time
  return t;
}

function pushLog(proc, msg, logType) {
  proc.logs.push({
    seq: ++proc.logSeq, // monotonically increasing → clients poll with ?since=<seq>
    time: new Date().toISOString(),
    type: logType || 'info',
    message: typeof msg === 'string' ? msg : JSON.stringify(msg),
  });
  // Cap log buffer to prevent unbounded memory growth.
  if (proc.logs.length > MAX_LOGS_PER_PROCESS) proc.logs.shift();
}

// Wire a freshly started campaign emitter to its process record. Events from
// an emitter that has been replaced (loop restart) are ignored.
function attachEmitter(proc, emitter) {
  const current = () => proc.emitter === emitter;
  emitter.on('log', (msg, logType) => { if (current()) pushLog(proc, msg, logType); });
  emitter.on('stats', (stats) => { if (current()) proc.stats = stats; });
  emitter.on('summary', (summary) => { if (current()) proc.summary = summary; });
  emitter.on('status', (status) => {
    if (!current()) return;
    proc.status = status;
    if (!TERMINAL_STATUSES.has(status)) { proc.endedAt = null; return; }
    proc.endedAt = proc.endedAt || Date.now();
    if (status === 'completed' && proc.loop && !proc.stopRequested) scheduleLoopRestart(proc);
  });
}

function launchProcess(proc) {
  const def = CAMPAIGN_MODES[proc.type];
  const emitter = def.start(proc.config);
  proc.emitter = emitter;
  attachEmitter(proc, emitter);
}

// Per-campaign "loop": when a run completes, start the same campaign again.
// (Dashboard Auto-Loop is driven by the dashboard itself; this is for API/MCP.)
function scheduleLoopRestart(proc) {
  const delay = Math.max(1000, proc.loopDelayMs);
  proc.status = 'restarting';
  proc.endedAt = null;
  pushLog(proc, `[Loop] Iteration ${proc.iteration} finished — restarting in ${Math.round(delay / 1000)}s`, 'info');
  proc.loopTimer = setTimeout(() => {
    proc.loopTimer = null;
    if (proc.stopRequested) return;
    try {
      proc.history.push({ iteration: proc.iteration, summary: proc.summary || null });
      if (proc.history.length > 50) proc.history.shift();
      proc.iteration++;
      proc.stats = null;
      proc.summary = null;
      proc.config = CAMPAIGN_MODES[proc.type].build(proc.body); // fresh proxies / privacy each round
      pushLog(proc, `[Loop] Starting iteration ${proc.iteration}`, 'info');
      launchProcess(proc);
    } catch (e) {
      proc.status = 'failed';
      proc.endedAt = Date.now();
      pushLog(proc, `[Loop] Could not restart: ${e.message}`, 'error');
    }
  }, delay);
  if (proc.loopTimer.unref) proc.loopTimer.unref();
}

let nextProcessId = 1;

// Start any campaign mode. Throws an Error with .statusCode 400 for bad input.
// origin: 'api' | 'schedule' (informational).
function startCampaign(mode, body, origin) {
  const def = CAMPAIGN_MODES[mode];
  if (!def) throw httpError(400, `Unknown campaign mode "${mode}". Use one of: ${Object.keys(CAMPAIGN_MODES).join(', ')}`);
  const request = body && typeof body === 'object' ? body : {};
  const config = def.build(request);
  const id = `proc_${nextProcessId++}`;
  const proc = {
    id, type: mode, origin: origin || 'api', body: request, config, emitter: null,
    logs: [], logSeq: 0, status: 'starting', startedAt: Date.now(), endedAt: null,
    stats: null, summary: null,
    loop: !!request.loop, loopDelayMs: toPositiveInt(request.loopDelaySeconds, 5) * 1000,
    iteration: 1, history: [], loopTimer: null, stopRequested: false,
  };
  processes.set(id, proc);
  try {
    launchProcess(proc);
  } catch (e) {
    processes.delete(id);
    throw e;
  }
  return proc;
}

// --- Working proxies load by themselves (ProxyAutomation.js) ---------------------------------------------------
const proxyAutomation = createProxyAutomation({
  file: path.join(appDataDir(), 'proxies.json'),
  list: () => loadedProxies,
  restore: (records) => { if (!loadedProxies.length) loadedProxies = records; else addToProxyList(records); },
  addProxies: (records) => addToProxyList(records),
  startCheck: (opts) => beginValidation(opts),
  busy: () => !!(activeValidation && activeValidation.status === 'running') || scrapeRunning,
  scrape: () => scrapeSourcesNow(null),
  clean: cleanProxyRecord,
  settings: () => getSettings().proxyAuto,
  saveSettings: (patch) => saveSettings({ proxyAuto: { ...getSettings().proxyAuto, ...patch } }),
  isPublic: (u) => { try { ProxySources.assertFetchable(u); return true; } catch (_) { return false; } },
  log: (m) => console.log(m),
});
let proxiesRestored = false;

// --- Only proxies that can open the campaign's address are used ------------------------------------------------
// A proxy that passes a generic test can still be unable to open the page a campaign visits (many free proxies cannot
// tunnel HTTPS, or are blocked by the site). So before a campaign that uses proxies starts, its proxies are tried on
// the campaign's own address — in parallel, stopping as soon as enough have passed — and only those are used. If none
// pass, the campaign does not start: quietly running without proxies would expose the user's own address.
function campaignTestUrl(mode, body) {
  const raw = mode === 'gmaps' ? (body.website || body.targetUrl) : (body.url || body.targetUrl);
  if (!raw) return null;
  try { return normalizeUrlInput(raw, false, 'URL') || null; } catch (_) { return null; }
}

async function verifyCampaignProxies(mode, body) {
  const wanted = resolveProxies(body);
  if (!wanted.useProxies || !wanted.proxies.length) return { body, info: null };      // direct connection: nothing to verify
  const started = Date.now();
  const sessions = Math.min(toPositiveInt(body.sessions, 1), MAX_SESSIONS);
  const needed = Math.max(1, Math.min(sessions, 100));

  // clean copies; ones already known to work first (fastest first), unknown next, ones that failed before last
  const records = [];
  for (const p of wanted.proxies) {
    const c = cleanProxyRecord(p);
    if (!c) continue;
    c._rank = p.status === 'working' ? 0 : p.status === 'dead' ? 2 : 1;
    c._ms = typeof p.ms === 'number' ? p.ms : 1e9;
    records.push(c);
  }
  records.sort((a, b) => a._rank - b._rank || a._ms - b._ms);

  let url = campaignTestUrl(mode, body);
  let site = url ? new URL(url).origin : 'generic';
  let fallback = null;
  const split = (siteKey) => {
    const good = [], unknown = [];
    let cached = 0;
    for (const p of records) {
      const c = cachedCheck(p, siteKey);
      if (c && c.ok) { good.push(p); cached++; } else if (!c) unknown.push(p);
    }
    return { good, unknown, cached };
  };
  const run = async (testUrl, list, want) => {
    const job = new ValidationJob('pre_' + (++validationSeq), list, { concurrency: 500, timeoutMs: 6000, stopAfterWorking: want, testUrl, updateStatus: false, removeDead: false, onResult: rememberCheck });
    const timer = setTimeout(() => job.cancel(), 60000);
    await job.finished;
    clearTimeout(timer);
    return job;
  };

  let { good, unknown, cached } = split(site);
  let checked = 0, reasons = {};
  if (good.length < needed && unknown.length) {
    let job = await run(url, unknown, needed - good.length);
    if (job.status === 'error' && url) {
      // The address does not open for us even without a proxy (it may turn away non-browser clients while real browsers
      // get in). That is not a reason to block the campaign: fall back to the quick general check instead.
      fallback = job.error;
      url = null; site = 'generic';
      ({ good, unknown, cached } = split(site));
      job = good.length < needed && unknown.length ? await run(null, unknown, needed - good.length) : null;
    }
    if (job) {
      if (job.status === 'error') throw httpError(503, job.error);
      checked = job.done;
      reasons = job.reasons;
      unknown.forEach((p, i) => { if (job.results[i] && job.results[i].ok) good.push(p); });
    }
  }
  const info = { url, tested: records.length, checked, verified: good.length, cached, seconds: +((Date.now() - started) / 1000).toFixed(1), reasons, ...(fallback ? { fallback } : {}) };
  if (!good.length) {
    const why = reasonSummary(reasons);
    const err = httpError(422, `None of the ${records.length} proxies could open ${url || 'the test address'}${checked && checked < records.length ? ` (${checked} checked in ${info.seconds} s)` : ''}${why ? ` — ${why}` : ''}. Load proxies that work for this site, or run the campaign without proxies.`);
    err.proxyCheck = info;
    throw err;
  }
  const clean = good.map(({ type, host, port, username, password, raw }) => ({ type, host, port, username, password, raw }));
  return { body: { ...body, proxies: clean, useLoadedProxies: false }, info };
}

// Why proxies failed, in words (for logs and error messages; the page has its own translated labels).
const REASON_TEXT = { timeout: 'timed out', refused: 'refused the connection', reset: 'dropped the connection', closed: 'closed the connection', dns: 'unknown host', unreachable: 'unreachable', tls: 'broke HTTPS (bad certificate)', login: 'wrong or missing login', 'no-tunnel': 'cannot tunnel HTTPS', 'socks-login': 'SOCKS with a login (Chrome cannot use these)', 'bad-answer': 'gave a garbled answer', error: 'other errors' };
function reasonSummary(reasons, top = 3) {
  return Object.entries(reasons || {}).sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([k, n]) => `${n} ${REASON_TEXT[k] || (/^http-\d+$/.test(k) ? `answered HTTP ${k.slice(5)}` : k)}`).join(', ');
}

// Start a campaign, first making sure the proxies it will use can open its address.
async function startCampaignVerified(mode, body, origin) {
  const def = CAMPAIGN_MODES[mode];
  if (!def) throw httpError(400, `Unknown campaign mode "${mode}". Use one of: ${Object.keys(CAMPAIGN_MODES).join(', ')}`);
  const request = body && typeof body === 'object' ? body : {};
  def.build(request);                                   // a bad request (no URL, bad option …) fails at once, before any proxy is tried
  proxyAutomation.noteCampaignUrl(campaignTestUrl(mode, request));   // new proxies are looked for on this campaign's address
  let v;
  try { v = await verifyCampaignProxies(mode, request); }
  catch (e) {
    if (e.statusCode === 422 && getSettings().proxyAuto.enabled && proxyAutomation.kick()) {
      e.message += ' TrafficDrive is now looking for working proxies for this site in the background — try again in a minute or two.';
    }
    throw e;
  }
  const proc = startCampaign(mode, v.body, origin);
  if (v.info) {
    proc.proxyCheck = v.info;
    const where = v.info.url || 'the test address';
    pushLog(proc, `${v.info.verified} of ${v.info.tested} proxies could open ${where} (${v.info.seconds} s) — using only those${v.info.fallback ? `. ${v.info.fallback.replace(/ Nothing was marked.*$/, '')}; the general test was used instead` : ''}`, 'info');
  }
  return proc;
}

function stopProcess(proc) {
  proc.stopRequested = true;
  proc.loop = false;
  if (proc.loopTimer) { clearTimeout(proc.loopTimer); proc.loopTimer = null; }
  const live = !TERMINAL_STATUSES.has(proc.status) && proc.status !== 'restarting';
  if (live && proc.emitter) {
    try { proc.emitter.emit('stop'); } catch (_) {}
  }
  if (live || proc.status === 'restarting') {
    proc.status = 'stopped';
    pushLog(proc, 'Campaign stopped.', 'warn');
  }
  proc.endedAt = proc.endedAt || Date.now();
}

// JSON-safe snapshot of a campaign (no proxy credentials, no emitter).
function describeProcess(proc) {
  const { proxies, proxy, ...request } = proc.body || {};
  const cfg = proc.config || {};
  return {
    id: proc.id,
    mode: proc.type,
    modeLabel: CAMPAIGN_MODES[proc.type] ? CAMPAIGN_MODES[proc.type].label : proc.type,
    origin: proc.origin,
    status: proc.status,
    target: cfg.targetLabel ? cfg.targetLabel : cfg.businessName ? `${cfg.businessName}${cfg.targetUrl ? ' → ' + cfg.targetUrl : ''}` : (cfg.targetUrl || ''),
    loop: proc.loop,
    iteration: proc.iteration,
    startedAt: new Date(proc.startedAt).toISOString(),
    endedAt: proc.endedAt ? new Date(proc.endedAt).toISOString() : null,
    stats: proc.stats || null,
    summary: proc.summary || null,
    history: proc.history,
    lastSeq: proc.logSeq,
    logCount: proc.logs.length,
    usesProxies: !!(cfg.proxies && cfg.proxies.useProxies),
    proxyCheck: proc.proxyCheck || null,
    privacy: { level: cfg.privacyLevel || 'standard', features: cfg.privacyFeatures || [] },
    config: {
      sessions: cfg.sessions, threads: cfg.threads, headless: cfg.headless, device: cfg.device,
      visitTimeMs: cfg.visitTimeMs, keywords: cfg.keywords, engine: cfg.assignedEngine && cfg.assignedEngine.id,
      platforms: cfg.socialPlatforms && cfg.socialPlatforms.map(p => p.id),
    },
    request,
  };
}

function pruneFinishedProcesses() {
  const now = Date.now();
  for (const [id, proc] of processes) {
    if (proc.endedAt && now - proc.endedAt > FINISHED_PROCESS_TTL_MS) {
      try { proc.emitter && proc.emitter.removeAllListeners(); } catch (_) {}
      processes.delete(id);
    }
  }
}
setInterval(pruneFinishedProcesses, 60 * 1000).unref();

// --- MCP integration helpers -----------------------------------------------------
function shellQuote(str) {
  if (/^[\w@%+=:,./-]+$/.test(str)) return str;
  if (process.platform === 'win32') return '"' + str.replace(/"/g, '\\"') + '"';
  return '"' + str.replace(/(["\\$`])/g, '\\$1') + '"';
}

// How a client launches the MCP server for THIS install. Inside the desktop
// app (dev or packaged) it reuses the app's own runtime via ELECTRON_RUN_AS_NODE,
// so users do not need Node.js installed; under plain Node it uses that Node.
function mcpLaunchInfo() {
  const script = path.join(__dirname, 'mcp-server.js');
  const electron = !!process.versions.electron;
  const env = electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
  const command = process.execPath;
  const runtime = electron ? (process.defaultApp ? 'electron-dev' : 'packaged-app') : 'node';
  const envFlags = Object.entries(env).map(([k, v]) => `-e ${k}=${v} `).join('');
  const cfg = { mcpServers: { trafficdrive: { command, args: [script], ...(Object.keys(env).length ? { env } : {}) } } };
  const envPrefix = Object.keys(env).length
    ? (process.platform === 'win32' ? Object.entries(env).map(([k, v]) => `set ${k}=${v} && `).join('') : Object.entries(env).map(([k, v]) => `${k}=${v} `).join(''))
    : '';
  return {
    command, args: [script], env, runtime, script, platform: process.platform,
    needsNode: !electron,
    snippets: {
      claudeCode: `claude mcp add ${envFlags}trafficdrive -- ${shellQuote(command)} ${shellQuote(script)}`,
      claudeDesktop: JSON.stringify(cfg, null, 2),
      json: JSON.stringify(cfg, null, 2),
      commandLine: `${envPrefix}${shellQuote(command)} ${shellQuote(script)}`,
    },
  };
}

function connectionStatus() {
  const info = readJsonFile(DISCOVERY_FILE, null);
  return {
    allowed: getSettings().allowMcpConnections,
    requestedByApp: connectionRequested,
    disabledByEnvironment: process.env.TD_NO_CONNECTION_FILE === '1',
    published: !!(info && info.pid === process.pid),
    file: DISCOVERY_FILE,
  };
}

// --- Detect which AI assistants are installed on this computer --------------------------
// Read-only. For every assistant in AssistantClients.js it looks for its command on PATH, its app folders and its
// VS Code extension, and — where the vendor documents a config file — checks (by parsing in memory, never
// returning file contents) whether TrafficDrive is already set up in it, and whether for THIS install.
const AssistantClients = require('./AssistantClients.js');
const AssistantSkills = require('./AssistantSkills.js');
const SkillPackage = require('./SkillPackage.js');

function execQuick(command, timeoutMs) {            // `command` is always a fixed string or a validated path
  return new Promise((resolve) => {
    try {
      require('child_process').exec(command, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 },
        (err, stdout) => resolve(err ? null : String(stdout).trim()));
    } catch (_) { resolve(null); }
  });
}

function assistantEnv() {
  const h = os.homedir();
  const win = process.platform === 'win32', mac = process.platform === 'darwin';
  const appdata = process.env.APPDATA || path.join(h, 'AppData', 'Roaming');
  const localappdata = process.env.LOCALAPPDATA || path.join(h, 'AppData', 'Local');
  const xdg = process.env.XDG_CONFIG_HOME || path.join(h, '.config');
  return {
    platform: process.platform, home: h, appdata, localappdata, join: path.join,
    claudeDesktopDir: win ? path.join(appdata, 'Claude') : mac ? path.join(h, 'Library', 'Application Support', 'Claude') : path.join(xdg, 'Claude'),
    vscodeUserRoot: win ? path.join(appdata, 'Code') : mac ? path.join(h, 'Library', 'Application Support', 'Code') : path.join(xdg, 'Code'),
    codexHome: process.env.CODEX_HOME || path.join(h, '.codex'),
  };
}

const pathExists = (p) => { try { return !!p && fs.existsSync(p); } catch (_) { return false; } };

// Where a command lives: on PATH, else in the usual homes (desktop apps often start with a short PATH).
async function findCommand(name, env) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return null;      // names come from the registry; belt and braces
  const win = env.platform === 'win32';
  const onPath = await execQuick(win ? `where ${name}` : `command -v ${name}`, 4000);
  const first = onPath && onPath.split(/\r?\n/)[0].trim();
  if (first && pathExists(first)) return first;
  const candidates = win
    ? [path.join(env.appdata, 'npm', `${name}.cmd`), path.join(env.home, '.local', 'bin', `${name}.exe`), path.join(env.localappdata, 'Programs', name, `${name}.exe`)]
    : [path.join(env.home, '.local', 'bin', name), path.join(env.home, '.claude', 'local', name), `/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`, `/usr/bin/${name}`];
  return candidates.find(pathExists) || null;
}

function extensionInstalled(prefix, env) {
  for (const root of ['.vscode', '.vscode-insiders', '.vscode-server', '.cursor']) {
    try {
      const dir = path.join(env.home, root, 'extensions');
      if (fs.readdirSync(dir).some((n) => n.toLowerCase().startsWith(prefix.toLowerCase() + '-'))) return true;
    } catch (_) {}
  }
  return false;
}

// The skill TrafficDrive ships for AI assistants (skills/trafficdrive). Read on demand; a build that left the
// folder out simply reports it as unavailable instead of breaking detection.
const SKILL_DIR = path.join(__dirname, 'skills', AssistantSkills.SKILL_NAME);
function loadSkillBundle() {
  try {
    const files = SkillPackage.collectFiles(SKILL_DIR);
    const md = files.find((f) => f.path === 'SKILL.md');
    if (!md) return null;
    return { files, skillMd: md.data.toString('utf8'), bytes: files.reduce((n, f) => n + f.data.length, 0) };
  } catch (_) { return null; }
}
// 'current' (an identical copy is installed), 'stale' (installed but different), 'none', or 'unknown' when the
// assistant has no documented skills folder to look in.
function installedSkillState(id, env, skillMd) {
  const dirs = AssistantSkills.candidates(id);
  if (!dirs.length) return 'unknown';
  const norm = (t) => String(t).replace(/\r\n/g, '\n').trim();
  let state = 'none';
  for (const segs of dirs) {
    let text;
    try { text = fs.readFileSync(path.join(env.home, ...segs, AssistantSkills.SKILL_NAME, 'SKILL.md'), 'utf8'); } catch (_) { continue; }
    if (norm(text) === norm(skillMd)) return 'current';
    state = 'stale';
  }
  return state;
}

const betterState = (a, b) => ({ current: 3, stale: 2, none: 1, unknown: 0 }[b] > { current: 3, stale: 2, none: 1, unknown: 0 }[a] ? b : a);

async function detectAssistants() {
  const env = assistantEnv();
  const launch = mcpLaunchInfo();
  const skillBundle = loadSkillBundle();
  const cliPaths = new Map();
  await Promise.all([...new Set(AssistantClients.CLIENTS.filter((c) => c.cli).map((c) => c.cli))].map(async (name) => cliPaths.set(name, await findCommand(name, env))));

  const assistants = await Promise.all(AssistantClients.CLIENTS.map(async (c) => {
    const cliPath = c.cli ? cliPaths.get(c.cli) : null;
    const dirHit = (c.appDirs ? c.appDirs(env) : []).some(pathExists);
    const extHit = c.extPrefix ? extensionInstalled(c.extPrefix, env) : false;
    const installed = !c.generic && !!(cliPath || dirHit || extHit);
    // Version only for the well-known command-line agents — never launch an editor just to ask its version.
    const version = c.cliVersion && cliPath && !/["\r\n`$]/.test(cliPath) ? ((await execQuick(`"${cliPath}" --version`, 6000)) || '').split(/\r?\n/)[0].slice(0, 80) || null : null;

    let added = 'unknown', addedIn = [];
    const configPath = c.stateFile ? c.stateFile(env) : null;
    if (configPath) {
      added = 'none';
      for (const file of [configPath, ...(c.stateAlso ? c.stateAlso(env) : [])]) {
        const content = c.stateKind === 'toml' ? (pathExists(file) ? (() => { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; } })() : null) : readJsonFile(file, null);
        if (content === null || content === undefined) continue;
        const r = c.stateOf(content, launch);
        added = betterState(added, r.state);
        if (r.scopes) addedIn = r.scopes;
      }
    }
    return {
      id: c.id, name: c.name, generic: !!c.generic, installed, version, path: cliPath,
      configPath, configExists: pathExists(configPath), added, addedIn, docs: c.docs || null,
      setup: c.setup(launch, env),
      skill: AssistantSkills.skillSetup(c.id, { platform: env.platform, name: c.name, skillMd: skillBundle ? skillBundle.skillMd : '', available: !!skillBundle, state: skillBundle ? installedSkillState(c.id, env, skillBundle.skillMd) : 'unknown' }),
    };
  }));
  const found = assistants.find((a) => a.installed);
  return {
    platform: process.platform, assistants, recommended: found ? found.id : 'claudeCode', anyFound: !!found, detectedAt: new Date().toISOString(),
    skill: skillBundle ? { name: AssistantSkills.SKILL_NAME, zipName: AssistantSkills.ZIP_NAME, files: skillBundle.files.length, bytes: skillBundle.bytes } : null,
  };
}

// Launch the MCP server exactly as a client would, speak the protocol to it and
// report what it found. Proves the command works and shows how it connected.
function runMcpSelfTest(timeoutMs = 25000) {
  const { spawn } = require('child_process');
  const launch = mcpLaunchInfo();
  return new Promise((resolve) => {
    const started = Date.now();
    let child, buf = '', stderr = '', done = false;
    const replies = {};
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child && child.kill(); } catch (_) {}
      resolve({ ms: Date.now() - started, command: launch.command, ...result });
    };
    const timer = setTimeout(() => finish({ ok: false, error: `No answer within ${Math.round(timeoutMs / 1000)}s`, stderr: stderr.slice(-500) }), timeoutMs);
    const send = (msg) => { try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch (_) {} };
    try {
      child = spawn(launch.command, launch.args, { env: { ...process.env, ...launch.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { return finish({ ok: false, error: e.message }); }
    child.on('error', (e) => finish({ ok: false, error: `Could not start: ${e.message}` }));
    child.on('exit', (code) => finish({ ok: false, error: `The MCP server exited early (code ${code})`, stderr: stderr.slice(-500) }));
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch (_) { return finish({ ok: false, error: 'The MCP server printed non-protocol text to stdout', stderr: line.slice(0, 200) }); }
        if (m.id === undefined) continue;
        replies[m.id] = m;
        if (m.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
          send({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
          send({ jsonrpc: '2.0', id: 4, method: 'prompts/list' });
          send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_status', arguments: {} } });
        }
        if (replies[2] && replies[3] && replies[4] && replies[5]) {
          const conn = (replies[5].result && replies[5].result.structuredContent && replies[5].result.structuredContent.connection) || {};
          return finish({
            ok: true,
            server: replies[1].result && replies[1].result.serverInfo,
            tools: replies[2].result.tools.length, resources: replies[3].result.resources.length, prompts: replies[4].result.prompts.length,
            connection: { mode: conn.mode, source: conn.source },
            attachedToThisApp: conn.url === `http://127.0.0.1:${PORT}`,
          });
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'trafficdrive-selftest', version: getAppVersion() } } });
  });
}

// --- Route handlers --------------------------------------------------------

async function handleRequest(req, res) {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;
  const method = req.method;

  // --- Request gate --------------------------------------------------------
  // 1. Only requests addressed to localhost (blocks DNS rebinding).
  // 2. Only the file:// dashboard or non-browser clients (blocks websites).
  // 3. Every API call must present the per-launch token.
  if (!isAllowedHost(req.headers.host) || !isAllowedOrigin(req.headers.origin)) {
    sendJSON(res, 403, { success: false, error: 'Forbidden origin' });
    return;
  }

  // CORS preflight (allowed origins only — checked above)
  if (method === 'OPTIONS') {
    sendJSON(res, 204, {});
    return;
  }

  const presented = req.headers['x-td-token'] || parsed.searchParams.get('token') || '';
  if (!tokenMatches(String(presented))) {
    sendJSON(res, 401, { success: false, error: 'Missing or invalid API token' });
    return;
  }

  // --- Health check ---
  if (pathname === '/api/health' && method === 'GET') {
    const all = [...processes.values()];
    sendJSON(res, 200, {
      success: true, status: 'ok', version: getAppVersion(), platform: process.platform, uptimeSec: Math.round(process.uptime()),
      processes: processes.size,
      running: all.filter(pr => !TERMINAL_STATUSES.has(pr.status)).length,
      proxies: loadedProxies.length,
      autoRestart: autoRestartEnabled,
      serverSchedules: (loadScheduleData(), savedSchedules.filter(sc => sc.runner === 'server' && sc.enabled).length),
      limits: { maxThreads: MAX_THREADS, maxSessions: MAX_SESSIONS },
    });
    return;
  }

  // --- Browser detection ---
  if (pathname === '/api/browsers/detect' && method === 'GET') {
    loadBrowserRegistry();
    const systemBrowsers = detectSystemBrowsers();
    const installed = getInstalledBrowsers();
    const browsers = [
      { id: 'chromium', name: 'Chromium (Playwright)', path: findCachedChromiumSafe() },
      { id: 'custom', name: 'Custom Path', path: '' },
    ];
    // Add system-detected browsers
    for (const sb of systemBrowsers) {
      const idx = browsers.findIndex(b => b.id === sb.id);
      if (idx >= 0) {
        browsers[idx].path = sb.path;
      } else {
        const names = {
          'chrome': 'Google Chrome', 'chrome-beta': 'Chrome Beta', 'chrome-dev': 'Chrome Dev',
          'chrome-canary': 'Chrome Canary', 'edge': 'Microsoft Edge', 'edge-beta': 'Edge Beta',
          'edge-dev': 'Edge Dev', 'edge-canary': 'Edge Canary', 'brave': 'Brave',
          'brave-beta': 'Brave Beta', 'brave-nightly': 'Brave Nightly', 'vivaldi': 'Vivaldi',
          'opera': 'Opera', 'opera-gx': 'Opera GX', 'firefox': 'Mozilla Firefox',
          'firefox-dev': 'Firefox Developer', 'firefox-nightly': 'Firefox Nightly',
          'waterfox': 'Waterfox', 'librewolf': 'LibreWolf', 'thorium': 'Thorium',
          'maxthon': 'Maxthon', 'slimjet': 'Slimjet',
        };
        browsers.push({ id: sb.id, name: names[sb.id] || sb.id, path: sb.path });
      }
    }
    // Add NGF NOMI TOOLS-installed browsers
    for (const ib of installed) {
      if (ib.path && fs.existsSync(ib.path)) {
        const idx = browsers.findIndex(b => b.id === ib.id);
        if (idx >= 0) {
          browsers[idx].path = ib.path;
        } else {
          browsers.push({ id: ib.id, name: ib.name, path: ib.path });
        }
      }
    }
    // Add custom browsers
    for (const cb of customBrowsers) {
      if (cb.path && fs.existsSync(cb.path)) {
        browsers.push({ id: cb.id, name: cb.name, path: cb.path });
      }
    }
    sendJSON(res, 200, { success: true, browsers, installed, customBrowsers });
    return;
  }

  // --- Browsers: install (download + extract) ---
  if (pathname === '/api/browsers/install' && method === 'POST') {
    const body = await readBody(req);
    const id = String(body.id || '');
    // id becomes a folder / file name — reject anything that could escape
    // the install directory (e.g. "..\\..\\Startup").
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(id) || id.includes('..')) {
      sendJSON(res, 400, { success: false, error: 'Invalid browser id' });
      return;
    }
    const entry = LibraryCatalog.BROWSERS.find(b => b.id === id);
    let url, name;
    if (req.headers['x-td-client'] === 'mcp') {
      // An AI assistant can only install what the app's own browser library offers —
      // it can never point the downloader (and later the launcher) at a URL of its choosing.
      if (body.url) { sendJSON(res, 400, { success: false, error: "Downloads come from the app's browser library — do not pass a url" }); return; }
      if (!entry) { sendJSON(res, 404, { success: false, error: `Unknown browser "${id}" (see the browser library)` }); return; }
      if (!entry.dlUrl) { sendJSON(res, 400, { success: false, error: `${entry.name} has no direct download in the library — get it from ${entry.dl}` }); return; }
      url = safeHttpUrl(entry.dlUrl); name = entry.name;
    } else {
      url = safeHttpUrl(body.url || (entry && entry.dlUrl));
      name = String(body.name || (entry && entry.name) || id);
    }
    if (!url) { sendJSON(res, 400, { success: false, error: 'id and a valid http(s) url are required' }); return; }
    if (process.platform !== 'win32') {
      // The library's downloads are Windows builds and the installer only looks for .exe files.
      sendJSON(res, 400, { success: false, error: 'The browser library installs Windows builds; on this operating system install the browser normally, then add it with "add custom browser".' });
      return;
    }
    const active = browserInstallProgress.get(id);
    if (active && (active.status === 'downloading' || active.status === 'extracting')) {
      sendJSON(res, 409, { success: false, error: 'Install already in progress' });
      return;
    }
    // Start the install in the background
    installBrowserTask(id, name, url).catch(() => {});
    sendJSON(res, 200, { success: true, message: 'Install started', id, name });
    return;
  }

  // --- Browsers: install status (polling alternative to the progress stream) ---
  if (pathname === '/api/browsers/install-status' && method === 'GET') {
    const wanted = parsed.searchParams.get('id');
    const installs = [...browserInstallStatus.values()].filter(x => !wanted || x.id === wanted);
    sendJSON(res, 200, { success: true, installs });
    return;
  }

  // --- Browsers: progress (SSE stream) ---
  if (pathname === '/api/browsers/progress' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...corsHeaders(req),
    });
    res.write('retry: 2000\n\n');
    // Send current state for all in-progress installs
    for (const [id, data] of browserInstallProgress) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
    browserProgressClients.add(res);
    req.on('close', () => { browserProgressClients.delete(res); });
    return;
  }

  // --- Browsers: add custom browser ---
  if (pathname === '/api/browsers/add' && method === 'POST') {
    loadBrowserRegistry();
    const body = await readBody(req);
    const id = body.id || ('custom-' + Date.now());
    const name = body.name || 'Custom Browser';
    const browserPath = String(body.path || '').trim();
    let isFile = false;
    try { isFile = !!browserPath && fs.statSync(browserPath).isFile(); } catch (_) {}
    if (!isFile) {
      sendJSON(res, 400, { success: false, error: 'Invalid browser path (must be an existing executable file)' });
      return;
    }
    const entry = { id, name, path: browserPath, addedAt: new Date().toISOString() };
    // Replace if same id exists
    const idx = customBrowsers.findIndex(b => b.id === id);
    if (idx >= 0) customBrowsers[idx] = entry;
    else customBrowsers.push(entry);
    saveBrowserRegistry();
    sendJSON(res, 200, { success: true, browser: entry });
    return;
  }

  // --- Browsers: remove custom browser ---
  if (pathname === '/api/browsers/remove' && method === 'POST') {
    loadBrowserRegistry();
    const body = await readBody(req);
    const id = body.id;
    if (!id) { sendJSON(res, 400, { success: false, error: 'id required' }); return; }
    customBrowsers = customBrowsers.filter(b => b.id !== id);
    saveBrowserRegistry();
    sendJSON(res, 200, { success: true });
    return;
  }

  // --- Browsers: list installed ---
  if (pathname === '/api/browsers/installed' && method === 'GET') {
    loadBrowserRegistry();
    const installed = getInstalledBrowsers().filter(b => b.path && fs.existsSync(b.path));
    sendJSON(res, 200, { success: true, installed, customBrowsers });
    return;
  }

  // --- Browsers: launch (open a browser for testing) ---
  if (pathname === '/api/browsers/launch' && method === 'POST') {
    const body = await readBody(req);
    let browserPath = String(body.path || '');
    if (!browserPath && body.id) browserPath = browserPathById(String(body.id));
    // Only launch executables this app already knows as browsers (detected,
    // installed by the app, or added by the user) — never an arbitrary path.
    if (!browserPath || !knownBrowserPaths().has(path.resolve(browserPath)) || !fs.existsSync(browserPath)) {
      sendJSON(res, 400, { success: false, error: 'Browser not found in the detected/installed browser list' });
      return;
    }
    // The optional URL must be a real http(s) URL; this also prevents
    // smuggling command-line switches (e.g. "--renderer-cmd-prefix=...").
    let args = [];
    if (body.url) {
      const safe = safeHttpUrl(body.url);
      if (!safe) {
        sendJSON(res, 400, { success: false, error: 'url must be an http(s) URL' });
        return;
      }
      args = [safe];
    }
    try {
      const { spawn } = require('child_process');
      const child = spawn(browserPath, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      sendJSON(res, 200, { success: true });
    } catch (e) {
      sendJSON(res, e instanceof SyntaxError ? 400 : 500, { success: false, error: e.message });
    }
    return;
  }

  // --- Proxies: list. No query = the whole list; with limit/offset/status/type/q/sort = one filtered page;
  //     usable=1 = everything except proxies already found dead (what a campaign should use). ---
  if (pathname === '/api/proxies' && method === 'GET') {
    const sp = parsed.searchParams;
    const stats = proxyStats();
    if (sp.get('usable') === '1') { sendJSON(res, 200, { success: true, proxies: loadedProxies.filter((p) => p.status !== 'dead'), stats }); return; }
    if (!['limit', 'offset', 'status', 'type', 'q', 'sort'].some((k) => sp.has(k))) { sendJSON(res, 200, { success: true, proxies: loadedProxies, stats }); return; }
    let list = loadedProxies;
    const status = sp.get('status');
    if (status && status !== 'all') list = list.filter((p) => (status === 'unchecked' ? !p.status : p.status === status));
    const type = sp.get('type');
    if (type && type !== 'all') list = list.filter((p) => p.type === type);
    const q = (sp.get('q') || '').trim().toLowerCase();
    if (q) list = list.filter((p) => `${p.host}:${p.port}`.includes(q));
    if (sp.get('sort') === 'speed') list = list.slice().sort((a, b) => (a.ms == null ? 1e12 : a.ms) - (b.ms == null ? 1e12 : b.ms));
    const limit = clampInt(sp.get('limit'), 1, 1000, 100), offset = clampInt(sp.get('offset'), 0, 1e9, 0);
    sendJSON(res, 200, { success: true, proxies: list.slice(offset, offset + limit), filtered: list.length, offset, limit, stats });
    return;
  }

  // --- Proxies: load. Either ready records (`proxies`) or pasted text (`text` + default `type`); duplicates are skipped. ---
  if (pathname === '/api/proxies/load' && method === 'POST') {
    const body = await readBody(req);
    let records = Array.isArray(body.proxies) ? body.proxies : [];
    let badLines = 0, invalidLines = [];
    if (typeof body.text === 'string' && body.text.trim()) {
      const type = ProxyTools.SCHEMES.includes(String(body.type).toLowerCase()) ? String(body.type).toLowerCase() : 'http';
      const t = ProxyTools.parseText(body.text, type);
      records = records.concat(t.proxies);
      badLines = t.invalid;
      invalidLines = t.invalidLines;        // which lines failed and why — the page shows them and keeps them in the box
    }
    const r = addToProxyList(records);
    proxiesChanged();
    // Chrome cannot use SOCKS proxies that need a password: say so now rather than let them fail later
    const socksLogin = records.filter((p) => /^socks/i.test(String(p.type)) && p.username).length;
    sendJSON(res, 200, { success: true, count: loadedProxies.length, added: r.added, duplicates: r.duplicates, invalid: r.invalid + badLines, invalidLines, socksLogin, stats: proxyStats() });
    return;
  }

  // --- Proxy sources: the lists "Scrape" downloads. Built-ins can be switched off; the user can add their own. ---
  if (pathname === '/api/proxies/sources' && method === 'GET') {
    sendJSON(res, 200, { success: true, sources: proxySources.list() });
    return;
  }
  if (pathname === '/api/proxies/sources' && method === 'POST') {
    // An assistant must not be able to point the app at a proxy list of its choosing (the proxies it contains would
    // then carry the user's traffic). Sources are added from the app only.
    if (req.headers['x-td-client'] === 'mcp') { sendJSON(res, 403, { success: false, error: 'Proxy sources can only be added from the app itself, not by an AI assistant' }); return; }
    const body = await readBody(req).catch(() => ({}));
    try { sendJSON(res, 200, { success: true, source: proxySources.add(body), sources: proxySources.list() }); }
    catch (e) { sendJSON(res, 400, { success: false, error: e.message }); }
    return;
  }
  if (pathname === '/api/proxies/sources/update' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const id = String(body.id || '');
    try {
      if ((body.name !== undefined || body.type !== undefined) && req.headers['x-td-client'] === 'mcp') {
        sendJSON(res, 403, { success: false, error: 'Proxy sources can only be edited from the app itself, not by an AI assistant' }); return;
      }
      if (body.name !== undefined || body.type !== undefined) proxySources.update(id, { name: body.name, type: body.type });
      if (body.enabled !== undefined) proxySources.setEnabled(id, !!body.enabled);
      sendJSON(res, 200, { success: true, source: proxySources.get(id), sources: proxySources.list() });
    } catch (e) { sendJSON(res, e.message === 'Source not found' ? 404 : 400, { success: false, error: e.message }); }
    return;
  }
  if (pathname === '/api/proxies/sources/delete' && method === 'POST') {
    if (req.headers['x-td-client'] === 'mcp') { sendJSON(res, 403, { success: false, error: 'Proxy sources can only be removed from the app itself, not by an AI assistant' }); return; }
    const body = await readBody(req).catch(() => ({}));
    try { proxySources.remove(String(body.id || '')); sendJSON(res, 200, { success: true, sources: proxySources.list() }); }
    catch (e) { sendJSON(res, e.message === 'Source not found' ? 404 : 400, { success: false, error: e.message }); }
    return;
  }

  // --- Proxies: scrape. Downloads every enabled source (or the given sourceIds) in parallel and adds what it finds. ---
  if (pathname === '/api/proxies/scrape' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const ids = Array.isArray(body.sourceIds) ? body.sourceIds.map(String) : null;
    try {
      const r = await scrapeSourcesNow(ids);
      const add = addToProxyList(r.proxies);
      proxiesChanged();
      sendJSON(res, 200, { success: true, scraped: r.proxies.length, added: add.added, total: loadedProxies.length, results: r.results, stats: proxyStats() });
    } catch (e) {
      sendJSON(res, e.statusCode || 500, { success: false, error: e.message });
    }
    return;
  }

  // --- Automatic proxies: keep working ones loaded (saved across restarts, topped up when too few) ---
  if (pathname === '/api/proxies/auto' && method === 'GET') {
    sendJSON(res, 200, { success: true, ...proxyAutomation.status() });
    return;
  }
  if (pathname === '/api/proxies/auto' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const patch = {};
    if (body.enabled !== undefined) patch.enabled = !!body.enabled;
    if (body.target !== undefined) {
      const t = parseInt(body.target, 10);
      if (!(t >= 1 && t <= 1000)) { sendJSON(res, 400, { success: false, error: 'target must be between 1 and 1000' }); return; }
      patch.target = t;
    }
    if (Object.keys(patch).length) saveSettings({ proxyAuto: { ...getSettings().proxyAuto, ...patch } });
    if (body.runNow || patch.enabled === true || patch.target !== undefined) proxyAutomation.kick();
    sendJSON(res, 200, { success: true, ...proxyAutomation.status() });
    return;
  }

  // --- Proxies: check. start → poll status → (cancel). A job reports progress while it runs. ---
  if (pathname === '/api/proxies/validate/start' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    try { const job = beginValidation(body, { mcp: req.headers['x-td-client'] === 'mcp' }); sendJSON(res, 200, { success: true, job: job.snapshot() }); }
    catch (e) { sendJSON(res, e.status || e.statusCode || 500, { success: false, error: e.message, ...(e.status === 409 && activeValidation ? { job: activeValidation.snapshot() } : {}) }); }
    return;
  }
  if (pathname === '/api/proxies/validate/status' && method === 'GET') {
    const wanted = parsed.searchParams.get('id');
    const job = wanted ? validationJobs.get(wanted) : activeValidation;
    sendJSON(res, 200, { success: true, job: job ? job.snapshot() : null, stats: proxyStats() });
    return;
  }
  if (pathname === '/api/proxies/validate/cancel' && method === 'POST') {
    const running = activeValidation && activeValidation.status === 'running';
    if (running) activeValidation.cancel();
    sendJSON(res, 200, { success: true, cancelled: !!running, job: activeValidation ? activeValidation.snapshot() : null });
    return;
  }
  // Check and wait for the result in one call (what the MCP server and older clients use).
  if (pathname === '/api/proxies/validate' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    let job;
    try { job = beginValidation(body, { mcp: req.headers['x-td-client'] === 'mcp' }); } catch (e) { sendJSON(res, e.status || e.statusCode || 500, { success: false, error: e.message }); return; }
    res.on('close', () => { if (!res.writableEnded) job.cancel(); });   // the caller gave up — stop wasting connections
    await job.finished;
    if (job.status === 'error') { sendJSON(res, 503, { success: false, error: job.error }); return; }
    const results = Array.from(job.results, (r) => r || { ok: false, ms: 0, skipped: true });
    sendJSON(res, 200, { success: true, results, working: job.working, total: job.total, checked: job.done, removed: job.removed, stoppedEarly: job.stoppedEarly, cancelled: job.status === 'cancelled', elapsedMs: job.finishedAt - job.startedAt, stats: proxyStats() });
    return;
  }

  // --- Proxies: remove (by host:port; type optional) ---
  if (pathname === '/api/proxies/remove' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const targets = (Array.isArray(body.proxies) ? body.proxies : []).filter(x => x && x.host && x.port);
    const before = loadedProxies.length;
    loadedProxies = loadedProxies.filter(lp => !targets.some(t =>
      String(t.host).toLowerCase() === String(lp.host).toLowerCase() &&
      String(t.port) === String(lp.port) &&
      (!t.type || String(t.type).toLowerCase() === String(lp.type).toLowerCase())));
    proxiesChanged();
    sendJSON(res, 200, { success: true, removed: before - loadedProxies.length, total: loadedProxies.length });
    return;
  }

  // --- Proxies: clear all ---
  if (pathname === '/api/proxies/clear' && method === 'POST') {
    if (activeValidation && activeValidation.status === 'running') activeValidation.cancel();
    loadedProxies = [];
    proxiesChanged();
    sendJSON(res, 200, { success: true });
    return;
  }

  // --- Proxies: remove the ones found dead ---
  if (pathname === '/api/proxies/remove-dead' && method === 'POST') {
    const before = loadedProxies.length;
    loadedProxies = loadedProxies.filter((p) => p.status !== 'dead');
    proxiesChanged();
    sendJSON(res, 200, { success: true, removed: before - loadedProxies.length, total: loadedProxies.length, stats: proxyStats() });
    return;
  }

  // --- Auto-restart ---
  if (pathname === '/api/autorestart/enable' && method === 'POST') {
    autoRestartEnabled = true;
    sendJSON(res, 200, { success: true, enabled: true });
    return;
  }
  if (pathname === '/api/autorestart/disable' && method === 'POST') {
    autoRestartEnabled = false;
    sendJSON(res, 200, { success: true, enabled: false });
    return;
  }

  // --- RPA: Start recording (opens a browser for recording) ---
  if (pathname === '/api/rpa/start' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    // Default to google.com if no (valid) URL provided — fresh tab experience
    const url = safeHttpUrl(body.url) || 'https://www.google.com';
    try {
      // Starting a new recording must not leak the previous browser.
      await closeRpaBrowser();
      const { chromium } = require('playwright');
      const browserPath = findCachedChromiumSafe();
      const launchOpts = { headless: !!body.headless };
      if (browserPath) launchOpts.executablePath = browserPath;
      const browser = await chromium.launch(launchOpts);
      const context = await browser.newContext();

      rpaState.browser = browser;
      rpaState.context = context;
      rpaState.actions = [];
      rpaState.recording = true;

      // Actions are sent to Node the moment they happen, so they survive page
      // navigations (the old in-page array was wiped on every new document).
      await context.exposeBinding('__rpaPush', (source, action) => {
        if (!rpaState.recording || rpaState.context !== context) return;
        if (!action || typeof action !== 'object') return;
        if (rpaState.actions.length >= 20000) return;
        rpaState.actions.push(action);
      });
      // Registered BEFORE the first navigation so the first page is recorded.
      await context.addInitScript(rpaRecorderScript);

      const page = await context.newPage();
      rpaState.page = page;
      // Record navigations from Node, with the destination URL.
      page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame() || !rpaState.recording || rpaState.page !== page) return;
        const u = frame.url();
        if (!u || u === 'about:blank') return;
        const last = rpaState.actions[rpaState.actions.length - 1];
        if (last && last.type === 'navigate' && last.url === u) return;
        rpaState.actions.push({ type: 'navigate', url: u, ts: Date.now() });
      });
      // If the user closes the window, keep the actions recorded so far.
      browser.on('disconnected', () => {
        if (rpaState.browser === browser) {
          rpaState.browser = null;
          rpaState.context = null;
          rpaState.page = null;
        }
      });

      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (_) {}
      sendJSON(res, 200, { success: true, message: 'Recording browser opened', url });
    } catch (e) {
      rpaState.recording = false;
      await closeRpaBrowser();
      sendJSON(res, e instanceof SyntaxError ? 400 : 500, { success: false, error: e.message });
    }
    return;
  }

  // --- RPA: Stop & Save (closes browser, returns recorded actions) ---
  if (pathname === '/api/rpa/stop' && method === 'POST') {
    // Flush any input that is still inside its debounce window.
    if (rpaState.page && !rpaState.page.isClosed()) {
      try {
        await Promise.race([
          rpaState.page.evaluate(() => { if (window.__rpaFlush) window.__rpaFlush(); }),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 200)); // let the binding call land
      } catch (_) {}
    }
    rpaState.recording = false;
    const actions = rpaState.actions
      .map((a, i) => ({ a, i }))
      .sort((x, y) => ((x.a.ts || 0) - (y.a.ts || 0)) || (x.i - y.i))
      .map((x) => x.a);
    rpaState.actions = [];
    closeRpaBrowser().catch(() => {}); // don't block the response
    const stopBody = await readBody(req).catch(() => ({}));
    let recording = null;
    if (stopBody.save) {
      try { recording = rpaRecordingMeta(saveRpaRecording({ name: stopBody.name, actions, duration: stopBody.duration })); }
      catch (e) { sendJSON(res, e.statusCode || 500, { success: false, error: e.message, actions }); return; }
    }
    sendJSON(res, 200, { success: true, actions, recording });
    return;
  }

  // --- RPA: status ---
  if (pathname === '/api/rpa/status' && method === 'GET') {
    sendJSON(res, 200, {
      success: true,
      recording: !!rpaState.recording,
      browserOpen: !!rpaState.browser,
      actionCount: rpaState.actions.length,
      url: rpaState.page && !rpaState.page.isClosed() ? rpaState.page.url() : null,
    });
    return;
  }

  // --- RPA: recording library ---
  if (pathname === '/api/rpa/recordings' && method === 'GET') {
    sendJSON(res, 200, { success: true, recordings: loadRpaRecordings().map(rpaRecordingMeta) });
    return;
  }
  const recMatch = pathname.match(/^\/api\/rpa\/recordings\/([^/]+)$/);
  if (recMatch && method === 'GET') {
    const rec = loadRpaRecordings().find(r => r.id === decodeURIComponent(recMatch[1]));
    if (!rec) { sendJSON(res, 404, { success: false, error: 'Recording not found' }); return; }
    sendJSON(res, 200, { success: true, recording: rec });
    return;
  }
  if (pathname === '/api/rpa/recordings' && method === 'POST') {
    try {
      const body = await readBody(req);
      const rec = saveRpaRecording(body);
      sendJSON(res, 200, { success: true, recording: rpaRecordingMeta(rec) });
    } catch (e) {
      sendJSON(res, e.statusCode || (e instanceof SyntaxError ? 400 : 500), { success: false, error: e.message });
    }
    return;
  }
  if (pathname === '/api/rpa/recordings/delete' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const list = loadRpaRecordings();
    if (!list.some(r => r.id === body.id)) { sendJSON(res, 404, { success: false, error: 'Recording not found' }); return; }
    saveRpaRecordings(list.filter(r => r.id !== body.id));
    sendJSON(res, 200, { success: true });
    return;
  }

  // --- RPA: Play (replays recorded actions) ---
  if (pathname === '/api/rpa/play' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    let actions;
    try {
      if (body.recordingId) {
        const rec = loadRpaRecordings().find(r => r.id === body.recordingId);
        if (!rec) { sendJSON(res, 404, { success: false, error: 'Recording not found' }); return; }
        actions = rec.actions;
      } else {
        actions = sanitizeRpaActions(body.actions || []);
      }
    } catch (e) { sendJSON(res, e.statusCode || 400, { success: false, error: e.message }); return; }
    const speed = parseFloat(body.speed) > 0 ? parseFloat(body.speed) : 1;
    try {
      const r = await replayActions(actions, { speed, headless: !!body.headless });
      sendJSON(res, 200, { success: true, message: 'Replay complete', actionsPlayed: r.actionsPlayed });
    } catch (e) {
      sendJSON(res, e instanceof SyntaxError ? 400 : 500, { success: false, error: e.message });
    }
    return;
  }

  // --- Schedule: Save (saves to list of saved schedules) ---
  if (pathname === '/api/schedule/save' && method === 'POST') {
    loadScheduleData();
    try {
      const body = await readBody(req);
      const idx = body.id ? savedSchedules.findIndex(sc => sc.id === body.id) : -1;
      const sched = prepareSchedule(body, idx >= 0 ? savedSchedules[idx] : null);
      if (idx >= 0) savedSchedules[idx] = sched;
      else savedSchedules.push(sched);
      scheduleState = { ...sched };
      persistSchedules();
      sendJSON(res, 200, { success: true, schedule: sched, savedSchedules });
    } catch (e) {
      sendJSON(res, e.statusCode || (e instanceof SyntaxError ? 400 : 500), { success: false, error: e.message });
    }
    return;
  }

  // --- Schedule: List (returns all saved schedules) ---
  if (pathname === '/api/schedule/list' && method === 'GET') {
    loadScheduleData();
    sendJSON(res, 200, { success: true, savedSchedules });
    return;
  }

  // --- Schedule: Get ---
  if (pathname === '/api/schedule/get' && method === 'GET') {
    loadScheduleData();
    sendJSON(res, 200, { success: true, schedule: scheduleState, savedSchedules });
    return;
  }

  // --- Schedule: Toggle ---
  if (pathname === '/api/schedule/toggle' && method === 'POST') {
    loadScheduleData();
    const body = await readBody(req).catch(() => ({}));
    if (body.id) {
      // Toggle a specific saved schedule
      const sched = savedSchedules.find(sc => sc.id === body.id);
      if (!sched) { sendJSON(res, 404, { success: false, error: 'Schedule not found' }); return; }
      const enable = body.enabled !== undefined ? !!body.enabled : !sched.enabled;
      if (enable && sched.runner === 'server') {
        try { Object.assign(sched, prepareSchedule({ ...sched, enabled: true }, sched)); }
        catch (e) { sendJSON(res, e.statusCode || 500, { success: false, error: e.message }); return; }
      } else {
        sched.enabled = enable;
        if (!enable) sched.nextRunAt = null;
      }
      persistSchedules();
      sendJSON(res, 200, { success: true, enabled: sched.enabled, schedule: sched, savedSchedules });
      return;
    }
    scheduleState.enabled = body.enabled !== undefined ? body.enabled : !scheduleState.enabled;
    persistSchedules();
    sendJSON(res, 200, { success: true, enabled: scheduleState.enabled, savedSchedules });
    return;
  }

  // --- Schedule: Delete (removes a specific schedule or all) ---
  if (pathname === '/api/schedule/delete' && method === 'POST') {
    loadScheduleData();
    const body = await readBody(req).catch(() => ({}));
    if (body.id) {
      if (!savedSchedules.some(sc => sc.id === body.id)) { sendJSON(res, 404, { success: false, error: 'Schedule not found' }); return; }
      savedSchedules = savedSchedules.filter(sc => sc.id !== body.id);
      persistSchedules();
      sendJSON(res, 200, { success: true, savedSchedules });
      return;
    }
    // Delete all
    scheduleState = {};
    savedSchedules = [];
    try { fs.unlinkSync(SCHEDULE_FILE); } catch (_) {}
    sendJSON(res, 200, { success: true, savedSchedules });
    return;
  }

  // --- Schedule: Run now ---
  if (pathname === '/api/schedule/run' && method === 'POST') {
    loadScheduleData();
    try {
      const body = await readBody(req);
      const sched = savedSchedules.find(sc => sc.id === body.id);
      if (!sched) { sendJSON(res, 404, { success: false, error: 'Schedule not found' }); return; }
      const proc = await runSchedule(sched, 'run now');
      persistSchedules();
      sendJSON(res, 200, { success: true, processId: proc.id, mode: proc.type, status: proc.status });
    } catch (e) {
      sendJSON(res, e.statusCode || (e instanceof SyntaxError ? 400 : 500), { success: false, error: e.message });
    }
    return;
  }

  // --- Traffic start endpoints ---
  // POST /api/<mode>/start (dashboard) and POST /api/campaigns/start {mode,...}
  const startMatch = pathname.match(/^\/api\/(organic|direct|referral|gmaps)\/start$/);
  if ((startMatch || pathname === '/api/campaigns/start') && method === 'POST') {
    try {
      const body = await readBody(req);
      const mode = startMatch ? startMatch[1] : String(body.mode || '');
      // Who asked: the dashboard's own routes, an MCP client (it says so in X-TD-Client), or a plain API caller.
      const origin = req.headers['x-td-client'] === 'mcp' ? 'mcp' : (startMatch ? 'dashboard' : 'api');
      const proc = await startCampaignVerified(mode, body, origin);
      sendJSON(res, 200, { success: true, processId: proc.id, mode: proc.type, status: proc.status, proxyCheck: proc.proxyCheck || null });
    } catch (e) {
      sendJSON(res, e.statusCode || (e instanceof SyntaxError ? 400 : 500), { success: false, error: e.message, ...(e.proxyCheck ? { proxyCheck: e.proxyCheck } : {}) });
    }
    return;
  }

  // --- Saved campaigns (the Campaigns page) ---
  if (pathname === '/api/saved-campaigns' && method === 'GET') {
    sendJSON(res, 200, { success: true, campaigns: loadSavedCampaigns() });
    return;
  }
  if (pathname === '/api/saved-campaigns' && method === 'POST') {
    try {
      const body = await readBody(req);
      const list = loadSavedCampaigns();
      const idx = body.id ? list.findIndex(c => c.id === body.id) : -1;
      if (body.id && idx < 0) throw httpError(404, 'Saved campaign not found');
      const t = prepareSavedCampaign(body, idx >= 0 ? list[idx] : null);
      if (idx >= 0) list[idx] = t; else list.push(t);
      persistSavedCampaigns(list);
      sendJSON(res, 200, { success: true, campaign: t, campaigns: list });
    } catch (e) {
      sendJSON(res, e.statusCode || (e instanceof SyntaxError ? 400 : 500), { success: false, error: e.message });
    }
    return;
  }
  if (pathname === '/api/saved-campaigns/delete' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const list = loadSavedCampaigns();
    if (!list.some(c => c.id === body.id)) { sendJSON(res, 404, { success: false, error: 'Saved campaign not found' }); return; }
    const rest = list.filter(c => c.id !== body.id);
    persistSavedCampaigns(rest);
    sendJSON(res, 200, { success: true, campaigns: rest });
    return;
  }
  if (pathname === '/api/saved-campaigns/run' && method === 'POST') {
    try {
      const body = await readBody(req);
      const list = loadSavedCampaigns();
      const t = list.find(c => c.id === body.id);
      if (!t) throw httpError(404, 'Saved campaign not found');
      const origin = req.headers['x-td-client'] === 'mcp' ? 'mcp' : 'dashboard';
      const proc = await startCampaignVerified(t.mode, savedCampaignRequest(t, body.overrides && typeof body.overrides === 'object' ? body.overrides : null), origin);
      t.lastRunAt = Date.now(); t.runCount = (t.runCount || 0) + 1; t.lastProcessId = proc.id;
      persistSavedCampaigns(list);
      pushLog(proc, `Started from saved campaign "${t.name}"`, 'info');
      sendJSON(res, 200, { success: true, processId: proc.id, mode: proc.type, status: proc.status });
    } catch (e) {
      sendJSON(res, e.statusCode || (e instanceof SyntaxError ? 400 : 500), { success: false, error: e.message });
    }
    return;
  }

  // --- Campaign list / details ---
  if (pathname === '/api/processes' && method === 'GET') {
    const wanted = parsed.searchParams.get('status');
    const list = [...processes.values()]
      .filter(pr => !wanted || pr.status === wanted)
      .map(describeProcess);
    sendJSON(res, 200, { success: true, processes: list, total: list.length });
    return;
  }
  const procMatch = pathname.match(/^\/api\/processes\/([^/]+)$/);
  if (procMatch && method === 'GET') {
    const proc = processes.get(decodeURIComponent(procMatch[1]));
    if (!proc) { sendJSON(res, 404, { success: false, error: 'Process not found' }); return; }
    sendJSON(res, 200, { success: true, process: describeProcess(proc) });
    return;
  }

  // --- Stop / pause / resume ---
  const controlMatch = pathname.match(/^\/api\/(stop|pause|resume)\/(.+)$/);
  if (controlMatch && method === 'POST') {
    const action = controlMatch[1];
    const id = decodeURIComponent(controlMatch[2]);
    const proc = processes.get(id);
    if (!proc) {
      sendJSON(res, 404, { success: false, error: 'Process not found' });
      return;
    }
    if (action === 'stop') {
      stopProcess(proc);
      sendJSON(res, 200, { success: true, status: proc.status });
      return;
    }
    if (TERMINAL_STATUSES.has(proc.status)) {
      sendJSON(res, 409, { success: false, error: `Campaign already ${proc.status}` });
      return;
    }
    if (proc.status === 'restarting') {
      sendJSON(res, 409, { success: false, error: 'Campaign is between loop iterations — stop it or wait for the next run' });
      return;
    }
    if (action === 'pause' && proc.status !== 'paused') {
      try { proc.emitter.emit('pause'); } catch (_) {}
      proc.status = 'paused';
    } else if (action === 'resume' && proc.status === 'paused') {
      try { proc.emitter.emit('resume'); } catch (_) {}
      proc.status = 'running';
    }
    sendJSON(res, 200, { success: true, status: proc.status });
    return;
  }

  if (pathname === '/api/stop-all' && method === 'POST') {
    let stopped = 0;
    for (const [, proc] of processes) {
      if (TERMINAL_STATUSES.has(proc.status)) continue;
      stopProcess(proc);
      stopped++;
    }
    sendJSON(res, 200, { success: true, stopped });
    return;
  }

  // --- Logs polling ---
  // GET /api/logs/:id?since=<seq> → only entries newer than <seq>. The client
  // keeps the returned lastSeq and sends it next time, so nothing repeats.
  const logsMatch = pathname.match(/^\/api\/logs\/(.+)$/);
  if (logsMatch && method === 'GET') {
    const id = decodeURIComponent(logsMatch[1]);
    const proc = processes.get(id);
    if (!proc) {
      sendJSON(res, 404, { success: false, error: 'Process not found' });
      return;
    }
    const since = toInt(parsed.searchParams.get('since'), 0);
    const logs = since > 0 ? proc.logs.filter(l => l.seq > since) : proc.logs;
    sendJSON(res, 200, {
      success: true,
      logs,
      lastSeq: proc.logSeq,
      status: proc.status,
      stats: proc.stats || null,
      summary: proc.summary || null,
      iteration: proc.iteration,
    });
    return;
  }

  // --- Privacy: verify that the chosen protections really work ---
  if (pathname === '/api/privacy/verify' && method === 'POST') {
    try {
      const body = await readBody(req);
      const resolved = PrivacyCatalog.resolve(body);
      if (!resolved.features.length) { sendJSON(res, 400, { success: false, error: 'Choose privacyFeatures or a privacyProfile (balanced / stealth) to verify' }); return; }
      const result = await require('./PrivacyVerify.js').verifyPrivacy({
        features: resolved.features,
        userAgent: typeof body.userAgent === 'string' ? body.userAgent : undefined,
        device: body.device,
      });
      sendJSON(res, 200, { success: true, ...result });
    } catch (e) {
      sendJSON(res, e.statusCode || (e instanceof SyntaxError ? 400 : 500), { success: false, error: e.message });
    }
    return;
  }

  // --- Settings ---
  if (pathname === '/api/settings' && method === 'GET') {
    sendJSON(res, 200, { success: true, settings: getSettings(), connection: connectionStatus() });
    return;
  }
  if (pathname === '/api/settings' && method === 'POST') {
    try {
      const body = await readBody(req);
      const patch = {};
      if (body.allowMcpConnections !== undefined) {
        if (typeof body.allowMcpConnections !== 'boolean') throw httpError(400, 'allowMcpConnections must be true or false');
        patch.allowMcpConnections = body.allowMcpConnections;
      }
      saveSettings(patch);
      syncConnectionFile(); // takes effect immediately: publish or withdraw the connection file
      sendJSON(res, 200, { success: true, settings: getSettings(), connection: connectionStatus() });
    } catch (e) {
      sendJSON(res, e.statusCode || (e instanceof SyntaxError ? 400 : 500), { success: false, error: e.message });
    }
    return;
  }

  // --- MCP: setup info + self-test ---
  if (pathname === '/api/mcp/info' && method === 'GET') {
    sendJSON(res, 200, { success: true, version: getAppVersion(), backendUrl: `http://127.0.0.1:${PORT}`, connection: connectionStatus(), launch: mcpLaunchInfo() });
    return;
  }
  if (pathname === '/api/mcp/detect' && method === 'GET') {
    sendJSON(res, 200, { success: true, ...(await detectAssistants()) });
    return;
  }
  if (pathname === '/api/mcp/skill.zip' && method === 'GET') {
    const bundle = loadSkillBundle();
    if (!bundle) { sendJSON(res, 404, { success: false, error: 'The TrafficDrive skill files are not included in this build' }); return; }
    const zip = SkillPackage.buildZip(AssistantSkills.SKILL_NAME, bundle.files);
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length, 'Content-Disposition': `attachment; filename="${AssistantSkills.ZIP_NAME}"`, 'Cache-Control': 'no-store', ...corsHeaders(res.req) });
    res.end(zip);
    return;
  }
  if (pathname === '/api/mcp/selftest' && method === 'POST') {
    sendJSON(res, 200, { success: true, result: await runMcpSelfTest() });
    return;
  }

  // --- Catalog: everything a client needs to build a valid request ---
  if (pathname === '/api/catalog' && method === 'GET') {
    sendJSON(res, 200, {
      success: true,
      modes: Object.entries(CAMPAIGN_MODES).map(([id, d]) => ({ id, label: d.label })),
      searchEngines: Object.values(SEARCH_ENGINES).map(({ id, name }) => ({ id, name })),
      socialPlatforms: Object.values(SOCIAL_PLATFORMS).map(({ id, name }) => ({ id, name })),
      devices: ['desktop', 'mobile', 'tablet'],
      privacy: {
        features: PrivacyCatalog.FEATURES,
        profiles: PrivacyCatalog.PROFILES,
      },
      limits: { maxThreads: MAX_THREADS, maxSessions: MAX_SESSIONS },
    });
    return;
  }

  // --- 404 ---
  sendJSON(res, 404, { success: false, error: `Unknown endpoint: ${method} ${pathname}` });
}

// --- Small filesystem helpers for browser detection ---
function safeExists(p) {
  try { return fs.existsSync(p) ? p : ''; } catch (_) { return ''; }
}

// id → executable for a browser the app knows (cached Chromium, detected, installed, custom).
function browserPathById(id) {
  loadBrowserRegistry();
  if (id === 'chromium') return findCachedChromiumSafe();
  const found = [...detectSystemBrowsers(), ...getInstalledBrowsers(), ...customBrowsers].find(b => b.id === id && b.path);
  return found ? found.path : '';
}

// Every browser executable the dashboard can legitimately ask to launch.
function knownBrowserPaths() {
  loadBrowserRegistry();
  const set = new Set();
  const add = (p) => { if (p) set.add(path.resolve(p)); };
  add(findCachedChromiumSafe());
  for (const b of detectSystemBrowsers()) add(b.path);
  for (const b of getInstalledBrowsers()) add(b.path);
  for (const b of customBrowsers) add(b.path);
  return set;
}

function findBundledChromium() {
  // In a packaged Electron app electron-builder copies extraResources to
  // process.resourcesPath. We ship Chromium there so users do not need to
  // download anything extra.
  try {
    const candidates = [];
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'chromium', 'chrome-win64', 'chrome.exe'));
      candidates.push(path.join(process.resourcesPath, 'chromium', 'chrome-win', 'chrome.exe'));
    }
    // Also support running the server directly from the source tree (dev mode).
    candidates.push(path.join(__dirname, 'bundled-chromium', 'chrome-win64', 'chrome.exe'));
    candidates.push(path.join(__dirname, 'bundled-chromium', 'chrome-win', 'chrome.exe'));
    for (const exe of candidates) {
      const dir = path.dirname(exe);
      const dll = path.join(dir, 'chrome.dll');
      if (fs.existsSync(exe) && fs.existsSync(dll)) return exe;
    }
  } catch (_) {}
  return '';
}

function findCachedChromiumSafe() {
  // Prefer the Chromium we ship with the app over a system ms-playwright cache.
  const bundled = findBundledChromium();
  if (bundled) return bundled;
  try {
    // Shared, cross-platform cache scan (was Windows-only here as well).
    const { findCachedChromium } = require('./browser-launcher.js');
    return findCachedChromium() || '';
  } catch (_) {}
  return '';
}

// --- Server startup --------------------------------------------------------

let PORT = toInt(process.env.TD_PORT, 3000);

let serverInstance = null;

function createServer() {
  if (serverInstance) return serverInstance;
  
  serverInstance = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      const badRequest = err instanceof SyntaxError || /too large/i.test(err.message || '');
      if (!badRequest) console.error('[server] Unhandled error:', err);
      sendJSON(res, badRequest ? 400 : 500, { success: false, error: err.message });
    });
  });
  
  return serverInstance;
}

// --- App settings (settings.json) ----------------------------------------------
// allowMcpConnections: may AI assistants attach to this running app (publishes
// the connection file)? Default on; the dashboard's "AI Assistant" page toggles it.
let appSettings = null;
function getSettings() {
  if (!appSettings) {
    const saved = readJsonFile(SETTINGS_FILE, {});
    const pa = saved.proxyAuto || {};
    appSettings = {
      allowMcpConnections: saved.allowMcpConnections !== false,
      proxyAuto: { enabled: pa.enabled !== false, target: Math.min(1000, Math.max(1, parseInt(pa.target, 10) || 50)) },
    };
  }
  return appSettings;
}
function saveSettings(patch) {
  appSettings = { ...getSettings(), ...patch };
  try { writeJsonFile(SETTINGS_FILE, appSettings); } catch (e) { console.error('[settings] save failed:', e.message); }
  return appSettings;
}

// --- Connection file (lets the MCP server attach to this running app) ---------
// Written only when the host asks for it (the Electron app does) AND the user
// allows it AND TD_NO_CONNECTION_FILE is not set. Owner-only permissions,
// removed on shutdown, and added/removed live when the setting changes.
let connectionRequested = false; // the host (main.js) asked for it
let connectionWritten = false;

function getAppVersion() {
  try { return require('./package.json').version; } catch (_) { return 'unknown'; }
}

function connectionAllowed() {
  return connectionRequested && getSettings().allowMcpConnections && process.env.TD_NO_CONNECTION_FILE !== '1';
}

function removeConnectionFile() {
  try {
    const cur = readJsonFile(DISCOVERY_FILE, null);
    if (cur && cur.pid === process.pid) fs.unlinkSync(DISCOVERY_FILE);
  } catch (_) {}
  connectionWritten = false;
}
process.once('exit', () => { if (connectionWritten) removeConnectionFile(); });

// Bring the file in line with the settings: write it, or remove it.
function syncConnectionFile() {
  const listening = !!(serverInstance && serverInstance.listening);
  if (connectionAllowed() && listening) {
    try {
      writeJsonFile(DISCOVERY_FILE, {
        url: `http://127.0.0.1:${PORT}`, port: PORT, token: apiToken, pid: process.pid,
        startedAt: new Date().toISOString(), version: getAppVersion(),
      }, 0o600);
      connectionWritten = true;
    } catch (e) {
      console.error('[NGF NOMI TOOLS] Could not write the connection file:', e.message);
    }
  } else if (connectionWritten) {
    removeConnectionFile();
  }
}

// opts: { token?, port? (0 = any free port), publishConnectionInfo? (let local
//         tools such as the MCP server attach; main.js sets it) }
function startServer(opts = {}) {
  if (opts && typeof opts.token === 'string' && opts.token) {
    apiToken = opts.token;
  }
  if (opts && Number.isInteger(opts.port) && opts.port >= 0) {
    PORT = opts.port;
  }
  connectionRequested = !!(opts.publishConnectionInfo || opts.discovery);
  if (!apiToken) {
    // Standalone use (not launched from main.js): make a token and print it
    // so the API can still be called, e.g. with curl -H "X-TD-Token: ...".
    apiToken = crypto.randomBytes(32).toString('hex');
    console.log(`[NGF NOMI TOOLS] API token for this run: ${apiToken}`);
  }
  if (!proxiesRestored) {
    proxiesRestored = true;
    const n = proxyAutomation.restore();
    if (n) console.log(`[NGF NOMI TOOLS] Loaded ${n} working proxies saved last time.`);
  }
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once('listening', () => {
      PORT = server.address().port; // resolves port 0 → the real port
      startScheduler();
      syncConnectionFile();
      if (opts.proxyAutomation) proxyAutomation.start();
    });
    server.once('close', () => { removeConnectionFile(); proxyAutomation.stop(); });

    server.listen(PORT, '127.0.0.1', () => {
      console.log(`[NGF NOMI TOOLS] Backend server running on http://localhost:${PORT}`);
      resolve(server);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[NGF NOMI TOOLS] Port ${PORT} is already in use. Is another instance running?`);
      } else {
        console.error('[NGF NOMI TOOLS] Server error:', err);
      }
      reject(err);
    });
  });
}

module.exports = {
  get server() { return createServer(); },
  get port() { return PORT; },
  startServer,
  appDataDir,
};
