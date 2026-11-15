// PrivacyGuard.js
// Browser fingerprint / network-privacy protections for a Playwright session.
// The 34 feature IDs match PRIVACY_FEATURES in index.html 1:1, so every
// dashboard toggle maps to a real protection.
//
// installPrivacyGuard(page, { privacyFeatures: [...], privacyLevel, onLog })
//
// How features are applied (most reliable first):
//   1. Chromium DevTools Protocol (CDP) — User-Agent / platform / language /
//      Sec-CH-UA client hints (headers AND navigator.*, always consistent),
//      timezone, and HTTP-cache disabling. These are native browser overrides,
//      so they also cover Date#toString, Intl, request headers, etc.
//   2. An init script registered on the whole browser CONTEXT (not just one
//      page), so popups and new tabs opened by a site are protected too. It
//      patches the page-level APIs (canvas, WebGL, audio, WebRTC, ...) and is
//      also the fallback for (1) if CDP is unavailable.
//   3. Context-level request headers (DNT).
//
// Spoofed values are always derived from the session's actual User-Agent
// (set by the traffic module / dashboard), so e.g. an iPhone User-Agent is
// never contradicted by a "Windows" platform or desktop client hints.

const crypto = require('crypto');

// context → { cfg, plan } for contexts that already carry the guard.
const guardedContexts = new WeakMap();

