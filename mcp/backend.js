// mcp/backend.js — how the MCP server reaches the TrafficDrive backend.
//
//   connect   attach to a backend that is already running, found via
//               1. --url / --token  (or TD_API_URL / TD_API_TOKEN), or
//               2. the connection file the running desktop app writes
//                  (owner-only api.json in the app data folder)
//   embedded  start a private backend inside this process on a free port
//   auto      (default) try connect, fall back to embedded
//
// Attaching to the desktop app means campaigns started by an AI client show up
// in the dashboard and vice-versa; embedded mode works headless with no app.

const fs = require('fs');
const crypto = require('crypto');
const { connectionFile } = require('../AppPaths.js');

class BackendError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
    this.body = body;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function makeClient({ url, token, mode, source, closeFn }) {
  const base = url.replace(/\/+$/, '');

  async function request(method, path, opts = {}) {
    const { body, query, timeoutMs = 30000, signal } = opts;
    let full = base + path;
    if (query) {
      const q = new URLSearchParams();
      Object.entries(query).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') q.set(k, String(v)); });
      if ([...q].length) full += '?' + q.toString();
    }
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    let res;
    try {
      res = await fetch(full, {
        method,
        headers: { 'X-TD-Token': token, 'X-TD-Client': 'mcp', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      if (e.name === 'TimeoutError') throw new BackendError(0, `The backend did not answer within ${Math.round(timeoutMs / 1000)}s (${method} ${path})`);
      if (e.name === 'AbortError') throw new BackendError(0, 'Request cancelled');
      throw new BackendError(0, `TrafficDrive backend is not reachable at ${base} (${(e.cause && e.cause.code) || e.message}). Is the app still running?`);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch (_) { /* non-JSON error page */ }
    if (!res.ok || (data && data.success === false)) {
      const msg = (data && data.error) || `HTTP ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`;
      throw new BackendError(res.status, msg, data);
    }
    return data || {};
  }

  return {
    mode, url: base, source,
    request,
    get: (path, opts) => request('GET', path, opts),
    post: (path, body, opts) => request('POST', path, { ...(opts || {}), body: body === undefined ? {} : body }),
    close: closeFn || (async () => {}),
  };
}

async function tryAttach(url, token, source) {
  const client = makeClient({ url, token, mode: 'connect', source });
  try {
    const health = await client.get('/api/health', { timeoutMs: 4000 });
    return { client, health };
  } catch (e) {
    return { error: e };
  }
}

// opts: { url?, token?, mode?: 'auto'|'connect'|'embedded', port?, log? }
async function connectBackend(opts = {}) {
  const log = opts.log || (() => {});
  const mode = opts.mode || 'auto';
  const failures = [];

  if (mode !== 'embedded') {
    if (opts.url) {
      if (!opts.token) throw new Error('--url requires --token (or TD_API_TOKEN)');
      const r = await tryAttach(opts.url, opts.token, 'explicit url');
      if (r.client) { log(`Attached to backend at ${opts.url}`); return r.client; }
      failures.push(`${opts.url}: ${r.error.message}`);
    } else {
      let info = null;
      try { info = JSON.parse(fs.readFileSync(connectionFile(), 'utf8')); } catch (_) {}
      if (info && info.url && info.token && pidAlive(info.pid)) {
        const r = await tryAttach(info.url, info.token, 'running TrafficDrive app');
        if (r.client) { log(`Attached to the running TrafficDrive app at ${info.url} (pid ${info.pid})`); return r.client; }
        failures.push(`${info.url}: ${r.error.message}`);
      } else if (info) {
        failures.push('connection file is stale (the app is not running)');
      }
    }
    if (mode === 'connect') {
      throw new Error('Could not attach to a running TrafficDrive backend. ' + (failures.join('; ') || 'No connection file found — start the desktop app, or pass --url and --token.'));
    }
  }

  // Embedded backend: private token, free port, nothing written to disk.
  const backend = require('../server.js');
  const token = crypto.randomBytes(32).toString('hex');
  const server = await backend.startServer({ token, port: Number.isInteger(opts.port) ? opts.port : 0 });
  const url = `http://127.0.0.1:${server.address().port}`;
  log(`Started an embedded backend at ${url}` + (failures.length ? ` (${failures.join('; ')})` : ''));
  const client = makeClient({
    url, token, mode: 'embedded', source: 'embedded backend',
    closeFn: async () => {
      try { await client.post('/api/stop-all', {}, { timeoutMs: 15000 }); } catch (_) {}
      await new Promise((resolve) => server.close(() => resolve()));
    },
  });
  return client;
}

module.exports = { connectBackend, BackendError };
