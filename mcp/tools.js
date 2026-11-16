// mcp/tools.js — every MCP tool. Thin, validated wrappers over the backend API.
const path = require('path');
const PrivacyCatalog = require('../PrivacyCatalog.js');
const LibraryCatalog = require('../LibraryCatalog.js');
const S = require('./schemas.js');
const { ok, fail, guarded, sleep, parseProxyLine, maskProxy, proxyKey } = require('./util.js');
const { z } = S;

const TERMINAL = new Set(['completed', 'stopped', 'failed', 'error']);
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const enc = encodeURIComponent;

// Behavioural hints for clients (they may ask the user before running some).
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const VISITS_WEB = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

function registerTools(server, ctx) {
  const api = ctx.backend;
  const tool = (name, config, handler) => server.registerTool(name, config, guarded(handler));

  // ── shared helpers ──────────────────────────────────────────────────────────
  function summarizeCampaign(p) {
    const st = p.stats || {};
    return {
      id: p.id, mode: p.mode, origin: p.origin, status: p.status, target: p.target,
      progress: { completed: st.completed || 0, failed: st.failed || 0, running: st.running || 0, pending: st.pending || 0, total: st.total || 0, percent: st.progress || 0 },
      loop: p.loop, iteration: p.iteration, startedAt: p.startedAt, endedAt: p.endedAt,
      usesProxies: p.usesProxies, privacyLevel: p.privacy && p.privacy.level,
      ...(p.proxyCheck ? { proxyCheck: p.proxyCheck } : {}),
    };
  }
  const logLine = (l) => `[${l.time.slice(11, 19)}] ${l.type.toUpperCase().padEnd(7)} ${l.message}`;

  async function tailLogs(id, n) {
    const r = await api.get(`/api/logs/${enc(id)}`);
    return { lines: r.logs.slice(-n).map(logLine), lastSeq: r.lastSeq };
  }

  // A campaign may only use a browser the backend already knows about —
  // never an arbitrary executable path supplied through a tool call.
  async function knownBrowserPaths() {
    const r = await api.get('/api/browsers/detect');
    const all = [...(r.browsers || []), ...(r.installed || []), ...(r.customBrowsers || [])];
    return new Set(all.map((b) => b.path).filter(Boolean).map((p) => path.resolve(p)));
  }
  async function browserProblem(customBrowserPath) {
    if (!customBrowserPath) return null;
    const known = await knownBrowserPaths();
    if (known.has(path.resolve(customBrowserPath))) return null;
    return `customBrowserPath "${customBrowserPath}" is not a known browser. Use list_browsers to see valid paths, or register one with add_custom_browser.`;
  }

  async function startCampaign(mode, args) {
    const problem = await browserProblem(args.customBrowserPath);
    if (problem) return fail(problem);
    const r = await api.post('/api/campaigns/start', S.toRequestBody(mode, args), { timeoutMs: 150000 });
    const { process: p } = await api.get(`/api/processes/${enc(r.processId)}`);
    return ok({ campaignId: r.processId, ...summarizeCampaign(p) },
      `Started ${p.modeLabel} campaign ${r.processId} (${p.config.sessions} session(s), ${p.config.threads} thread(s)). Track it with get_campaign or wait_for_campaign.`);
  }

  // ═════════════════════════════ System ═══════════════════════════════════════
  tool('get_status', {
    title: 'Backend status',
    description: 'Show how this MCP server is connected to TrafficDrive, plus a snapshot: version, running campaigns, loaded proxies, active server-side schedules and safety limits. Call this first to confirm everything is working.',
    inputSchema: {}, annotations: READ,
  }, async () => {
    const h = await api.get('/api/health');
    return ok({ connection: { mode: api.mode, source: api.source, url: api.url }, ...h },
      `TrafficDrive ${h.version} — ${h.running} running campaign(s), ${h.proxies} proxy(ies) loaded (${api.mode === 'connect' ? 'attached to ' + api.source : 'embedded backend'}).`);
  });

  tool('get_catalog', {
    title: 'Options catalog',
    description: 'List the valid values for campaign options: campaign modes, search engines, social platforms, device types and safety limits. (Privacy features have their own tool: list_privacy_features.)',
    inputSchema: {}, annotations: READ,
  }, async () => {
    const c = await api.get('/api/catalog');
    return ok({ modes: c.modes, searchEngines: c.searchEngines, socialPlatforms: c.socialPlatforms, devices: c.devices, limits: c.limits, privacy: { features: c.privacy.features.length, profiles: Object.keys(c.privacy.profiles) } });
  });

  // ═════════════════════════════ Campaigns ════════════════════════════════════
  tool('start_direct_traffic', {
    title: 'Start direct traffic',
    description: 'Start a campaign where browsers open a page directly (as if typing the address), stay for the visit time, optionally scroll and open internal links. Returns a campaign id — use get_campaign / wait_for_campaign to follow it and stop_campaign to end it.',
    inputSchema: S.directShape, annotations: VISITS_WEB,
  }, (a) => startCampaign('direct', a));

  tool('start_organic_search_traffic', {
    title: 'Start organic search traffic',
    description: 'Start a campaign where browsers search for a keyword on a search engine, look through the result pages for the given website, click it and stay. Returns a campaign id.',
    inputSchema: S.organicShape, annotations: VISITS_WEB,
  }, (a) => startCampaign('organic', a));

  tool('start_referral_traffic', {
    title: 'Start referral traffic',
    description: 'Start a campaign where browsers visit a social platform first and then reach the target page from it, so the visit appears as a referral. Returns a campaign id.',
    inputSchema: S.referralShape, annotations: VISITS_WEB,
  }, (a) => startCampaign('referral', a));

  tool('start_google_maps_traffic', {
    title: 'Start Google Maps traffic',
    description: 'Start a campaign where browsers search a business on Google Maps, open its listing and (optionally) its website. Returns a campaign id.',
    inputSchema: S.gmapsShape, annotations: VISITS_WEB,
  }, (a) => startCampaign('gmaps', a));

  tool('list_campaigns', {
    title: 'List campaigns',
    description: 'List campaigns known to the backend (running, paused, and finished within the last 10 minutes) with progress.',
    inputSchema: { status: z.enum(['starting', 'running', 'paused', 'restarting', 'completed', 'stopped', 'failed', 'error']).optional().describe('Only campaigns in this status.') },
    annotations: READ,
  }, async ({ status }) => {
    const r = await api.get('/api/processes', { query: { status } });
    const campaigns = r.processes.map(summarizeCampaign);
    return ok({ campaigns, total: campaigns.length }, campaigns.length ? `${campaigns.length} campaign(s).` : 'No campaigns right now.');
  });

  tool('get_campaign', {
    title: 'Campaign details',
    description: 'Full status of one campaign: state, per-session counts, summary, settings (no proxy credentials) and the most recent log lines.',
    inputSchema: {
      id: z.string().min(1).describe('Campaign id, e.g. proc_3'),
      logLines: z.number().int().min(0).max(500).default(20).describe('How many recent log lines to include.'),
    }, annotations: READ,
  }, async ({ id, logLines }) => {
    const { process: p } = await api.get(`/api/processes/${enc(id)}`);
    const logs = logLines ? await tailLogs(id, logLines) : { lines: [], lastSeq: p.lastSeq };
    return ok({ ...summarizeCampaign(p), summary: p.summary, history: p.history, config: p.config, request: p.request, privacyFeatures: p.privacy.features, recentLogs: logs.lines, lastSeq: logs.lastSeq },
      `${p.modeLabel} campaign ${p.id}: ${p.status}.`);
  });

  tool('get_campaign_logs', {
    title: 'Campaign logs',
    description: 'Read a campaign\'s log lines. Pass the returned nextSince back as "since" to fetch only new lines (no repeats).',
    inputSchema: {
      id: z.string().min(1).describe('Campaign id'),
      since: z.number().int().min(0).optional().describe('Only lines after this sequence number (use nextSince from the previous call).'),
      limit: z.number().int().min(1).max(1000).default(100).describe('Maximum lines to return (the newest ones).'),
      level: z.enum(['info', 'success', 'warn', 'warning', 'error']).optional().describe('Only lines of this level.'),
    }, annotations: READ,
  }, async ({ id, since, limit, level }) => {
    const r = await api.get(`/api/logs/${enc(id)}`, { query: { since } });
    let logs = r.logs;
    if (level) logs = logs.filter((l) => l.type.toLowerCase() === level || (level === 'warn' && l.type.toLowerCase() === 'warning'));
    const total = logs.length;
    logs = logs.slice(-limit);
    return ok({ id, status: r.status, lines: logs.map(logLine), returned: logs.length, omittedOlder: total - logs.length, nextSince: r.lastSeq },
      `${logs.length} line(s); campaign is ${r.status}.`);
  });

  tool('wait_for_campaign', {
    title: 'Wait for a campaign',
    description: 'Block until a campaign finishes (completed, stopped or failed) or the timeout passes, then return its final state. Streams progress updates while waiting. Campaigns started with loop=true never finish by themselves.',
    inputSchema: {
      id: z.string().min(1).describe('Campaign id'),
      timeoutSeconds: z.number().int().min(1).max(3600).default(300).describe('Give up waiting after this many seconds (the campaign keeps running).'),
      pollSeconds: z.number().min(0.5).max(60).default(2).describe('How often to check.'),
    }, annotations: READ,
  }, async ({ id, timeoutSeconds, pollSeconds }, extra) => {
    const deadline = Date.now() + timeoutSeconds * 1000;
    const token = extra && extra._meta && extra._meta.progressToken;
    let tick = 0, lastMsg = '', p;
    for (;;) {
      ({ process: p } = await api.get(`/api/processes/${enc(id)}`, { signal: extra && extra.signal }));
      const st = p.stats || {};
      const msg = `${p.status}: ${st.completed || 0}/${st.total || 0} sessions done${st.failed ? `, ${st.failed} failed` : ''}${p.loop ? `, iteration ${p.iteration}` : ''}`;
      if (token !== undefined && msg !== lastMsg) {
        lastMsg = msg;
        await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++tick, message: msg } }).catch(() => {});
      }
      if (TERMINAL.has(p.status)) break;
      if (extra && extra.signal && extra.signal.aborted) return fail('Cancelled while waiting; the campaign is still running.');
      if (Date.now() >= deadline) {
        const logs = await tailLogs(id, 10);
        return ok({ timedOut: true, ...summarizeCampaign(p), recentLogs: logs.lines },
          `Still ${p.status} after ${timeoutSeconds}s (${msg}). Call wait_for_campaign again, or stop_campaign.`);
      }
      await sleep(pollSeconds * 1000, extra && extra.signal);
    }
    const logs = await tailLogs(id, 10);
    return ok({ timedOut: false, ...summarizeCampaign(p), summary: p.summary, recentLogs: logs.lines },
      `Campaign ${id} ${p.status}${p.summary ? `: ${p.summary.completed} completed, ${p.summary.failed} failed, ${p.summary.stopped} stopped` : ''}.`);
  });

  const campaignControl = (name, title, description, path, annotations) => tool(name, {
    title, description, inputSchema: { id: z.string().min(1).describe('Campaign id') }, annotations,
  }, async ({ id }) => {
    const r = await api.post(`/api/${path}/${enc(id)}`, {});
    return ok({ id, status: r.status }, `Campaign ${id} is now ${r.status}.`);
  });
  campaignControl('pause_campaign', 'Pause a campaign', 'Pause a running campaign. Sessions already in progress hold at their next wait and everything continues on resume_campaign.', 'pause', WRITE_IDEMPOTENT);
  campaignControl('resume_campaign', 'Resume a campaign', 'Resume a paused campaign so its sessions continue where they held.', 'resume', WRITE_IDEMPOTENT);
  campaignControl('stop_campaign', 'Stop a campaign', 'Stop a campaign now: waiting sessions are woken, open browsers are closed and (for loop campaigns) no further iteration starts. Finished campaigns are left as they are.', 'stop', DESTRUCTIVE);

  tool('stop_all_campaigns', {
    title: 'Stop all campaigns',
    description: 'Stop every running or paused campaign.',
    inputSchema: {}, annotations: DESTRUCTIVE,
  }, async () => {
    const r = await api.post('/api/stop-all', {}, { timeoutMs: 60000 });
    return ok({ stopped: r.stopped }, `Stopped ${r.stopped} campaign(s).`);
  });

  // ═════════════════════════════ Proxies ══════════════════════════════════════
  tool('list_proxies', {
    title: 'List loaded proxies',
    description: 'Show the proxies loaded in the backend (credentials are masked), with how many are working, dead or not yet checked. Campaigns use the ones not found dead when useLoadedProxies is true.',
    inputSchema: {
      type: z.enum(['http', 'https', 'socks4', 'socks5']).optional().describe('Only this protocol.'),
      status: z.enum(['working', 'dead', 'unchecked']).optional().describe('Only proxies with this check result.'),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0),
    }, annotations: READ,
  }, async ({ type, status, limit, offset }) => {
    const r = await api.get('/api/proxies');
    const byType = {};
    r.proxies.forEach((p) => { byType[p.type] = (byType[p.type] || 0) + 1; });
    let filtered = type ? r.proxies.filter((p) => p.type === type) : r.proxies;
    if (status) filtered = filtered.filter((p) => (status === 'unchecked' ? !p.status : p.status === status));
    const { total, working, dead, unchecked, avgMs } = r.stats;
    return ok({ total, working, dead, unchecked, avgMs, byType, matching: filtered.length, proxies: filtered.slice(offset, offset + limit).map(maskProxy) },
      `${total} proxy(ies) loaded: ${working} working, ${dead} dead, ${unchecked} not checked yet.`);
  });

  tool('add_proxies', {
    title: 'Add proxies',
    description: 'Load proxies into the backend. One per entry; formats: host:port, host:port:user:pass, user:pass@host:port, scheme://[user:pass@]host:port (schemes: http, https, socks4, socks5). Duplicates are ignored.',
    inputSchema: {
      proxies: z.array(z.string().min(1).max(500)).min(1).max(5000).describe('Proxy entries'),
      defaultType: z.enum(['http', 'https', 'socks4', 'socks5']).default('http').describe('Protocol for entries that do not state one.'),
    }, annotations: WRITE,
  }, async ({ proxies, defaultType }) => {
    const good = [], invalid = [];
    proxies.forEach((line, i) => {
      const r = parseProxyLine(line, defaultType);
      if (r.proxy) good.push(r.proxy); else invalid.push({ entry: i + 1, problem: r.error });
    });
    if (!good.length) return fail('None of the entries could be parsed.', invalid.slice(0, 5).map((x) => `#${x.entry}: ${x.problem}`).join('; '));
    const socksLogin = good.filter((p) => /^socks/.test(p.type) && p.username).length;
    const before = (await api.get('/api/proxies')).proxies.length;
    const r = await api.post('/api/proxies/load', { proxies: good });
    return ok({ added: r.count - before, duplicatesIgnored: good.length - (r.count - before), invalid: invalid.slice(0, 20), invalidCount: invalid.length, totalLoaded: r.count },
      `Added ${r.count - before} proxy(ies); ${r.count} loaded.${invalid.length ? ` ${invalid.length} entr${invalid.length === 1 ? 'y was' : 'ies were'} invalid.` : ''}${socksLogin ? ` Warning: ${socksLogin} are SOCKS proxies with a login — the campaign browser (Chrome) cannot use those; use the provider's HTTP port instead.` : ''} Run validate_proxies to drop dead ones.`);
  });

  tool('list_proxy_sources', {
    title: 'List proxy sources',
    description: 'The lists scrape_free_proxies downloads from (the "Proxy sources" card in the app): the built-in ones plus any the user added, each with whether it is switched on and how its last download went. Assistants cannot add, edit or remove sources — only the user can, in the app.',
    inputSchema: {}, annotations: READ,
  }, async () => {
    const r = await api.get('/api/proxies/sources');
    const sources = r.sources.map(({ id, name, type, builtin, enabled, lastRun }) => ({ id, name, type, builtin, enabled, lastRun }));
    return ok({ total: sources.length, enabled: sources.filter((x) => x.enabled).length, sources }, `${sources.length} source(s), ${sources.filter((x) => x.enabled).length} switched on.`);
  });

  tool('set_proxy_source_enabled', {
    title: 'Switch a proxy source on or off',
    description: 'Include or exclude one source when scrape_free_proxies runs without sourceIds. Does not delete anything.',
    inputSchema: { id: z.string().min(1).max(80).describe('Source id from list_proxy_sources'), enabled: z.boolean() }, annotations: WRITE_IDEMPOTENT,
  }, async ({ id, enabled }) => {
    const r = await api.post('/api/proxies/sources/update', { id, enabled });
    return ok({ id, name: r.source.name, enabled: r.source.enabled }, `"${r.source.name}" is now ${r.source.enabled ? 'on' : 'off'}.`);
  });

  tool('proxy_automation', {
    title: 'Automatic proxies',
    description: 'Show or change "Automatic proxies" (on by default in the desktop app): working proxies are saved and loaded again at every start, re-checked in the background so dead ones drop out, and topped up from the enabled sources — checked against the last campaign\'s address — whenever fewer than `target` are ready. With no arguments it only reports the status. Note: while proxies are loaded, campaigns use them unless useLoadedProxies is false.',
    inputSchema: {
      enabled: z.boolean().optional().describe('Switch automatic proxies on or off.'),
      target: z.number().int().min(1).max(1000).optional().describe('Keep at least this many working proxies ready.'),
      runNow: z.boolean().optional().describe('Look for working proxies now instead of waiting for the next round.'),
    },
    annotations: { ...WRITE_IDEMPOTENT, openWorldHint: true },
  }, async ({ enabled, target, runNow }) => {
    const changes = { ...(enabled !== undefined ? { enabled } : {}), ...(target !== undefined ? { target } : {}), ...(runNow ? { runNow: true } : {}) };
    const r = Object.keys(changes).length ? await api.post('/api/proxies/auto', changes) : await api.get('/api/proxies/auto');
    const { success, ...st } = r;
    return ok(st, `Automatic proxies are ${st.enabled ? 'on' : 'off'}: ${st.ready}/${st.target} working proxies ready${st.state === 'inactive' ? ' (it runs while the desktop app is open)' : st.message ? '. ' + st.message : '.'}`);
  });

  tool('scrape_free_proxies', {
    title: 'Scrape free proxies',
    description: 'Download the public proxy lists that are switched on (see list_proxy_sources) — or only the given sourceIds — all at once, and add what they contain. Free public proxies are slow, short-lived and untrusted: run validate_proxies afterwards and avoid sending sensitive traffic through them. Takes about 15 seconds.',
    inputSchema: { sourceIds: z.array(z.string().min(1).max(80)).min(1).max(60).optional().describe('Only these sources (ids from list_proxy_sources), even if switched off.') },
    annotations: { ...WRITE, openWorldHint: true },
  }, async ({ sourceIds }) => {
    const r = await api.post('/api/proxies/scrape', sourceIds ? { sourceIds } : {}, { timeoutMs: 120000 });
    const sources = r.results.map(({ name, ok: good, count, error }) => ({ name, ok: good && !error, found: count, ...(error ? { problem: error } : {}) }));
    return ok({ found: r.scraped, newlyAdded: r.added, totalLoaded: r.total, sources },
      `Found ${r.scraped} proxies from ${sources.filter((x) => x.ok).length}/${sources.length} sources (${r.added} new); ${r.total} loaded. Run validate_proxies next.`);
  });

  tool('validate_proxies', {
    title: 'Validate proxies',
    description: 'Test proxies by connecting through each one to a test server (a proxy only counts as working if the real server answers; proxies that hijack the request do not). With testUrl, each proxy must open that actual page — HTTPS included, with the certificate checked — which is the test that matters for a campaign (many free proxies pass the quick test but cannot open HTTPS sites). Many are tested at once, so thousands take about a minute, not an hour. With no "proxies", tests the whole loaded list (or only the not-yet-checked ones) and by default REMOVES the dead ones from it; set removeDead=false to keep them marked. With "proxies", only tests those entries and removes nothing. stopAfterWorking ends the run as soon as that many working proxies are found.',
    inputSchema: {
      proxies: z.array(z.string().min(1).max(500)).min(1).max(2000).optional().describe('Entries to test instead of the whole loaded list.'),
      concurrency: z.number().int().min(1).max(500).optional().describe('How many to test at the same time (default 500).'),
      timeoutSeconds: z.number().min(1).max(30).optional().describe('Give up on a proxy after this long (default 5).'),
      testUrl: z.string().min(3).max(2048).optional().describe('Open this public web address through each proxy instead of the quick general test (use the campaign\'s address). A proxy then counts as working only if it can open that page — including HTTPS pages.'),
      stopAfterWorking: z.number().int().min(1).optional().describe('Stop as soon as this many working proxies have been found.'),
      onlyUnchecked: z.boolean().optional().describe('Loaded list only: skip proxies that were already checked for this address (or already checked in general when no testUrl is given). Proxies checked only for a different address are checked again.'),
      removeDead: z.boolean().default(true).describe('Loaded list only: remove the dead ones when the check completes.'),
    },
    annotations: { ...DESTRUCTIVE, openWorldHint: true },
  }, async ({ proxies, concurrency, timeoutSeconds, stopAfterWorking, testUrl, onlyUnchecked, removeDead }, extra) => {
    const opts = { ...(concurrency ? { concurrency } : {}), ...(timeoutSeconds ? { timeoutSeconds } : {}), ...(stopAfterWorking ? { stopAfterWorking } : {}), ...(testUrl ? { testUrl } : {}) };
    if (proxies) {
      const parsed = proxies.map((l) => parseProxyLine(l)).filter((r) => r.proxy).map((r) => r.proxy);
      if (!parsed.length) return fail('None of the entries could be parsed.');
      const r = await api.post('/api/proxies/validate', { proxies: parsed, ...opts }, { timeoutMs: 20 * 60 * 1000, signal: extra && extra.signal });
      const results = r.results.map((x, i) => ({ ...maskProxy(parsed[i]), ok: x.ok, ms: x.ms }));
      const fastest = results.filter((x) => x.ok).sort((a, b) => a.ms - b.ms).slice(0, 10);
      return ok({ tested: r.total, working: r.working, dead: r.checked - r.working, notChecked: r.total - r.checked, removedDeadFromLoaded: false, loadedNow: r.stats.total, results: results.slice(0, 200), fastest, testedAgainst: testUrl || null },
        `${r.working}/${r.total} proxies ${testUrl ? 'can open ' + testUrl : 'work'}.`);
    }
    const started = await api.post('/api/proxies/validate/start', { ...opts, onlyUnchecked: !!onlyUnchecked, removeDead: removeDead !== false });
    const id = started.job.id;
    const token = extra && extra._meta && extra._meta.progressToken;
    let job = started.job, tick = 0, lastMsg = '';
    for (;;) {
      const s = await api.get('/api/proxies/validate/status', { query: { id }, signal: extra && extra.signal });
      job = s.job;
      const msg = `${job.done}/${job.total} checked · ${job.working} working · ${job.dead} dead`;
      if (token !== undefined && msg !== lastMsg) {
        lastMsg = msg;
        await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++tick, total: job.total, message: msg } }).catch(() => {});
      }
      if (job.status !== 'running') break;
      if (extra && extra.signal && extra.signal.aborted) { await api.post('/api/proxies/validate/cancel', {}).catch(() => {}); return fail('Cancelled; the check was stopped and nothing was removed.'); }
      await sleep(1000, extra && extra.signal);
    }
    if (job.status === 'error') return fail(job.error);
    const top = await api.get('/api/proxies', { query: { status: 'working', sort: 'speed', limit: 10 } });
    const removed = job.options.removeDead && job.status === 'done';
    return ok({ tested: job.total, checked: job.done, working: job.working, dead: job.dead, notChecked: job.total - job.done, skippedAlreadyVerified: job.skipped, deadReasons: job.reasons, stoppedEarly: job.stoppedEarly, cancelled: job.status === 'cancelled', removedDeadFromLoaded: removed, removed: job.removed, loadedNow: top.stats.total, avgMs: job.avgMs, seconds: Math.round(job.elapsedMs / 1000), testedAgainst: job.testUrl, fastest: top.proxies.map(maskProxy) },
      `${job.working}/${job.done} proxies ${job.testUrl ? `can open ${job.testUrl}` : 'work'} (${Math.round(job.elapsedMs / 1000)} s)${removed ? `; ${job.removed} dead removed` : ''}${job.stoppedEarly ? '; stopped early' : ''}${job.status === 'cancelled' ? '; cancelled' : ''}.`);
  });

  tool('remove_proxies', {
    title: 'Remove proxies',
    description: 'Remove specific proxies from the loaded list (matched by host and port).',
    inputSchema: { proxies: z.array(z.string().min(1).max(500)).min(1).max(5000).describe('Entries to remove (any supported format).') },
    annotations: DESTRUCTIVE,
  }, async ({ proxies }) => {
    const parsed = proxies.map((l) => parseProxyLine(l)).filter((r) => r.proxy).map((r) => ({ host: r.proxy.host, port: r.proxy.port }));
    if (!parsed.length) return fail('None of the entries could be parsed.');
    const r = await api.post('/api/proxies/remove', { proxies: parsed });
    return ok({ removed: r.removed, totalLoaded: r.total }, `Removed ${r.removed}; ${r.total} left.`);
  });

  tool('clear_proxies', {
    title: 'Clear all proxies',
    description: 'Remove every loaded proxy. Campaigns then connect directly.',
    inputSchema: {}, annotations: DESTRUCTIVE,
  }, async () => {
    const before = (await api.get('/api/proxies')).proxies.length;
    await api.post('/api/proxies/clear', {});
    return ok({ removed: before, totalLoaded: 0 }, `Cleared ${before} proxy(ies).`);
  });

  // ═════════════════════════════ Browsers ═════════════════════════════════════
  tool('list_browsers', {
    title: 'List browsers',
    description: 'Browsers TrafficDrive can use: the bundled/cached Chromium, detected system browsers, installed and custom ones. Their paths are the only values accepted for customBrowserPath.',
    inputSchema: {}, annotations: READ,
  }, async () => {
    const r = await api.get('/api/browsers/detect');
    const browsers = (r.browsers || []).filter((b) => b.path).map(({ id, name, path: p }) => ({ id, name, path: p }));
    return ok({ browsers, custom: (r.customBrowsers || []).map(({ id, name, path: p }) => ({ id, name, path: p })) }, `${browsers.length} browser(s) available.`);
  });

  tool('add_custom_browser', {
    title: 'Register a custom browser',
    description: 'Register an existing Chromium-based browser executable (absolute path) so campaigns can use it via customBrowserPath.',
    inputSchema: {
      name: z.string().min(1).max(80).describe('Display name'),
      path: z.string().min(1).max(1024).describe('Absolute path to the browser executable'),
    }, annotations: WRITE,
  }, async ({ name, path: p }) => {
    if (!path.isAbsolute(p)) return fail('path must be an absolute path to an existing executable.');
    const r = await api.post('/api/browsers/add', { name, path: p });
    return ok({ browser: { id: r.browser.id, name: r.browser.name, path: r.browser.path } }, `Registered "${name}".`);
  });

  tool('remove_custom_browser', {
    title: 'Remove a custom browser',
    description: 'Unregister a custom browser added with add_custom_browser (the program itself is not touched).',
    inputSchema: { id: z.string().min(1).describe('Browser id from list_browsers → custom') }, annotations: DESTRUCTIVE,
  }, async ({ id }) => {
    await api.post('/api/browsers/remove', { id });
    return ok({ removed: id }, `Removed custom browser ${id}.`);
  });

  tool('list_browser_catalog', {
    title: 'Browser library',
    description: 'The app\'s Browser Library (the Browser Library page): 51 browsers with engine, category, size and website. "installable" means the app can download and install it itself (Windows builds only); "available" means it is already usable here (see list_browsers for its path).',
    inputSchema: {
      engine: z.enum(['chromium', 'firefox', 'other']).optional().describe('Only this engine family.'),
      category: z.string().max(60).optional().describe('Only this category, e.g. "Chromium Core".'),
      installableOnly: z.boolean().default(false).describe('Only browsers the app can install itself.'),
      search: z.string().max(60).optional().describe('Text to look for in the name.'),
    }, annotations: READ,
  }, async ({ engine, category, installableOnly, search }) => {
    const detect = await api.get('/api/browsers/detect');
    const have = new Map((detect.browsers || []).filter((b) => b.path).map((b) => [b.id, b.path]));
    let list = LibraryCatalog.BROWSERS.filter((b) => (!engine || b.engine === engine) && (!category || b.cat.toLowerCase() === category.toLowerCase())
      && (!installableOnly || b.dlUrl) && (!search || b.name.toLowerCase().includes(search.toLowerCase())));
    const out = list.map((b) => ({ id: b.id, name: b.name, engine: b.engine, category: b.cat, size: b.size, installable: !!b.dlUrl, available: have.has(b.id), path: have.get(b.id) || null, website: b.web, downloadPage: b.dl }));
    return ok({ total: out.length, categories: [...new Set(LibraryCatalog.BROWSERS.map((b) => b.cat))], browsers: out },
      `${out.length} browser(s); ${out.filter((b) => b.installable).length} can be installed by the app.`);
  });

  tool('install_browser', {
    title: 'Install a library browser',
    description: 'Download and install a browser from the app\'s Browser Library (only the library\'s own download links are ever used — you cannot give a URL). Windows builds only; on other systems install the browser normally and use add_custom_browser. Waits for the result by default.',
    inputSchema: {
      id: z.string().min(1).max(64).describe('Library id from list_browser_catalog (must be installable).'),
      wait: z.boolean().default(true).describe('Wait until the install finishes (streams progress). Otherwise poll get_browser_install_status.'),
      timeoutSeconds: z.number().int().min(10).max(3600).default(600).describe('Stop waiting after this long (the install continues).'),
    }, annotations: { ...WRITE, openWorldHint: true },
  }, async ({ id, wait, timeoutSeconds }, extra) => {
    const started = await api.post('/api/browsers/install', { id }, { timeoutMs: 30000 });
    if (!wait) return ok({ id, started: true }, `Install of ${started.name || id} started. Check get_browser_install_status.`);
    const token = extra && extra._meta && extra._meta.progressToken;
    const deadline = Date.now() + timeoutSeconds * 1000;
    let tick = 0, last = '', st = null;
    for (;;) {
      await sleep(1500, extra && extra.signal);
      const r = await api.get('/api/browsers/install-status', { query: { id }, signal: extra && extra.signal });
      st = r.installs[0];
      if (st) {
        const msg = st.status === 'downloading' ? `downloading ${st.percent || 0}%` : st.status;
        if (token !== undefined && msg !== last) { last = msg; await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++tick, message: `${started.name || id}: ${msg}` } }).catch(() => {}); }
        if (st.status === 'complete') return ok({ id, status: 'complete' }, `${started.name || id} installed. Use list_browsers to see its path.`);
        if (st.status === 'error') return fail(`Install failed: ${st.error || 'unknown error'}`);
      }
      if (extra && extra.signal && extra.signal.aborted) return fail('Cancelled while waiting; the install continues in the app.');
      if (Date.now() >= deadline) return ok({ id, status: st ? st.status : 'unknown', timedOut: true }, `Still ${st ? st.status : 'working'} after ${timeoutSeconds}s — check get_browser_install_status later.`);
    }
  });

  tool('get_browser_install_status', {
    title: 'Browser install status',
    description: 'State of browser installs started in this session (downloading with percent, extracting, complete or error).',
    inputSchema: { id: z.string().max(64).optional().describe('Only this browser.') }, annotations: READ,
  }, async ({ id }) => {
    const r = await api.get('/api/browsers/install-status', { query: { id } });
    return ok({ installs: r.installs.map(({ id: i, name, status, percent, downloaded, total, error, updatedAt }) => ({ id: i, name, status, percent, downloaded, total, error, updatedAt })) }, `${r.installs.length} install(s).`);
  });

  tool('launch_browser', {
    title: 'Open a browser window',
    description: 'Open one of your browsers (from list_browsers) as a normal window on the desktop, optionally on a page — like the Launch button in the Browser Library. This is for you to look at; campaigns open their own browsers.',
    inputSchema: {
      id: z.string().min(1).max(64).describe('Browser id from list_browsers.'),
      url: z.string().max(2048).optional().describe('http(s) page to open.'),
    }, annotations: { ...WRITE, openWorldHint: true },
  }, async ({ id, url }) => {
    await api.post('/api/browsers/launch', { id, url });
    return ok({ launched: id, url: url || null }, `Opened ${id}${url ? ' at ' + url : ''}.`);
  });

  // ═════════════════════════════ Libraries (User Agents, Resolutions) ═════════════════════
  tool('list_user_agents', {
    title: 'User Agent library',
    description: 'The built-in User Agent library (the User Agents page): real browser/OS User-Agent strings. Pass chosen strings as "userAgents" to a start_* tool (with uaMode "rotate" to alternate).',
    inputSchema: {
      category: z.enum(['desktop', 'mobile']).optional(),
      browser: z.string().max(40).optional().describe('e.g. Chrome, Firefox, Safari, Edge.'),
      os: z.string().max(40).optional().describe('e.g. Windows, macOS, iOS, Android.'),
      search: z.string().max(80).optional().describe('Text to look for in the string.'),
    }, annotations: READ,
  }, async ({ category, browser, os, search }) => {
    const out = (category ? [category] : ['desktop', 'mobile']).flatMap((c) => LibraryCatalog.USER_AGENTS[c].map((x) => ({ category: c, browser: x.browser, os: x.os, userAgent: x.ua })))
      .filter((x) => (!browser || x.browser.toLowerCase() === browser.toLowerCase()) && (!os || x.os.toLowerCase() === os.toLowerCase()) && (!search || x.userAgent.toLowerCase().includes(search.toLowerCase())));
    return ok({ total: out.length, userAgents: out }, `${out.length} User-Agent string(s).`);
  });

  tool('list_resolutions', {
    title: 'Screen resolution presets',
    description: 'The Resolutions page presets (desktop monitors and phones/tablets with their names). Use width/height as viewportWidth/viewportHeight in a start_* tool, or set autoRotateResolutions to vary them per session.',
    inputSchema: {
      category: z.enum(['desktop', 'mobile']).optional(),
      group: z.string().max(60).optional().describe('e.g. "Full HD", "iPhone Resolutions".'),
      search: z.string().max(60).optional().describe('Text to look for in the name.'),
    }, annotations: READ,
  }, async ({ category, group, search }) => {
    const out = (category ? [category] : ['desktop', 'mobile']).flatMap((c) => LibraryCatalog.RESOLUTIONS[c].map((r) => ({ category: c, ...r })))
      .filter((r) => (!group || r.group.toLowerCase() === group.toLowerCase()) && (!search || r.name.toLowerCase().includes(search.toLowerCase())));
    return ok({ total: out.length, groups: [...new Set(out.map((r) => r.group))], resolutions: out }, `${out.length} resolution preset(s).`);
  });

  // ═════════════════════════════ Privacy ══════════════════════════════════════
  tool('list_privacy_features', {
    title: 'List privacy features',
    description: 'The 34 privacy protections a campaign can enable (fingerprint, network and sensor privacy) with what each does, plus the preset profiles. Use the IDs in privacyFeatures, or a profile name in privacyProfile.',
    inputSchema: { category: z.enum(['Browser Fingerprint', 'Network Privacy', 'Sensor Privacy']).optional().describe('Only this category.') },
    annotations: READ,
  }, async ({ category }) => {
    const features = PrivacyCatalog.FEATURES.filter((f) => !category || f.cat === category);
    return ok({ features: features.map(({ id, name, cat, description }) => ({ id, name, category: cat, description })), profiles: Object.fromEntries(Object.entries(PrivacyCatalog.PROFILES).map(([k, v]) => [k, { count: v.length, features: v }])) },
      `${features.length} feature(s). Profiles: none (0), balanced (${PrivacyCatalog.PROFILES.balanced.length}), stealth (${PrivacyCatalog.PROFILES.stealth.length}).`);
  });

  tool('preview_privacy_config', {
    title: 'Preview a privacy configuration',
    description: 'Resolve a privacy profile and/or feature list into exactly what a campaign would enable, its shield level, and what stays off. Nothing is started.',
    inputSchema: S.privacyShape, annotations: READ,
  }, async (a) => {
    const r = PrivacyCatalog.resolve(a);
    const off = PrivacyCatalog.ALL_IDS.filter((id) => !r.features.includes(id));
    return ok({ level: r.level, enabledCount: r.features.length, enabled: r.features, notEnabled: off }, `Shield level "${r.level}": ${r.features.length}/${PrivacyCatalog.FEATURES.length} protections.`);
  });

  tool('verify_privacy', {
    title: 'Verify privacy protections',
    description: 'Prove the chosen protections work on this machine: launches a short headless browser, applies them exactly as a campaign would, loads a LOCAL test page (nothing leaves the machine) and checks what a website could observe — e.g. platform, timezone, canvas, headers, WebRTC. Takes ~5 seconds.',
    inputSchema: {
      ...S.privacyShape,
      device: z.enum(['desktop', 'mobile', 'tablet']).default('desktop'),
      userAgent: z.string().min(10).max(500).optional().describe('User-Agent for the test session (default: Windows Chrome).'),
    }, annotations: READ,
  }, async ({ device, userAgent, ...privacy }) => {
    const r = await api.post('/api/privacy/verify', { ...privacy, device, userAgent }, { timeoutMs: 120000 });
    const failed = r.checks.filter((c) => !c.ok);
    return ok({ ok: r.ok, passed: r.passed, failed: r.failed, level: r.level, device: r.device, failedChecks: failed.map((c) => ({ feature: c.feature, check: c.name, detail: String(c.detail).slice(0, 200) })), passedFeatures: r.checks.filter((c) => c.ok).map((c) => c.feature), notTestable: r.checks.filter((c) => c.skipped).map((c) => c.feature), pageErrors: r.pageErrors, observed: r.observed },
      r.ok ? `All ${r.passed} checks passed.` : `${r.failed} of ${r.checks.length} checks FAILED.`);
  });

  // ═════════════════════════════ Saved campaigns ═════════════════════════════════
  const summarizeSaved = (c) => ({
    id: c.id, name: c.name, mode: c.mode, url: c.url, keywords: c.keywords, sessions: c.sessions, category: c.category, options: c.options,
    runCount: c.runCount || 0, lastRunAt: iso(c.lastRunAt), lastCampaignId: c.lastProcessId || null,
  });

  tool('list_saved_campaigns', {
    title: 'List saved campaigns',
    description: 'The Campaigns page: reusable campaign definitions shared between the dashboard and AI assistants. Run one with run_saved_campaign.',
    inputSchema: {}, annotations: READ,
  }, async () => {
    const r = await api.get('/api/saved-campaigns');
    return ok({ total: r.campaigns.length, campaigns: r.campaigns.map(summarizeSaved) }, `${r.campaigns.length} saved campaign(s).`);
  });

  tool('save_campaign', {
    title: 'Save a campaign',
    description: 'Create a saved campaign, or update one by passing its id (only the fields you give are changed). It appears on the dashboard\'s Campaigns page. For Google Maps the name is the business name and url is its website; for organic, give keywords.',
    inputSchema: {
      id: z.string().max(60).optional().describe('Existing saved campaign to update (omit to create).'),
      name: z.string().min(1).max(120).optional().describe('Name (required when creating).'),
      mode: z.enum(S.MODES).optional().describe('Campaign mode (required when creating).'),
      url: z.string().max(2048).optional().describe('Target URL (gmaps: the business website; rpa: unused).'),
      keywords: z.array(z.string().min(1).max(200)).max(100).optional().describe('Search phrases (organic mode).'),
      sessions: z.number().int().min(1).max(100000).optional().describe('How many sessions a run uses (default 1000).'),
      category: z.string().regex(/^[a-z0-9_-]{1,40}$/i).optional().describe('A label such as business, ecommerce, blog, news (default business).'),
      options: z.record(z.string(), z.any()).optional().describe('Any other start options, using the same names as the start_* tools (threads, headless, device, visitTimeMs, privacyProfile, customEngine, recordingId …). Replaces the stored options.'),
    }, annotations: WRITE,
  }, async (a) => {
    const problem = await browserProblem(a.options && a.options.customBrowserPath);
    if (problem) return fail(problem);
    const r = await api.post('/api/saved-campaigns', a);
    return ok(summarizeSaved(r.campaign), `${a.id ? 'Updated' : 'Saved'} campaign "${r.campaign.name}" (${r.campaign.id}).`);
  });

  tool('run_saved_campaign', {
    title: 'Run a saved campaign',
    description: 'Start a saved campaign now. Optional overrides change this run only (same option names as the start_* tools). Returns the running campaign\'s id.',
    inputSchema: {
      id: z.string().min(1).max(60).describe('Saved campaign id from list_saved_campaigns.'),
      overrides: z.record(z.string(), z.any()).optional().describe('Options for this run only, e.g. {"sessions": 3, "headless": true}.'),
    }, annotations: VISITS_WEB,
  }, async ({ id, overrides }) => {
    const problem = await browserProblem(overrides && overrides.customBrowserPath);
    if (problem) return fail(problem);
    const r = await api.post('/api/saved-campaigns/run', { id, overrides }, { timeoutMs: 150000 });
    const { process: p } = await api.get(`/api/processes/${enc(r.processId)}`);
    return ok({ campaignId: r.processId, savedCampaignId: id, ...summarizeCampaign(p) }, `Started campaign ${r.processId} from saved campaign ${id}.`);
  });

  tool('delete_saved_campaign', {
    title: 'Delete a saved campaign',
    description: 'Permanently delete a saved campaign definition (campaigns already running from it are not affected).',
    inputSchema: { id: z.string().min(1).max(60) }, annotations: DESTRUCTIVE,
  }, async ({ id }) => {
    await api.post('/api/saved-campaigns/delete', { id });
    return ok({ deleted: id }, `Deleted saved campaign ${id}.`);
  });

  // ═════════════════════════════ Schedules ════════════════════════════════════
  const summarizeSchedule = (sc) => ({
    id: sc.id, name: sc.name || null, runner: sc.runner === 'server' ? 'server' : 'dashboard', type: sc.type, enabled: !!sc.enabled,
    mode: sc.trafficMode || (sc.request && sc.request.mode) || null,
    target: sc.url || (sc.request && (sc.request.url || sc.request.businessName || sc.request.recordingId)) || null,
    nextRunAt: iso(sc.nextRunAt), lastRunAt: iso(sc.lastRunAt), runCount: sc.runCount || 0, lastCampaignId: sc.lastProcessId || null, lastError: sc.lastError || null,
  });

  tool('list_schedules', {
    title: 'List schedules',
    description: 'Saved schedules. "server" schedules (made with create_schedule) run inside the backend even with no dashboard open; "dashboard" schedules are managed by the dashboard page.',
    inputSchema: {}, annotations: READ,
  }, async () => {
    const r = await api.get('/api/schedule/list');
    const schedules = r.savedSchedules.map(summarizeSchedule);
    return ok({ schedules, total: schedules.length }, `${schedules.length} schedule(s).`);
  });

  tool('create_schedule', {
    title: 'Create a schedule',
    description: 'Schedule a campaign to run later (any mode, including replaying a saved recording with mode "rpa"): once after a delay, once at a date/time, or weekly on chosen days. It runs inside the backend, so the app must be running at that time (a one-time run more than 5 minutes late is skipped).',
    inputSchema: {
      name: z.string().min(1).max(120).optional().describe('A label for the schedule.'),
      when: S.whenSchema,
      campaign: S.campaignSchema,
    }, annotations: WRITE,
  }, async ({ name, when, campaign }) => {
    const problem = await browserProblem(campaign.customBrowserPath);
    if (problem) return fail(problem);
    const body = { runner: 'server', name, request: S.toRequestBody(campaign.mode, campaign) };
    if (when.type === 'delay') Object.assign(body, { type: 'delay', delayHours: when.hours, delayMinutes: when.minutes, delaySeconds: when.seconds });
    else if (when.type === 'datetime') Object.assign(body, { type: 'datetime', datetime: when.at });
    else Object.assign(body, { type: 'recurring', days: when.days, recurTime: when.time });
    const r = await api.post('/api/schedule/save', body);
    const sc = summarizeSchedule(r.schedule);
    return ok(sc, `Scheduled "${name || sc.id}" — next run ${sc.nextRunAt}.`);
  });

  tool('set_schedule_enabled', {
    title: 'Enable or disable a schedule',
    description: 'Turn a schedule on or off. Re-enabling a one-time schedule restarts its timer (a delay counts from now; a past date/time is rejected).',
    inputSchema: { id: z.string().min(1), enabled: z.boolean() }, annotations: WRITE_IDEMPOTENT,
  }, async ({ id, enabled }) => {
    const r = await api.post('/api/schedule/toggle', { id, enabled });
    const sc = summarizeSchedule(r.schedule);
    return ok(sc, `Schedule ${id} ${enabled ? 'enabled' : 'disabled'}${sc.nextRunAt ? ` — next run ${sc.nextRunAt}` : ''}.`);
  });

  tool('delete_schedule', {
    title: 'Delete a schedule',
    description: 'Permanently delete one schedule.',
    inputSchema: { id: z.string().min(1) }, annotations: DESTRUCTIVE,
  }, async ({ id }) => {
    await api.post('/api/schedule/delete', { id });
    return ok({ deleted: id }, `Deleted schedule ${id}.`);
  });

  tool('run_schedule_now', {
    title: 'Run a schedule now',
    description: 'Start a saved schedule\'s campaign immediately (its timer is not changed). Returns the new campaign id.',
    inputSchema: { id: z.string().min(1) }, annotations: VISITS_WEB,
  }, async ({ id }) => {
    const r = await api.post('/api/schedule/run', { id }, { timeoutMs: 150000 });
    return ok({ campaignId: r.processId, mode: r.mode, status: r.status }, `Started campaign ${r.processId} from schedule ${id}.`);
  });

  // ═════════════════════════════ RPA (record & replay) ════════════════════════
  tool('rpa_start_recording', {
    title: 'Start recording a browser session',
    description: 'Open a browser and record the clicks, typing, keys, scrolls and navigations performed in it. A person must perform the actions in that window, so it is visible by default; finish with rpa_stop_recording.',
    inputSchema: {
      url: z.string().max(2048).optional().describe('Page to open first (default google.com).'),
      headless: z.boolean().default(false).describe('Hide the window (only useful when something else drives the page).'),
    }, annotations: WRITE,
  }, async ({ url, headless }) => {
    const r = await api.post('/api/rpa/start', { url, headless }, { timeoutMs: 90000 });
    return ok({ recording: true, url: r.url }, `Recording started at ${r.url}. Perform the actions in the browser window, then call rpa_stop_recording.`);
  });

  tool('rpa_stop_recording', {
    title: 'Stop recording',
    description: 'Close the recording browser and return what was captured, optionally saving it to the recording library.',
    inputSchema: {
      save: z.boolean().default(true).describe('Save to the library (recommended).'),
      name: z.string().max(120).optional().describe('Name for the saved recording.'),
      includeActions: z.boolean().default(false).describe('Also return the raw action list.'),
    }, annotations: WRITE,
  }, async ({ save, name, includeActions }) => {
    const r = await api.post('/api/rpa/stop', { save, name }, { timeoutMs: 30000 });
    const byType = {};
    r.actions.forEach((a) => { byType[a.type] = (byType[a.type] || 0) + 1; });
    return ok({ actionCount: r.actions.length, byType, recording: r.recording, ...(includeActions ? { actions: r.actions } : {}) },
      r.recording ? `Saved "${r.recording.name}" (${r.actions.length} actions) as ${r.recording.id}.` : `Captured ${r.actions.length} action(s) (not saved).`);
  });

  tool('rpa_get_status', {
    title: 'Recording status',
    description: 'Whether a recording is in progress, how many actions it has so far and the current page.',
    inputSchema: {}, annotations: READ,
  }, async () => ok(await api.get('/api/rpa/status')));

  tool('rpa_list_recordings', {
    title: 'List recordings',
    description: 'Recordings in the library (those made through the backend/MCP — the dashboard keeps its own list in the page).',
    inputSchema: {}, annotations: READ,
  }, async () => {
    const r = await api.get('/api/rpa/recordings');
    return ok({ recordings: r.recordings, total: r.recordings.length }, `${r.recordings.length} recording(s).`);
  });

  tool('rpa_get_recording', {
    title: 'Get a recording',
    description: 'One saved recording with its actions (to inspect, copy or re-save under another name).',
    inputSchema: {
      recordingId: z.string().min(1).describe('Id from rpa_list_recordings'),
      includeActions: z.boolean().default(true).describe('Return the full action list.'),
    }, annotations: READ,
  }, async ({ recordingId, includeActions }) => {
    const { recording: rec } = await api.get(`/api/rpa/recordings/${enc(recordingId)}`);
    const byType = {};
    rec.actions.forEach((a) => { byType[a.type] = (byType[a.type] || 0) + 1; });
    return ok({ id: rec.id, name: rec.name, date: rec.date, duration: rec.duration, actionCount: rec.actions.length, byType, ...(includeActions ? { actions: rec.actions } : {}) }, `"${rec.name}": ${rec.actions.length} action(s).`);
  });

  tool('rpa_save_recording', {
    title: 'Save a recording',
    description: 'Add a recording to the library from an action list (e.g. built by hand or exported earlier).',
    inputSchema: { name: z.string().min(1).max(120), actions: z.array(S.actionSchema).min(1).max(20000) }, annotations: WRITE,
  }, async ({ name, actions }) => {
    const r = await api.post('/api/rpa/recordings', { name, actions });
    return ok({ recording: r.recording }, `Saved "${name}" as ${r.recording.id}.`);
  });

  tool('rpa_play_recording', {
    title: 'Replay a recording',
    description: 'Replay a saved recording in a fresh browser and wait until it finishes. Headless by default.',
    inputSchema: {
      recordingId: z.string().min(1).describe('Id from rpa_list_recordings'),
      speed: z.number().min(0.25).max(10).default(1).describe('Playback speed multiplier.'),
      headless: z.boolean().default(true),
      background: z.boolean().default(false).describe('Start it as a campaign and return at once (follow it with get_campaign / wait_for_campaign; it can be paused, stopped or looped). Otherwise wait for the replay to finish.'),
    }, annotations: VISITS_WEB,
  }, async ({ recordingId, speed, headless, background }, extra) => {
    if (background) {
      const r = await api.post('/api/campaigns/start', { mode: 'rpa', recordingId, speed, headless }, { timeoutMs: 150000 });
      const { process: p } = await api.get(`/api/processes/${enc(r.processId)}`);
      return ok({ campaignId: r.processId, ...summarizeCampaign(p) }, `Replay started as campaign ${r.processId}.`);
    }
    const r = await api.post('/api/rpa/play', { recordingId, speed, headless }, { timeoutMs: 20 * 60 * 1000, signal: extra && extra.signal });
    return ok({ recordingId, actionsPlayed: r.actionsPlayed }, `Replay complete (${r.actionsPlayed} actions).`);
  });

  tool('rpa_delete_recording', {
    title: 'Delete a recording',
    description: 'Permanently delete a recording from the library.',
    inputSchema: { recordingId: z.string().min(1) }, annotations: DESTRUCTIVE,
  }, async ({ recordingId }) => {
    await api.post('/api/rpa/recordings/delete', { id: recordingId });
    return ok({ deleted: recordingId }, `Deleted recording ${recordingId}.`);
  });
}

module.exports = { registerTools };
