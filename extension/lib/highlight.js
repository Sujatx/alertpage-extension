/*
 * Pure keyword matching. No DOM - it returns character ranges, and the caller
 * turns those into <mark> elements. Keeping it text-only means the content script
 * never builds HTML from page text.
 */
(function (root) {
  'use strict';

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function normKey(s) {
    return String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /**
   * Build one combined matcher for the whole ruleset.
   *
   * Alternatives are sorted longest-first so that at any given position the longest
   * phrase wins - that is what makes "fire is out" beat "fire" and "no fire" beat "fire".
   * Token boundaries use lookarounds rather than \b so that terms containing digits
   * or punctuation ("10-75", "class 3") behave the same as plain words.
   */
  function buildMatcher(rules) {
    var seen = Object.create(null);
    var entries = [];
    var list = Array.isArray(rules) ? rules : [];

    for (var i = 0; i < list.length; i++) {
      var rule = list[i];
      if (!rule || rule.enabled === false || !rule.id) { continue; }
      var terms = Array.isArray(rule.terms) ? rule.terms : [];
      for (var j = 0; j < terms.length; j++) {
        var term = String(terms[j] == null ? '' : terms[j]).trim();
        if (!term) { continue; }
        var key = normKey(term);
        if (!key || seen[key]) { continue; }   // first rule to claim a term keeps it
        seen[key] = rule.id;
        entries.push({ key: key, term: term });
      }
    }

    if (!entries.length) { return null; }

    entries.sort(function (a, b) {
      return b.key.length - a.key.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    });

    var sources = entries.map(function (e) {
      // a space inside a term matches any run of whitespace, including a line break
      return escapeRe(e.term).replace(/\s+/g, '\\s+');
    });

    var re;
    try {
      re = new RegExp('(?<![A-Za-z0-9])(?:' + sources.join('|') + ')(?![A-Za-z0-9])', 'gi');
    } catch (err) {
      return null;   // a malformed user-entered term must not break the page
    }

    return { re: re, ruleByKey: seen };
  }

  /**
   * @returns {Array<{start:number, end:number, ruleId:string, text:string}>}
   *          non-overlapping, in document order
   */
  function findRanges(text, rules) {
    var src = String(text == null ? '' : text);
    if (!src) { return []; }

    var matcher = buildMatcher(rules);
    if (!matcher) { return []; }

    var out = [];
    var m;
    matcher.re.lastIndex = 0;
    while ((m = matcher.re.exec(src)) !== null) {
      if (m[0] === '') { matcher.re.lastIndex++; continue; }
      var ruleId = matcher.ruleByKey[normKey(m[0])];
      if (ruleId) {
        out.push({ start: m.index, end: m.index + m[0].length, ruleId: ruleId, text: m[0] });
      }
    }
    return out;
  }

  /**
   * Find http(s) URLs embedded in transcript text, so the caller can render them as
   * real links instead of dead text. Trailing punctuation (a sentence's closing
   * period, a comma, a bracket) is trimmed off the match - it is almost never part
   * of the URL itself.
   *
   * @returns {Array<{start:number, end:number, text:string}>}
   *          non-overlapping, in document order
   */
  function findLinkRanges(text) {
    var src = String(text == null ? '' : text);
    if (!src) { return []; }

    var out = [];
    var re = /https?:\/\/[^\s<>"']+/g;
    var m;
    while ((m = re.exec(src)) !== null) {
      var start = m.index;
      var end = start + m[0].length;
      while (end > start && /[.,;:!?)\]}'"]/.test(src.charAt(end - 1))) { end--; }
      if (end > start) { out.push({ start: start, end: end, text: src.slice(start, end) }); }
    }
    return out;
  }

  /**
   * Fill in anything a stored/user-edited ruleset is missing so the content script
   * can trust the shape. Unknown ids are kept - the ruleset is meant to be extensible.
   */
  function normalizeRules(rules, defaults) {
    var fallback = Array.isArray(defaults) ? defaults : [];
    if (!Array.isArray(rules) || !rules.length) { return fallback.slice(); }

    var byId = Object.create(null);
    for (var i = 0; i < fallback.length; i++) { byId[fallback[i].id] = fallback[i]; }

    var out = [];
    for (var j = 0; j < rules.length; j++) {
      var r = rules[j];
      if (!r || !r.id) { continue; }
      var d = byId[r.id] || {};
      out.push({
        id: String(r.id),
        label: r.label || d.label || String(r.id),
        bg: r.bg || d.bg || '#ffec99',
        fg: r.fg || d.fg || '#333333',
        enabled: r.enabled !== false,
        terms: Array.isArray(r.terms) ? r.terms.slice() : (d.terms || []).slice()
      });
    }
    return out.length ? out : fallback.slice();
  }

  var api = {
    findRanges: findRanges,
    findLinkRanges: findLinkRanges,
    buildMatcher: buildMatcher,
    normalizeRules: normalizeRules,
    escapeRe: escapeRe
  };

  root.APA = root.APA || {};
  root.APA.highlight = api;

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : self);
