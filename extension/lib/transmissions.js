/*
 * Pure helpers for the Summarize feature. No DOM, no chrome.*, no I/O, so
 * tests/run-tests.js can exercise them under plain Node.
 *
 * Three jobs:
 *
 *   1. Pull the exact trigger timestamp out of a lead's own audio URL.
 *      Verified live (2026-09-10, see docs/FINDINGS.md): a transmission's audio
 *      filename always embeds its transmission_time_stamp - confirmed byte-exact
 *      across 20 real transmissions, two systems, 100% match. Grammars differ by
 *      ingest source, and the epoch isn't always sitting directly in the URL:
 *
 *          .../icecast/spotsylvania_va_fire/777527_999999_1789054874.mp3
 *          .../openmhz/pittsburgh_police_and_fire/pghpdfd-7-1789054652.m4a
 *          .../bcfy_calls/fdny_analog/1787763340-223670.m4a        (epoch first, older capture)
 *          https://signal.alertpage.net/media/<base64 JSON>        (see below)
 *
 *      The last one is a signed proxy URL, not a direct file path - live-verified
 *      2026-09-10 (a Monroe/Ontario Counties lead). Its <base64> segment
 *      base64-decodes to plain JSON, e.g.
 *      {"b":"media-alrtpg","e":1789146046,"k":"1789057280890-294f75e0.m4a"} - `e`
 *      is the signed URL's own expiry, not the transmission time, and `k` is the
 *      real underlying filename, epoch in MILLISECONDS this time. Both this and the
 *      plain-URL case ultimately reduce to "find a plausible epoch run in a
 *      filename," which extractEpochFromFilename() does once, in one place. This
 *      decode is pure base64+JSON parsing of data already sitting in the page's own
 *      onclick attribute - the same thing the content script already reads for the
 *      inline player, nothing pulled from anywhere else.
 *
 *      extractEpochFromAudioUrl() looks for a plausible epoch anywhere in the
 *      filename rather than assuming a fixed position, and returns null - never a
 *      guess - when it can't find exactly one. Some systems (RDIO-relay ones, e.g.
 *      a bare `https://5042.rdio.alertpagesdr.com` link) have no per-transmission
 *      file at all, and null here is the correct, permanent answer for those, not a
 *      bug to chase.
 *
 *   2. Split a raw /get_transmissions?include_alerts=1 response into real
 *      transmissions and the separate "alert document" siblings the API also
 *      returns (see docs/FINDINGS.md "alerts" section) - a second, independent
 *      signal for which transmission triggered an alert, on top of the epoch match.
 *
 *   3. Find the transmission that triggered a given lead's alert (the "anchor") and
 *      build the chronological window fed to the model: up to 10 transmissions
 *      before it, through the most recent one fetched. Deliberately not scoped to
 *      one talkgroup - ops/tac follow-up on a busy incident is routinely on a
 *      different talkgroup than dispatch (see config/data-feed-settings.js's own
 *      comment on why syncTalkgroup defaults off).
 */
