// ProxyTools.js — the one place that understands proxy text. Used by the backend (loading pasted lists and
// scraped sources) and by the MCP server, so every route in accepts exactly the same formats.
'use strict';

const SCHEMES = ['http', 'https', 'socks4', 'socks5'];
// socks5h / socks4a only say that the proxy should resolve host names; to us they are plain SOCKS5 / SOCKS4.
const SCHEME_ALIASES = { socks5h: 'socks5', socks4a: 'socks4' };

function validHost(h) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(h) || /^\[[0-9a-f:]+\]$/i.test(h);
}

// "host:port" or "[v6]:port" → [host, port] (or null if it is not exactly that).
function splitHostPort(hp) {
  const v6 = hp.match(/^(\[[0-9a-f:]+\]):(\d+)$/i);
  if (v6) return [v6[1], v6[2]];
  const parts = hp.split(':');
  return parts.length === 2 ? parts : null;
}

// Accepts: host:port | host:port:user:pass | user:pass@host:port |
//          scheme://host:port | scheme://user:pass@host:port   ([v6]:port too)
// Returns { proxy } or { error }.
function parseProxyLine(line, defaultType = 'http') {
  let s = String(line || '').trim();
  if (!s) return { error: 'empty line' };
  let type = defaultType;
  const m = s.match(/^([a-z][a-z0-9]*):\/\/(.+)$/i);
  if (m) {
    type = m[1].toLowerCase();
    s = m[2];
    type = SCHEME_ALIASES[type] || type;
    if (!SCHEMES.includes(type)) return { error: `unsupported scheme "${m[1]}" (use ${SCHEMES.join(', ')})` };
  }
  let hostPort = null, username = null, password = null;
  // user:pass@host:port — the LAST "@" separates credentials (passwords may contain "@")…
  const at = s.lastIndexOf('@');
  if (at > 0 && (hostPort = splitHostPort(s.slice(at + 1)))) {
    const cred = s.slice(0, at);
    const ci = cred.indexOf(':');
    username = ci >= 0 ? cred.slice(0, ci) : cred;
    password = ci >= 0 ? cred.slice(ci + 1) : '';
  } else {
    // …otherwise host:port or host:port:user:pass (an "@" here belongs to the password).
    hostPort = splitHostPort(s);
    if (!hostPort) {
      const parts = s.split(':');
      if (parts.length >= 4) {
        hostPort = [parts[0], parts[1]];
        username = parts[2];
        password = parts.slice(3).join(':');
      }
    }
  }
  if (!hostPort) return { error: 'expected host:port, host:port:user:pass, user:pass@host:port or scheme://…' };
  const [host, port] = hostPort;
  const portNum = parseInt(port, 10);
  if (!host || !validHost(host)) return { error: `invalid host "${host}"` };
  if (!(portNum >= 1 && portNum <= 65535) || String(portNum) !== String(port).trim()) return { error: `invalid port "${port}"` };
  return { proxy: { type, host, port: portNum, username: username || null, password: password || null, raw: `${host}:${portNum}` } };
}

// What to call a protocol label found in a list ("socks5", "HTTPS", ["http","https"] …).
function typeFromProtocol(label, fallback) {
  const s = String(label || '').toLowerCase();
  if (s.includes('socks5')) return 'socks5';
  if (s.includes('socks4')) return 'socks4';
  if (s.includes('https')) return 'https';
  if (s.includes('http')) return 'http';
  return fallback;
}

