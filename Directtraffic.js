const { launchBrowser: _launchBrowser } = require('./browser-launcher.js');
const PopupHandler = require('./PopupHandler.js');
const EventEmitter = require('events');
const stopManager = require('./StopManager.js');
const { installCaptchaGuard } = require('./CaptchaGuard.js');
const { installPrivacyGuard } = require('./PrivacyGuard.js');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const DESKTOP_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
];

const MOBILE_USER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
];

const TABLET_USER_AGENTS = [
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; SM-X816B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

function getUserAgent(userAgents, autoRotate, device) {
  if (userAgents && userAgents.length > 0) {
    return autoRotate ? pickRandom(userAgents) : userAgents[0];
  }
  if (device === 'mobile') return pickRandom(MOBILE_USER_AGENTS);
  if (device === 'tablet') return pickRandom(TABLET_USER_AGENTS);
  return pickRandom(DESKTOP_USER_AGENTS);
}

function getViewport(device, autoRotateResolutions, vpWidth, vpHeight) {
  if (device === 'mobile') {
    // Standardized mobile resolution: 390x844
    return { width: 390, height: 844, isMobile: true, hasTouch: true };
  }
  if (device === 'tablet') {
    return { width: 768, height: 1024, isMobile: true, hasTouch: true };
  }
  if (autoRotateResolutions) {
    const res = [
      [1280, 800], [1366, 768], [1440, 900], [1536, 864], [1920, 1080],
    ];
    const pick = pickRandom(res);
    return { width: pick[0], height: pick[1], isMobile: false, hasTouch: false };
  }
  return { width: vpWidth, height: vpHeight, isMobile: false, hasTouch: false };
}

async function humanScroll(page, scrollDirection, waitTimeMs) {
  await page.evaluate((direction) => {
    return new Promise((resolve) => {
      const body = document.body;
      const html = document.documentElement;
      const documentHeight = Math.max(
        body.scrollHeight,
        body.offsetHeight,
        html.clientHeight,
        html.scrollHeight,
        html.offsetHeight
      );
      const viewportHeight = window.innerHeight;
      const startY = window.scrollY;
      let targetY;
      
      if (direction === 'down') {
        const scrollAmount = documentHeight * (0.6 + Math.random() * 0.2);
        targetY = Math.min(startY + scrollAmount, documentHeight - viewportHeight);
      } else {
        targetY = Math.max(0, startY - (startY * (0.4 + Math.random() * 0.2)));
      }

      const duration = 2000 + Math.random() * 3000;
      const startTime = performance.now();
      
      const easeInOutQuad = (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      
      function scrollStep(timestamp) {
        const elapsed = timestamp - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easedProgress = easeInOutQuad(progress);
        
        window.scrollTo({
          top: startY + (targetY - startY) * easedProgress,
          behavior: 'auto'
        });
        
        if (progress < 1) {
          requestAnimationFrame(scrollStep);
        } else {
          resolve();
        }
      }
      
      requestAnimationFrame(scrollStep);
    });
  }, scrollDirection);
  
  await sleep(waitTimeMs || randomBetween(500, 2000));
}

async function smoothNaturalScroll(page, scrollDirectionConfig, scrollDownWaitMs, scrollUpWaitMs) {
  const direction = scrollDirectionConfig || 'random';
  
  if (direction === 'down-only') {
    await humanScroll(page, 'down', scrollDownWaitMs);
  } else if (direction === 'up-down') {
    await humanScroll(page, 'down', scrollDownWaitMs);
    await sleep(randomBetween(800, 2000));
    await humanScroll(page, 'up', scrollUpWaitMs);
  } else {
    const scrollPattern = Math.random();
    if (scrollPattern < 0.7) {
      await humanScroll(page, 'down', scrollDownWaitMs);
      if (Math.random() < 0.4) {
        await sleep(randomBetween(800, 2000));
        await humanScroll(page, 'up', scrollUpWaitMs);
      }
    } else if (scrollPattern < 0.9) {
      await humanScroll(page, 'down', scrollDownWaitMs);
      await sleep(randomBetween(1000, 2500));
      await humanScroll(page, 'up', scrollUpWaitMs);
      await sleep(randomBetween(1000, 2000));
      await humanScroll(page, 'down', scrollDownWaitMs);
    } else {
      await humanScroll(page, 'down', scrollDownWaitMs);
    }
  }
}

// Normalize a URL so the same page is never counted twice (drops hash,
// query-only tracking differences are kept, trailing slash is unified).
function normalizeUrl(href) {
  try {
    const u = new URL(href);
    u.hash = '';
    let path = u.pathname.replace(/\/+$/, '');
    if (path === '') path = '/';
    return `${u.origin}${path}${u.search}`;
  } catch {
    return href;
  }
}

// Collect same-origin, navigable links from the page the browser is on right now.
async function collectInternalLinks(page, origin) {
  return page.evaluate((o) => {
    const skip = /\.(pdf|zip|rar|7z|jpe?g|png|gif|svg|webp|mp4|mp3|avi|dmg|exe|apk|css|js)(\?|$)/i;
    const seen = new Set();
    const out = [];
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      const href = a.href;
      if (!href) continue;
      let u;
      try { u = new URL(href); } catch { continue; }
      if (u.origin !== o) continue;
      if (!/^https?:$/.test(u.protocol)) continue;
      if (skip.test(u.pathname)) continue;
      // Ignore pure in-page anchors and links pointing at the current page
      if (u.pathname === location.pathname && u.search === location.search) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      out.push(href);
    }
    return out;
  }, origin).catch(() => []);
}

// Click a link the way a real visitor would: scroll it into view, strip
// target="_blank" so it navigates in the same tab, then click and wait for
// the navigation to commit. Works identically on desktop, mobile and tablet
// viewports because Playwright dispatches touch events automatically when the
// context has hasTouch enabled.
async function clickInternalLink(page, href, timeoutMs = 30000) {
  const marked = await page.evaluate((target) => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const anchor = anchors.find(a => a.href === target);
    if (!anchor) return false;
    document.querySelectorAll('[data-tp-nav]').forEach(el => el.removeAttribute('data-tp-nav'));
    anchor.setAttribute('data-tp-nav', '1');
    anchor.removeAttribute('target');
    anchor.scrollIntoView({ block: 'center', behavior: 'instant' });
    return true;
  }, href).catch(() => false);

  if (!marked) return false;

  const locator = page.locator('a[data-tp-nav="1"]').first();
  await sleep(randomBetween(300, 900));

  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeoutMs }),
      locator.click({ timeout: 10000 }),
    ]);
  } catch (_) {
    // Click may have been intercepted by an overlay — retry ignoring hit-testing
    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeoutMs }),
        locator.click({ timeout: 8000, force: true }),
      ]);
    } catch (__) {
      return false;
    }
  }

  return normalizeUrl(page.url()) === normalizeUrl(href);
}

