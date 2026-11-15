// CaptchaGuard.js
// Minimal CAPTCHA detection / pause helper.
//
// The full production version bundles a browser extension that auto-solves
// reCAPTCHA challenges. This minimal implementation simply watches the page
// for known CAPTCHA iframes/elements and, when one is detected, pauses the
// workflow (resolves once the CAPTCHA is gone) so the user can solve it
// manually in a visible browser window.

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="captcha"]',
  'div.g-recaptcha',
  '#captcha-container',
  'iframe[title*="reCAPTCHA" i]',
  'img[src*="captcha" i]',
];

function installCaptchaGuard(page, opts = {}) {
  const { sessionId = 'Session', onLog = () => {} } = opts;
  let busy = false;

  async function detect() {
    try {
      for (const sel of CAPTCHA_SELECTORS) {
        const el = await page.$(sel).catch(() => null);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) return true;
        }
      }
    } catch (_) {}
    return false;
  }

  function isBusy() {
    return busy;
  }

  // Polls until no CAPTCHA is visible. Resolves immediately if not busy.
  async function waitForCaptchaResolution() {
    if (!busy) return;
    onLog(`[${sessionId}] CAPTCHA detected — waiting for manual resolution...`, 'warning');
    while (busy) {
      await sleep(2500);
      const stillThere = await detect();
      if (!stillThere) {
        busy = false;
        onLog(`[${sessionId}] CAPTCHA resolved — resuming workflow.`, 'success');
        break;
      }
    }
  }

  // Lightweight background watcher — marks the guard busy when a CAPTCHA
  // appears so the next navigation retry loop can pause for it.
  let watcherRunning = false;
  async function startWatcher() {
    if (watcherRunning) return;
    watcherRunning = true;
    while (watcherRunning) {
      try {
        const pageClosed = page.isClosed();
        if (pageClosed) { watcherRunning = false; break; }
        if (!busy) {
          const found = await detect();
          if (found) busy = true;
        } else {
          // re-check whether it cleared on its own
          const found = await detect();
          if (!found) busy = false;
        }
      } catch (_) {
        watcherRunning = false;
        break;
      }
      await sleep(3000);
    }
  }
  startWatcher().catch(() => {});

  return { isBusy, waitForCaptchaResolution, detect };
}

module.exports = { installCaptchaGuard };
