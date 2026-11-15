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
// Parsing lives in ProxyTools.js so the app and the MCP server accept exactly the same formats.
const { SCHEMES, parseProxyLine } = require('../ProxyTools.js');

// Never hand credentials back to the model.
function maskProxy(p) {
  return { type: p.type, host: p.host, port: p.port, auth: p.username ? `${p.username}:***` : null, ...(p.status ? { status: p.status } : {}), ...(typeof p.ms === 'number' && p.status === 'working' ? { ms: p.ms } : {}) };
}

function proxyKey(p) { return `${p.host}:${p.port}`; }

module.exports = { ok, fail, guarded, sleep, clip, parseProxyLine, maskProxy, proxyKey, SCHEMES };
