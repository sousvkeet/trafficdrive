// ProxySources.js — where "Scrape Proxies" gets its lists from.
//
// The sources the app always used are built in (so they are listed from the start and can be switched off);
// users can add their own list URLs. Custom sources and the on/off choices are saved in proxy-sources.json.
//
// Fetching is parallel (one slow source no longer delays the rest) and guarded:
//  - only http(s) URLs, with a size cap and a time limit;
//  - addresses on a private network (127.x, 10.x, 192.168.x, 169.254.x …) are refused — a source URL must not be a
//    way to poke at the user's own machine or LAN. TD_ALLOW_PRIVATE_SOURCES=1 lifts this (LAN lists, tests).
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const crypto = require('crypto');
const { parseAny, dedupeKey } = require('./ProxyTools.js');

const MAX_REDIRECTS = 5;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_CUSTOM_SOURCES = 50;
const TYPES = ['auto', 'http', 'https', 'socks4', 'socks5'];

const ps = (proto) => `https://api.proxyscrape.com/v2/?request=getproxies&protocol=${proto}&timeout=10000&country=all&ssl=all&anonymity=all`;
const pld = (t) => `https://www.proxy-list.download/api/v1/get?type=${t}`;
// Exactly the lists the scraper has always used.
const BUILTIN = [
  { id: 'proxyscrape-http', name: 'ProxyScrape · HTTP', url: ps('http'), type: 'http' },
  { id: 'proxyscrape-socks4', name: 'ProxyScrape · SOCKS4', url: ps('socks4'), type: 'socks4' },
  { id: 'proxyscrape-socks5', name: 'ProxyScrape · SOCKS5', url: ps('socks5'), type: 'socks5' },
  { id: 'geonode', name: 'GeoNode · all protocols', url: 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc', type: 'auto' },
  { id: 'proxy-list-download-http', name: 'proxy-list.download · HTTP', url: pld('http'), type: 'http' },
  { id: 'proxy-list-download-https', name: 'proxy-list.download · HTTPS', url: pld('https'), type: 'https' },
  { id: 'proxy-list-download-socks4', name: 'proxy-list.download · SOCKS4', url: pld('socks4'), type: 'socks4' },
  { id: 'proxy-list-download-socks5', name: 'proxy-list.download · SOCKS5', url: pld('socks5'), type: 'socks5' },
];

// ── private-network guard ─────────────────────────────────────────────────────
const allowPrivate = () => process.env.TD_ALLOW_PRIVATE_SOURCES === '1';

function isPrivateAddress(ip) {
  let a = String(ip).replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) a = mapped[1];
  if (net.isIPv4(a)) {
    const [p, q] = a.split('.').map(Number);
    return p === 0 || p === 10 || p === 127 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127) || p >= 224;
  }
  if (net.isIPv6(a)) return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
  return true;   // anything we cannot classify is treated as unsafe
}

// Throws for URLs that must not be fetched. (DNS names are checked again at connect time, see `lookup` below.)
function assertFetchable(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (_) { throw new Error('That is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http:// and https:// addresses are allowed');
  if (u.username || u.password) throw new Error('Put the address without a user name or password in it');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate() && net.isIP(host) && isPrivateAddress(host)) throw new Error('Addresses on a private network are not allowed');
  if (!allowPrivate() && /^localhost$/i.test(host)) throw new Error('Addresses on a private network are not allowed');
  return u;
}

// dns.lookup that refuses private results — catches names that resolve to the user's own network.
function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (!allowPrivate() && list.some((x) => isPrivateAddress(x.address))) {
      return cb(Object.assign(new Error('Addresses on a private network are not allowed'), { code: 'EPRIVATE' }));
    }
    cb(null, address, family);
  });
}

// GET with redirects, a size cap and an overall time limit.
function fetchText(urlStr, { timeoutMs = 15000, redirectsLeft = MAX_REDIRECTS } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = assertFetchable(urlStr); } catch (e) { reject(e); return; }
    const lib = u.protocol === 'https:' ? https : http;
    let done = false;
    const finish = (err, value) => { if (done) return; done = true; clearTimeout(timer); try { req.destroy(); } catch (_) {} err ? reject(err) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('timed out')), timeoutMs);
    const req = lib.get(u, { lookup: safeLookup, headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return finish(new Error('too many redirects'));
        let next;
        try { next = new URL(res.headers.location, u).toString(); } catch (e) { return finish(e); }
        clearTimeout(timer); done = true;
        fetchText(next, { timeoutMs, redirectsLeft: redirectsLeft - 1 }).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return finish(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) return finish(new Error('the list is too large (over 8 MB)')); chunks.push(c); });
      res.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
      res.on('error', (e) => finish(e));
    });
    req.on('error', (e) => finish(e));
  });
}