async function visitInternalPages(page, config, emitter, sessionNum, isStopped, captchaGuard) {
  const {
    internalPagesCount, internalScrollMode, internalPageWaitMs,
    scrollDownWaitMs, scrollUpWaitMs, targetUrl
  } = config;
  const popupOpts = { label: `[Session ${sessionNum}]`, log: emitter };
  const log = (msg) => emitter.emit('log', `[Session ${sessionNum}] ${msg}`);

  const wanted = parseInt(internalPagesCount, 10);
  if (!wanted || wanted <= 0) return;

  let origin;
  try {
    origin = new URL(page.url() || targetUrl).origin;
  } catch {
    log('Cannot resolve site origin — skipping internal pages');
    return;
  }

  const visited = new Set([normalizeUrl(page.url())]);
  const failed = new Set();
  let processed = 0;
  // Keep hard upper bound so the routine never opens more than configured count.
  const maxAttempts = wanted * 5 + 5;

  log(`Internal pages: opening ${wanted} page(s) as configured`);

  // Build an initial candidate pool from the landing page.
  const initialPool = (await collectInternalLinks(page, origin))
    .filter(href => !visited.has(normalizeUrl(href)));
  const queue = initialPool.sort(() => 0.5 - Math.random());

  for (let attempt = 0; attempt < maxAttempts && processed < wanted; attempt++) {
    if (isStopped && isStopped()) {
      log('Stop requested — aborting internal pages');
      return;
    }

    // Refill queue from the current page when needed, but never include links
    // already processed or marked failed.
    if (queue.length === 0) {
      const refill = (await collectInternalLinks(page, origin))
        .filter(href => !visited.has(normalizeUrl(href)) && !failed.has(normalizeUrl(href)));
      if (refill.length === 0) {
        log(`No further internal links available — processed ${processed}/${wanted}`);
        return;
      }
      refill.sort(() => 0.5 - Math.random()).forEach(href => queue.push(href));
    }

    const link = queue.shift();
    const key = normalizeUrl(link);

    let navigated = await clickInternalLink(page, link);
    if (!navigated) {
      // Click path blocked (JS handler, overlay, SPA router) — navigate directly
      try {
        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 45000 });
        if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
        navigated = normalizeUrl(page.url()) === key;
      } catch (err) {
        log(`Failed to open internal page ${link}: ${err.message}`);
      }
    }

    if (!navigated) {
      failed.add(key);
      continue;
    }

    if (isStopped && isStopped()) return;

    // A page is considered "processed" only after it has fully loaded.
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    } catch (_) {}
    try {
      await page.waitForLoadState('networkidle', { timeout: 12000 });
    } catch (_) {}

    visited.add(key);
    visited.add(normalizeUrl(page.url()));
    await sleep(1500);
    await PopupHandler.dismissAll(page, popupOpts);

    if (isStopped && isStopped()) return;

    await smoothNaturalScroll(page, internalScrollMode, scrollDownWaitMs, scrollUpWaitMs);

    if (isStopped && isStopped()) return;

    await sleep(internalPageWaitMs || 5000);

    processed++;
    log(`Internal page ${processed}/${wanted} processed: ${page.url()}`);
  }

  if (processed < wanted) {
    log(`Internal pages finished: processed ${processed}/${wanted} (site did not expose enough links)`);
  } else {
    log(`Internal pages finished: processed ${processed}/${wanted}`);
  }
}

