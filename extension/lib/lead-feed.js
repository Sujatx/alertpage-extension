/*
 * Pure helpers for Phase 3 (Data Feed sync). No DOM, no chrome.*, no I/O, so
 * tests/run-tests.js can exercise them under plain Node.
 *
 * Two jobs:
 *
 *   1. Turn the lead's combined feed string into a Data Feed system id.
 *      parse-lead.js produces one string holding system *and* talkgroup:
 *
 *          Michigan's Public Safety Communications System (MPSCS) - Fire East
 *
 *      The obvious move - split on the last " - " - is wrong. 150 of the 1849
 *      system names in a live /get_systems response contain " - " themselves
 *      ("Arizona Department of Public Safety - District 4"), so a split can cut
 *      through the middle of a system name. matchSystem() instead asks which
 *      known system name is a prefix of the feed string, longest wins, and takes
 *      the talkgroup from what is left over. Deterministic, no fuzzy scoring.
 *
 *   2. Read the lead's header timestamp and turn it into a custom range the
 *      Data Feed's own start_date/end_date inputs accept.
 *
 * Verified against live traffic 2026-09-02; see docs/FINDINGS.md.
 */
(function (root) {
  'use strict';

  var SEP = ' - ';

  var MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };

  // "2026-Sep-02 11:52" as rendered at working-screen.html:388. Seconds are
  // accepted but have never been observed. No timezone is present in the markup:
  // the server renders in the dispatcher's own profile timezone, so this parses
  // as browser-local, which is also how the Data Feed reads its datetime-local
  // inputs back (its applyCustomRange does `new Date(input.value)`).
  var LEAD_TIME_RE = /(\d{4})-([A-Za-z]{3,})-(\d{1,2})[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?/;

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /**
   * @param {string} feed   the combined "System - Talkgroup" string from parseLead
   * @param {Array<{ltp_id:number, system_name:string}>} index  slimmed /get_systems
   * @returns {{ltpId:number, systemName:string, talkgroupName:string, ambiguous:boolean}|null}
   *
   * null when nothing matches - the caller must degrade to an unfiltered Data Feed
   * link rather than guess. `ambiguous` is set when more than one ltp_id carries
   * the winning name (14 such duplicates exist in the live list), so the banner
   * can say the system was picked, not resolved.
   */
  function matchSystem(feed, index) {
    var text = String(feed == null ? '' : feed).trim();
    var lower = text.toLowerCase();
    if (!text || !index || !index.length) { return null; }

    var best = null;
    var duplicates = 0;

    for (var i = 0; i < index.length; i++) {
      var entry = index[i];
      if (!entry) { continue; }
      var name = String(entry.system_name == null ? '' : entry.system_name).trim();
      if (!name || name.length > text.length) { continue; }
      if (lower.slice(0, name.length) !== name.toLowerCase()) { continue; }

      var rest = text.slice(name.length);
      // A prefix only counts at a name boundary: either the whole string, or the
      // separator follows. Without this, "Wayne County, OH" would match a feed
      // string beginning "Wayne County, OHIO ...".
      if (rest && rest.slice(0, SEP.length) !== SEP) { continue; }

      if (best && name.length === best.systemName.length) { duplicates++; continue; }
      if (best && name.length < best.systemName.length) { continue; }

      duplicates = 0;
      best = {
        ltpId: entry.ltp_id,
        systemName: name,
        talkgroupName: rest ? rest.slice(SEP.length).trim() : '',
        ambiguous: false
      };
    }

    if (best && duplicates) { best.ambiguous = true; }
    return best;
  }

  /**
   * @param {string} text  the .apa-lead-time span's text, e.g. "2026-Sep-02 11:52"
   * @returns {number|null} epoch ms in local time
   *
   * Deliberately strict: an unrecognised shape returns null rather than falling
   * through to Date.parse, because Date.parse's fallbacks are implementation
   * defined and a silently wrong timestamp would filter the Data Feed to the
   * wrong window without looking broken.
   */
  function parseLeadTime(text) {
    var m = LEAD_TIME_RE.exec(String(text == null ? '' : text).trim());
    if (!m) { return null; }

    var month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (month == null) { return null; }

    var year = Number(m[1]);
    var day = Number(m[3]);
    var hour = Number(m[4]);
    var minute = Number(m[5]);
    var second = m[6] ? Number(m[6]) : 0;

    if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) { return null; }

    var date = new Date(year, month, day, hour, minute, second, 0);
    // Rejects real-looking but impossible dates (2026-Feb-30 rolls into March).
    if (date.getMonth() !== month || date.getDate() !== day) { return null; }
    return date.getTime();
  }

  /**
   * Bracket a timestamp by +/- minutes. The Data Feed's own timestamp helper
   * (applyTimeRangeFromTimestamp) hard-codes +/- 10; this is the configurable
   * equivalent.
   */
  function timeWindow(epochMs, minutes) {
    var span = Math.max(1, Number(minutes) || 0) * 60 * 1000;
    return { start: epochMs - span, end: epochMs + span };
  }

  /**
   * "YYYY-MM-DDTHH:mm" for an <input type="datetime-local">. Mirrors the Data
   * Feed's own formatToLocalDateTimeString() exactly, including the missing
   * seconds - the page parses these values back as local time.
   */
  function toDateTimeLocal(epochMs) {
    var d = new Date(epochMs);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
      + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  var api = {
    matchSystem: matchSystem,
    parseLeadTime: parseLeadTime,
    timeWindow: timeWindow,
    toDateTimeLocal: toDateTimeLocal,
    SEP: SEP
  };

  root.APA = root.APA || {};
  root.APA.leadFeed = api;

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : self);
