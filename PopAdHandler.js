// PopAdHandler.js
// Auto-clicks website when opened to trigger PopAds / Popunder advertising scripts,
// and manages the lifecycle of opened popunder / popad windows and tabs.

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Searches the page for popunder overlays or safe coordinates to click,
 * and performs genuine human-like mouse clicks to trigger PopAds / popunder scripts.
 */
async function triggerPopAds(page, opts = {}) {
  const log = opts.log && opts.log.emit ? (m, type) => opts.log.emit('log', m, type) : () => {};
  const label = opts.label || '[PopAds]';
  const isStopped = typeof opts.isStopped === 'function' ? opts.isStopped : () => false;

  if (opts.enabled === false) return 0;
  if (!page || (page.isClosed && page.isClosed())) return 0;
  if (isStopped()) return 0;

  const clicks = Math.min(Math.max(parseInt(opts.clicks, 10) || 1, 1), 5);
  const delayMs = Math.max(parseInt(opts.delayMs, 10) || 2000, 500);
  const clickIntervalMs = Math.max(parseInt(opts.clickIntervalMs, 10) || 1500, 500);

  // Wait for ad network scripts (PopAds, PopCash, Adsterra, etc.) to load and attach listeners
  log(`${label} [PopAds] Waiting ${Math.round(delayMs / 1000)}s for popad/popunder scripts to initialize...`);
  const delayChunks = Math.ceil(delayMs / 250);
  for (let c = 0; c < delayChunks; c++) {
    if (isStopped() || (page.isClosed && page.isClosed())) return 0;
    await sleep(250);
  }

  let clicksPerformed = 0;

  for (let i = 1; i <= clicks; i++) {
    if (isStopped() || (page.isClosed && page.isClosed())) break;

    try {
      // Find candidate coordinates to click safely
      const target = await page.evaluate(() => {
        const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
        const vh = window.innerHeight || document.documentElement.clientHeight || 800;

        // 1. Check for transparent or full-screen overlays injected by popunder scripts
        const allDivs = document.querySelectorAll('div, span, a, section, ins');
        for (const el of allDivs) {
          try {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const isFixed = style.position === 'fixed' || style.position === 'absolute';
            const coversScreen = rect.width >= vw * 0.4 && rect.height >= vh * 0.4;
            const zIndex = parseInt(style.zIndex, 10) || 0;
            const isTransparent = style.opacity === '0' || style.visibility === 'hidden' || style.backgroundColor === 'transparent';
            const idClass = ((el.id || '') + ' ' + (el.className || '')).toLowerCase();
            const hasPopPattern = /(pop|under|overlay|click|catcher|interstitial|ad-)/.test(idClass);

            if (isFixed && (coversScreen || hasPopPattern) && (zIndex >= 10 || isTransparent)) {
              return {
                x: Math.floor(Math.max(10, rect.left + rect.width / 2)),
                y: Math.floor(Math.max(10, rect.top + rect.height / 2)),
                isOverlay: true,
                desc: 'ad overlay (' + (el.id || el.className || 'transparent div') + ')'
              };
            }
          } catch (_) {}
        }

        // 2. Sample coordinates across the viewport to find a safe neutral spot (NOT a navigation link)
        const candidates = [
          { x: Math.floor(vw * 0.5), y: Math.floor(vh * 0.45) },
          { x: Math.floor(vw * 0.35), y: Math.floor(vh * 0.35) },
          { x: Math.floor(vw * 0.65), y: Math.floor(vh * 0.35) },
          { x: Math.floor(vw * 0.5), y: Math.floor(vh * 0.6) },
          { x: Math.floor(vw * 0.25), y: Math.floor(vh * 0.5) },
          { x: Math.floor(vw * 0.75), y: Math.floor(vh * 0.5) },
        ];

        for (const pt of candidates) {
          try {
            const el = document.elementFromPoint(pt.x, pt.y);
            if (!el) continue;
            // Avoid navigation links, form submissions, and interactive inputs
            const interactive = el.closest('a[href], button, input, select, textarea, [role="button"], [role="link"]');
            if (!interactive) {
              return {
                x: pt.x,
                y: pt.y,
                isOverlay: false,
                desc: 'neutral element <' + el.tagName.toLowerCase() + '>'
              };
            }
          } catch (_) {}
        }

        // Fallback: viewport center
        return {
          x: Math.floor(vw * 0.5),
          y: Math.floor(vh * 0.45),
          isOverlay: false,
          desc: 'viewport center'
        };
      }).catch(() => null);

      if (!target) break;

      // Add slight human jitter (±15px)
      const jitterX = Math.max(10, target.x + randomBetween(-15, 15));
      const jitterY = Math.max(10, target.y + randomBetween(-15, 15));

      // Human-like mouse movement and click (trusted CDP input)
      await page.mouse.move(jitterX, jitterY, { steps: randomBetween(3, 7) });
      await sleep(randomBetween(50, 100));
      await page.mouse.down();
      await sleep(randomBetween(60, 140));
      await page.mouse.up();

      clicksPerformed++;
      log(`${label} [PopAds] Auto-clicked website to trigger PopAds/Popunder (${clicksPerformed}/${clicks} at ${jitterX},${jitterY} on ${target.desc})`);

      // Dispatch backup synthetic click event in case script uses window/document capture
      await page.evaluate(() => {
        try {
          const ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
          document.body.dispatchEvent(ev);
        } catch (_) {}
      }).catch(() => {});

      if (i < clicks) {
        const intervalChunks = Math.ceil(clickIntervalMs / 200);
        for (let ic = 0; ic < intervalChunks; ic++) {
          if (isStopped() || (page.isClosed && page.isClosed())) break;
          await sleep(200);
        }
      }
    } catch (err) {
      log(`${label} [PopAds] Auto-click attempt error: ${err.message}`, 'WARN');
    }
  }

  // Brief pause to allow popunder / popup window to spawn
  await sleep(1000);
  return clicksPerformed;
}

