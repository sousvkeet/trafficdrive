// PopupHandler.js
// Minimal popup / consent-banner dismissor.
//
// Real sites throw cookie banners, newsletter modals, age gates, etc. at the
// visitor. Left unhandled these can cover the link we want to click or break
// scrolling. This module tries a curated list of common accept/close button
// selectors and dismisses whatever it can find on the page.

const CONSENT_SELECTORS = [
  // Generic "accept cookies" / consent banners
  'button#onetrust-accept-btn-handler',
  'button[id*="accept" i]',
  'button[class*="accept" i]',
  'a[class*="accept" i]',
  'button[aria-label*="accept" i]',
  'button[aria-label*="agree" i]',
  'button[aria-label*="consent" i]',
  'button[title*="accept" i]',
  'button[data-testid*="accept" i]',
  // Cookie banner variants
  '#cookie-accept',
  '#cookieAccept',
  '.cookie-accept',
  '.cookie__accept',
  '.js-accept-cookies',
  '#cmpbntyestext',
  // Newsletter / modal close buttons
  'button[aria-label="Close" i]',
  'button[aria-label="close" i]',
  'button.close',
  '.modal-close',
  '.popup-close',
  '[data-dismiss="modal"]',
];

// Buttons whose WHOLE label is one of these (case-insensitive). The old
// `:has-text("OK")` / `:has-text("Agree")` selectors were substring matches,
// so they clicked "Book now", "Facebook", "Cookie settings" and "Disagree".
const ACCEPT_LABEL_RE = /^\s*(accept|accept all|accept all cookies|accept cookies|allow all|allow all cookies|allow cookies|i agree|agree|agree and close|agree and continue|got it|ok|okay)\s*[.!]?\s*$/i;

// Never click these even when a selector above matched (e.g. an element with
// class "accept-settings", or aria-label "Disagree").
const AVOID_LABEL_RE = /(disagree|reject|decline|deny|refuse|setting|preference|manage|customi[sz]e|options|learn more|more info|privacy policy)/i;

async function labelOf(handle) {
  return handle.evaluate((n) => (
    (n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('title') || '') + ' ' + (n.innerText || n.textContent || '')
  ).replace(/\s+/g, ' ').trim()).catch(() => '');
}

async function clickIfSafe(handle) {
  const visible = await handle.isVisible().catch(() => false);
  if (!visible) return false;
  const label = await labelOf(handle);
  if (AVOID_LABEL_RE.test(label)) return false;
  await handle.click({ timeout: 2000 }).catch(() => {});
  // Brief pause so the banner animation can finish.
  await new Promise((r) => setTimeout(r, 250));
  return true;
}

async function dismissAll(page, opts = {}) {
  const log = opts.log && opts.log.emit ? (m) => opts.log.emit('log', m) : () => {};
  if (!page || (page.isClosed && page.isClosed())) return 0;
  let dismissed = 0;
  for (const selector of CONSENT_SELECTORS) {
    try {
      const els = await page.$$(selector).catch(() => []);
      for (const el of els) {
        if (await clickIfSafe(el)) dismissed++;
      }
    } catch (_) {
      // selector not present — move on
    }
  }
  // Text buttons: exact (whole-label) match only.
  try {
    const candidates = page.locator('button, [role="button"]').filter({ hasText: ACCEPT_LABEL_RE });
    const count = Math.min(await candidates.count().catch(() => 0), 5);
    for (let i = 0; i < count; i++) {
      const handle = await candidates.nth(i).elementHandle({ timeout: 1000 }).catch(() => null);
      if (handle && await clickIfSafe(handle)) dismissed++;
    }
  } catch (_) {}
  if (dismissed > 0) {
    log(`[PopupHandler] Dismissed ${dismissed} popup/consent element(s)`);
  }
  return dismissed;
}

async function tryFrameworkSelectors(page, opts = {}) {
  return dismissAll(page, opts);
}

function startMonitor(page, opts = {}) {
  const intervalMs = opts.interval || opts.intervalMs || 2500;
  const dismissFn = opts.dismissFn || dismissAll;
  // One pass at a time: a pass can take longer than the interval, and
  // overlapping passes used to pile up clicks on the same elements.
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    if (!page || (page.isClosed && page.isClosed())) { clearInterval(timer); return; }
    running = true;
    try {
      await dismissFn(page, { log: opts.log });
    } catch (_) {
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

const PopAdHandler = require('./PopAdHandler.js');

class PopupHandler {
  static dismissAll = dismissAll;
  static dismissGoogle = dismissAll;
  static dismissContinueBrowsing = dismissAll;
  static tryFrameworkSelectors = tryFrameworkSelectors;
  static startMonitor = startMonitor;
  static triggerPopAds = PopAdHandler.triggerPopAds;
  static setupPopunderWatcher = PopAdHandler.setupPopunderWatcher;
}

PopupHandler.dismissAll = dismissAll;
PopupHandler.dismissGoogle = dismissAll;
PopupHandler.dismissContinueBrowsing = dismissAll;
PopupHandler.tryFrameworkSelectors = tryFrameworkSelectors;
PopupHandler.startMonitor = startMonitor;
PopupHandler.triggerPopAds = PopAdHandler.triggerPopAds;
PopupHandler.setupPopunderWatcher = PopAdHandler.setupPopunderWatcher;
PopupHandler.PopAdHandler = PopAdHandler;

module.exports = PopupHandler;
module.exports.dismissAll = dismissAll;
module.exports.dismissGoogle = dismissAll;
module.exports.dismissContinueBrowsing = dismissAll;
module.exports.tryFrameworkSelectors = tryFrameworkSelectors;
module.exports.startMonitor = startMonitor;
module.exports.triggerPopAds = PopAdHandler.triggerPopAds;
module.exports.setupPopunderWatcher = PopAdHandler.setupPopunderWatcher;
module.exports.PopAdHandler = PopAdHandler;
