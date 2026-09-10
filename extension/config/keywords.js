/*
 * Data only. This is the file to tune when the highlighting is wrong - there is no UI
 * for any of it. The content script reads "apa.rules" from chrome.storage.local when
 * something is stored there and falls back to these values, which are also what
 * DEFAULT_SETTINGS' legendEnabled comes from. Nothing writes apa.rules today; edit
 * here and reload the extension.
 *
 * Deliberately minimal: one category, literal phrases only.
 *
 * The point of the highlight is to answer one question fast - "does this transmission
 * literally say it is a structure fire?" - not to colour in every architectural noun in
 * the transcript. Terms like "basement", "roof", "first floor", "address" and "boulevard"
 * appear in almost every transmission, so highlighting them highlights nothing.
 *
 * Add terms as real leads show you what is actually worth catching, and add categories
 * to the array below as needed.
 *
 * Matching rules (see lib/highlight.js):
 *   - case-insensitive
 *   - whole-token: "fire" does NOT match inside "firefighter"
 *   - longest phrase at a given position wins
 *   - a space inside a term matches any run of whitespace
 */
(function (root) {
  'use strict';

  var DEFAULT_RULES = [
    {
      id: 'structure',
      label: 'Structure',
      bg: '#ffd8a8',
      fg: '#6b3000',
      enabled: true,
      terms: [
        'structure',
        'damage',
        'fire'
      ]
    }
  ];

  var DEFAULT_SETTINGS = {
    highlightEnabled: true,
    legendEnabled: false,   // one category needs no legend; turn on if you add more
    footerReshuffleEnabled: true,
    monitorAutoSendEnabled: false,
    darkMode: false
  };

  var api = {
    DEFAULT_RULES: DEFAULT_RULES,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS
  };

  root.APA = root.APA || {};
  root.APA.keywords = api;

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : self);
