// api-client.js — shared helpers for talking to the local backend.
//
// The backend requires the per-launch API token (handed to this page by
// preload.js) on every request. Use apiFetch() instead of fetch() and
// apiEventSource() instead of new EventSource() for anything under /api.
//
// escapeHtml() is used wherever server- or website-supplied text is inserted
// into the page as HTML (logs, error messages, names).

(function () {
  'use strict';

  const API_BASE = 'http://localhost:3000';
  const token = (window.trafficdrive && window.trafficdrive.apiToken) || '';

  function toApiUrl(url) {
    // Relative /api paths would resolve against file:// — always go to the backend.
    return typeof url === 'string' && url.startsWith('/api/') ? API_BASE + url : url;
  }

  function apiFetch(url, opts) {
    const options = Object.assign({}, opts || {});
    const headers = new Headers(options.headers || {});
    if (token) headers.set('X-TD-Token', token);
    options.headers = headers;
    return fetch(toApiUrl(url), options);
  }

  // EventSource cannot send headers, so the token goes in the query string.
  function apiEventSource(url) {
    const full = toApiUrl(url);
    const sep = full.includes('?') ? '&' : '?';
    return new EventSource(full + sep + 'token=' + encodeURIComponent(token));
  }

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  window.API_BASE = API_BASE;
  window.apiFetch = apiFetch;
  window.apiEventSource = apiEventSource;
  window.escapeHtml = escapeHtml;
})();