async function runDirectSession(config, emitter, sessionNum, browserTracker, isStoppedRef, campaignId) {
  const {
    targetUrl, sessions, threads, headless, proxy,
    userAgents, uaAutoRotate, device, customBrowserPath, browserEngine,
    visitTimeMs, viewportWidth, viewportHeight, autoRotateResolutions,
    scrollingInternalPagesEnabled, scrollDirection, scrollDownWaitMs, 
    scrollUpWaitMs, internalPagesCount, internalScrollMode, internalPageWaitMs, proxies: proxiesData
  } = config;

  // Debug logging
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`[Direct Traffic] Session ${sessionNum} Config:`);
  console.log('Headless:', headless, '(type:', typeof headless, ')');
  console.log('Target URL:', targetUrl);
  console.log('Threads:', threads);
  console.log('═══════════════════════════════════════════════════════════');

  // Unified stop check: StopManager (primary) or legacy isStoppedRef fallback
  const isStopped = () => stopManager.isStopped(campaignId) || (isStoppedRef && isStoppedRef());

  // Cancellable + pause-aware waits for this session (shadows the module-level
  // sleep): Stop wakes them instantly, Pause holds them until Resume.
  const sleep = (ms) => stopManager.sleep(campaignId, ms);

  // Check stop immediately
  if (isStopped()) {
    return false;
  }

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    `--window-size=${viewportWidth},${viewportHeight}`,
  ];

  const vp = getViewport(device, autoRotateResolutions, viewportWidth, viewportHeight);
  const ua = getUserAgent(userAgents, uaAutoRotate, device);

  // Prepare proxy options
  let proxyOptions = {};
  let assignedProxy = null;
  if (proxiesData && proxiesData.useProxies) {
    // Use working proxies if available, else all proxies
    const proxyPool = proxiesData.workingProxies.length > 0 
      ? proxiesData.workingProxies 
      : proxiesData.proxies;
    
    if (proxyPool.length > 0) {
      // Assign a proxy per session (round-robin through pool)
      assignedProxy = proxyPool[(sessionNum - 1) % proxyPool.length]; // sessionNum is 1-based

      const ProxyHandler = require('./Proxyhandler.js');
      const ph = new ProxyHandler();

      // Inject a unique -session-<id> into the username for ProxyOmega / residential
      // proxies so each thread gets its own rotating IP. Plain IP proxies are unaffected.
      const sessionProxy = ph.buildSessionProxy(assignedProxy, `t${sessionNum}`);
      proxyOptions = ph.buildPlaywrightProxyOpts(sessionProxy);

      const proxyLabel = sessionProxy.username
        ? `${sessionProxy.host}:${sessionProxy.port} (user: ${sessionProxy.username})`
        : `${sessionProxy.host}:${sessionProxy.port}`;
      emitter.emit('log', `[Session ${sessionNum}] Using proxy: ${proxyLabel}`);
    }
  }

  // Check stop before launching browser
  if (isStopped()) {
    return false;
  }

  // Debug: Log before launch
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`[Direct Traffic] Session ${sessionNum} - About to launch browser`);
  console.log('Launch Args:', launchArgs);
  console.log('Headless value being passed:', headless, '(expected: false)');
  console.log('Viewport:', vp);
  console.log('User Agent: ' + (ua ? ua.substring(0, 50) + '...' : 'undefined'));
  console.log('═══════════════════════════════════════════════════════════');

  // Launch Playwright's Chromium browser — NO proxy at launch level.
  // Proxy is applied exclusively on browser.newContext() below to avoid
  // Chromium spawning a blocking system-level proxy auth dialog.
  const browser = await _launchBrowser({
    headless: headless,
    customBrowserPath: customBrowserPath || undefined,
    args: launchArgs,
    onLog: (msg) => emitter.emit('log', msg),
    sessionId: `Session ${sessionNum}`,
  });
  
  emitter.emit('log', `[Session ${sessionNum}] Browser launched successfully`);

  // Register with StopManager so Stop can force-close it immediately
  if (campaignId) stopManager.registerBrowser(campaignId, browser);

  if (browserTracker) {
    browserTracker(browser);
  }

  // Only a visit that actually loaded and finished counts as completed.
  let visitOk = false;
  try {
    if (isStopped()) {
      return false;
    }

    const contextOptions = {
      viewport: { width: vp.width, height: vp.height },
      userAgent: ua,
    };
    if (proxyOptions && proxyOptions.proxy) {
      contextOptions.proxy = proxyOptions.proxy;
    }

    const context = await browser.newContext(contextOptions);

    const page = await context.newPage();

    // CAPTCHA guard — pauses the workflow if a reCAPTCHA challenge appears
    // during the direct visit. The bundled extension attempts an auto-solve;
    // otherwise the UI notifies the user to complete it manually.
    const captchaGuard = installCaptchaGuard(page, {
      sessionId: `Session ${sessionNum}`,
      onLog: (msg, type) => emitter.emit('log', msg, type),
    });

    // Apply privacy/anti-detection features (from the Privacy page toggles).
    const privacyFeatures = config.privacyFeatures || [];
    const privacyLevel = config.privacyLevel || 'standard';
    await installPrivacyGuard(page, {
      privacyFeatures,
      privacyLevel,
      onLog: (msg) => emitter.emit('log', msg),
    });

    // Workaround for Playwright Chromium proxy-auth redirect hang.
    if (proxyOptions && proxyOptions.proxy && proxyOptions.proxy.server) {
      try { await page.route('**/*', route => route.continue()); } catch (_) {}
    }

    try { await page.bringToFront(); } catch (_) {}

    if (isStopped()) {
      return false;
    }

    const popupOpts = { label: `[Session ${sessionNum}]`, log: emitter };

    const forceNavigate = async (url) => {
      try {
        await page.evaluate((u) => { window.location.href = u; }, url);
      } catch (_) {}
    };

    const navigateWithRetry = async (url, label) => {
      // When using a proxy, the website can take much longer to load due to
      // proxy latency / tunnel priming. Use more attempts and longer timeouts
      // so the browser doesn't give up and close before the page actually opens.
      const usingProxy = !!(proxyOptions && proxyOptions.proxy && proxyOptions.proxy.server);
      const maxAttempts = usingProxy ? 8 : 4;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (isStopped && isStopped()) throw new Error('__STOPPED__');

        // ── CAPTCHA pause: wait for any active CAPTCHA to be resolved before
        // attempting navigation.  This prevents the retry loop from
        // navigating away while the extension is solving a CAPTCHA.
        if (captchaGuard && captchaGuard.isBusy()) {
          emitter.emit('log', `[Session ${sessionNum}] CAPTCHA in progress — pausing navigation to ${label}...`, 'warning');
          await captchaGuard.waitForCaptchaResolution();
          if (isStopped && isStopped()) throw new Error('__STOPPED__');
        }

        const aboutBlankWatchdog = setTimeout(() => {
          const current = page.url();
          // Don't fire the watchdog if a CAPTCHA is being solved
          if (captchaGuard && captchaGuard.isBusy()) return;
          if (!current || current === 'about:blank') {
            emitter.emit('log', `[Session ${sessionNum}] Watchdog: about:blank detected, forcing navigation...`, 'WARN');
            forceNavigate(url).catch(() => {});
          }
        }, usingProxy ? (attempt === 1 ? 30000 : 50000) : (attempt === 1 ? 15000 : 25000));

        try {
          emitter.emit('log', `[Session ${sessionNum}] Navigating to ${label} (attempt ${attempt}/${maxAttempts})...`);

          const currentUrl = page.url();
          if (currentUrl === 'about:blank' && attempt > 1) {
            // Don't reload if a CAPTCHA is active
            if (!captchaGuard || !captchaGuard.isBusy()) {
              try { await page.reload({ waitUntil: 'commit', timeout: usingProxy ? 30000 : 15000 }); } catch (_) {}
            }
          }

          // Longer timeouts when using a proxy — the proxy tunnel adds latency
          const navTimeout = usingProxy
            ? (attempt <= 2 ? 60000 : (attempt <= 5 ? 90000 : 120000))
            : (attempt === 1 ? 25000 : 45000);
          const waitStage = attempt <= 2 ? 'commit' : 'domcontentloaded';

          try {
            await page.goto(url, { waitUntil: waitStage, timeout: navTimeout });
          } catch (firstNavErr) {
            if (isStopped && isStopped()) throw new Error('__STOPPED__');
            // Don't force-navigate if a CAPTCHA appeared during the timeout
            if (captchaGuard && captchaGuard.isBusy()) {
              emitter.emit('log', `[Session ${sessionNum}] CAPTCHA detected during navigation — waiting for extension to solve...`, 'warning');
              clearTimeout(aboutBlankWatchdog);
              await captchaGuard.waitForCaptchaResolution();
              if (isStopped && isStopped()) throw new Error('__STOPPED__');
              const landed = page.url();
              if (landed && landed !== 'about:blank') {
                try { await page.waitForLoadState('domcontentloaded', { timeout: usingProxy ? 30000 : 15000 }); } catch (_) {}
                return landed;
              }
              continue;
            }
            const errMsg = firstNavErr.message || '';
            if (/timeout|timed out/i.test(errMsg) && attempt < maxAttempts) {
              emitter.emit('log', `[Session ${sessionNum}] Navigation slow, trying window.location fallback...`, 'WARN');
              try {
                await Promise.race([
                  new Promise((_, rej) => setTimeout(() => rej(new Error('force-timeout')), usingProxy ? 40000 : 20000)),
                  (async () => {
                    await forceNavigate(url);
                    await page.waitForNavigation({ waitUntil: 'commit', timeout: usingProxy ? 30000 : 15000 }).catch(() => {});
                  })(),
                ]);
              } catch (_) {}
            } else {
              throw firstNavErr;
            }
          }
        } catch (navErr) {
          clearTimeout(aboutBlankWatchdog);
          if (isStopped && isStopped()) throw new Error('__STOPPED__');
          if (attempt < maxAttempts) {
            emitter.emit('log', `[Session ${sessionNum}] Navigation error (${navErr.message.substring(0, 90)}) — retrying in 2s...`, 'WARN');
            await sleep(2000);
            continue;
          }
          throw navErr;
        } finally {
          clearTimeout(aboutBlankWatchdog);
        }

        const landed = page.url();
        if (landed && landed !== 'about:blank') {
          emitter.emit('log', `[Session ${sessionNum}] Page loaded: ${landed.substring(0, 70)}`);
          try {
            await page.waitForLoadState('domcontentloaded', { timeout: usingProxy ? 30000 : 15000 });
          } catch (_) {}
          // Wait for CAPTCHA after landing
          if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
          return landed;
        }

        emitter.emit('log', `[Session ${sessionNum}] Still on about:blank — forcing navigation via window.location...`, 'WARN');
        await forceNavigate(url);
        try { await page.waitForNavigation({ waitUntil: 'commit', timeout: usingProxy ? 30000 : 15000 }); } catch (_) {}
        if (attempt < maxAttempts) await sleep(2000);
      }

      // ── FINAL PATIENT WAIT ────────────────────────────────────────────────
      // All retry attempts exhausted but the page might still be loading
      // through a slow proxy. Instead of immediately closing the browser,
      // wait up to 3 minutes for the page to actually land on a real URL.
      const finalCheck = page.url();
      if (finalCheck && finalCheck !== 'about:blank') {
        emitter.emit('log', `[Session ${sessionNum}] Page loaded on final check: ${finalCheck.substring(0, 70)}`);
        return finalCheck;
      }

      if (usingProxy) {
        emitter.emit('log', `[Session ${sessionNum}] Proxy is slow — waiting up to 3 minutes for page to load...`, 'WARN');
        const patientDeadline = Date.now() + 180000; // 3 minutes
        while (Date.now() < patientDeadline) {
          if (isStopped && isStopped()) throw new Error('__STOPPED__');
          if (captchaGuard && captchaGuard.isBusy()) {
            await captchaGuard.waitForCaptchaResolution();
          }
          await sleep(5000);
          const patientUrl = page.url();
          if (patientUrl && patientUrl !== 'about:blank') {
            emitter.emit('log', `[Session ${sessionNum}] Page finally loaded: ${patientUrl.substring(0, 70)}`);
            try { await page.waitForLoadState('domcontentloaded', { timeout: 30000 }); } catch (_) {}
            if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
            return patientUrl;
          }
        }
      }

      throw new Error(`Page stuck on about:blank after ${maxAttempts} attempts — proxy may be blocking`);
    };

    if (proxyOptions && proxyOptions.proxy && proxyOptions.proxy.server) {
      emitter.emit('log', `[Session ${sessionNum}] Priming proxy tunnel with lightweight warm-up request...`);
      try {
        const warmupUrl = /https?:\/\//i.test(targetUrl)
          ? (new URL(targetUrl).origin + '/favicon.ico')
          : 'https://www.google.com/favicon.ico';
        await Promise.race([
          new Promise((_, rej) => setTimeout(() => rej(new Error('warmup-timeout')), 25000)),
          page.goto(warmupUrl, { waitUntil: 'commit', timeout: 20000 }).catch(() => {}),
        ]);
      } catch (_) {}
    }

    try {
      await navigateWithRetry(targetUrl, targetUrl.length > 60 ? targetUrl.substring(0, 60) + '...' : targetUrl);
      if (isStopped()) return false;
      await sleep(2000);
      if (isStopped()) return false;
      // Pause if the target site (or an interstitial) shows a CAPTCHA
      if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
      if (isStopped()) return false;
      await PopupHandler.dismissAll(page, popupOpts);
      await sleep(1000);
      if (isStopped()) return false;
      if (scrollingInternalPagesEnabled) {
        await smoothNaturalScroll(page, scrollDirection, scrollDownWaitMs, scrollUpWaitMs);
        if (isStopped()) return false;
        await sleep((visitTimeMs || 20000) + randomBetween(0, 5000));
        if (isStopped()) return false;
        await visitInternalPages(page, config, emitter, sessionNum, isStopped, captchaGuard);
        if (isStopped()) return false;
      } else {
        await sleep((visitTimeMs || 20000) + randomBetween(0, 5000));
        if (isStopped()) return false;
      }
      emitter.emit('log', `[Session ${sessionNum}] Direct visit completed`);
      visitOk = true;
    } catch (error) {
      emitter.emit('log', `[Session ${sessionNum}] Direct visit failed: ${error.message}`);
    }

    if (isStopped()) return false;
    await sleep(randomBetween(2000, 5000));
  } catch (err) {
    emitter.emit('log', `[Session ${sessionNum}] Fatal error: ${err.message}`);
    console.error(err);
  } finally {
    if (campaignId) stopManager.unregisterBrowser(campaignId, browser);
    try { await browser.close(); } catch (_) {}
    emitter.emit('log', `[Session ${sessionNum}] Closed browser`);
  }
  // Previously always `true`, so failed visits were counted as completed.
  return visitOk;
}

