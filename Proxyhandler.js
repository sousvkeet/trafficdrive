// Proxyhandler.js
// Builds Playwright-compatible proxy configuration from proxy records.
//
// A proxy record looks like:
//   { type, host, port, username, password, raw }
//
// buildSessionProxy() injects a unique -session-<id> suffix into the username
// for rotating/residential proxies (ProxyOmega, Bright Data, etc.) so each
// thread gets its own exit IP. Plain IP:port proxies (no username) are
// returned unchanged.
//
// buildPlaywrightProxyOpts() turns a session proxy into the { proxy: {...} }
// object Playwright's newContext() expects.

class ProxyHandler {
  buildSessionProxy(proxy, sessionId) {
    if (!proxy) return null;
    const sessionProxy = { ...proxy };
    if (sessionProxy.username && typeof sessionId === 'string' && sessionId) {
      // Only inject the session suffix for proxies that look like rotating
      // residential/datacenter pools (they typically use a username with a
      // bracketed session token already, e.g. user-session-XYZ).
      const base = sessionProxy.username;
      // Avoid double-injecting if a -session- token is already present.
      if (!/-session-/i.test(base)) {
        sessionProxy.username = `${base}-session-${sessionId}`;
      }
    }
    return sessionProxy;
  }

  buildPlaywrightProxyOpts(proxy) {
    if (!proxy || !proxy.host || !proxy.port) return {};
    const scheme = (proxy.type || 'http').toLowerCase();
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
