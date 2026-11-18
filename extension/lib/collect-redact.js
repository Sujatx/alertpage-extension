/*
 * Redaction for the collector (event-schema-v1 section 8). Pure: allow-list form fields,
 * scrub forbidden keys, strip URL queries, keep a payload under the 32 KB cap.
 */
(function (root) {
  'use strict';

  var C = root.APA && root.APA.collectorConfig;
  if (!C && typeof require === 'function') { C = require('../config/collector-settings.js'); }
  var CANON = root.APA && root.APA.canon;
  if (!CANON && typeof require === 'function') { CANON = require('./collect-canon.js'); }

  // Section 8.1. Real form names (the schema's "address"/"zip" are address1/zip_code).
  var FORM_FIELDS = ['working_queue_id', 'lead_id', 'formatted_address', 'address1', 'latitude', 'longitude',
    'address2', 'city', 'county', 'countyid', 'state', 'zip_code', 'jurisdiction', 'incident_notes',
    'internal_notes', 'event_type', 'incident_types', 'sub_incident_type', 'logout', 'send_technical'];
  // Section 3.5 field_changed: fields that are submitted anyway.
  var CHANGE_FIELDS = ['internal_notes', 'incident_notes', 'jurisdiction', 'address1', 'city', 'county',
    'state', 'zip_code', 'incident_types', 'sub_incident_type'];

  function pickAllowed(map) {
    var out = {};
    if (!map) { return out; }
    FORM_FIELDS.forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(map, k)) { out[k] = map[k]; }
    });
    return out;
  }

  /** Deep copy without any key matching FORBIDDEN_KEY_RE. */
  function scrub(v, depth) {
    depth = depth || 0;
    if (v === null || typeof v !== 'object' || depth > 8) { return v; }
    if (Array.isArray(v)) { return v.map(function (x) { return scrub(x, depth + 1); }); }
    var out = {};
    Object.keys(v).forEach(function (k) {
      if (!C.FORBIDDEN_KEY_RE.test(k)) { out[k] = scrub(v[k], depth + 1); }
    });
    return out;
  }

  function stripQuery(url) { return String(url == null ? '' : url).split(/[?#]/)[0]; }

  /** Cut to at most maxBytes of UTF-8 without leaving half a surrogate pair. */
  function truncate(text, maxBytes) {
    text = String(text);
    if (CANON.byteLength(text) <= maxBytes) { return text; }
    var lo = 0, hi = text.length;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (CANON.byteLength(text.slice(0, mid)) <= maxBytes) { lo = mid; } else { hi = mid - 1; }
    }
    var cut = text.slice(0, lo);
    var last = cut.charCodeAt(cut.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
  }

  /** Scrubbed copy of payload, longest strings shortened until JSON <= maxBytes. */
  function fitPayload(payload, maxBytes) {
    maxBytes = maxBytes || C.MAX_PAYLOAD_BYTES;
    var out = scrub(payload);
    for (var i = 0; i < 60; i++) {
      var excess = CANON.byteLength(JSON.stringify(out)) - maxBytes;
      if (excess <= 0) { break; }
      var best = null;
      (function walk(o) {
        Object.keys(o).forEach(function (k) {
          var x = o[k];
          if (typeof x === 'string') {
            if (!best || x.length > best.o[best.k].length) { best = { o: o, k: k }; }
          } else if (x && typeof x === 'object') { walk(x); }
        });
      })(out);
      if (!best) { break; }
      var s = best.o[best.k];
      // Removing `excess` chars removes at least `excess` bytes, so this converges.
      best.o[best.k] = truncate(s.slice(0, Math.max(0, s.length - excess)), maxBytes);
    }
    return out;
  }

  /**
   * Section 7. st: { ext: {value, at}|null, trusted: {at}|null }. `at` values are comparable
   * (performance.now()). initial is the value the page rendered.
   */
  function provenance(st, current, initial) {
    st = st || {};
    var after = st.ext && st.trusted && st.trusted.at >= st.ext.at;
    if (st.ext) {
      if (after) { return 'extension_then_dispatcher'; }
      return current === st.ext.value ? 'extension' : 'page_script';
    }
    if (st.trusted) { return 'dispatcher'; }
    if (initial === undefined) { return 'unknown'; }
    return current === initial ? 'page_initial' : 'page_script';
  }

  var api = {
    FORM_FIELDS: FORM_FIELDS, CHANGE_FIELDS: CHANGE_FIELDS,
    pickAllowed: pickAllowed, scrub: scrub, stripQuery: stripQuery, truncate: truncate,
    fitPayload: fitPayload, provenance: provenance
  };

  root.APA = root.APA || {};
  root.APA.redact = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : self);
