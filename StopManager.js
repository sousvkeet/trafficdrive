// StopManager.js
// Centralised stop/pause bookkeeping for traffic campaigns.
//
// Each campaign gets a unique id. Sessions register their browsers with the
// manager so that `stopCampaign(id)` can force-close every browser instantly
// and wake every in-flight `sleep()` — this is what makes the Stop button feel
// responsive even when sessions are stuck inside long waits.
//
// Pause: while a campaign is paused, `sleep()` calls finish their timer and
// then hold until the campaign is resumed (or stopped). Sessions therefore
// pause at their next wait point instead of only between sessions.

let nextCampaignId = 1;

// campaignId -> { stopped, paused, browsers: Set<Browser>, sleepers: Set<{timer, resolve}>, resumeWaiters: Set<fn> }
const campaigns = new Map();

// Ids of campaigns that have ended. Late callers (a session still unwinding
// after Stop) must see an ended campaign as stopped; previously they silently
// re-created a fresh, un-stopped entry.
const ended = new Set();

function plainSleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms || 0)));
}

function startCampaign() {
  const id = `camp_${nextCampaignId++}`;
  campaigns.set(id, {
    stopped: false,
    paused: false,
    browsers: new Set(),
    sleepers: new Set(),
    resumeWaiters: new Set(),
  });
  return id;
}

function isStopped(id) {
  if (!id) return false;
  const c = campaigns.get(id);
  return c ? c.stopped : ended.has(id);
}

function isPaused(id) {
  const c = id ? campaigns.get(id) : null;
  return !!(c && c.paused && !c.stopped);
}

function registerBrowser(id, browser) {
  if (!id || !browser) return;
  const c = campaigns.get(id);
  if (c && !c.stopped) {
    c.browsers.add(browser);
    return;
  }
  // The browser finished launching after Stop was pressed (or after the
  // campaign ended) — close it now so no stray window is left open.
  if ((c && c.stopped) || ended.has(id)) {
    try { browser.close().catch(() => {}); } catch (_) {}
  }
}

function unregisterBrowser(id, browser) {
  if (!id || !browser) return;
  const c = campaigns.get(id);
  if (c) c.browsers.delete(browser);
}

function waitWhilePaused(id) {
  const c = id ? campaigns.get(id) : null;
  if (!c || !c.paused || c.stopped) return Promise.resolve();
  return new Promise((resolve) => c.resumeWaiters.add(resolve));
}

// Cancellable, pause-aware sleep — resolves immediately when the campaign is
// stopped, and holds after the timer while the campaign is paused.
function sleep(id, ms) {
  if (!id) return plainSleep(ms);
  const c = campaigns.get(id);
  if (!c) return ended.has(id) ? Promise.resolve() : plainSleep(ms);
  if (c.stopped) return Promise.resolve();
  return new Promise((resolve) => {
    const sleeper = { timer: null, resolve };
    sleeper.timer = setTimeout(() => {
      c.sleepers.delete(sleeper);
      waitWhilePaused(id).then(resolve);
    }, Math.max(0, ms || 0));
    c.sleepers.add(sleeper);
  });
}

function wakeAll(c) {
  // Resolve (not just clear) every pending sleep so awaiting sessions resume
  // and unwind. Clearing the timer alone left those promises pending forever.
  c.sleepers.forEach((s) => {
    clearTimeout(s.timer);
    s.resolve();
  });
  c.sleepers.clear();
  c.resumeWaiters.forEach((r) => r());
  c.resumeWaiters.clear();
}

function pauseCampaign(id) {
  const c = id ? campaigns.get(id) : null;
  if (c && !c.stopped) c.paused = true;
}

function resumeCampaign(id) {
  const c = id ? campaigns.get(id) : null;
  if (!c) return;
  c.paused = false;
  c.resumeWaiters.forEach((r) => r());
  c.resumeWaiters.clear();
}

async function stopCampaign(id) {
  const c = campaigns.get(id);
  if (!c) return;
  c.stopped = true;
  c.paused = false;
  wakeAll(c);

  // Force-close every registered browser.
  const closers = [];
  c.browsers.forEach((b) => {
    closers.push((async () => { try { await b.close(); } catch (_) {} })());
  });
  c.browsers.clear();
  await Promise.all(closers);
}

// Call once the campaign loop has fully finished (all sessions returned).
function endCampaign(id) {
  if (!id) return;
  const c = campaigns.get(id);
  if (c) wakeAll(c);
  campaigns.delete(id);
  ended.add(id);
}

module.exports = {
  startCampaign,
  endCampaign,
  isStopped,
  isPaused,
  registerBrowser,
  unregisterBrowser,
  stopCampaign,
  pauseCampaign,
  resumeCampaign,
  sleep,
};
