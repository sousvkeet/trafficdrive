// PrivacyVerify.js — checks that the enabled privacy protections really work.
//
// Launches a short-lived headless browser, applies PrivacyGuard exactly as a
// campaign session would, loads a local test page (nothing leaves this
// machine) and compares what a website could observe against what each
// feature promises. Used by POST /api/privacy/verify and the MCP server's
// verify_privacy tool.

const http = require('http');
const { launchBrowser } = require('./browser-launcher.js');
const { installPrivacyGuard, uaProfile } = require('./PrivacyGuard.js');
const PrivacyCatalog = require('./PrivacyCatalog.js');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEVICES = {
  desktop: { viewport: { width: 1280, height: 800 } },
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  tablet: { viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true },
};

// Runs inside the page: gathers everything the checks need.
async function probePage(enabledList) {
  const o = {};
  const enabled = new Set(enabledList || []);
  // One stuck probe must never hang the whole verification.
  const safe = async (key, fn) => {
    try {
      o[key] = await Promise.race([Promise.resolve().then(fn), new Promise((_, rej) => setTimeout(() => rej(new Error('probe timed out')), 8000))]);
    } catch (e) { o[key] = { error: String(e && e.message || e).slice(0, 120) }; }
  };
  o.ua = navigator.userAgent; o.platform = navigator.platform; o.language = navigator.language;
  o.languages = Array.from(navigator.languages); o.languagesSame = navigator.languages === navigator.languages;
  o.hardwareConcurrency = navigator.hardwareConcurrency; o.deviceMemory = navigator.deviceMemory;
  o.doNotTrack = navigator.doNotTrack; o.webdriver = navigator.webdriver; o.maxTouchPoints = navigator.maxTouchPoints;
  o.nav = { vendor: navigator.vendor, appName: navigator.appName, product: navigator.product, productSub: navigator.productSub };
  await safe('window', () => ({ iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight, dpr: devicePixelRatio }));
  o.screen = { w: screen.width, h: screen.height, aw: screen.availWidth, ah: screen.availHeight, cd: screen.colorDepth, pd: screen.pixelDepth };
  await safe('tz', () => ({ name: Intl.DateTimeFormat().resolvedOptions().timeZone, jan: new Date(Date.UTC(2026, 0, 15, 12)).getTimezoneOffset(), jul: new Date(Date.UTC(2026, 6, 15, 12)).getTimezoneOffset(), supported: typeof Intl.DateTimeFormat.supportedLocalesOf === 'function' }));
  await safe('webgl', () => {
    const out = {};
    for (const v of ['webgl', 'webgl2']) {
      const gl = document.createElement('canvas').getContext(v);
      if (!gl) { out[v] = null; continue; }
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gl.getParameter(gl.VERSION); // must not throw
      out[v] = ext ? { vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) } : { vendor: null, renderer: null };
    }
    return out;
  });
  await safe('canvas', () => {
    const c = document.createElement('canvas'); c.width = 200; c.height = 50; const x = c.getContext('2d');
    x.fillStyle = '#f60'; x.fillRect(10, 10, 90, 25); x.font = '15px Arial'; x.fillStyle = '#069'; x.fillText('Fingerprint 123', 4, 40);
    const a = c.toDataURL(), b = c.toDataURL();
    const w = document.createElement('canvas'); w.toDataURL();
    return { a, b, glAfter: !!w.getContext('webgl') || !document.createElement('canvas').getContext('webgl') };
  });
  await safe('audio', async () => {
    const run = async () => {
      const ctx = new OfflineAudioContext(1, 4000, 44100); const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 10000;
      const comp = ctx.createDynamicsCompressor(); osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
      const buf = await ctx.startRendering(); const sum = (d) => { let s = 0; for (let i = 0; i < 2000; i++) s += d[i]; return s; };
      return [sum(buf.getChannelData(0)), sum(buf.getChannelData(0))];
    };
    return run();
  });
  await safe('fonts', () => {
    const probe = () => ['Arial', 'Courier New', 'Georgia', 'Impact', 'Tahoma', 'Verdana', 'Times New Roman', 'Comic Sans MS'].map((f) => {
      const s = document.createElement('span'); s.style.cssText = 'position:absolute;left:-9999px;font-size:72px;font-family:"' + f + '",monospace'; s.textContent = 'mmmmmmmmmmlli';
      document.body.appendChild(s); const r = [s.offsetWidth, s.offsetHeight]; s.remove(); return r;
    });
    const d = document.createElement('div'); d.style.cssText = 'width:200px;height:40px'; document.body.appendChild(d); const plain = [d.offsetWidth, d.offsetHeight]; d.remove();
    return { a: probe(), b: probe(), plain };
  });
  await safe('rects', () => {
    const d = document.createElement('div'); d.style.cssText = 'position:absolute;left:10.3px;top:20.7px;width:101px;height:33px'; document.body.appendChild(d);
    const a = d.getClientRects(), b = d.getClientRects(); const r = { len: a.length, item: typeof a.item === 'function', w: a[0].width, h: a[0].height, stable: a[0].x === b[0].x && a[0].y === b[0].y, near: Math.abs(a[0].x - 10.3) < 0.5 };
    d.remove(); return r;
  });
  await safe('plugins', () => ({ n: navigator.plugins.length, same: navigator.plugins === navigator.plugins, named: !!(navigator.plugins.namedItem && navigator.plugins.namedItem('PDF Viewer')), mn: navigator.mimeTypes.length, msame: navigator.mimeTypes === navigator.mimeTypes }));
  await safe('uad', async () => {
    const u = navigator.userAgentData; if (!u) return { present: false };
    const high = await u.getHighEntropyValues(['platform', 'platformVersion']);
    return { present: true, brands: u.brands.map((b) => b.brand), mobile: u.mobile, platform: u.platform, highOk: !!high && !!high.platform };
  });
  await safe('speechMedia', async () => ({ voices: speechSynthesis.getVoices().length, devices: navigator.mediaDevices ? (await navigator.mediaDevices.enumerateDevices()).length : 0 }));
  await safe('rtc', () => new Promise((resolve) => {
    const out = { types: [], error: null };
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:1' }] });
      out.instance = pc instanceof RTCPeerConnection; out.statics = typeof RTCPeerConnection.generateCertificate === 'function';
      pc.createDataChannel('x');
      pc.onicecandidate = (e) => { if (e.candidate) { const m = / typ (\w+)/.exec(e.candidate.candidate); out.types.push(m ? m[1] : '?'); } };
      pc.createOffer().then((off) => pc.setLocalDescription(off)).catch((e) => { out.error = String(e.message); });
    } catch (e) { out.error = String(e.message); }
    setTimeout(() => resolve(out), 1500);
  }));
  await safe('hints', () => new Promise((resolve) => setTimeout(() => {
    const dyn = document.createElement('link'); dyn.rel = 'dns-prefetch preconnect'; dyn.href = '//example.invalid'; document.head.appendChild(dyn);
    setTimeout(() => resolve({ staticLeft: document.querySelectorAll('link[rel~=dns-prefetch],link[rel~=prefetch],link[rel~=preconnect]').length - (document.head.contains(dyn) ? 1 : 0), dynamicKept: document.head.contains(dyn), pingAttr: document.getElementById('lnk').hasAttribute('ping') }), 120);
  }, 300)));
  await safe('battery', async () => (navigator.getBattery ? (({ level, charging }) => ({ level, charging }))(await navigator.getBattery()) : { n_a: true }));
  await safe('sensor', () => {
    let calls = 0; const l = () => { calls++; }; const ev = () => new DeviceOrientationEvent('deviceorientation', { alpha: 1, beta: 2, gamma: 3 });
    addEventListener('deviceorientation', l); dispatchEvent(ev()); const afterAdd = calls; removeEventListener('deviceorientation', l); dispatchEvent(ev());
    let objCalls = 0; try { addEventListener('devicemotion', { handleEvent() { objCalls++; } }); dispatchEvent(new Event('devicemotion')); } catch (_) {}
    return { afterAdd, afterRemove: calls, objCalls };
  });
  await safe('gamepads', () => { const g = navigator.getGamepads(); return { len: g.length, allNull: Array.prototype.every.call(g, (x) => x === null) }; });
  await safe('devices', async () => {
    const out = {};
    // Playwright evaluates with a simulated user gesture, so on an UNPROTECTED browser requestDevice()
    // would open a chooser that never closes. Only probe an API when its spoof is enabled.
    for (const [k, getter, req] of [['bluetooth', 'getAvailability', 'requestDevice'], ['usb', 'getDevices', 'requestDevice'], ['serial', 'getPorts', 'requestPort'], ['hid', 'getDevices', 'requestDevice']]) {
      if (!enabled.has(k + '-spoof')) { out[k] = { skipped: true }; continue; }
      const api = navigator[k]; if (!api) { out[k] = { n_a: true }; continue; }
      const v = await api[getter](); let rej = null; try { await api[req](); } catch (e) { rej = e && e.name; }
      out[k] = { empty: Array.isArray(v) ? v.length === 0 : v === false, rej };
    }
    return out;
  });
  await safe('iframe', () => { const f = document.createElement('iframe'); document.body.appendChild(f); const v = f.contentWindow.navigator.webdriver; f.remove(); return { webdriver: v }; });
  await safe('network', async () => {
    const echo = await fetch('/echo').then((r) => r.json());
    await fetch('/etag').then((r) => r.text()); await fetch('/etag').then((r) => r.text()); await fetch('/etag').then((r) => r.text());
    return { echo };
  });
  return o;
}