// One line of a pasted or downloaded list. Lists in the wild are messy, so after the strict parser (which handles every
// documented format exactly) a few harmless repairs are tried: "ip port" separated by spaces or a tab, a trailing "/"
// or path, a trailing ":", text glued to the port ("8080-US"), and an extra column after the port ("ip:port:US").
// Anything that still is not a proxy is reported, never guessed: ports must be 1-65535 and hosts must look like hosts.
function parseListLine(raw, defaultType = 'http') {
  let line = String(raw || '').replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim();
  line = line.replace(/\s+(#|\/\/).*$/, '').trim();                       // "ip:port   # note"
  const spaced = line.match(/^([^\s:@/]+)[ \t]+(\d{1,5})(?:[ \t].*)?$/);   // "1.2.3.4 8080"
  if (spaced) line = `${spaced[1]}:${spaced[2]}`;
  const token = line.split(/[\s,;|]+/)[0];
  let r = parseProxyLine(token, defaultType);
  if (r.proxy) return r;

  const m = token.match(/^([a-z][a-z0-9]*:\/\/)?([^/?#]*)/i);
  const scheme = m && m[1] ? m[1] : '';
  let body = m ? m[2] : token;
  body = body.replace(/:+$/, '');                                          // "1.2.3.4:8080:"
  body = body.replace(/^(.*:\d{1,5})[^\d:@].*$/, '$1');                    // "1.2.3.4:8080-US"
  let r2 = parseProxyLine(scheme + body, defaultType);
  if (r2.proxy) return r2;
  const parts = body.split(':');
  if (parts.length === 3 && !body.includes('@')) {                         // "1.2.3.4:8080:US"
    r2 = parseProxyLine(`${scheme}${parts[0]}:${parts[1]}`, defaultType);
    if (r2.proxy) return r2;
  }
  return r;                                                                // the original, most useful error
}

// A pasted or downloaded list: one proxy per line, "#" comments and blank lines ignored. `defaultType` applies to lines
// that do not carry a scheme. Returns { proxies, invalid, invalidLines } — `invalid` counts lines that looked like
// entries but failed, `invalidLines` lists the first of them ({ line, text, error }) so the user can be told which.
function parseText(text, defaultType = 'http', limit = 200000) {
  const proxies = [];
  const invalidLines = [];
  let invalid = 0;
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (proxies.length >= limit) break;
    const line = lines[i].replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim();
    if (!line || line[0] === '#' || line.startsWith('//')) continue;
    const r = parseListLine(line, defaultType);
    if (r.proxy) proxies.push(r.proxy);
    else { invalid++; if (invalidLines.length < 1000) invalidLines.push({ line: i + 1, text: line.slice(0, 200), error: r.error }); }
  }
  return { proxies, invalid, invalidLines };
}

// JSON lists (GeoNode and similar APIs): finds every object that has an address and a port, wherever it sits.
function parseJson(value, defaultType = 'http', limit = 200000) {
  const proxies = [];
  let visited = 0;
  const walk = (node, depth) => {
    if (proxies.length >= limit || depth > 8 || ++visited > 500000) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
    if (!node || typeof node !== 'object') return;
    const host = node.ip || node.host || node.address || node.IP;
    const port = node.port || node.Port;
    if (host && port && typeof host === 'string') {
      const labels = Array.isArray(node.protocols) ? node.protocols : [node.protocols || node.protocol || node.type];
      const types = [...new Set(labels.map((l) => typeFromProtocol(l, defaultType)))];
      for (const type of (types.length ? types : [defaultType])) {
        const r = parseProxyLine(`${host}:${port}`, type);
        if (r.proxy) proxies.push(r.proxy);
      }
      return;
    }
    Object.values(node).forEach((n) => { if (n && typeof n === 'object') walk(n, depth + 1); });
  };
  walk(value, 0);
  return { proxies, invalid: 0 };
}

// Text or JSON, decided by what the body looks like.
function parseAny(body, defaultType = 'http', limit = 200000) {
  const s = String(body || '').trim();
  if (s[0] === '{' || s[0] === '[') {
    try { return parseJson(JSON.parse(s), defaultType, limit); } catch (_) { /* not JSON after all — fall through to text */ }
  }
  return parseText(s, defaultType, limit);
}

// Same proxy, same key — used to avoid loading it twice.
const dedupeKey = (p) => `${p.type}:${String(p.host).toLowerCase()}:${p.port}`;

module.exports = { SCHEMES, SCHEME_ALIASES, validHost, splitHostPort, parseProxyLine, parseListLine, typeFromProtocol, parseText, parseJson, parseAny, dedupeKey };
