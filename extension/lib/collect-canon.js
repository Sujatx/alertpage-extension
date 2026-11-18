/*
 * Canonical JSON and SHA-256, shared by the extension and the Worker (server/ imports this
 * file), so a snapshot or chat hash computed on the laptop matches the one the Worker checks.
 * Canonical = object keys sorted at every depth, arrays in order, undefined dropped.
 */
(function (root) {
  'use strict';

  function canonical(v) {
    if (v === null || typeof v !== 'object') { return JSON.stringify(v); }
    if (Array.isArray(v)) {
      return '[' + v.map(function (x) { return x === undefined ? 'null' : canonical(x); }).join(',') + ']';
    }
    var keys = Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + canonical(v[k]); }).join(',') + '}';
  }

  function sha256Hex(text) {
    var bytes = new TextEncoder().encode(text);
    return root.crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return b.toString(16).padStart(2, '0');
      }).join('');
    });
  }

  function byteLength(text) { return new TextEncoder().encode(text).length; }

  var api = { canonical: canonical, sha256Hex: sha256Hex, byteLength: byteLength };

  root.APA = root.APA || {};
  root.APA.canon = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : self);
