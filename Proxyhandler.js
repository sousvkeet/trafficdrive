// Proxyhandler.js
// Turns a proxy record into what Playwright's browser.newContext() expects, and says whether the browser can use it.
//
// A proxy record looks like:
//   { type, host, port, username, password, raw }
//
// Rules — each one fixes a way a proxy used to pass the checker and then fail inside a campaign:
//  - The login is used exactly as given. (It used to get "-session-t1", "-session-t2"… appended for every proxy with a
//    user name, so ordinary user:pass proxies were refused by their own server.) A per-session value is only put in
//    where it is asked for: a "{session}" placeholder in the user name, or Bright Data's documented
//    "brd-customer-…-zone-…" form, which takes "-session-<id>".
//  - A proxy listed as "https" is an ordinary proxy that can tunnel HTTPS (that is what proxy lists mean by it), so
//    Chrome is given http://host:port. Telling Chrome https://host:port makes it speak TLS to a plain proxy and fail.
//  - Chrome cannot use SOCKS proxies that need a user name and password; browserSupport() says so, so the checker
//    can reject them instead of reporting them as working.

const BRIGHT_DATA = /^brd-customer-[^:]*-zone-/i;

class ProxyHandler {
  buildSessionProxy(proxy, sessionId) {
    if (!proxy) return null;
    const sessionProxy = { ...proxy };
    const user = sessionProxy.username;
    if (user && typeof sessionId === 'string' && sessionId) {
      if (user.includes('{session}')) sessionProxy.username = user.split('{session}').join(sessionId);
      else if (BRIGHT_DATA.test(user) && !/-session-/i.test(user)) sessionProxy.username = `${user}-session-${sessionId}`;
    }
    return sessionProxy;
  }

  // { ok: true } or { ok: false, reason } — what the campaign browser (Chromium) can do with this proxy.
  browserSupport(proxy) {
    const type = String((proxy && proxy.type) || 'http').toLowerCase();
    if ((type === 'socks5' || type === 'socks4') && proxy.username) return { ok: false, reason: 'socks-login' };
    return { ok: true };
  }

  buildPlaywrightProxyOpts(proxy) {
    if (!proxy || !proxy.host || !proxy.port) return {};
    let scheme = (proxy.type || 'http').toLowerCase();
    if (scheme === 'https') scheme = 'http';          // see the top of the file
    const server = `${scheme}://${proxy.host}:${proxy.port}`;
    const opts = {
      proxy: { server },
    };
    if (proxy.username) {
      opts.proxy.username = proxy.username;
      if (proxy.password) opts.proxy.password = proxy.password;
    }
    return opts;
  }
}

module.exports = ProxyHandler;
