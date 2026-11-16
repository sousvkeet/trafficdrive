// ProxyAutomation.js — keeps working proxies loaded without anyone pressing a button.
//
//  1. Remembers them. The working proxies (with their check results) are saved to proxies.json in the app's data folder
//     — owner-only, because proxy logins are stored too — and loaded every time the app starts.
//  2. Keeps them fresh. Proxies die over time, so working ones whose last check is old (or was made for a different
//     address) are checked again in the background, and the dead ones drop out.
//  3. Tops the list up. When fewer than `target` working proxies are ready, it downloads the enabled proxy sources and
//     checks the new proxies against the address of the last campaign (or the last address checked on the Proxies
//     page), keeping only the ones that work. If that does not find enough, it waits before trying again (10 minutes,
//     doubling up to an hour) instead of hammering the sources.
//
// It never runs while the user's own check or scrape is running, and it only starts when the host asks for it
// (the desktop app does; tests and the MCP server's private backend do not).
'use strict';
const fs = require('fs');
const path = require('path');

const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };

function createProxyAutomation(ctx) {
  // ctx: { file, list(), restore(records), addProxies(records), startCheck(opts) → job, busy(), scrape() → { proxies, results },
  //        clean(record), settings() → { enabled, target }, saveSettings(patch), isPublic(url), log(msg) }
  const TICK_MS = num(process.env.TD_PROXY_AUTO_TICK_MS, 60 * 1000);
  const FIRST_MS = num(process.env.TD_PROXY_AUTO_DELAY_MS, 15 * 1000);
  const RECHECK_MS = num(process.env.TD_PROXY_RECHECK_MS, 30 * 60 * 1000);
  const BACKOFF_MS = num(process.env.TD_PROXY_AUTO_BACKOFF_MS, 10 * 60 * 1000);
  const MAX_BACKOFF_MS = BACKOFF_MS * 6;

  let timer = null, firstTimer = null, saveTimer = null, running = false;
  let backoff = BACKOFF_MS, nextTopUpAt = 0;
  let meta = { lastTestUrl: null, lastTestAt: 0, lastCampaignUrl: null, lastCampaignAt: 0 };
  let state = 'off', message = '', lastRun = null, lastTopUp = null, lastRecheck = null, savedInfo = null;

  // ── which address new proxies must be able to open ─────────────────────────────────────────────────────
  const targetUrl = () => {
    const c = meta.lastCampaignAt >= meta.lastTestAt ? meta.lastCampaignUrl : meta.lastTestUrl;
    return c || meta.lastCampaignUrl || meta.lastTestUrl || null;
  };
  const siteOf = (u) => { try { return u ? new URL(u).origin : null; } catch (_) { return null; } };
  const readyCount = () => { const site = siteOf(targetUrl()); return ctx.list().filter((p) => p.status === 'working' && (p.checkedFor || null) === site).length; };

  // ── saving and restoring ────────────────────────────────────────────────────────────────────────────────
  function saveNow() {
    clearTimeout(saveTimer); saveTimer = null;
    const working = ctx.list().filter((p) => p.status === 'working')
      .map(({ type, host, port, username, password, ms, checkedAt, checkedFor }) => ({ type, host, port, username: username || null, password: password || null, ms: ms == null ? null : ms, checkedAt: checkedAt || null, checkedFor: checkedFor || null }));
    try {
      fs.mkdirSync(path.dirname(ctx.file), { recursive: true });
      const tmp = ctx.file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), ...meta, proxies: working }, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, ctx.file);
      try { fs.chmodSync(ctx.file, 0o600); } catch (_) {}
      savedInfo = { count: working.length, at: Date.now() };
    } catch (e) { ctx.log(`[proxies] could not save the working proxies: ${e.message}`); }
  }
  // Save soon after a change. A save already scheduled is not pushed back by further changes, so frequent changes
  // still get written within a couple of seconds.
  function changed() { if (saveTimer) return; saveTimer = setTimeout(saveNow, 1500); if (saveTimer.unref) saveTimer.unref(); }

  function restore() {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(ctx.file, 'utf8')); } catch (_) { return 0; }
    if (!raw || !Array.isArray(raw.proxies)) return 0;
    meta = { lastTestUrl: raw.lastTestUrl || null, lastTestAt: raw.lastTestAt || 0, lastCampaignUrl: raw.lastCampaignUrl || null, lastCampaignAt: raw.lastCampaignAt || 0 };
    const records = [];
    for (const r of raw.proxies) {
      const c = ctx.clean(r);
      if (!c) continue;
      records.push({ ...c, status: 'working', ms: typeof r.ms === 'number' ? r.ms : null, checkedAt: r.checkedAt || 0, checkedFor: r.checkedFor || null });
    }
    if (records.length) ctx.restore(records);
    savedInfo = { count: records.length, at: raw.savedAt || null };
    return records.length;
  }

  // ── what the app tells it ──────────────────────────────────────────────────────────────────────────────
  function noteTestUrl(url) { if (url && ctx.isPublic(url)) { meta.lastTestUrl = url; meta.lastTestAt = Date.now(); changed(); } }
  function noteCampaignUrl(url) { if (url && ctx.isPublic(url)) { meta.lastCampaignUrl = url; meta.lastCampaignAt = Date.now(); changed(); } }

  // ── the background work ────────────────────────────────────────────────────────────────────────────────
  const waitJob = async (job) => { await job.finished; return job; };

  async function tick(force) {
    const s = ctx.settings();
    if (!s.enabled) { state = 'off'; message = ''; return; }
    if (running) return;
    if (ctx.busy()) { if (state !== 'checking' && state !== 'scraping') { state = 'waiting'; message = 'Waiting for the current check to finish.'; } return; }
    running = true;
    try {
      const url = targetUrl();
      const site = siteOf(url);
      const now = Date.now();

      // 1) keep fresh: working proxies whose check is old, or was for another address
      const stale = ctx.list().filter((p) => p.status === 'working' && (now - (p.checkedAt || 0) > RECHECK_MS || (p.checkedFor || null) !== site));
      if (stale.length) {
        state = 'rechecking'; message = `Re-checking ${stale.length} saved proxies${url ? ` against ${new URL(url).host}` : ''}.`;
        const job = await waitJob(ctx.startCheck({ subject: stale, testUrl: url, removeDead: true, concurrency: 300, timeoutSeconds: 6 }));
        lastRun = lastRecheck = { kind: 'recheck', at: Date.now(), checked: job.done, working: job.working, removed: job.removed, error: job.error, testUrl: url };
      }

      // 2) top up when fewer than the target are ready
      const ready = readyCount();
      if (ready >= s.target) { backoff = BACKOFF_MS; nextTopUpAt = 0; state = 'idle'; message = `${ready} working proxies ready.`; return; }
      if (!force && Date.now() < nextTopUpAt) { state = 'waiting'; message = `${ready} of ${s.target} working proxies ready. Looking for more again at ${new Date(nextTopUpAt).toLocaleTimeString()}.`; return; }

      state = 'scraping'; message = 'Downloading the proxy sources.';
      let scraped;
      try { scraped = await ctx.scrape(); } catch (e) { scraped = { error: e.message }; }
      if (scraped.error) {
        lastRun = lastTopUp = { kind: 'topup', at: Date.now(), scraped: 0, added: 0, checked: 0, working: 0, error: scraped.error, testUrl: url };
      } else {
        const add = ctx.addProxies(scraped.proxies);
        state = 'checking'; message = `Checking ${add.added} new proxies${url ? ` against ${new URL(url).host}` : ''}.`;
        let job = null;
        try { job = await waitJob(ctx.startCheck({ onlyUnchecked: true, testUrl: url, removeDead: true, concurrency: 300, timeoutSeconds: 6 })); }
        catch (e) { if (!/already been checked|no proxies/i.test(e.message)) throw e; }
        lastRun = lastTopUp = { kind: 'topup', at: Date.now(), scraped: scraped.proxies.length, added: add.added, checked: job ? job.done : 0, working: job ? job.working : 0, error: job && job.status === 'error' ? job.error : null, testUrl: url };
      }
      const now2 = readyCount();
      if (now2 >= s.target) { backoff = BACKOFF_MS; nextTopUpAt = 0; state = 'idle'; message = `${now2} working proxies ready.`; }
      else {
        nextTopUpAt = Date.now() + backoff;
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        state = 'waiting';
        message = `${now2} of ${s.target} working proxies ready${lastRun && lastRun.error ? ` (${lastRun.error})` : ''}. Looking for more again at ${new Date(nextTopUpAt).toLocaleTimeString()}.`;
      }
    } catch (e) {
      state = 'waiting'; message = `Could not top up: ${e.message}`;
      nextTopUpAt = Date.now() + backoff;
    } finally {
      running = false;            // (the checks themselves report list changes, which schedules the save)
    }
  }

  function start() {
    stop();
    state = ctx.settings().enabled ? 'idle' : 'off';
    firstTimer = setTimeout(() => tick(false), FIRST_MS);
    timer = setInterval(() => tick(false), TICK_MS);
    if (firstTimer.unref) firstTimer.unref();
    if (timer.unref) timer.unref();
  }
  function stop() { clearTimeout(firstTimer); clearInterval(timer); firstTimer = timer = null; if (saveTimer) saveNow(); }
  // Run soon, ignoring the wait after a failed attempt (the user pressed "Find now", or a campaign was refused).
  function kick() { if (!timer) return false; nextTopUpAt = 0; setTimeout(() => tick(true), 50); return true; }   // only where it runs

  function status() {
    const s = ctx.settings();
    const url = targetUrl();
    return {
      enabled: s.enabled, target: s.target, running: !!timer,
      // 'inactive': switched on, but this backend does not run it (only the desktop app does)
      state: !s.enabled ? 'off' : timer ? state : 'inactive', message: s.enabled && timer ? message : '',
      ready: readyCount(), testUrl: url, nextTopUpAt: nextTopUpAt || null,
      lastRun, lastTopUp, lastRecheck, saved: savedInfo,
    };
  }

  return { restore, changed, saveNow, noteTestUrl, noteCampaignUrl, start, stop, kick, tick, status, targetUrl };
}

module.exports = { createProxyAutomation };
