// PrivacyCatalog.js — the single source of truth for the 34 privacy features.
//
// Loaded three ways (UMD):
//   - dashboard (index.html):  <script src="PrivacyCatalog.js"> → window.PrivacyCatalog
//   - backend / MCP server:    require('./PrivacyCatalog.js')
// The feature IDs are implemented in PrivacyGuard.js (one handler per ID).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PrivacyCatalog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const F = (id, name, cat, description) => ({ id, name, cat, description });

  const FEATURES = [
    F('webgl-spoof', 'WebGL Fingerprint Spoofing', 'Browser Fingerprint', 'Reports a GPU vendor/renderer that matches the session User-Agent instead of the real graphics card.'),
    F('canvas-noise', 'Canvas Fingerprint Noise', 'Browser Fingerprint', 'Adds stable, invisible noise to canvas pixel reads and exports so the canvas fingerprint differs from the real one.'),
    F('audio-spoof', 'Audio Context Spoofing', 'Browser Fingerprint', 'Adds tiny stable noise to Web Audio output used for audio fingerprinting.'),
    F('font-spoof', 'Font Fingerprint Spoofing', 'Browser Fingerprint', 'Nudges text-measurement probes so installed-font detection returns scrambled results.'),
    F('hardware-spoof', 'Hardware Concurrency Spoofing', 'Browser Fingerprint', 'Reports 8 CPU cores.'),
    F('device-memory-spoof', 'Device Memory Spoofing', 'Browser Fingerprint', 'Reports 8 GB of device memory.'),
    F('screen-spoof', 'Screen Resolution Spoofing', 'Browser Fingerprint', 'Reports a 24-bit, desktop-sized screen (1920x1080 or larger) that is bigger than the browser window; phones keep their own screen.'),
    F('timezone-spoof', 'Timezone Spoofing', 'Browser Fingerprint', 'Sets the browser timezone to America/New_York (daylight saving honoured) for Date and Intl.'),
    F('language-spoof', 'Language Spoofing', 'Browser Fingerprint', 'Sets navigator.language(s) and the Accept-Language header to en-US.'),
    F('platform-spoof', 'Platform Spoofing', 'Browser Fingerprint', 'Makes navigator.platform match the session User-Agent (Win32, MacIntel, iPhone, Linux armv8l...).'),
    F('webrtc-leak', 'WebRTC IP Leak Protection', 'Network Privacy', 'Forces relay-only ICE so WebRTC cannot reveal local or public IPs. Peer-to-peer calls need a TURN server.'),
    F('dns-prefetch', 'Disable DNS Prefetching', 'Network Privacy', 'Removes dns-prefetch / prefetch / preconnect hints from pages as they load.'),
    F('hyperlink-audit', 'Disable Hyperlink Auditing', 'Network Privacy', 'Strips the ping attribute from links so clicks send no tracking pings.'),
    F('battery-spoof', 'Battery API Spoofing', 'Sensor Privacy', 'Reports a full, charging battery.'),
    F('sensor-spoof', 'Sensor API Spoofing', 'Sensor Privacy', 'Replaces device orientation / motion readings with plausible stable values.'),
    F('gamepad-spoof', 'Gamepad API Spoofing', 'Sensor Privacy', 'Reports no connected gamepads.'),
    F('bluetooth-spoof', 'Bluetooth API Spoofing', 'Sensor Privacy', 'Reports Bluetooth unavailable / no devices.'),
    F('usb-spoof', 'USB API Spoofing', 'Sensor Privacy', 'Reports no WebUSB devices.'),
    F('serial-spoof', 'Serial API Spoofing', 'Sensor Privacy', 'Reports no serial ports.'),
    F('hid-spoof', 'HID API Spoofing', 'Sensor Privacy', 'Reports no HID devices.'),
    F('client-rects', 'Client Rects Spoofing', 'Browser Fingerprint', 'Adds sub-pixel stable noise to getClientRects / getBoundingClientRect.'),
    F('speech-spoof', 'Speech Synthesis Spoofing', 'Browser Fingerprint', 'Limits the speech-synthesis voice list to four voices.'),
    F('media-spoof', 'Media Devices Spoofing', 'Browser Fingerprint', 'Limits enumerateDevices() to three devices.'),
    F('plugin-spoof', 'Plugin List Spoofing', 'Browser Fingerprint', 'Presents the standard built-in PDF viewer plugin list.'),
    F('mimetype-spoof', 'MIME Type Spoofing', 'Browser Fingerprint', 'Presents the standard PDF MIME type list.'),
    F('do-not-track', 'Do Not Track Header', 'Network Privacy', 'Sends the DNT: 1 request header and sets navigator.doNotTrack to "1".'),
    F('referer-control', 'Referer Header Control', 'Network Privacy', 'Sends no Referer on fetch() requests. Normal page navigations are untouched, so Referral mode keeps working.'),
    F('cookie-sanitize', 'Cookie Sanitization', 'Network Privacy', 'Clears and blocks common tracking cookies (_ga, _gid, _fbp, fr, IDE, ...) written by scripts.'),
    F('etag-clear', 'ETag Cache Clearing', 'Network Privacy', 'Disables the HTTP cache so ETag / If-None-Match cannot re-identify the browser, and empties Cache Storage.'),
    F('user-agent-override', 'User-Agent Override', 'Browser Fingerprint', 'Removes the "HeadlessChrome" marker from the User-Agent (header and JavaScript) while keeping the chosen device/UA.'),
    F('sec-ch-ua-spoof', 'Sec-CH-UA Client Hints Spoofing', 'Browser Fingerprint', 'Makes Sec-CH-UA headers and navigator.userAgentData match the session User-Agent.'),
    F('navigator-override', 'Navigator Properties Override', 'Browser Fingerprint', 'Normalises vendor / appName / product / productSub / cookieEnabled for the session User-Agent family.'),
    F('window-properties', 'Window Properties Spoofing', 'Browser Fingerprint', 'Gives the window a realistic frame (outer size larger than inner size) and devicePixelRatio 1 on desktop.'),
    F('iframe-sandbox', 'iframe Sandbox Enforcement', 'Browser Fingerprint', 'Keeps navigator.webdriver false inside iframes, even when read synchronously.'),
  ];

  const ALL_IDS = FEATURES.map((f) => f.id);

  // Named profiles. 'stealth' = everything; 'balanced' = the core fingerprint
  // and header protections without the heavier sensor/API stubs.
  const PROFILES = {
    none: [],
    balanced: ['webgl-spoof', 'canvas-noise', 'audio-spoof', 'font-spoof', 'hardware-spoof', 'device-memory-spoof', 'timezone-spoof', 'language-spoof', 'platform-spoof', 'webrtc-leak', 'do-not-track', 'referer-control', 'client-rects', 'user-agent-override', 'sec-ch-ua-spoof', 'navigator-override', 'battery-spoof'],
    stealth: ALL_IDS.slice(),
  };

  // Same thresholds the dashboard's shield level uses.
  function levelFor(count) {
    const total = FEATURES.length;
    if (count >= total * 0.7) return 'stealth';
    if (count >= total * 0.4) return 'balanced';
    return 'standard';
  }

  // Resolve a request into a clean, de-duplicated feature list.
  //   { privacyFeatures?: string[], privacyProfile?: 'none'|'balanced'|'stealth' }
  // Explicit feature IDs win over a profile; unknown IDs are reported, not used.
  function resolve(input) {
    const known = new Set(ALL_IDS);
    const src = input || {};
    let ids = [];
    if (Array.isArray(src.privacyFeatures) && src.privacyFeatures.length) ids = src.privacyFeatures;
    else if (src.privacyProfile && PROFILES[src.privacyProfile]) ids = PROFILES[src.privacyProfile];
    const features = [];
    const unknown = [];
    ids.forEach((id) => {
      if (known.has(id)) { if (features.indexOf(id) === -1) features.push(id); } else unknown.push(id);
    });
    return { features, unknown, level: levelFor(features.length) };
  }

  return { FEATURES, ALL_IDS, PROFILES, levelFor, resolve };
});
