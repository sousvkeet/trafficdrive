// ProxyValidator.js — checks many proxies quickly and honestly.
//
// What "working" means here:
//  - Quick check (no address): the proxy must carry a request to a tiny test endpoint (Google's generate_204, with
//    Cloudflare's as a fallback) and the real server must answer exactly 204. Proxies that answer every request with
//    their own page do not pass.
//  - Address check (`testUrl`): the proxy must open THAT address — the page the campaign will visit — and get a normal
//    answer (2xx or a redirect). HTTPS addresses go through a CONNECT tunnel (or a SOCKS tunnel) and the site's
//    certificate is verified, so proxies that cannot tunnel HTTPS, that block the site, or that tamper with HTTPS fail.
//    Many free proxies pass the quick check and still cannot open an HTTPS site; this is the check that matters.
//
// Why it is fast: a pool of workers keeps `concurrency` checks in flight, a dead proxy never holds up the next one,
// progress is reported while it runs, and a cancel destroys the open sockets.
//
// Why it never wipes a list by mistake: before judging any proxy the test address is opened WITHOUT a proxy. If that
// fails (offline, site down, site refuses us) the job stops with an error and touches nothing.
'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { SocksClient } = require('socks');

const DEFAULT_TARGETS = ['http://www.gstatic.com/generate_204', 'http://cp.cloudflare.com/generate_204'];
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// TD_PROXY_TEST_URL swaps the quick-check target (used by the tests, which must not depend on the internet).
function targetCandidates() {
  return process.env.TD_PROXY_TEST_URL ? [process.env.TD_PROXY_TEST_URL] : DEFAULT_TARGETS;
}

// Extra trusted certificate authority (a company's own, or a test one): TD_EXTRA_CA=/path/to/ca.pem
function extraCa() {
  const f = process.env.TD_EXTRA_CA;
  if (!f) return undefined;
  try { return [...tls.rootCertificates, fs.readFileSync(f)]; } catch (_) { return undefined; }
}

// 'generic': exactly 204.  'open': a normal answer — 2xx, or a redirect (the proxy reached the site).
const isOk = (status, expect) => (expect === 'open' ? status >= 200 && status < 400 : status === 204);
const siteOf = (urlObj) => urlObj.origin;

