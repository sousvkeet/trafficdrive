// mcp/util.js — result helpers, proxy parsing/masking, small utilities.
const { BackendError } = require('./backend.js');

const MAX_TEXT = 24000; // keep tool output readable and cheap for the model

function clip(text, max = MAX_TEXT) {
  return text.length > max ? text.slice(0, max) + `\n… (truncated, ${text.length - max} more characters)` : text;
}

// Successful result: a one-line summary + the data as JSON text, and the same
// data as structuredContent for clients that use it.
function ok(data, summary) {
  const body = clip(JSON.stringify(data, null, 2));
  return {
    content: [{ type: 'text', text: summary ? `${summary}\n\n${body}` : body }],
    structuredContent: data,
  };
}

function fail(message, hint) {
  return { isError: true, content: [{ type: 'text', text: hint ? `${message}\n\nHint: ${hint}` : message }] };
}

// Wrap a tool handler so backend / unexpected errors become clear tool errors
// (isError: true) instead of protocol errors.
function guarded(handler) {
  return async (args, extra) => {
    try {
      return await handler(args || {}, extra);
    } catch (e) {
      if (e instanceof BackendError) {
        const hints = {
          401: 'The API token was rejected — restart the MCP server so it re-reads the connection file.',
          404: 'That id was not found. Use the matching list_* tool to see valid ids (finished campaigns are removed after 10 minutes).',
          409: 'The item is not in a state that allows this action.',
        };
        return fail(e.message, hints[e.status]);
      }
      return fail(`Unexpected error: ${e && e.message ? e.message : e}`);
    }
  };
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

// ── proxies ───────────────────────────────────────────────────────────────────
const SCHEMES = ['http', 'https', 'socks4', 'socks5'];

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

// Never hand credentials back to the model.
function maskProxy(p) {
  return { type: p.type, host: p.host, port: p.port, auth: p.username ? `${p.username}:***` : null };
}

function proxyKey(p) { return `${p.host}:${p.port}`; }

module.exports = { ok, fail, guarded, sleep, clip, parseProxyLine, maskProxy, proxyKey, SCHEMES };