/**
 * Listens for new popunder or popad tabs/windows opened by the browser context.
 * Brings the main page back into focus, lets the ad tab dwell for the specified
 * stay time so ad networks register impressions, and closes the ad tab cleanly.
 */
function setupPopunderWatcher(context, initialMainPage, opts = {}) {
  const log = opts.log && opts.log.emit ? (m, type) => opts.log.emit('log', m, type) : () => {};
  const label = opts.label || '[PopAds]';
  const stayTimeMs = Math.max(parseInt(opts.popAdStayTimeMs, 10) || 8000, 2000);
  const autoClose = opts.popAdAutoClose !== false;
  const isStopped = typeof opts.isStopped === 'function' ? opts.isStopped : () => false;

  let currentMainPage = initialMainPage;
  const activeAdPages = new Set();
  let stopped = false;

  const onPageHandler = async (adPage) => {
    if (stopped) return;
    if (adPage === currentMainPage) return;
    if (activeAdPages.has(adPage)) return;
    activeAdPages.add(adPage);

    let initialUrl = 'about:blank';
    try { initialUrl = adPage.url() || 'about:blank'; } catch (_) {}
    log(`${label} [PopAds] Popunder / ad tab detected: ${initialUrl}`);

    // Immediately keep the main target page in foreground
    try {
      if (currentMainPage && !currentMainPage.isClosed()) {
        await currentMainPage.bringToFront();
      }
    } catch (_) {}

    // Track frame navigation (redirect chains common in ad networks)
    const onNav = (frame) => {
      try {
        if (frame === adPage.mainFrame()) {
          const u = frame.url();
          if (u && u !== 'about:blank' && u !== initialUrl) {
            log(`${label} [PopAds] Ad redirected: ${u}`);
          }
        }
      } catch (_) {}
    };
    try { adPage.on('framenavigated', onNav); } catch (_) {}

    // Process ad in background
    (async () => {
      try {
        // Wait for ad page to settle
        try {
          await Promise.race([
            adPage.waitForLoadState('domcontentloaded', { timeout: 12000 }),
            adPage.waitForLoadState('load', { timeout: 15000 }),
            sleep(5000),
          ]);
        } catch (_) {}

        if (stopped || isStopped()) return;

        log(`${label} [PopAds] Dwelling on ad tab for ${Math.round(stayTimeMs / 1000)}s...`);

        // Light activity simulation on the ad page (anti-fraud engagement)
        try {
          await adPage.evaluate(() => {
            window.scrollBy({ top: 120, behavior: 'smooth' });
          }).catch(() => {});
        } catch (_) {}

        // Dwell loop aware of session stop
        const chunks = Math.ceil(stayTimeMs / 500);
        for (let k = 0; k < chunks; k++) {
          if (stopped || isStopped()) break;
          await sleep(500);
        }

        // Auto-close ad tab if enabled
        if (autoClose && !adPage.isClosed()) {
          try {
            await adPage.close();
            log(`${label} [PopAds] Ad view complete (${Math.round(stayTimeMs / 1000)}s) — closed ad tab`);
          } catch (_) {}
        } else if (!autoClose) {
          log(`${label} [PopAds] Keeping ad tab open as configured`);
        }
      } catch (err) {
        log(`${label} [PopAds] Ad tab handler notice: ${err.message}`, 'WARN');
      } finally {
        activeAdPages.delete(adPage);
        try {
          if (currentMainPage && !currentMainPage.isClosed()) {
            await currentMainPage.bringToFront();
          }
        } catch (_) {}
      }
    })();
  };

  try {
    context.on('page', onPageHandler);
  } catch (_) {}

  return {
    setMainPage(page) {
      if (page) currentMainPage = page;
    },
    getMainPage() {
      return currentMainPage;
    },
    getAdPages() {
      return Array.from(activeAdPages);
    },
    async cleanup() {
      stopped = true;
      try { context.off('page', onPageHandler); } catch (_) {}
      for (const p of Array.from(activeAdPages)) {
        if (!p.isClosed()) {
          try { await p.close(); } catch (_) {}
        }
      }
      activeAdPages.clear();

      // Clean up any remaining extra pages in context
      try {
        const all = context.pages();
        for (const p of all) {
          if (p !== currentMainPage && !p.isClosed()) {
            try { await p.close(); } catch (_) {}
          }
        }
      } catch (_) {}
    },
    stop() {
      stopped = true;
      try { context.off('page', onPageHandler); } catch (_) {}
    },
  };
}

class PopAdHandler {
  static triggerPopAds = triggerPopAds;
  static setupPopunderWatcher = setupPopunderWatcher;
}

PopAdHandler.triggerPopAds = triggerPopAds;
PopAdHandler.setupPopunderWatcher = setupPopunderWatcher;

module.exports = PopAdHandler;
module.exports.triggerPopAds = triggerPopAds;
module.exports.setupPopunderWatcher = setupPopunderWatcher;