// Open an address WITHOUT a proxy. → { ok, status, error }
function directOpen(targetUrl, { expect = 'generic', timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    let done = false, req = null;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); try { req && req.destroy(); } catch (_) {} resolve(v); } };
    const timer = setTimeout(() => finish({ ok: false, status: 0, error: 'timed out' }), timeoutMs);
    try {
      const u = new URL(targetUrl);
      const lib = u.protocol === 'https:' ? https : http;
      req = lib.get(u, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,*/*;q=0.8' }, ...(u.protocol === 'https:' ? { ca: extraCa() } : {}) },
        (res) => { res.resume(); finish({ ok: isOk(res.statusCode, expect), status: res.statusCode, error: null }); });
      req.on('error', (e) => finish({ ok: false, status: 0, error: e.code || e.message }));
    } catch (e) { finish({ ok: false, status: 0, error: e.message }); }
  });
}
const directCheck = (targetUrl, timeoutMs = 4000) => directOpen(targetUrl, { expect: 'generic', timeoutMs }).then((r) => r.ok);

async function pickTarget() {
  for (const t of targetCandidates()) {
    if (await directCheck(t)) return new URL(t);
  }
  return null;
}

// One proxy, one check. Resolves { ok, ms, status } — or { aborted: true } when the signal fired first (not the proxy's
// fault, so the caller leaves that proxy unchecked instead of calling it dead).
function checkProxy(proxy, { target, timeoutMs, signal, expect = 'generic' }) {
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
    const dead = () => finish({ ok: false, ms: 0 });
    const onAbort = () => finish({ aborted: true });
    const timer = setTimeout(dead, timeoutMs);
    if (signal) { if (signal.aborted) return finish({ aborted: true }); signal.addEventListener('abort', onAbort, { once: true }); }

    const type = String((proxy && proxy.type) || 'http').toLowerCase();
    const host = proxy && proxy.host;
    const port = parseInt(proxy && proxy.port, 10);
    if (!host || !port) return dead();
    const secure = target.protocol === 'https:';
    const targetHost = target.hostname;                                        // IPv6 keeps its [brackets] here
    const targetPort = parseInt(target.port, 10) || (secure ? 443 : 80);
    const path = target.pathname + target.search;
    const requestText = `GET ${path} HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: ${BROWSER_UA}\r\nAccept: text/html,application/xhtml+xml,*/*;q=0.8\r\nAccept-Language: en-US,en;q=0.9\r\nConnection: close\r\n\r\n`;

    // The tunnel to the site exists (CONNECT or SOCKS): for https add TLS — certificate checked — then ask for the page
    // and read just the status line.
    const speak = (socket) => {
      const go = (s) => {
        sock = s;
        let buf = '';
        s.setEncoding('utf8');
        s.on('data', (chunk) => {
          buf += chunk;
          const m = buf.match(/^HTTP\/1\.[01] (\d{3})/);
          if (m) finish({ ok: isOk(+m[1], expect), ms: Date.now() - start, status: +m[1] });
          else if (buf.length > 64) dead();
        });
        s.on('error', dead);
        s.on('close', dead);
        s.write(requestText);
      };
      if (!secure) return go(socket);
      const bare = targetHost.replace(/^\[|\]$/g, '');
      const t = tls.connect({ socket, host: bare, servername: net.isIP(bare) ? undefined : bare, ALPNProtocols: ['http/1.1'], ca: extraCa() });
      sock = t;
      t.once('secureConnect', () => go(t));
      t.on('error', dead);
    };

    try {
      if (type.startsWith('socks')) {
        SocksClient.createConnection({
          proxy: { host, port, type: type === 'socks4' ? 4 : 5, ...(proxy.username ? { userId: proxy.username } : {}), ...(proxy.password ? { password: proxy.password } : {}) },
          command: 'connect',
          destination: { host: targetHost.replace(/^\[|\]$/g, ''), port: targetPort },
          timeout: timeoutMs,
        }).then(({ socket }) => { if (settled) { socket.destroy(); return; } sock = socket; speak(socket); }).catch(dead);
        return;
      }

      const proxyHost = host.replace(/^\[|\]$/g, '');
      const auth = proxy.username ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64') } : {};
      if (secure) {
        // https through an http(s) proxy: ask for a tunnel (CONNECT). Proxies that do not allow it fail here.
        req = http.request({ hostname: proxyHost, port, method: 'CONNECT', path: `${targetHost}:${targetPort}`, headers: { Host: `${targetHost}:${targetPort}`, 'User-Agent': BROWSER_UA, ...auth } });
        req.on('connect', (res, socket) => { if (res.statusCode !== 200) { socket.destroy(); return dead(); } speak(socket); });
        req.on('response', () => dead());     // a plain answer instead of a tunnel
      } else {
        // http: ask the proxy to fetch the absolute URL.
        req = http.request({ hostname: proxyHost, port, method: 'GET', path: target.href, headers: { Host: target.host, 'User-Agent': BROWSER_UA, Accept: 'text/html,*/*;q=0.8', Connection: 'close', ...auth } },
          (res) => finish({ ok: isOk(res.statusCode, expect), ms: Date.now() - start, status: res.statusCode }));   // the status line is all we need
      }
      req.on('error', dead);
      req.end();
    } catch (_) {
      dead();
    }
  });
}

// A validation run over `proxies` (the objects themselves).
//   opts: { concurrency, timeoutMs, stopAfterWorking, removeDead, onlyUnchecked, skipped, testUrl, updateStatus, onResult, onFinish }
//   testUrl      — open this address through each proxy (see the top of the file); omitted = the quick check
//   updateStatus — write status / ms / checkedAt / checkedFor onto each proxy (default true)
//   onResult(proxy, { ok, ms }, site) — called for every finished check (the server keeps a short-lived memory of them)
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
      let target, expect, site;
      if (this.opts.testUrl) {
        target = new URL(this.opts.testUrl);
        expect = 'open';
        site = siteOf(target);
        const base = await directOpen(target.href, { expect: 'open', timeoutMs: 8000 });
        if (!base.ok) {
          this.status = 'error';
          this.error = base.status
            ? `Cannot open ${site} directly (HTTP ${base.status}), so proxies cannot be judged by it. Nothing was marked dead or removed.`
            : `Cannot open ${site} directly (${base.error}). Check the address and your internet connection. Nothing was marked dead or removed.`;
          return;
        }
      } else {
        target = await pickTarget();
        expect = 'generic';
        site = null;
        if (!target) {
          this.status = 'error';
          this.error = 'Cannot reach the test server directly. Check your internet connection — no proxy was marked dead and nothing was removed.';
          return;
        }
      }
      this.target = target.href;
      let next = 0;
      const worker = async () => {
        while (!this._ac.signal.aborted) {
          const i = next++;
          if (i >= this.proxies.length) return;
          const p = this.proxies[i];
          const r = await checkProxy(p, { target, timeoutMs: this.opts.timeoutMs, signal: this._ac.signal, expect });
          if (r.aborted) return;
          if (this.opts.updateStatus !== false) {
            p.status = r.ok ? 'working' : 'dead';
            p.ms = r.ok ? r.ms : null;
            p.checkedAt = Date.now();
            p.checkedFor = site;
          }
          if (this.opts.onResult) { try { this.opts.onResult(p, r, site || 'generic'); } catch (_) {} }
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
      target: this.target, testUrl: this.opts.testUrl || null, error: this.error, stoppedEarly: this.stoppedEarly, removed: this.removed, skipped: this.opts.skipped || 0,
      options: { concurrency: this.opts.concurrency, timeoutMs: this.opts.timeoutMs, stopAfterWorking: this.opts.stopAfterWorking || null, removeDead: !!this.opts.removeDead, onlyUnchecked: !!this.opts.onlyUnchecked },
    };
  }
}

module.exports = { ValidationJob, checkProxy, directOpen, directCheck, pickTarget, DEFAULT_TARGETS };
