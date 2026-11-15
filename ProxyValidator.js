// ProxyValidator.js — checks many proxies quickly and honestly.
//
// Why the old checker was slow and unreliable, and what this does instead:
//  - It tested 20 proxies at a time, each with an 8 s timeout, one batch after another. A pool of workers now keeps
//    `concurrency` checks in flight at all times, so a dead proxy never holds up the next one.
//  - It reported nothing until the very end. A job reports progress as it goes and can be cancelled instantly (open
//    sockets are destroyed).
//  - It tested against httpbin.org, which is slow and often down. The test target is Google's generate_204 endpoint
//    (Cloudflare's as a fallback), picked by trying it WITHOUT a proxy first.
//  - It called anything below HTTP 400 "working", so proxies that hijack every request with their own page passed.
//    A working proxy must return exactly 204 with no body, which only the real server does.
//  - Offline, every proxy "failed" and the dead ones were deleted — i.e. the whole list. If the test server cannot be
//    reached directly the job stops with an error and touches nothing.
'use strict';
const http = require('http');
const { SocksClient } = require('socks');

const DEFAULT_TARGETS = ['http://www.gstatic.com/generate_204', 'http://cp.cloudflare.com/generate_204'];

// TD_PROXY_TEST_URL swaps the test target (used by the tests, which must not depend on the internet).
function targetCandidates() {
  return process.env.TD_PROXY_TEST_URL ? [process.env.TD_PROXY_TEST_URL] : DEFAULT_TARGETS;
}

// Can we reach this URL directly (no proxy) and get a 204?
function directCheck(targetUrl, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); try { req.destroy(); } catch (_) {} resolve(v); } };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const req = http.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => { res.resume(); finish(res.statusCode === 204); });
    req.on('error', () => finish(false));
  });
}

async function pickTarget() {
  for (const t of targetCandidates()) {
    if (await directCheck(t)) return new URL(t);
  }
  return null;
}

// One proxy, one check. Resolves { ok, ms } — or { aborted: true } when the signal fired first (not the proxy's fault,
// so the caller leaves that proxy unchecked instead of calling it dead).
function checkProxy(proxy, { target, timeoutMs, signal }) {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false, req = null, sock = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { if (req) req.destroy(); } catch (_) {}
      try { if (sock) sock.destroy(); } catch (_) {}
      resolve(r);
    };
    const onAbort = () => finish({ aborted: true });
    const timer = setTimeout(() => finish({ ok: false, ms: 0 }), timeoutMs);
    if (signal) { if (signal.aborted) return finish({ aborted: true }); signal.addEventListener('abort', onAbort, { once: true }); }

    const type = String((proxy && proxy.type) || 'http').toLowerCase();
    const host = proxy && proxy.host;
    const port = parseInt(proxy && proxy.port, 10);
    if (!host || !port) return finish({ ok: false, ms: 0 });
    const path = target.pathname + target.search;
    const targetPort = parseInt(target.port, 10) || 80;

    try {
      if (type.startsWith('socks')) {
        SocksClient.createConnection({
          proxy: { host, port, type: type === 'socks4' ? 4 : 5, ...(proxy.username ? { userId: proxy.username } : {}), ...(proxy.password ? { password: proxy.password } : {}) },
          command: 'connect',
          destination: { host: target.hostname, port: targetPort },
          timeout: timeoutMs,
        }).then(({ socket }) => {
          sock = socket;
          if (settled) { socket.destroy(); return; }
          let buf = '';
          socket.setEncoding('utf8');
          socket.on('data', (chunk) => {
            buf += chunk;
            const m = buf.match(/^HTTP\/1\.[01] (\d{3})/);
            if (m) finish({ ok: m[1] === '204', ms: Date.now() - start });
            else if (buf.length > 64) finish({ ok: false, ms: 0 });
          });
          socket.on('error', () => finish({ ok: false, ms: 0 }));
          socket.on('close', () => finish({ ok: false, ms: 0 }));
          socket.write(`GET ${path} HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n`);
        }).catch(() => finish({ ok: false, ms: 0 }));
        return;
      }

      // http / https proxies: ask the proxy to fetch the absolute URL.
      const headers = { Host: target.host, 'User-Agent': 'Mozilla/5.0', Connection: 'close' };
      if (proxy.username) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
      req = http.request({ hostname: host.replace(/^\[|\]$/g, ''), port, method: 'GET', path: target.href, headers }, (res) => {
        // The status line is all we need; don't wait for (or keep open) the rest of the response.
        finish({ ok: res.statusCode === 204, ms: Date.now() - start });
      });
      req.on('error', () => finish({ ok: false, ms: 0 }));
      req.end();
    } catch (_) {
      finish({ ok: false, ms: 0 });
    }
  });
}