// Runs in the baseline (unprotected) page — only what we compare against.
async function probeBaseline() {
  const c = document.createElement('canvas'); c.width = 200; c.height = 50; const x = c.getContext('2d');
  x.fillStyle = '#f60'; x.fillRect(10, 10, 90, 25); x.font = '15px Arial'; x.fillStyle = '#069'; x.fillText('Fingerprint 123', 4, 40);
  const ctx = new OfflineAudioContext(1, 4000, 44100); const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 10000;
  const comp = ctx.createDynamicsCompressor(); osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
  const buf = await ctx.startRendering(); const d = buf.getChannelData(0); let audio = 0; for (let i = 0; i < 2000; i++) audio += d[i];
  const fonts = ['Arial', 'Courier New', 'Georgia', 'Impact', 'Tahoma', 'Verdana', 'Times New Roman', 'Comic Sans MS'].map((f) => {
    const s = document.createElement('span'); s.style.cssText = 'position:absolute;left:-9999px;font-size:72px;font-family:"' + f + '",monospace'; s.textContent = 'mmmmmmmmmmlli';
    document.body.appendChild(s); const r = [s.offsetWidth, s.offsetHeight]; s.remove(); return r;
  });
  return { canvas: c.toDataURL(), audio, fonts };
}

function startTestSite() {
  const seen = { pings: 0, etags: [] };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/ping') { seen.pings++; res.writeHead(204); return res.end(); }
    if (u.pathname === '/echo') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(req.headers)); }
    if (u.pathname === '/etag') {
      seen.etags.push(req.headers['if-none-match'] || null);
      if (req.headers['if-none-match'] === 'W/"v1"') { res.writeHead(304, { ETag: 'W/"v1"' }); return res.end(); }
      res.writeHead(200, { ETag: 'W/"v1"', 'Content-Type': 'text/plain' }); return res.end('x');
    }
    if (u.pathname === '/cookies') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': ['_ga=fromserver; Path=/', 'keep=1; Path=/'] });
      return res.end('<!doctype html><body>cookies</body>');
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><meta charset=utf-8><link rel="dns-prefetch" href="//example.invalid"><link rel="prefetch" href="/pf.js">
      <link rel="preconnect" href="http://127.0.0.1:9"><body><a id="lnk" href="#x" ping="/ping">link</a></body>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

