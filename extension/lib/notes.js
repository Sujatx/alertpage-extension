/*
 * Pure helpers for the Internal Notes quick-fill pills. No DOM, no chrome.* -
 * shared by the toolbar popup and tests/run-tests.js.
 */
(function (root) {
  'use strict';

  /**
   * Fill in anything a stored/user-edited pill list is missing so the content script
   * can trust the shape. Unknown ids are kept - the list is meant to be extensible.
   */
  function normalizePills(pills, defaults) {
    var fallback = Array.isArray(defaults) ? defaults : [];
    if (!Array.isArray(pills) || !pills.length) { return fallback.slice(); }

    var byId = Object.create(null);
    for (var i = 0; i < fallback.length; i++) { byId[fallback[i].id] = fallback[i]; }

    var out = [];
    for (var j = 0; j < pills.length; j++) {
      var p = pills[j];
      if (!p || !p.id) { continue; }
      var d = byId[p.id] || {};
      out.push({
        id: String(p.id),
        text: p.text || d.text || ''
      });
    }
    return out.length ? out : fallback.slice();
  }

  var api = {
    normalizePills: normalizePills
  };

  root.APA = root.APA || {};
  root.APA.notes = api;

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : self);