// ─────────────────────────────────────────────────────────────────────────────
// User-Agent profile (Node side). Everything the spoofs need is derived here
// once and passed to the page script as plain data.
// ─────────────────────────────────────────────────────────────────────────────
function uaProfile(ua) {
  const s = String(ua || '');
  let os = 'windows';
  if (/iPhone|iPad|iPod/.test(s)) os = 'ios';
  else if (/Android/.test(s)) os = 'android';
  else if (/Windows/.test(s)) os = 'windows';
  else if (/Macintosh|Mac OS X/.test(s)) os = 'mac';
  else if (/CrOS|Linux|X11/.test(s)) os = 'linux';

  let family = 'chrome';
  let major = '124';
  let brand = 'Google Chrome';
  const edge = s.match(/Edg\/(\d+)/);
  const chrome = s.match(/Chrome\/(\d+)/);
  if (/Firefox\/|FxiOS\//.test(s)) family = 'firefox';
  else if (/CriOS\//.test(s)) family = 'safari'; // Chrome on iOS is WebKit — no client hints
  else if (edge) { major = edge[1]; brand = 'Microsoft Edge'; }
  else if (chrome) major = chrome[1];
  else if (/Safari\//.test(s)) family = 'safari';
  else if (s) family = 'chrome';

  let platform = 'Win32';
  if (os === 'ios') platform = /iPad/.test(s) ? 'iPad' : (/iPod/.test(s) ? 'iPod' : 'iPhone');
  else if (os === 'android') platform = 'Linux armv8l';
  else if (os === 'mac') platform = 'MacIntel';
  else if (os === 'linux') platform = 'Linux x86_64';

  const androidVer = (s.match(/Android (\d+(?:\.\d+)*)/) || [])[1] || '13';
  const model = (s.match(/Android [^;]+; ([^;)]+)\)/) || [])[1] || '';
  const touch = /iPhone|iPad|iPod|Android/.test(s);
  const mobile = /iPhone|iPod|Mobile/.test(s);

  const GPU = {
    windows: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    mac: { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
    ios: { vendor: 'Apple Inc.', renderer: 'Apple GPU' },
    android: { vendor: 'Google Inc. (Qualcomm)', renderer: 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)' },
    linux: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)' },
  }[os];

  return {
    os, family, major, brand, platform, touch, mobile, model, androidVer,
    vendor: family === 'chrome' ? 'Google Inc.' : (family === 'safari' ? 'Apple Computer, Inc.' : ''),
    productSub: family === 'firefox' ? '20100101' : '20030107',
    gpu: GPU,
  };
}

// Client-hints metadata for CDP Emulation.setUserAgentOverride.
function buildUserAgentMetadata(p) {
  if (p.family !== 'chrome') {
    // Safari / Firefox send no client hints; an empty list is the closest
    // Chromium allows and stops it advertising "Chromium 1xx".
    return { brands: [], fullVersionList: [], platform: '', platformVersion: '', architecture: '', model: '', mobile: false };
  }
  const full = p.major + '.0.0.0';
  const names = [{ brand: 'Chromium' }, { brand: p.brand }, { brand: 'Not-A.Brand' }];
  const brands = names.map((b, i) => ({ brand: b.brand, version: i === 2 ? '99' : p.major }));
  const fullVersionList = names.map((b, i) => ({ brand: b.brand, version: i === 2 ? '99.0.0.0' : full }));
  const platforms = { windows: ['Windows', '10.0.0'], mac: ['macOS', '10.15.7'], android: ['Android', p.androidVer + '.0.0'], linux: ['Linux', '6.5.0'], ios: ['iOS', '17.4.0'] };
  const [plat, platVer] = platforms[p.os] || platforms.windows;
  const mobileOs = p.os === 'android' || p.os === 'ios';
  return {
    brands, fullVersionList, fullVersion: full,
    platform: plat, platformVersion: platVer,
    architecture: mobileOs ? '' : 'x86', bitness: mobileOs ? '' : '64', wow64: false,
    model: p.os === 'android' ? p.model : '', mobile: p.mobile,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-page CDP setup (UA/platform/language/client hints, timezone, cache).
// Returns which native overrides were applied so the page script can skip the
// matching in-page fallback.
// ─────────────────────────────────────────────────────────────────────────────
async function applyCdp(page, plan) {
  const applied = { ua: false, tz: false, cache: false };
  let cdp;
  try {
    cdp = await page.context().newCDPSession(page);
  } catch (_) {
    return applied; // not Chromium / session refused → in-page fallbacks
  }
  if (plan.ua) {
    try { await cdp.send('Emulation.setUserAgentOverride', plan.ua); applied.ua = true; } catch (_) {}
  }
  if (plan.tz) {
    try { await cdp.send('Emulation.setTimezoneOverride', { timezoneId: plan.tz }); applied.tz = true; } catch (_) {}
  }
  if (plan.cacheOff) {
    try {
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      applied.cache = true;
    } catch (_) {}
  }
  return applied;
}

/**
 * Install the privacy guard on a Playwright page's browser context.
 * @param {import('playwright').Page} page
 * @param {Object} opts
 * @param {string[]} [opts.privacyFeatures] enabled feature IDs
 * @param {string}   [opts.privacyLevel]    'standard' | 'balanced' | 'stealth' (informational)
 * @param {Function} [opts.onLog]           (msg) => void
 */
async function installPrivacyGuard(page, opts = {}) {
  const features = new Set(opts.privacyFeatures || []);
  const level = opts.privacyLevel || 'standard';
  const onLog = opts.onLog || (() => {});
  const context = page.context();

  // A second page on a context that is already guarded only needs its own
  // CDP overrides (init scripts and headers are context-wide).
  const existing = guardedContexts.get(context);
  if (existing) {
    await applyCdp(page, existing.plan);
    return;
  }

  // The session's real User-Agent (set by the module via newContext()).
  let realUA = '';
  try { realUA = await page.evaluate(() => navigator.userAgent); } catch (_) {}
  const stripHeadless = (u) => String(u || '').replace(/HeadlessChrome/g, 'Chrome');
  const effectiveUA = features.has('user-agent-override') ? stripHeadless(realUA) : realUA;
  const profile = uaProfile(effectiveUA);

  // ── CDP plan ──────────────────────────────────────────────────────────────
  const plan = { ua: null, tz: null, cacheOff: false };
  const wantsUaOverride = ['user-agent-override', 'platform-spoof', 'language-spoof', 'sec-ch-ua-spoof'].some((f) => features.has(f));
  if (wantsUaOverride && effectiveUA) {
    plan.ua = { userAgent: effectiveUA };
    if (features.has('language-spoof')) plan.ua.acceptLanguage = 'en-US,en';
    if (features.has('platform-spoof')) plan.ua.platform = profile.platform;
    if (features.has('sec-ch-ua-spoof')) plan.ua.userAgentMetadata = buildUserAgentMetadata(profile);
  }
  if (features.has('timezone-spoof')) plan.tz = 'America/New_York';
  if (features.has('etag-clear')) plan.cacheOff = true;

  const applied = await applyCdp(page, plan);

  // ── Context-wide request headers ──────────────────────────────────────────
  if (features.has('do-not-track')) {
    try { await context.setExtraHTTPHeaders({ DNT: '1' }); } catch (_) {}
  }

  // ── Page script (context-wide: also covers popups / new tabs) ─────────────
  const cfg = {
    features: [...features],
    seed: crypto.randomBytes(4).readUInt32LE(0),
    profile,
    effectiveUA,
    native: applied, // which overrides CDP already handled natively
  };
  guardedContexts.set(context, { cfg, plan });
  await context.addInitScript(pageGuardScript, cfg);

  // Popups / new tabs get their own CDP overrides (those are per-page).
  if (plan.ua || plan.tz || plan.cacheOff) {
    context.on('page', (p) => { applyCdp(p, plan).catch(() => {}); });
  }

  const notes = [];
  if (plan.ua && !applied.ua) notes.push('UA overrides use in-page fallback');
  if (plan.tz && !applied.tz) notes.push('timezone uses in-page fallback');
  if (plan.cacheOff && !applied.cache) notes.push('HTTP cache could not be disabled');
  onLog(`[PrivacyGuard] Applied ${features.size} privacy features (${level})` + (notes.length ? ` — ${notes.join('; ')}` : ''));
}

// ─────────────────────────────────────────────────────────────────────────────
// Page script. Runs before any site script in every frame of the context.
// Must be fully self-contained (it is serialised and sent to the browser).
// ─────────────────────────────────────────────────────────────────────────────
function pageGuardScript(cfg) {
  'use strict';
  const set = new Set(cfg.features);
  const P = cfg.profile;
  const seed = cfg.seed >>> 0;
  const native = cfg.native || {};

  // ── helpers ────────────────────────────────────────────────────────────────
  // Deterministic per-session noise: same inputs → same output, so repeated
  // reads agree (a fingerprinter sees a stable — but altered — value).
  function hash(n) {
    let h = ((n | 0) ^ seed) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  }
  function strHash(s) {
    let h = 2166136261 >>> 0;
    s = String(s);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  // Define an accessor on whichever object in the prototype chain owns it
  // (e.g. Navigator.prototype), like the real browser does.
  function def(obj, prop, getter) {
    try {
      let t = obj;
      while (t && !Object.prototype.hasOwnProperty.call(t, prop)) t = Object.getPrototypeOf(t);
      const target = t || obj;
      const old = Object.getOwnPropertyDescriptor(target, prop);
      Object.defineProperty(target, prop, { get: getter, set: undefined, enumerable: old ? old.enumerable : true, configurable: true });
      return true;
    } catch (_) { return false; }
  }
  const has = (id) => set.has(id);
  const guard = (fn) => { try { fn(); } catch (_) {} };

  // ── always on: automation marker ───────────────────────────────────────────
  guard(() => def(Navigator.prototype, 'webdriver', () => false));
  guard(() => {
    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || {};
  });

  // ══ Browser fingerprint ════════════════════════════════════════════════════

  if (has('webgl-spoof')) guard(() => {
    // Each context type needs its OWN original getParameter — sharing the
    // WebGL1 one with WebGL2 threw "Illegal invocation" on every WebGL2 call.
    for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
      const Ctor = window[name];
      if (!Ctor) continue;
      const orig = Ctor.prototype.getParameter;
      Ctor.prototype.getParameter = function (p) {
        if (p === 0x9245) return P.gpu.vendor;   // UNMASKED_VENDOR_WEBGL
        if (p === 0x9246) return P.gpu.renderer; // UNMASKED_RENDERER_WEBGL
        return orig.apply(this, arguments);
      };
    }
  });

  if (has('canvas-noise')) guard(() => {
    // Flip the lowest bit of a sparse, seed-determined subset of pixels.
    const noise = (data) => {
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        const h = hash(i >>> 2);
        if ((h & 7) === 0) data[i + ((h >>> 3) % 3)] ^= 1;
      }
    };
    const CRC = CanvasRenderingContext2D.prototype;
    const origGetImageData = CRC.getImageData;
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    const origGetContext = HTMLCanvasElement.prototype.getContext;

    CRC.getImageData = function () {
      const img = origGetImageData.apply(this, arguments);
      noise(img.data);
      return img;
    };
    // toDataURL/toBlob export a noisy COPY. Calling getContext() on the
    // original (as before) both left the export untouched and could stop a
    // fresh canvas from later getting a WebGL context.
    const noisyCopy = (canvas) => {
      try {
        const w = canvas.width, h = canvas.height;
        if (!w || !h || w * h > 4194304) return null;
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const x = origGetContext.call(c, '2d');
        x.drawImage(canvas, 0, 0);
        const img = origGetImageData.call(x, 0, 0, w, h);
        noise(img.data);
        x.putImageData(img, 0, 0);
        return c;
      } catch (_) { return null; } // tainted / unreadable → export unchanged
    };
    HTMLCanvasElement.prototype.toDataURL = function () {
      return origToDataURL.apply(noisyCopy(this) || this, arguments);
    };
    HTMLCanvasElement.prototype.toBlob = function () {
      return origToBlob.apply(noisyCopy(this) || this, arguments);
    };
  });

  if (has('audio-spoof')) guard(() => {
    // Noise each channel exactly once (the old code re-applied random noise on
    // every call, mutating the live buffer further each time).
    const done = new WeakMap();
    const addNoise = (arr, base) => {
      for (let i = 0; i < arr.length; i += 100) arr[i] += ((hash(base + i) / 4294967296) - 0.5) * 2e-7;
    };
    if (window.AudioBuffer) {
      const origGet = AudioBuffer.prototype.getChannelData;
      AudioBuffer.prototype.getChannelData = function (ch) {
        const data = origGet.apply(this, arguments);
        let chans = done.get(this);
        if (!chans) { chans = new Set(); done.set(this, chans); }
        if (!chans.has(ch)) { chans.add(ch); addNoise(data, ch * 7919); }
        return data;
      };
      const origCopy = AudioBuffer.prototype.copyFromChannel;
      AudioBuffer.prototype.copyFromChannel = function (dest, ch, start) {
        const r = origCopy.apply(this, arguments);
        const off = start | 0;
        for (let i = 0; i < dest.length; i++) if (((off + i) % 100) === 0) dest[i] += ((hash(ch * 7919 + off + i) / 4294967296) - 0.5) * 2e-7;
        return r;
      };
    }
    if (window.AnalyserNode) {
      const wrapF = (name) => {
        const o = AnalyserNode.prototype[name];
        if (!o) return;
        AnalyserNode.prototype[name] = function (arr) {
          const r = o.apply(this, arguments);
          for (let i = 0; i < arr.length; i += 8) arr[i] += ((hash(i + 31) / 4294967296) - 0.5) * 0.02;
          return r;
        };
      };
      wrapF('getFloatFrequencyData');
      wrapF('getFloatTimeDomainData');
    }
  });

  if (has('font-spoof')) guard(() => {
    // Font probes measure a hidden span with an inline font-family. Give
    // those (and only those) a stable ±1px nudge per font name, so installed-
    // font detection is scrambled but ordinary layout reads stay exact.
    const looksLikeProbe = (el) => {
      const st = el.style;
      return !!(st && st.fontFamily && (st.position === 'absolute' || st.position === 'fixed' || st.visibility === 'hidden'));
    };
    for (const [prop, salt] of [['offsetWidth', 1], ['offsetHeight', 2]]) {
      const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
      if (!d || !d.get) continue;
      Object.defineProperty(HTMLElement.prototype, prop, {
        get: function () {
          const v = d.get.call(this);
          if (!looksLikeProbe(this)) return v;
          return v + ((hash(strHash(this.style.fontFamily) + salt) % 3) - 1);
        },
        enumerable: d.enumerable, configurable: true,
      });
    }
    const origMeasure = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText = function (text) {
      const m = origMeasure.apply(this, arguments);
      const delta = (hash(strHash(this.font + '|' + text)) & 1 ? 1 : -1) * 0.02;
      return new Proxy(m, {
        get(t, p) {
          if (p === 'width') return t.width + delta;
          const v = Reflect.get(t, p, t);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
    };
  });

  if (has('hardware-spoof')) guard(() => def(Navigator.prototype, 'hardwareConcurrency', () => 8));
  if (has('device-memory-spoof')) guard(() => def(Navigator.prototype, 'deviceMemory', () => 8));

  if (has('screen-spoof')) guard(() => {
    def(Screen.prototype, 'colorDepth', () => 24);
    def(Screen.prototype, 'pixelDepth', () => 24);
    // A real desktop monitor is larger than its browser window; headless
    // screens equal the window, which reads as automation. Phones keep their
    // own (already correct) emulated screen.
    if (!P.touch) {
      const w = Math.max(1920, window.outerWidth || 0, window.innerWidth || 0);
      const h = Math.max(1080, window.outerHeight || 0, window.innerHeight || 0);
      def(Screen.prototype, 'width', () => w);
      def(Screen.prototype, 'height', () => h);
      def(Screen.prototype, 'availWidth', () => w);
      def(Screen.prototype, 'availHeight', () => h - 40); // taskbar
    }
  });

  if (has('timezone-spoof') && !native.tz) guard(() => {
    // Fallback only — normally the browser's native timezone override is used.
    const TZ = 'America/New_York';
    const OrigDTF = Intl.DateTimeFormat;
    const probe = new OrigDTF('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    const offsetMin = (ms) => {
      const p = {};
      probe.formatToParts(ms).forEach((x) => { p[x.type] = parseInt(x.value, 10); });
      return Math.round((Math.floor(ms / 1000) * 1000 - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)) / 60000);
    };
    Date.prototype.getTimezoneOffset = function () {
      const t = this.getTime();
      return isNaN(t) ? NaN : offsetMin(t); // DST-aware (EST 300 / EDT 240)
    };
    const withTZ = (args) => {
      const a = Array.prototype.slice.call(args);
      const o = Object.assign({}, a[1] && typeof a[1] === 'object' ? a[1] : {}); // never mutate the caller's options
      if (!o.timeZone) o.timeZone = TZ;
      a[1] = o;
      return a;
    };
    Intl.DateTimeFormat = new Proxy(OrigDTF, {
      construct(t, args, nt) { return Reflect.construct(t, withTZ(args), nt); },
      apply(t, thisArg, args) { return t.apply(thisArg, withTZ(args)); },
    });
    for (const m of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
      const o = Date.prototype[m];
      Date.prototype[m] = function (l, opt) { return o.call(this, l, Object.assign({ timeZone: TZ }, opt)); };
    }
  });

  if (has('language-spoof')) guard(() => {
    // Same values the native override sets, but ONE frozen array, so
    // navigator.languages === navigator.languages (the native override
    // returns a fresh array per read, which stock Chrome never does). Also
    // makes popups correct before their own native override lands.
    const langs = Object.freeze(['en-US', 'en']);
    def(Navigator.prototype, 'languages', () => langs);
    def(Navigator.prototype, 'language', () => 'en-US');
  });

  if (has('platform-spoof')) guard(() => def(Navigator.prototype, 'platform', () => P.platform));

  if (has('client-rects')) guard(() => {
    const jitter = (x, y, w, h) => (((hash(Math.round(x * 64) * 31 + Math.round(y * 64) * 17 + Math.round(w * 64) * 13 + Math.round(h * 64)) % 1001) / 1000) - 0.5) * 0.1;
    const spoofRect = (r) => { const j = jitter(r.x, r.y, r.width, r.height); return new DOMRect(r.x + j, r.y + j, r.width, r.height); };
    const origRects = Element.prototype.getClientRects;
    const origBox = Element.prototype.getBoundingClientRect;
    Element.prototype.getClientRects = function () {
      const out = Array.prototype.map.call(origRects.apply(this, arguments), spoofRect);
      Object.defineProperty(out, 'item', { value: (i) => out[i] || null });
      return out;
    };
    Element.prototype.getBoundingClientRect = function () { return spoofRect(origBox.apply(this, arguments)); };
  });

  if (has('speech-spoof')) guard(() => {
    if (!window.speechSynthesis || !window.SpeechSynthesis) return;
    const orig = SpeechSynthesis.prototype.getVoices;
    SpeechSynthesis.prototype.getVoices = function () { return Array.prototype.slice.call(orig.apply(this, arguments), 0, 4); };
  });

  if (has('media-spoof')) guard(() => {
    if (!window.MediaDevices) return;
    const orig = MediaDevices.prototype.enumerateDevices;
    MediaDevices.prototype.enumerateDevices = function () {
      return orig.apply(this, arguments).then((d) => d.slice(0, 3));
    };
  });

  if (has('plugin-spoof') || has('mimetype-spoof')) guard(() => {
    // Built once, so navigator.plugins === navigator.plugins (the old getter
    // returned a fresh array every read).
    const names = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'];
    const mimes = [
      { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    ];
    const plugins = names.map((name) => {
      const pl = { name, filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: mimes.length };
      mimes.forEach((m, i) => { pl[i] = m; });
      return pl;
    });
    const mimeTypes = mimes.map((m) => Object.assign({}, m, { enabledPlugin: plugins[0] }));
    const finish = (arr, key) => {
      Object.defineProperty(arr, 'item', { value: (i) => arr[i] || null });
      Object.defineProperty(arr, 'namedItem', { value: (n) => arr.find((x) => x[key] === n) || null });
      return arr;
    };
    if (has('plugin-spoof')) {
      finish(plugins, 'name');
      Object.defineProperty(plugins, 'refresh', { value: () => {} });
      def(Navigator.prototype, 'plugins', () => plugins);
    }
    if (has('mimetype-spoof')) {
      finish(mimeTypes, 'type');
      def(Navigator.prototype, 'mimeTypes', () => mimeTypes);
    }
  });

  if (has('user-agent-override')) guard(() => {
    // The HTTP header is set natively (CDP); this keeps JS in step for popups
    // whose native override has not landed yet, and is the full fallback.
    def(Navigator.prototype, 'userAgent', () => cfg.effectiveUA);
    def(Navigator.prototype, 'appVersion', () => cfg.effectiveUA.replace(/^Mozilla\//, ''));
  });

  if (has('sec-ch-ua-spoof')) guard(() => {
    // Safari / Firefox have no navigator.userAgentData at all.
    if (P.family !== 'chrome') { delete Navigator.prototype.userAgentData; return; }
    const nat = navigator.userAgentData;
    if (nat && typeof nat.getHighEntropyValues === 'function' && nat.brands && nat.brands.some((b) => b.brand === P.brand) && nat.mobile === P.mobile) return; // native hints already correct
    const full = P.major + '.0.0.0';
    const names = ['Chromium', P.brand, 'Not-A.Brand'];
    const brands = names.map((b, i) => ({ brand: b, version: i === 2 ? '99' : P.major }));
    const platName = { windows: 'Windows', mac: 'macOS', android: 'Android', linux: 'Linux', ios: 'iOS' }[P.os] || 'Windows';
    const platVer = { windows: '10.0.0', mac: '10.15.7', android: P.androidVer + '.0.0', linux: '6.5.0', ios: '17.4.0' }[P.os] || '10.0.0';
    const mobileOs = P.os === 'android' || P.os === 'ios';
    const high = { brands, fullVersionList: names.map((b, i) => ({ brand: b, version: i === 2 ? '99.0.0.0' : full })), mobile: P.mobile, model: P.os === 'android' ? P.model : '', platform: platName, platformVersion: platVer, architecture: mobileOs ? '' : 'x86', bitness: mobileOs ? '' : '64', uaFullVersion: full, wow64: false };
    const uad = {
      brands, mobile: P.mobile, platform: platName,
      getHighEntropyValues(hints) {
        const out = { brands, mobile: P.mobile, platform: platName };
        (hints || []).forEach((h) => { if (h in high) out[h] = high[h]; });
        return Promise.resolve(out);
      },
      toJSON() { return { brands, mobile: P.mobile, platform: platName }; },
    };
    def(Navigator.prototype, 'userAgentData', () => uad);
  });

  if (has('navigator-override')) guard(() => {
    // Values follow the session's User-Agent family (Chrome / Safari / Firefox).
    def(Navigator.prototype, 'vendor', () => P.vendor);
    def(Navigator.prototype, 'appName', () => 'Netscape');
    def(Navigator.prototype, 'appCodeName', () => 'Mozilla');
    def(Navigator.prototype, 'product', () => 'Gecko');
    def(Navigator.prototype, 'productSub', () => P.productSub);
    def(Navigator.prototype, 'cookieEnabled', () => true);
    def(Navigator.prototype, 'onLine', () => true);
    // Phones/tablets keep their emulated touch points; desktops have none.
    if (!P.touch) def(Navigator.prototype, 'maxTouchPoints', () => 0);
    // (Do-Not-Track is its own feature — it is no longer switched on here.)
  });

  if (has('window-properties')) guard(() => {
    // Headless windows have outer size == inner size, which real browsers
    // never do (they add the window frame / toolbar). Reading innerWidth must
    // keep returning the real value — the old override called itself and
    // threw "Maximum call stack size exceeded" on every read.
    if (P.touch) return; // mobile emulation: no browser chrome to account for
    const iw = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const ih = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    if (iw && iw.get && ih && ih.get) {
      def(window, 'outerWidth', () => iw.get.call(window) + 16);
      def(window, 'outerHeight', () => ih.get.call(window) + 88);
    }
    def(window, 'devicePixelRatio', () => 1);
  });

  if (has('iframe-sandbox')) guard(() => {
    const d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    if (!d || !d.get) return;
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      get: function () {
        const cw = d.get.call(this);
        if (cw) { try { Object.defineProperty(cw.navigator, 'webdriver', { get: () => false, configurable: true }); } catch (_) {} } // cross-origin → throws, ignore
        return cw;
      },
      enumerable: d.enumerable, configurable: true,
    });
  });

  // ══ Network privacy ════════════════════════════════════════════════════════

  if (has('webrtc-leak')) guard(() => {
    // Relay-only ICE: no host / server-reflexive candidates → no local or
    // public IP leak. A Proxy keeps statics (generateCertificate), instanceof
    // and subclassing intact, and never mutates the caller's config.
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
      const Orig = window[name];
      if (typeof Orig !== 'function') continue;
      window[name] = new Proxy(Orig, {
        construct(target, args, newTarget) {
          const base = args[0] && typeof args[0] === 'object' ? args[0] : {};
          return Reflect.construct(target, [Object.assign({}, base, { iceTransportPolicy: 'relay' })].concat(Array.prototype.slice.call(args, 1)), newTarget);
        },
      });
    }
  });

  if (has('dns-prefetch')) guard(() => {
    // Observe the document from the very start (the old code waited for
    // DOMContentLoaded, by which time <head> hints had already fired) and
    // match multi-token rel values like "dns-prefetch preconnect".
    const HINTS = ['dns-prefetch', 'prefetch', 'preconnect', 'prerender'];
    const isHint = (n) => !!(n && n.nodeType === 1 && n.localName === 'link' && n.relList && HINTS.some((t) => n.relList.contains(t)));
    const strip = (root) => { if (root.querySelectorAll) root.querySelectorAll('link').forEach((l) => { if (isHint(l)) l.remove(); }); };
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes') { if (isHint(m.target)) m.target.remove(); continue; }
        m.addedNodes.forEach((n) => { if (isHint(n)) n.remove(); else if (n.nodeType === 1) strip(n); });
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['rel'] });
    strip(document);
  });

  if (has('hyperlink-audit')) guard(() => {
    const hasPing = (n) => n && n.nodeType === 1 && (n.localName === 'a' || n.localName === 'area') && n.hasAttribute('ping');
    const clean = (root) => { if (root.querySelectorAll) root.querySelectorAll('a[ping],area[ping]').forEach((a) => a.removeAttribute('ping')); };
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes') { if (hasPing(m.target)) m.target.removeAttribute('ping'); continue; }
        m.addedNodes.forEach((n) => { if (hasPing(n)) n.removeAttribute('ping'); else if (n.nodeType === 1) clean(n); });
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['ping'] });
    // Belt and braces: the ping is sent on click, so strip it right before.
    document.addEventListener('click', (e) => {
      const a = e.target && e.target.closest && e.target.closest('a[ping],area[ping]');
      if (a) a.removeAttribute('ping');
    }, true);
    const origSet = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name) {
      if (String(name).toLowerCase() === 'ping' && (this.localName === 'a' || this.localName === 'area')) return;
      return origSet.apply(this, arguments);
    };
  });

  if (has('do-not-track')) guard(() => {
    // The "DNT: 1" request header is added by the Node side (context headers).
    def(Navigator.prototype, 'doNotTrack', () => '1');
  });

  if (has('referer-control')) guard(() => {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      // Copy — the old code wrote into the caller's init object.
      return origFetch.call(this, input, Object.assign({}, init, { referrer: '' }));
    };
  });

  if (has('cookie-sanitize')) guard(() => {
    const TRACK = ['_ga', '_gid', '_gat', '_fbp', '_fbc', '_gcl_au', 'fr', 'trc', 'IDE'];
    const isTracking = (name) => TRACK.indexOf(name) !== -1 || /^_ga_/.test(name) || /^_gat_/.test(name);
    const d = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (!d || !d.get || !d.set) return;
    // 1. Clear tracking cookies already present for this site / parent domains.
    try {
      const parts = location.hostname ? location.hostname.split('.') : [];
      const domains = [null];
      for (let i = 0; i < parts.length - 1; i++) domains.push(parts.slice(i).join('.'));
      const names = TRACK.slice();
      d.get.call(document).split(';').forEach((c) => { const n = c.split('=')[0].trim(); if (n && isTracking(n)) names.push(n); });
      names.forEach((n) => domains.forEach((dom) => {
        d.set.call(document, n + '=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/' + (dom ? '; domain=' + dom : ''));
      }));
    } catch (_) {}
    // 2. Refuse to (re)create them — analytics scripts would otherwise just
    //    write them back a moment later.
    Object.defineProperty(Document.prototype, 'cookie', {
      get: d.get,
      set: function (v) {
        const name = String(v).split('=')[0].trim();
        if (isTracking(name)) return;
        return d.set.call(this, v);
      },
      enumerable: d.enumerable, configurable: true,
    });
  });

  if (has('etag-clear')) guard(() => {
    // The HTTP cache (where ETags live) is disabled natively via CDP. Also
    // empty Cache Storage, which can carry the same kind of identifier.
    if (window.caches && caches.keys) caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
  });

  // ══ Sensor / device APIs ═══════════════════════════════════════════════════

  if (has('battery-spoof')) guard(() => {
    if (!Navigator.prototype.getBattery) return;
    Navigator.prototype.getBattery = function () {
      const b = new EventTarget();
      Object.assign(b, { charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1 });
      return Promise.resolve(b);
    };
  });

  if (has('sensor-spoof')) guard(() => {
    if (!window.DeviceOrientationEvent) return;
    const SENSOR = ['deviceorientation', 'deviceorientationabsolute', 'devicemotion', 'deviceproximity'];
    const base = { a: (hash(1) % 36000) / 100, b: (hash(2) % 1800) / 100 - 9, g: (hash(3) % 1800) / 100 - 9 };
    const jit = () => (Math.random() - 0.5) * 0.2;
    const spoof = (e, type) => {
      try {
        if (type === 'devicemotion') {
          Object.defineProperty(e, 'accelerationIncludingGravity', { get: () => ({ x: base.b / 10 + jit() / 10, y: base.g / 10 + jit() / 10, z: 9.8 + jit() / 10 }) });
          Object.defineProperty(e, 'rotationRate', { get: () => ({ alpha: jit(), beta: jit(), gamma: jit() }) });
        } else if (type !== 'deviceproximity') {
          Object.defineProperty(e, 'alpha', { get: () => base.a + jit() });
          Object.defineProperty(e, 'beta', { get: () => base.b + jit() });
          Object.defineProperty(e, 'gamma', { get: () => base.g + jit() });
        }
      } catch (_) {}
    };
    // One wrapper per (listener, event type, capture flag) so that
    // removeEventListener can find it again — previously listeners could
    // never be removed, and listener objects with handleEvent() crashed.
    const wrappers = new WeakMap();
    const keyOf = (type, opts) => type + ((opts === true || (opts && opts.capture)) ? ':c' : ':b');
    const callable = (l) => l && (typeof l === 'function' || typeof l.handleEvent === 'function');
    const origAdd = EventTarget.prototype.addEventListener;
    const origRemove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (SENSOR.indexOf(type) !== -1 && callable(listener)) {
        let byKey = wrappers.get(listener);
        if (!byKey) { byKey = Object.create(null); wrappers.set(listener, byKey); }
        const key = keyOf(type, options);
        const w = byKey[key] || (byKey[key] = function (e) {
          spoof(e, type);
          return typeof listener === 'function' ? listener.call(this, e) : listener.handleEvent(e);
        });
        return origAdd.call(this, type, w, options);
      }
      return origAdd.apply(this, arguments);
    };
    EventTarget.prototype.removeEventListener = function (type, listener, options) {
      if (SENSOR.indexOf(type) !== -1 && callable(listener)) {
        const byKey = wrappers.get(listener);
        const w = byKey && byKey[keyOf(type, options)];
        if (w) return origRemove.call(this, type, w, options);
      }
      return origRemove.apply(this, arguments);
    };
  });

  if (has('gamepad-spoof')) guard(() => {
    if (Navigator.prototype.getGamepads) Navigator.prototype.getGamepads = function () { return [null, null, null, null]; };
  });

  // Hardware access APIs: no devices, and the chooser "was dismissed" — the
  // same NotFoundError a real browser raises when the user cancels.
  const noDevice = (msg) => () => Promise.reject(new DOMException(msg, 'NotFoundError'));
  if (has('bluetooth-spoof')) guard(() => {
    if (!window.Bluetooth) return;
    Bluetooth.prototype.getAvailability = () => Promise.resolve(false);
    Bluetooth.prototype.getDevices = () => Promise.resolve([]);
    Bluetooth.prototype.requestDevice = noDevice('User cancelled the requestDevice() chooser.');
  });
  if (has('usb-spoof')) guard(() => {
    if (!window.USB) return;
    USB.prototype.getDevices = () => Promise.resolve([]);
    USB.prototype.requestDevice = noDevice('No device selected.');
  });
  if (has('serial-spoof')) guard(() => {
    if (!window.Serial) return;
    Serial.prototype.getPorts = () => Promise.resolve([]);
    Serial.prototype.requestPort = noDevice('No port selected by the user.');
  });
  if (has('hid-spoof')) guard(() => {
    if (!window.HID) return;
    HID.prototype.getDevices = () => Promise.resolve([]);
    HID.prototype.requestDevice = noDevice('No device selected.');
  });
}

module.exports = { installPrivacyGuard, uaProfile, buildUserAgentMetadata };
