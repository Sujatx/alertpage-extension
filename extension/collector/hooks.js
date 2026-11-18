/*
 * Tiny leaf loaded BEFORE content/working-screen.js. The extension's three write points call
 * APA.collector.ext(...) / autosend(...); this records the latest extension-written value per
 * field (provenance) and forwards to the observer once it registers. Never throws, and when
 * the collector is off (observer calls off()) every call is a no-op.
 */
(function (root) {
  'use strict';

  var latest = {}, buffer = [], sink = null, dead = false;

  function emit(msg) {
    try {
      if (dead) { return; }
      if (sink) { sink(msg); } else if (buffer.length < 100) { buffer.push(msg); }
    } catch (err) { /* a collector fault must never reach the page feature */ }
  }

  root.APA = root.APA || {};
  root.APA.collector = {
    ext: function (feature, field, value) {
      if (dead) { return; }
      var v = String(value == null ? '' : value);
      latest[field] = { feature: feature, value: v, at: root.performance.now() };
      emit({ kind: 'ext_field_written', feature: feature, field: field, value: v });
    },
    autosend: function (countyBare) {
      emit({ kind: 'ext_chat_autosend', county_bare: String(countyBare == null ? '' : countyBare) });
    },
    latestExt: function (field) { return latest[field] || null; },
    onExt: function (fn) {
      sink = fn;
      var pending = buffer;
      buffer = [];
      pending.forEach(emit);
    },
    off: function () { dead = true; buffer = []; sink = null; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
