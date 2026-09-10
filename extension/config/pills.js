/*
 * Data only. Presets for the Internal Notes quick-fill pills.
 * The toolbar popup writes a user-edited copy of this into chrome.storage.local
 * under "apa.pills"; these values are the seed and the "restore defaults" target.
 */
(function (root) {
  'use strict';

  var DEFAULT_PILLS = [
    { id: 'dup', text: 'dup' },
    { id: 'userID', text: 'AP***' }
  ];

  var api = {
    DEFAULT_PILLS: DEFAULT_PILLS
  };

  root.APA = root.APA || {};
  root.APA.pillsConfig = api;

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : self);
