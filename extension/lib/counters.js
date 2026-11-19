/*
 * Pure helpers for the daily disposition counters on the footer buttons. No DOM,
 * no chrome.* - shared by the content scripts and tests/run-tests.js.
 * State shape: { do_not_send, send_supervisor, mark_as_duplicate, lastAt }.
 * Resets after RESET_MS with no counted disposition (not at a clock time).
 */
(function (root) {
  'use strict';

  var ACTIONS = ['do_not_send', 'send_supervisor', 'mark_as_duplicate'];
  var RESET_MS = 3 * 60 * 60 * 1000;

  function zero() {
    return { do_not_send: 0, send_supervisor: 0, mark_as_duplicate: 0, lastAt: null };
  }

  /** The counts to show at `now`: zeros if state is missing/malformed or older than RESET_MS. */
  function visible(state, now) {
    if (!state || typeof state !== 'object' || typeof state.lastAt !== 'number' || !isFinite(state.lastAt)) { return zero(); }
    if (now - state.lastAt > RESET_MS) { return zero(); }
    var out = { lastAt: state.lastAt };
    ACTIONS.forEach(function (a) {
      var n = state[a];
      out[a] = (typeof n === 'number' && isFinite(n) && n > 0) ? Math.floor(n) : 0;
    });
    return out;
  }

  /** New state after a confirmed disposition. Unknown action: normalised, lastAt not bumped. */
  function applyConfirmed(state, action, now) {
    var v = visible(state, now);
    if (ACTIONS.indexOf(action) < 0) { return v; }
    v[action] += 1;
    v.lastAt = now;
    return v;
  }

  var api = {
    ACTIONS: ACTIONS,
    RESET_MS: RESET_MS,
    visible: visible,
    applyConfirmed: applyConfirmed
  };

  root.APA = root.APA || {};
  root.APA.counters = api;

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : self);
