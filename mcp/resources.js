// mcp/resources.js — read-only views of TrafficDrive state, plus a watcher that
// tells subscribed clients when something changes.
//
//   trafficdrive://status                    backend snapshot
//   trafficdrive://catalog                   valid option values
//   trafficdrive://campaigns                 all campaigns
//   trafficdrive://campaigns/{id}            one campaign (+ recent logs)
//   trafficdrive://campaigns/{id}/logs       its full log buffer (text)
//   trafficdrive://proxies                   loaded proxies (credentials masked)
//   trafficdrive://browsers                  available browsers
//   trafficdrive://schedules                 saved schedules
//   trafficdrive://privacy/features          the 34 protections
//   trafficdrive://privacy/profiles          none / balanced / stealth
//   trafficdrive://rpa/recordings            recording library
//   trafficdrive://saved-campaigns           the Campaigns page
//   trafficdrive://catalog/{user-agents,resolutions,browsers}   the built-in libraries
const crypto = require('crypto');
const { ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SubscribeRequestSchema, UnsubscribeRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const PrivacyCatalog = require('../PrivacyCatalog.js');
const LibraryCatalog = require('../LibraryCatalog.js');
const { maskProxy } = require('./util.js');

const JSON_MIME = 'application/json';
const enc = encodeURIComponent;
const hash = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex');

function registerResources(server, ctx) {
  const api = ctx.backend;
  const asJson = (uri, data) => ({ contents: [{ uri: typeof uri === 'string' ? uri : uri.href, mimeType: JSON_MIME, text: JSON.stringify(data, null, 2) }] });
  const logLine = (l) => `[${l.time}] ${l.type.toUpperCase().padEnd(7)} ${l.message}`;

  // ── fixed resources ──────────────────────────────────────────────────────────
  const fixed = [
    ['status', 'trafficdrive://status', 'Backend status', 'Version, running campaigns, loaded proxies and safety limits.', () => api.get('/api/health')],
    ['catalog', 'trafficdrive://catalog', 'Options catalog', 'Campaign modes, search engines, social platforms, devices and limits.', async () => { const c = await api.get('/api/catalog'); delete c.success; return { ...c, privacy: { features: c.privacy.features.length, profiles: Object.keys(c.privacy.profiles) } }; }],
    ['campaigns', 'trafficdrive://campaigns', 'Campaigns', 'Every running, paused and recently finished campaign.', async () => (await api.get('/api/processes')).processes],
    ['proxies', 'trafficdrive://proxies', 'Loaded proxies', 'Proxies loaded in the backend. Credentials are masked.', async () => { const r = await api.get('/api/proxies'); return { total: r.proxies.length, proxies: r.proxies.map(maskProxy) }; }],
    ['browsers', 'trafficdrive://browsers', 'Browsers', 'Browsers TrafficDrive can use.', async () => { const r = await api.get('/api/browsers/detect'); return { browsers: (r.browsers || []).filter((b) => b.path).map(({ id, name, path }) => ({ id, name, path })) }; }],
    ['schedules', 'trafficdrive://schedules', 'Schedules', 'Saved schedules (server-run and dashboard-run).', async () => (await api.get('/api/schedule/list')).savedSchedules],
    ['privacy-features', 'trafficdrive://privacy/features', 'Privacy features', 'The 34 privacy protections with descriptions.', async () => PrivacyCatalog.FEATURES],
    ['privacy-profiles', 'trafficdrive://privacy/profiles', 'Privacy profiles', 'The none / balanced / stealth presets and the features each enables.', async () => PrivacyCatalog.PROFILES],
    ['rpa-recordings', 'trafficdrive://rpa/recordings', 'RPA recordings', 'Saved record-and-replay sessions.', async () => (await api.get('/api/rpa/recordings')).recordings],
    ['saved-campaigns', 'trafficdrive://saved-campaigns', 'Saved campaigns', 'The Campaigns page: reusable campaign definitions.', async () => (await api.get('/api/saved-campaigns')).campaigns],
    ['catalog-user-agents', 'trafficdrive://catalog/user-agents', 'User Agent library', 'Built-in desktop and mobile User-Agent strings.', async () => LibraryCatalog.USER_AGENTS],
    ['catalog-resolutions', 'trafficdrive://catalog/resolutions', 'Resolution presets', 'Desktop and mobile screen resolution presets.', async () => LibraryCatalog.RESOLUTIONS],
    ['catalog-browsers', 'trafficdrive://catalog/browsers', 'Browser library', 'The 51 browsers of the Browser Library.', async () => LibraryCatalog.BROWSERS.map(({ id, name, engine, cat, size, dl, web, dlUrl }) => ({ id, name, engine, category: cat, size, downloadPage: dl, website: web, installable: !!dlUrl }))],
  ];
  const readers = new Map(); // uri → () => data  (also used by the change watcher)
  for (const [name, uri, title, description, read] of fixed) {
    readers.set(uri, read);
    server.registerResource(name, uri, { title, description, mimeType: JSON_MIME }, async () => asJson(uri, await read()));
  }

  // ── campaign templates ───────────────────────────────────────────────────────
  const campaignList = async () => (await api.get('/api/processes')).processes;

  server.registerResource('campaign', new ResourceTemplate('trafficdrive://campaigns/{id}', {
    list: async () => ({ resources: (await campaignList()).map((p) => ({ uri: `trafficdrive://campaigns/${p.id}`, name: `Campaign ${p.id}`, description: `${p.modeLabel} → ${p.target} (${p.status})`, mimeType: JSON_MIME })) }),
  }), { title: 'Campaign', description: 'One campaign: state, progress, settings and its most recent 50 log lines.', mimeType: JSON_MIME },
  async (uri, { id }) => {
    const { process: p } = await api.get(`/api/processes/${enc(id)}`);
    const logs = await api.get(`/api/logs/${enc(id)}`);
    return asJson(uri, { ...p, recentLogs: logs.logs.slice(-50).map(logLine) });
  });

  server.registerResource('campaign-logs', new ResourceTemplate('trafficdrive://campaigns/{id}/logs', {
    list: async () => ({ resources: (await campaignList()).map((p) => ({ uri: `trafficdrive://campaigns/${p.id}/logs`, name: `Logs of ${p.id}`, description: `${p.logCount} line(s)`, mimeType: 'text/plain' })) }),
  }), { title: 'Campaign logs', description: 'The campaign\'s full buffered log (up to 2000 lines).', mimeType: 'text/plain' },
  async (uri, { id }) => {
    const logs = await api.get(`/api/logs/${enc(id)}`);
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: logs.logs.map(logLine).join('\n') || '(no log lines yet)' }] };
  });

  // ── subscriptions + change watcher ────────────────────────────────────────────
  const subscribed = new Set();
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => { subscribed.add(req.params.uri); return {}; });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => { subscribed.delete(req.params.uri); return {}; });

  // What a subscribed client should be re-notified about, cheaply.
  async function fingerprint(uri, processes) {
    if (uri === 'trafficdrive://campaigns') return hash(processes.map((p) => [p.id, p.status, p.lastSeq, p.stats && p.stats.completed]));
    const m = uri.match(/^trafficdrive:\/\/campaigns\/([^/]+)(\/logs)?$/);
    if (m) { const p = processes.find((x) => x.id === m[1]); return p ? hash([p.status, p.lastSeq, p.iteration, p.stats && p.stats.completed]) : 'gone'; }
    if (readers.has(uri) && !/privacy|catalog|status/.test(uri)) return hash(await readers.get(uri)());
    return null; // static or ever-changing (uptime) — never pushed
  }

  let timer = null, busy = false;
  const statuses = new Map();
  const fps = new Map();
  let lastIds = null;
  let lastError = null;

  async function tick() {
    if (busy || !server.isConnected()) return;
    busy = true;
    try {
      const processes = await campaignList();

      const ids = processes.map((p) => p.id).sort().join(',');
      // (McpServer.sendResourceListChanged() returns void, not a promise.)
      if (lastIds !== null && ids !== lastIds) { try { server.sendResourceListChanged(); } catch (_) {} }
      lastIds = ids;

      for (const p of processes) {
        const prev = statuses.get(p.id);
        if (prev !== undefined && prev !== p.status) {
          const level = p.status === 'failed' || p.status === 'error' ? 'error' : p.status === 'completed' ? 'notice' : 'info';
          await server.sendLoggingMessage({ level, logger: 'trafficdrive', data: `Campaign ${p.id} (${p.mode}): ${prev} → ${p.status}${p.summary ? ` — ${p.summary.completed} completed, ${p.summary.failed} failed` : ''}` }).catch(() => {});
        }
        statuses.set(p.id, p.status);
      }

      for (const uri of subscribed) {
        const f = await fingerprint(uri, processes);
        if (f === null) continue;
        if (fps.has(uri) && fps.get(uri) !== f) await server.server.sendResourceUpdated({ uri }).catch(() => {});
        fps.set(uri, f);
      }
    } catch (e) {
      // Usually the backend being briefly unreachable — retry next tick. Say so once per distinct
      // problem on stderr, so a real bug here can never hide.
      const msg = String(e && e.message || e);
      if (msg !== lastError) { lastError = msg; process.stderr.write(`[trafficdrive-mcp] change watcher: ${msg}\n`); }
    } finally { busy = false; }
  }

  return {
    startWatcher() { if (!timer) { timer = setInterval(tick, 2000); timer.unref(); tick(); } },
    stopWatcher() { if (timer) clearInterval(timer); timer = null; },
    subscriptions: subscribed,
  };
}

module.exports = { registerResources };