(function (root) {
  'use strict';

  // Rejects obviously-wrong numbers (a ltp_id or talkgroup_decimal that happens to
  // be the right length) without pretending to know the exact valid range.
  var EPOCH_MIN = 1420070400; // 2015-01-01T00:00:00Z, in seconds
  var EPOCH_MAX = 2051222400; // 2035-01-01T00:00:00Z, in seconds

  // 9-10 digits for epoch seconds, 12-13 for epoch milliseconds (the
  // signal.alertpage.net proxy's embedded filename uses milliseconds).
  var DIGIT_RUN_RE = /^\d{9,13}$/;

  var MEDIA_EXT_RE = /\.(?:m4a|mp3|wav|ogg)$/i;
  var SIGNAL_PROXY_RE = /^https?:\/\/signal\.alertpage\.net\/media\/([A-Za-z0-9+/_=-]+)/i;

  function isPlausibleEpochSeconds(n) {
    return n >= EPOCH_MIN && n <= EPOCH_MAX;
  }

  // A 12-13 digit run is milliseconds, not seconds - reduce to seconds before the
  // plausibility check either way, so callers never see the unit distinction.
  function normalizeEpochDigits(digits) {
    var n = Number(digits);
    if (digits.length >= 12) { n = Math.round(n / 1000); }
    return isPlausibleEpochSeconds(n) ? n : null;
  }

  function basename(url) {
    var noQuery = String(url == null ? '' : url).split(/[?#]/)[0];
    var parts = noQuery.split('/');
    return parts[parts.length - 1] || '';
  }

  /**
   * The shared core: find a plausible epoch in a bare filename (not a full URL),
   * e.g. "777527_999999_1789054874.mp3" or "1789057280890-294f75e0.m4a". Used both
   * directly on a plain media URL's basename and on the filename recovered from a
   * signal.alertpage.net proxy token (see extractEpochFromSignalProxyUrl).
   *
   * @returns {number|null} epoch seconds, or null if none/ambiguous
   */
  function extractEpochFromFilename(name) {
    var stem = String(name == null ? '' : name).replace(/\.[a-zA-Z0-9]+$/, '');
    var segments = stem.split(/[_-]/);

    var candidates = [];
    for (var i = 0; i < segments.length; i++) {
      if (!DIGIT_RUN_RE.test(segments[i])) { continue; }
      var epoch = normalizeEpochDigits(segments[i]);
      if (epoch != null) { candidates.push({ index: i, value: epoch }); }
    }

    if (!candidates.length) { return null; }
    if (candidates.length === 1) { return candidates[0].value; }

    // More than one plausible run: prefer the one immediately before the
    // extension (the last segment) - covers "{ltp}_{tg}_{epoch}.mp3" and
    // "{slug}-{tgid}-{epoch}.m4a" when an earlier segment also happens to look
    // epoch-shaped.
    var last = candidates[candidates.length - 1];
    if (last.index === segments.length - 1) { return last.value; }

    // Still ambiguous - never guess.
    return null;
  }

  /**
   * base64 (standard or URL-safe) -> UTF-8 text. Works in a content script/service
   * worker (atob) and under Node (Buffer, for tests/run-tests.js) without either
   * runtime being a hard dependency of the other.
   */
  function base64Decode(token) {
    var normalized = String(token).replace(/-/g, '+').replace(/_/g, '/');
    try {
      if (typeof atob === 'function') { return atob(normalized); }
    } catch (err) { /* fall through to Buffer */ }
    try {
      if (typeof Buffer !== 'undefined') { return Buffer.from(normalized, 'base64').toString('utf8'); }
    } catch (err) { /* noop */ }
    return null;
  }

  /**
   * signal.alertpage.net wraps the real file behind a signed proxy URL, e.g.
   * https://signal.alertpage.net/media/<base64>, where <base64> decodes to JSON
   * like {"b":"media-alrtpg","e":1789146046,"k":"1789057280890-294f75e0.m4a"}.
   * `e` is that signed URL's own expiry - not the transmission time, and easy to
   * mistake for one since it is itself a plausible-looking epoch. `k` is the real
   * underlying filename, so only string fields shaped like a media filename are
   * ever handed to extractEpochFromFilename.
   */
  function extractEpochFromSignalProxyUrl(url) {
    var m = SIGNAL_PROXY_RE.exec(url);
    if (!m) { return null; }

    var decoded = base64Decode(m[1]);
    if (!decoded) { return null; }

    var payload;
    try { payload = JSON.parse(decoded); } catch (err) { return null; }
    if (!payload || typeof payload !== 'object') { return null; }

    for (var key in payload) {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) { continue; }
      var value = payload[key];
      if (typeof value === 'string' && MEDIA_EXT_RE.test(value)) {
        var epoch = extractEpochFromFilename(value);
        if (epoch != null) { return epoch; }
      }
    }

    return null;
  }

  /**
   * @param {string} url  a transmission or lead audio URL
   * @returns {number|null} epoch seconds, or null if none/ambiguous/unrecoverable
   */
  function extractEpochFromAudioUrl(url) {
    var str = String(url == null ? '' : url);

    var proxied = extractEpochFromSignalProxyUrl(str);
    if (proxied != null) { return proxied; }

    return extractEpochFromFilename(basename(str));
  }

  /**
   * @param {Array<object>} rawResults  /get_transmissions?include_alerts=1 results[]
   * @returns {{transmissions: object[], alertDocs: object[]}}
   *
   * A real transmission carries audio_path and a 32-char hex id_transmission. An
   * alert document lacks audio_path and instead carries id_transsmission (typo, one
   * extra 's' - the API's own field name, not ours) back-referencing the real one,
   * plus categories/keywords. See docs/FINDINGS.md "alerts" section for the shape.
   */
  function classifyResults(rawResults) {
    var transmissions = [];
    var alertDocs = [];
    var list = Array.isArray(rawResults) ? rawResults : [];

    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r) { continue; }
      if (r.audio_path && r.id_transmission) {
        transmissions.push(r);
      } else if (r.id_transsmission) {
        alertDocs.push(r);
      }
    }

    return { transmissions: transmissions, alertDocs: alertDocs };
  }

  /**
   * @param {object[]} transmissions
   * @param {object[]} alertDocs
   * @param {number} triggerEpochSec
   * @param {number} [toleranceSec=2]
   * @returns {object|null}
   *   { idTransmission, transmissionTimeStamp, talkgroupDecimal, confirmedBy, ambiguous }
   *   or null when nothing in range.
   */
  function findAnchor(transmissions, alertDocs, triggerEpochSec, toleranceSec) {
    var tol = toleranceSec == null ? 2 : toleranceSec;
    var list = Array.isArray(transmissions) ? transmissions : [];
    var alerts = Array.isArray(alertDocs) ? alertDocs : [];

    var matches = [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (Math.abs(Number(t.transmission_time_stamp) - triggerEpochSec) <= tol) {
        matches.push(t);
      }
    }

    if (!matches.length) { return null; }

    // Loose: id match, or a close timestamp (handles the float-vs-int wobble seen
    // between an alert doc and its transmission in live captures, e.g. 1789055531.0
    // vs 1789055531). Fine for confirming the *only* candidate.
    function alertConfirmsLoose(t) {
      for (var j = 0; j < alerts.length; j++) {
        var a = alerts[j];
        if (a.id_transsmission === t.id_transmission) { return true; }
        if (Math.abs(Number(a.transmission_time_stamp) - Number(t.transmission_time_stamp)) <= tol) { return true; }
      }
      return false;
    }

    // Strict: id match only. Used to break a tie among several candidates that are
    // themselves clustered within tolerance of each other - the loose timestamp
    // check can't discriminate between them, since that's exactly what put them all
    // in `matches` to begin with.
    function alertConfirmsStrict(t) {
      for (var j = 0; j < alerts.length; j++) {
        if (alerts[j].id_transsmission === t.id_transmission) { return true; }
      }
      return false;
    }

    function toAnchor(t, confirmedByAlert) {
      return {
        idTransmission: t.id_transmission,
        transmissionTimeStamp: Number(t.transmission_time_stamp),
        talkgroupDecimal: t.talkgroup_decimal != null ? t.talkgroup_decimal : null,
        confirmedBy: confirmedByAlert ? ['epoch', 'alert-doc'] : ['epoch'],
        ambiguous: false
      };
    }

    if (matches.length === 1) {
      return toAnchor(matches[0], alertConfirmsLoose(matches[0]));
    }

    var confirmed = [];
    for (var k = 0; k < matches.length; k++) {
      if (alertConfirmsStrict(matches[k])) { confirmed.push(matches[k]); }
    }

    if (confirmed.length === 1) { return toAnchor(confirmed[0], true); }

    // Still tied (zero or multiple alert-confirmed matches) - do not guess.
    return {
      idTransmission: null,
      transmissionTimeStamp: triggerEpochSec,
      talkgroupDecimal: null,
      confirmedBy: [],
      ambiguous: true
    };
  }

  /**
   * @param {object[]} transmissions
   * @param {object} anchor
   * @param {number} [beforeCount=10]
   * @returns {{window: object[], truncatedBefore: boolean}}
   *
   * Not scoped to the anchor's own talkgroup on purpose - ops/tac follow-up on a
   * busy incident is routinely on a different talkgroup than dispatch.
   */
  function buildTranscriptWindow(transmissions, anchor, beforeCount) {
    var before = beforeCount == null ? 10 : beforeCount;
    var list = Array.isArray(transmissions) ? transmissions : [];

    var seen = {};
    var deduped = [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var id = t && t.id_transmission;
      if (!id || seen[id]) { continue; }
      seen[id] = true;
      deduped.push(t);
    }

    deduped.sort(function (a, b) {
      return Number(a.transmission_time_stamp) - Number(b.transmission_time_stamp);
    });

    var anchorIndex = -1;
    for (var j = 0; j < deduped.length; j++) {
      if (deduped[j].id_transmission === anchor.idTransmission) { anchorIndex = j; break; }
    }

    if (anchorIndex === -1) { return { window: [], truncatedBefore: false }; }

    var startIndex = Math.max(0, anchorIndex - before);
    var window_ = deduped.slice(startIndex, deduped.length);

    return { window: window_, truncatedBefore: anchorIndex < before };
  }

  /**
   * The single entry point background.js calls.
   *
   * @param {object[]} rawResults  /get_transmissions?include_alerts=1 results[]
   * @param {number} triggerEpochSec
   * @param {{beforeCount?: number, toleranceSec?: number}} [options]
   * @returns {{ok:true, anchor:object, window:object[], truncatedBefore:boolean}
   *          |{ok:false, reason:'no-transmissions'|'anchor-not-found'|'anchor-ambiguous'}}
   */
  function selectSummarizationWindow(rawResults, triggerEpochSec, options) {
    var opts = options || {};
    var classified = classifyResults(rawResults);

    if (!classified.transmissions.length) { return { ok: false, reason: 'no-transmissions' }; }

    var anchor = findAnchor(classified.transmissions, classified.alertDocs, triggerEpochSec, opts.toleranceSec);
    if (!anchor) { return { ok: false, reason: 'anchor-not-found' }; }
    if (anchor.ambiguous) { return { ok: false, reason: 'anchor-ambiguous' }; }

    var built = buildTranscriptWindow(classified.transmissions, anchor, opts.beforeCount);
    return { ok: true, anchor: anchor, window: built.window, truncatedBefore: built.truncatedBefore };
  }

  var api = {
    extractEpochFromAudioUrl: extractEpochFromAudioUrl,
    classifyResults: classifyResults,
    findAnchor: findAnchor,
    buildTranscriptWindow: buildTranscriptWindow,
    selectSummarizationWindow: selectSummarizationWindow
  };

  root.APA = root.APA || {};
  root.APA.transmissions = api;

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : self);