async function main(config, emitter = new EventEmitter()) {

  const { sessions, threads } = config;

  // Register campaign with StopManager — this id flows to every session/browser
  const campaignId = stopManager.startCampaign();

  let isStopped = false;
  let isPaused = false;
  let nextSessionIndex = 0;
  let activeBrowsers = 0;
  let openBrowsers = [];

  const tasks = [];
  for (let i = 0; i < sessions; i++) {
    tasks.push({
      id: i + 1,
      status: 'pending'
    });
  }

  function emitStatsUpdate() {
    const total = tasks.length;
    const completed = tasks.filter(t => t.status === 'completed').length;
    const stats = {
      total: total,
      completed: completed,
      running: tasks.filter(t => t.status === 'running').length,
      pending: tasks.filter(t => t.status === 'pending').length,
      failed: tasks.filter(t => t.status === 'failed').length,
      stopped: tasks.filter(t => t.status === 'stopped').length,
      activeBrowsers: activeBrowsers,
      remaining: tasks.filter(t => t.status === 'pending' || t.status === 'running').length,
      progress: Math.round((completed / total) * 100)
    };
    emitter.emit('stats', stats);
  }

  const trackedRunDirectSession = async (config, emitter, sessionNum, isStoppedRef) => {
    let browser = null;
    try {
      const result = await runDirectSession(config, emitter, sessionNum, (b) => { 
        browser = b; 
        openBrowsers.push(b); 
      }, isStoppedRef, campaignId);
      return result;
    } finally {
      if (browser) {
        const index = openBrowsers.indexOf(browser);
        if (index > -1) {
          openBrowsers.splice(index, 1);
        }
      }
    }
  };


  // Dashboard "Delay Time": random wait between sessions on each thread.
  // Cancellable by Stop, held by Pause.
  const waitBetweenSessions = async () => {
    const min = Math.max(0, config.sessionDelayMinMs || 0);
    const max = Math.max(min, config.sessionDelayMaxMs || 0);
    if (max <= 0 || isStopped || nextSessionIndex >= sessions) return;
    await stopManager.sleep(campaignId, randomBetween(min, max));
  };

  const processSession = async () => {
    while (nextSessionIndex < sessions && !isStopped) {
      while (isPaused && !isStopped) {
        await sleep(100);
      }
      if (isStopped) break;
      
      const sessionIndex = nextSessionIndex++;
      const sessionConfig = { ...config };

      tasks[sessionIndex].status = 'running';
      activeBrowsers++;
      emitStatsUpdate();

      try {
        emitter.emit('log', `[Session ${sessionIndex + 1}] Starting...`);
        const result = await trackedRunDirectSession(sessionConfig, emitter, sessionIndex + 1, () => isStopped);
        if (isStopped) {
          tasks[sessionIndex].status = 'stopped';
        } else if (result) {
          tasks[sessionIndex].status = 'completed';
          emitter.emit('log', `[Session ${sessionIndex + 1}] Completed successfully`);
        } else {
          tasks[sessionIndex].status = 'failed';
          emitter.emit('log', `[Session ${sessionIndex + 1}] Failed to complete`);
        }
      } catch (err) {
        tasks[sessionIndex].status = isStopped ? 'stopped' : 'failed';
        if (!isStopped) emitter.emit('log', `[Session ${sessionIndex + 1}] Error: ${err.message}`);
      } finally {
        activeBrowsers--;
        emitStatsUpdate();
      }
      await waitBetweenSessions();
    }
  };

  const maintainActiveBrowsers = async () => {
    const workers = [];
    for (let i = 0; i < threads; i++) {
      workers.push(processSession());
    }
    await Promise.all(workers);
  };

  emitter.on('stop', async () => {
    isStopped = true;
    // Mark all non-completed tasks as stopped immediately
    tasks.forEach(task => {
      if (task.status === 'pending' || task.status === 'running') {
        task.status = 'stopped';
      }
    });
    emitter.emit('status', 'stopped');
    emitter.emit('log', 'Stop signal received. Force closing all browsers...');
    
    // StopManager: abort all sleeps + force-close all registered browsers instantly
    await stopManager.stopCampaign(campaignId);

    // Also close any browsers tracked in the local array (belt-and-suspenders)
    const closePromises = openBrowsers.map(async (browser) => {
      try {
        await browser.close();
        emitter.emit('log', 'Browser force-closed.');
      } catch (err) {
        emitter.emit('log', `Error closing browser: ${err.message}`);
      }
    });
    await Promise.all(closePromises);
    openBrowsers = [];
    activeBrowsers = 0;
    emitStatsUpdate();
    // NOTE: don't endCampaign() here — sessions are still unwinding. The
    // campaign is ended once the worker loop has fully finished.
  });

  emitter.on('pause', () => {
    isPaused = true;
    stopManager.pauseCampaign(campaignId); // in-flight sessions hold at their next wait
    emitter.emit('status', 'paused');
    emitter.emit('log', 'Campaign paused.');
    emitStatsUpdate();
  });

  emitter.on('resume', () => {
    isPaused = false;
    stopManager.resumeCampaign(campaignId);
    emitter.emit('status', 'running');
    emitter.emit('log', 'Campaign resumed.');
    emitStatsUpdate();
  });

  emitter.emit('status', 'running');
  emitter.emit('log', `Starting direct traffic with ${threads} active browsers...`);
  emitStatsUpdate();

  await maintainActiveBrowsers();

  emitter.emit('status', isStopped ? 'stopped' : 'completed');
  emitter.emit('log', isStopped ? 'Campaign stopped.' : 'All sessions complete!');
  
  const finalStats = {
    completed: tasks.filter(t => t.status === 'completed').length,
    pending: tasks.filter(t => t.status === 'pending').length,
    failed: tasks.filter(t => t.status === 'failed').length,
    stopped: tasks.filter(t => t.status === 'stopped').length,
    totalProcessed: tasks.filter(t => t.status === 'completed' || t.status === 'failed').length,
    remaining: tasks.filter(t => t.status === 'pending' || t.status === 'running').length
  };
  emitter.emit('summary', finalStats);
  emitStatsUpdate();

  stopManager.endCampaign(campaignId);

  return emitter;
}

module.exports = {
  startDirectTraffic: (config) => {
    const emitter = new EventEmitter();
    setImmediate(() => {
      main(config, emitter).catch((err) => {
        try {
          emitter.emit('log', `Fatal error: ${err.message}`);
          emitter.emit('status', 'failed');
        } catch (_) {}
      });
    });
    return emitter;
  },
  sleep,
  randomBetween,
  pickRandom
};
