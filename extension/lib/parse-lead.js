/*
 * Pure parsing of the AlertPage lead-detail blob. No DOM, no chrome.*, no I/O,
 * so tests/run-tests.js can exercise it under plain Node.
 *
 * The blob is one server-rendered <span> holding unstructured text. Verified shape
 * (working-screen.html:389, whitespace exact):
 *
 *     (FDNY Analog (BCFY Calls) - Queens Dispatch)
 *
 *     Alert Category - General Fire
 *
 *     Alert Keywords - fire in
 *
 *     Transcript - Division one four of the Queens. ...<br />
 *
 *     -
 *
 * Nothing in the page's own JS reads or rewrites this element after load, so a
 * one-shot transform is safe.
 */
(function (root) {
  'use strict';

  // Checked in order. "Alert Keywords" must be tested before "Transcript" so that a
  // keyword value which happens to contain the word "transcript" is not mistaken
  // for the transcript header.
  var LABEL_PATTERNS = [
    { key: 'category',   label: 'Alert Category', re: /^alert\s+categor(?:y|ies)\s*[-–—:]\s*(.*)$/i },
    { key: 'keywords',   label: 'Alert Keywords', re: /^alert\s+keywords?\s*[-–—:]\s*(.*)$/i },
    // Tolerates a few leading words, e.g. "in the Transcript - ...".
    { key: 'transcript', label: 'Transcript',     re: /^(?:\S+\s+){0,3}?transcript\s*[-–—:]\s*(.*)$/i }
  ];

  // A line that is only a separator dash. The captured lead ends with one of these.
  var FILLER_RE = /^[-–—•*_=]+$/;

  function matchLabel(line) {
    for (var i = 0; i < LABEL_PATTERNS.length; i++) {
      var m = LABEL_PATTERNS[i].re.exec(line);
      if (m) { return { key: LABEL_PATTERNS[i].key, value: m[1].trim() }; }
    }
    return null;
  }

  /**
   * True if the text looks like a lead-detail blob. Used to pick the right element
   * when the primary #working_lead_id anchor path fails.
   */
  function looksLikeLeadBlob(text) {
    var lines = String(text == null ? '' : text).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      if (matchLabel(lines[i].trim())) { return true; }
    }
    return false;
  }

  /**
   * @param {string} rawText  the element's textContent
   * @returns {{ok:boolean, feed:string, category:string, keywords:string,
   *            transcript:string, extra:string[]}}
   *
   * `ok` is false when the text does not look like a lead at all. Callers must
   * leave the page untouched in that case rather than render a wrong guess.
   * Anything that did not fit a known field lands in `extra`, so no text is lost.
   */
  function parseLead(rawText) {
    var lines = String(rawText == null ? '' : rawText).split(/\r?\n/);
    var out = { ok: false, feed: '', category: '', keywords: '', transcript: '', extra: [] };
    var current = null;
    var sawLabel = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) { continue; }
      if (FILLER_RE.test(line)) { continue; }

      var hit = matchLabel(line);
      if (hit) {
        out[hit.key] = hit.value;
        current = hit.key;
        sawLabel = true;
        continue;
      }

      // Continuation of the field we are already inside (multi-line transcripts).
      if (current) {
        out[current] = out[current] ? out[current] + ' ' + line : line;
        continue;
      }

      // Anything before the first label. The first such line is the feed/system,
      // rendered parenthesised in the captured page.
      if (!out.feed) {
        out.feed = /^\(.*\)$/.test(line) ? line.replace(/^\(|\)$/g, '').trim() : line;
        continue;
      }
      out.extra.push(line);
    }

    out.ok = sawLabel || !!out.transcript;
    return out;
  }

  /**
   * The audio URL. Prefers link text, then onclick argument, then direct href.
   */
  function extractAudioUrl(linkText, onclickAttr, hrefAttr) {
    var txt = String(linkText == null ? '' : linkText).trim();
    if (/^https?:\/\/\S+$/i.test(txt)) { return txt; }
    var oc = String(onclickAttr == null ? '' : onclickAttr);
    var m = /(?:openFullScreen|window\.open)\(\s*['"]([^'"]+)['"]/.exec(oc);
    if (m && /^https?:\/\/\S+$/i.test(m[1])) { return m[1]; }
    var hr = String(hrefAttr == null ? '' : hrefAttr).trim();
    if (/^https?:\/\/\S+$/i.test(hr) && hr !== '#') { return hr; }
    return '';
  }

  var api = {
    parseLead: parseLead,
    looksLikeLeadBlob: looksLikeLeadBlob,
    extractAudioUrl: extractAudioUrl,
    LABEL_PATTERNS: LABEL_PATTERNS
  };

  root.APA = root.APA || {};
  root.APA.lead = api;

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : self);