// A validation run over `proxies` (the objects themselves: each gets status / ms / checkedAt as it is checked).
//   opts: { concurrency, timeoutMs, stopAfterWorking, removeDead, onlyUnchecked, onFinish(job) }
class ValidationJob {
  constructor(id, proxies, opts) {
    this.id = id;
    this.proxies = proxies;
    this.opts = opts;
    this.status = 'running';          // running | done | cancelled | error
    this.total = proxies.length;
    this.done = 0; this.working = 0; this.dead = 0; this.sumMs = 0;
    this.results = new Array(proxies.length);
    this.startedAt = Date.now(); this.finishedAt = null;
    this.target = null; this.error = null; this.stoppedEarly = false; this.removed = 0;
    this._ac = new AbortController();
    this.finished = this._run();
  }

  async _run() {
    try {
      const target = await pickTarget();
      if (!target) {
        this.status = 'error';
        this.error = 'Cannot reach the test server directly. Check your internet connection — no proxy was marked dead and nothing was removed.';
        return;
      }
      this.target = target.href;
      let next = 0;
      const worker = async () => {
        while (!this._ac.signal.aborted) {
          const i = next++;
          if (i >= this.proxies.length) return;
          const p = this.proxies[i];
          const r = await checkProxy(p, { target, timeoutMs: this.opts.timeoutMs, signal: this._ac.signal });
          if (r.aborted) return;
          p.status = r.ok ? 'working' : 'dead';
          p.ms = r.ok ? r.ms : null;
          p.checkedAt = Date.now();
          this.results[i] = { ok: !!r.ok, ms: r.ok ? r.ms : 0 };
          this.done++;
          if (r.ok) { this.working++; this.sumMs += r.ms; } else this.dead++;
          if (this.opts.stopAfterWorking && this.working >= this.opts.stopAfterWorking) { this.stoppedEarly = true; this._ac.abort(); }
        }
      };
      const n = Math.max(1, Math.min(this.opts.concurrency, this.proxies.length));
      await Promise.all(Array.from({ length: n }, worker));
      this.status = this._cancelled ? 'cancelled' : 'done';
    } catch (e) {
      this.status = 'error';
      this.error = e && e.message ? e.message : String(e);
    } finally {
      this.finishedAt = Date.now();
      // e.g. drop the dead proxies from the list — done here, before anyone can poll "done", so they never see a half-finished job
      if (this.opts.onFinish) { try { this.opts.onFinish(this); } catch (_) {} }
    }
  }

  cancel() { if (this.status === 'running') { this._cancelled = true; this._ac.abort(); } }

  snapshot() {
    const end = this.finishedAt || Date.now();
    return {
      id: this.id, status: this.status, total: this.total, done: this.done, working: this.working, dead: this.dead,
      avgMs: this.working ? Math.round(this.sumMs / this.working) : null,
      startedAt: this.startedAt, finishedAt: this.finishedAt, elapsedMs: end - this.startedAt,
      target: this.target, error: this.error, stoppedEarly: this.stoppedEarly, removed: this.removed,
      options: { concurrency: this.opts.concurrency, timeoutMs: this.opts.timeoutMs, stopAfterWorking: this.opts.stopAfterWorking || null, removeDead: !!this.opts.removeDead, onlyUnchecked: !!this.opts.onlyUnchecked },
    };
  }
}

module.exports = { ValidationJob, checkProxy, directCheck, pickTarget, DEFAULT_TARGETS };