/**
 * @param {Object} opts
 * @param {string[]} opts.features   enabled feature IDs
 * @param {string}  [opts.userAgent] User-Agent for the test session
 * @param {string}  [opts.device]    desktop | mobile | tablet
 */
async function verifyPrivacy(opts = {}) {
  const { features, unknown } = PrivacyCatalog.resolve({ privacyFeatures: opts.features || [] });
  const enabled = new Set(features);
  const device = DEVICES[opts.device] ? opts.device : 'desktop';
  const userAgent = opts.userAgent || DEFAULT_UA;
  const checks = [];
  const add = (feature, name, ok, detail) => { if (enabled.has(feature)) checks.push({ feature, name, ok: !!ok, detail: detail === undefined ? '' : String(detail) }); };

  const site = await startTestSite();
  let browser;
  // Whatever goes wrong, a verification ends within a minute: closing the browser makes every pending step fail.
  const watchdog = setTimeout(() => { try { if (browser) browser.close().catch(() => {}); } catch (_) {} }, 60000);
  try {
    browser = await launchBrowser({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const ctxOpts = { ...DEVICES[device], userAgent };
    const base = `http://127.0.0.1:${site.port}`;

    // Unprotected baseline (only needed for features judged by "differs from real").
    let baseline = null;
    if (['canvas-noise', 'audio-spoof', 'font-spoof'].some((f) => enabled.has(f))) {
      const bctx = await browser.newContext(ctxOpts);
      const bp = await bctx.newPage(); await bp.goto(base + '/');
      baseline = await bp.evaluate(probeBaseline); await bctx.close();
    }

    const context = await browser.newContext(ctxOpts);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await installPrivacyGuard(page, { privacyFeatures: features, privacyLevel: PrivacyCatalog.levelFor(features.length), onLog: () => {} });
    await page.goto(base + '/');
    const o = await page.evaluate(probePage, features);
    const echo = (o.network && o.network.echo) || {};

    // Cookie + ping checks need their own navigations.
    seenReset(site.seen);
    await page.click('#lnk').catch(() => {}); await page.waitForTimeout(500);
    const pings = site.seen.pings;
    await page.goto(base + '/cookies');
    const cookieNow = await page.evaluate(() => { document.cookie = '_ga=fromscript; path=/'; document.cookie = '_fbp=1; path=/'; document.cookie = 'mine=ok; path=/'; return document.cookie; });
    const prof = uaProfile(/Headless/.test(o.ua) && !enabled.has('user-agent-override') ? userAgent : o.ua);
    const P = uaProfile(enabled.has('user-agent-override') ? userAgent.replace(/HeadlessChrome/g, 'Chrome') : userAgent);

    // ── checks ──
    const okVal = (v) => v && !v.error;
    add('webgl-spoof', 'WebGL1 and WebGL2 work and report the expected GPU', okVal(o.webgl) && Object.values(o.webgl).every((g) => !g || (g.renderer === P.gpu.renderer && g.vendor === P.gpu.vendor)), JSON.stringify(o.webgl));
    add('canvas-noise', 'canvas output differs from the real one and is stable', okVal(o.canvas) && baseline && o.canvas.a !== baseline.canvas && o.canvas.a === o.canvas.b && o.canvas.glAfter, okVal(o.canvas) ? 'altered=' + (baseline && o.canvas.a !== baseline.canvas) : o.canvas.error);
    add('audio-spoof', 'audio fingerprint differs and repeated reads agree', Array.isArray(o.audio) && baseline && o.audio[0] !== baseline.audio && o.audio[0] === o.audio[1], Array.isArray(o.audio) ? o.audio.join(' / ') : (o.audio && o.audio.error));
    add('font-spoof', 'font probes altered, stable, ordinary layout exact', okVal(o.fonts) && baseline && JSON.stringify(o.fonts.a) !== JSON.stringify(baseline.fonts) && JSON.stringify(o.fonts.a) === JSON.stringify(o.fonts.b) && o.fonts.plain[0] === 200 && o.fonts.plain[1] === 40, okVal(o.fonts) ? 'plain=' + o.fonts.plain : o.fonts.error);
    add('hardware-spoof', 'hardwareConcurrency is 8', o.hardwareConcurrency === 8, o.hardwareConcurrency);
    add('device-memory-spoof', 'deviceMemory is 8', o.deviceMemory === 8, o.deviceMemory);
    add('screen-spoof', 'colour depth 24; desktop screen larger than window', o.screen.cd === 24 && o.screen.pd === 24 && (P.touch || (o.screen.w >= 1920 && o.screen.h >= 1080 && o.screen.aw <= o.screen.w)), `${o.screen.w}x${o.screen.h}, depth ${o.screen.cd}`);
    add('timezone-spoof', 'America/New_York with daylight saving, Intl intact', okVal(o.tz) && o.tz.name === 'America/New_York' && o.tz.jan === 300 && o.tz.jul === 240 && o.tz.supported, okVal(o.tz) ? `${o.tz.name} jan=${o.tz.jan} jul=${o.tz.jul}` : o.tz.error);
    add('language-spoof', 'languages [en-US,en], stable object, Accept-Language header', o.language === 'en-US' && o.languages.join() === 'en-US,en' && o.languagesSame && /^en-US/.test(echo['accept-language'] || ''), `${o.languages.join()} / ${echo['accept-language']}`);
    add('platform-spoof', 'navigator.platform matches the User-Agent', o.platform === P.platform, `${o.platform} (expected ${P.platform})`);
    add('client-rects', 'rects stable, near-exact, item() present', okVal(o.rects) && o.rects.len === 1 && o.rects.item && o.rects.w === 101 && o.rects.h === 33 && o.rects.stable && o.rects.near, JSON.stringify(o.rects));
    add('speech-spoof', 'voice list limited to 4', okVal(o.speechMedia) && o.speechMedia.voices <= 4, okVal(o.speechMedia) ? o.speechMedia.voices : o.speechMedia.error);
    add('media-spoof', 'device list limited to 3', okVal(o.speechMedia) && o.speechMedia.devices <= 3, okVal(o.speechMedia) ? o.speechMedia.devices : o.speechMedia.error);
    add('plugin-spoof', 'plugin list populated and stable', okVal(o.plugins) && o.plugins.n >= 1 && o.plugins.same && o.plugins.named, JSON.stringify(o.plugins));
    add('mimetype-spoof', 'MIME type list populated and stable', okVal(o.plugins) && o.plugins.mn >= 1 && o.plugins.msame, okVal(o.plugins) ? o.plugins.mn : o.plugins.error);
    add('user-agent-override', 'no "Headless" in the User-Agent header or JavaScript', !/Headless/i.test(o.ua) && !/Headless/i.test(echo['user-agent'] || '') && o.ua === echo['user-agent'], (echo['user-agent'] || '').slice(0, 80));
    add('sec-ch-ua-spoof', 'client hints match the User-Agent (headers + userAgentData)', P.family === 'chrome' ? (okVal(o.uad) && o.uad.present && o.uad.highOk && o.uad.brands.includes(P.brand) && o.uad.mobile === P.mobile && !/Headless/i.test(echo['sec-ch-ua'] || '')) : (okVal(o.uad) && !o.uad.present), P.family === 'chrome' ? (echo['sec-ch-ua'] || '') : 'non-Chrome UA: no userAgentData');
    add('navigator-override', 'vendor/appName/product match the UA family; Do-Not-Track untouched', o.nav.vendor === P.vendor && o.nav.appName === 'Netscape' && o.nav.product === 'Gecko' && o.nav.productSub === P.productSub && (P.touch ? o.maxTouchPoints > 0 : o.maxTouchPoints === 0) && (enabled.has('do-not-track') || o.doNotTrack !== '1'), JSON.stringify(o.nav));
    add('window-properties', 'innerWidth readable; window frame larger than viewport', okVal(o.window) && o.window.iw > 0 && (P.touch || (o.window.iw === DEVICES[device].viewport.width && o.window.ow > o.window.iw)), JSON.stringify(o.window));
    add('iframe-sandbox', 'webdriver false inside a brand-new iframe', okVal(o.iframe) && o.iframe.webdriver === false, JSON.stringify(o.iframe));
    add('webrtc-leak', 'no host/server-reflexive ICE candidates; RTCPeerConnection intact', okVal(o.rtc) && !o.rtc.error && !o.rtc.types.some((t) => t === 'host' || t === 'srflx') && o.rtc.instance && o.rtc.statics, okVal(o.rtc) ? `candidates: [${o.rtc.types.join(',')}]` : o.rtc.error);
    add('dns-prefetch', 'prefetch/preconnect hints removed (HTML and scripted)', okVal(o.hints) && o.hints.staticLeft === 0 && !o.hints.dynamicKept, JSON.stringify(o.hints));
    add('hyperlink-audit', 'ping attribute stripped; click sends no ping', okVal(o.hints) && !o.hints.pingAttr && pings === 0, `ping attr: ${okVal(o.hints) && o.hints.pingAttr}, pings sent: ${pings}`);
    add('do-not-track', 'DNT: 1 header sent and navigator.doNotTrack = "1"', echo.dnt === '1' && o.doNotTrack === '1', `header=${echo.dnt} js=${o.doNotTrack}`);
    add('referer-control', 'fetch() sends no Referer', !echo.referer, echo.referer || '(none)');
    add('cookie-sanitize', 'tracking cookies cleared/blocked, normal cookies kept', !/_ga=/.test(cookieNow) && !/_fbp=/.test(cookieNow) && /mine=ok/.test(cookieNow) && /keep=1/.test(cookieNow), cookieNow);
    add('etag-clear', 'repeat requests never send If-None-Match', site.seen.etags.length >= 3 && site.seen.etags.every((v) => v === null), JSON.stringify(site.seen.etags));
    add('battery-spoof', 'full, charging battery', okVal(o.battery) && (o.battery.n_a || (o.battery.level === 1 && o.battery.charging === true)), JSON.stringify(o.battery));
    add('sensor-spoof', 'sensor listeners work and can be removed', okVal(o.sensor) && o.sensor.afterAdd === 1 && o.sensor.afterRemove === 1 && o.sensor.objCalls === 1, JSON.stringify(o.sensor));
    add('gamepad-spoof', 'four empty gamepad slots', okVal(o.gamepads) && o.gamepads.len === 4 && o.gamepads.allNull, JSON.stringify(o.gamepads));
    for (const [id, key] of [['bluetooth-spoof', 'bluetooth'], ['usb-spoof', 'usb'], ['serial-spoof', 'serial'], ['hid-spoof', 'hid']]) {
      const d = okVal(o.devices) ? o.devices[key] : null;
      add(id, `${key}: no devices, requests rejected with NotFoundError`, !!d && (d.n_a || (d.empty && d.rej === 'NotFoundError')), d ? (d.n_a ? 'API not exposed by this browser (nothing to spoof)' : JSON.stringify(d)) : 'probe failed');
    }
    checks.forEach((c) => { if (/not exposed/.test(c.detail)) c.skipped = true; });

    const passed = checks.filter((c) => c.ok).length;
    await context.close();
    return {
      features, unknownFeatures: unknown, level: PrivacyCatalog.levelFor(features.length), device, userAgent,
      checks, passed, failed: checks.length - passed, pageErrors: errors,
      ok: passed === checks.length && errors.length === 0,
      observed: { platform: o.platform, languages: o.languages, hardwareConcurrency: o.hardwareConcurrency, timezone: okVal(o.tz) ? o.tz.name : null, userAgent: o.ua },
    };
  } finally {
    clearTimeout(watchdog);
    try { if (browser) await browser.close(); } catch (_) {}
    site.server.close();
  }
}

function seenReset(seen) { seen.pings = 0; }

module.exports = { verifyPrivacy };
