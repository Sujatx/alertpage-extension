/*
 * Data only. Defaults for Phase 3 (Data Feed sync), read by content/working-screen.js,
 * content/data-feed.js and the popup. Stored overrides live in
 * chrome.storage.local['apa.dataFeedSettings']; these are the seed and the
 * "Restore defaults" target.
 *
 * Why these defaults:
 *
 *   syncSource      on  - the whole point. Without the system pre-selected the Data
 *                         Feed shows nothing at all.
 *   syncCounty      on  - narrows a statewide system to her incident's county.
 *   syncTalkgroup   off - deliberately. Locking to the dispatch talkgroup hides the
 *                         operational and tactical channels (TAC 1, Fireground 2)
 *                         where the follow-up traffic actually is.
 *   syncTimeRange   off - opt-in. Narrowing to a time window can hide the very
 *                         transmission she's after if the lead's timestamp is off by
 *                         more than timeWindowMinutes.
 *   timeWindowMinutes 15 - only takes effect once syncTimeRange is turned on; the
 *                         page's own timestamp helper uses 10, 15 is wider on purpose,
 *                         because the lead's header minute and the transmission's
 *                         minute are not the same clock reading.
 *
 * syncSource and syncCounty default on and are consumed as `x !== false` (a key
 * missing from storage means on). syncTalkgroup and syncTimeRange default off and are
 * consumed as `x === true` instead - see content/data-feed.js.
 */
(function (root) {
  'use strict';

  var DEFAULT_DATA_FEED_SETTINGS = {
    syncEnabled: true,
    syncSource: true,
    syncCounty: true,
    syncTalkgroup: false,
    syncTimeRange: false,
    timeWindowMinutes: 15
  };

  // How long a stored lead context stays usable. Past this, opening the Data Feed is
  // taken to be a manual visit and nothing is applied - a filter set from a lead she
  // finished with half an hour ago is worse than no filter.
  var LEAD_CONTEXT_TTL_MS = 30 * 60 * 1000;

  // /get_systems is ~843 KB and changes rarely. Cached slimmed, refreshed on this
  // interval or whenever the cached copy cannot answer a lookup.
  var SYSTEM_INDEX_TTL_MS = 12 * 60 * 60 * 1000;

  var DATA_FEED_ORIGIN = 'https://ap-portal.alertpage.net';
  var DATA_FEED_PATH = '/data_feed';
  var SYSTEMS_PATH = '/get_systems';

  // Fallback window target for the Data Feed link, used only if the service worker
  // cannot be reached. It is NOT what produces the one-tab behaviour - see below.
  //
  // A named target cannot work here, and this is a browser rule, not a bug we can fix:
  // the tab it opens is named at creation, but its very first navigation is
  // cross-origin (dispatch.alertpage.net -> ap-portal.alertpage.net), and Chrome clears
  // window.name on any cross-origin navigation (shipped Chrome 88). Different
  // subdomains of alertpage.net are different origins, so the rule bites. The name is
  // gone before the second click ever looks for it, so every click opened a new tab.
  // Tab reuse is done by chrome.tabs in background.js instead.
  var DATA_FEED_TARGET = 'apa-data-feed';

  // Match pattern for finding an already-open Data Feed tab. Covered by the ap-portal
  // host permission, so chrome.tabs.query needs no "tabs" permission.
  var DATA_FEED_MATCH = DATA_FEED_ORIGIN + DATA_FEED_PATH + '*';

  var api = {
    DEFAULT_DATA_FEED_SETTINGS: DEFAULT_DATA_FEED_SETTINGS,
    LEAD_CONTEXT_TTL_MS: LEAD_CONTEXT_TTL_MS,
    SYSTEM_INDEX_TTL_MS: SYSTEM_INDEX_TTL_MS,
    DATA_FEED_ORIGIN: DATA_FEED_ORIGIN,
    DATA_FEED_PATH: DATA_FEED_PATH,
    DATA_FEED_TARGET: DATA_FEED_TARGET,
    DATA_FEED_MATCH: DATA_FEED_MATCH,
    SYSTEMS_PATH: SYSTEMS_PATH
  };

  root.APA = root.APA || {};
  root.APA.dataFeed = api;

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : self);