// ── the source list (built-ins + the user's own) ──────────────────────────────
function createSourceStore(filePath) {
  let state = { custom: [], disabled: [], lastRuns: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (raw && typeof raw === 'object') state = { custom: Array.isArray(raw.custom) ? raw.custom : [], disabled: Array.isArray(raw.disabled) ? raw.disabled : [], lastRuns: raw.lastRuns && typeof raw.lastRuns === 'object' ? raw.lastRuns : {} };
  } catch (_) {}

  const save = () => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, filePath);
    } catch (_) { /* a read-only data folder must not break scraping */ }
  };
  const view = (s, builtin) => ({ id: s.id, name: s.name, url: s.url, type: s.type, builtin, enabled: !state.disabled.includes(s.id), lastRun: state.lastRuns[s.id] || null });
  const find = (id) => BUILTIN.find((s) => s.id === id) || state.custom.find((s) => s.id === id);

  return {
    list() { return [...BUILTIN.map((s) => view(s, true)), ...state.custom.map((s) => view(s, false))]; },
    get(id) { const s = find(id); return s ? view(s, BUILTIN.some((b) => b.id === id)) : null; },
    add({ name, url, type }) {
      const t = String(type || 'auto').toLowerCase();
      if (!TYPES.includes(t)) throw new Error(`Type must be one of: ${TYPES.join(', ')}`);
      const u = assertFetchable(String(url || '').trim());
      const urlStr = u.toString();
      if (urlStr.length > 2048) throw new Error('That address is too long');
      if ([...BUILTIN, ...state.custom].some((s) => s.url === urlStr)) throw new Error('That source is already in the list');
      if (state.custom.length >= MAX_CUSTOM_SOURCES) throw new Error(`You can add up to ${MAX_CUSTOM_SOURCES} sources`);
      const label = String(name || '').trim().slice(0, 60) || u.hostname;
      const src = { id: 'src_' + crypto.randomBytes(5).toString('hex'), name: label, url: urlStr, type: t };
      state.custom.push(src);
      save();
      return view(src, false);
    },
    setEnabled(id, enabled) {
      if (!find(id)) throw new Error('Source not found');
      state.disabled = state.disabled.filter((x) => x !== id);
      if (!enabled) state.disabled.push(id);
      save();
      return this.get(id);
    },
    update(id, { name, type }) {
      const s = state.custom.find((x) => x.id === id);
      if (!s) throw new Error(BUILTIN.some((b) => b.id === id) ? 'Built-in sources can only be switched on or off' : 'Source not found');
      if (name !== undefined) s.name = String(name).trim().slice(0, 60) || s.name;
      if (type !== undefined) { const t = String(type).toLowerCase(); if (!TYPES.includes(t)) throw new Error(`Type must be one of: ${TYPES.join(', ')}`); s.type = t; }
      save();
      return this.get(id);
    },
    remove(id) {
      if (BUILTIN.some((b) => b.id === id)) throw new Error('Built-in sources cannot be removed — switch them off instead');
      const before = state.custom.length;
      state.custom = state.custom.filter((x) => x.id !== id);
      if (state.custom.length === before) throw new Error('Source not found');
      delete state.lastRuns[id];
      state.disabled = state.disabled.filter((x) => x !== id);
      save();
    },
    recordRun(id, run) { state.lastRuns[id] = run; save(); },
    enabledIds() { return this.list().filter((s) => s.enabled).map((s) => s.id); },
  };
}

// Download the given sources in parallel and merge what they contain.
// Returns { proxies (de-duplicated), results: [{ id, name, ok, count, invalid, error, ms }] }.
async function scrapeSources(sources, { concurrency = 6, timeoutMs = 15000, onResult } = {}) {
  const results = new Array(sources.length);
  const seen = new Set();
  const proxies = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= sources.length) return;
      const s = sources[i];
      const started = Date.now();
      let r;
      try {
        const body = await fetchText(s.url, { timeoutMs });
        const parsed = parseAny(body, s.type === 'auto' ? 'http' : s.type);
        let fresh = 0;
        for (const p of parsed.proxies) { const k = dedupeKey(p); if (!seen.has(k)) { seen.add(k); proxies.push(p); fresh++; } }
        r = { id: s.id, name: s.name, ok: true, count: parsed.proxies.length, fresh, invalid: parsed.invalid, error: null, ms: Date.now() - started };
        if (!parsed.proxies.length) r.error = 'no proxies found in the list';
      } catch (e) {
        r = { id: s.id, name: s.name, ok: false, count: 0, fresh: 0, invalid: 0, error: e.message || String(e), ms: Date.now() - started };
      }
      results[i] = r;
      if (onResult) onResult(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));
  return { proxies, results };
}

module.exports = { BUILTIN, TYPES, createSourceStore, scrapeSources, fetchText, assertFetchable, isPrivateAddress };
