/*
 * Data only. Defaults and constants for the Summarize feature, read by
 * background.js and the popup. Stored overrides live in
 * chrome.storage.local['apa.llmSettings']; DEFAULT_LLM_SETTINGS is the seed.
 *
 * BYOK by design: apiKey is the dispatcher's own Google Gemini key, entered in the
 * popup and used directly - no proxy, no shared key. Nothing here is sent
 * anywhere except generativelanguage.googleapis.com, and only when she clicks
 * Summarize.
 *
 * GEMINI_MODEL is a constant, not user-configurable in v1 - one fewer thing to
 * get wrong in a popup field. Bump it here if Google retires the model; verified
 * live against Google's docs 2026-09-10 as a current free-tier Flash model.
 */
(function (root) {
  'use strict';

  var DEFAULT_LLM_SETTINGS = {
    apiKey: '',
    enabled: true
  };

  var GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';
  var GEMINI_MODEL = 'gemini-2.5-flash';
  var GEMINI_GENERATE_PATH = '/v1beta/models/' + GEMINI_MODEL + ':generateContent';
  // A schema-constrained generateContent call routinely takes several seconds and
  // occasionally spikes past 20s (cold key/project, a long prompt, ordinary API
  // latency). This is a manually-clicked, one-off action - there's no reason to be
  // stingy here just because she's waiting.
  var GEMINI_REQUEST_TIMEOUT_MS = 45000;

  // A single 429 is usually a burst against the free tier's per-minute cap, not
  // real exhaustion - one short wait and one retry clears most of them before she
  // ever sees an error. GEMINI_MIN_GAP_MS additionally spaces out her own
  // automatic calls (Lead Status fires on every lead open) so this extension is
  // less likely to be the thing that causes the burst in the first place.
  var GEMINI_RATE_LIMIT_RETRY_MS = 3000;
  var GEMINI_MIN_GAP_MS = 1100;

  // How many transmissions before the trigger to include, and how close a
  // transmission's timestamp has to be to the lead's audio-URL epoch to count as
  // the trigger itself. See lib/transmissions.js.
  var SUMMARIZE_BEFORE_COUNT = 10;
  var EPOCH_TOLERANCE_SEC = 2;

  // The /get_transmissions fetch doesn't know the anchor's rank up front, so it
  // starts with a 2h lookback and widens if the anchor isn't found or fewer than
  // SUMMARIZE_BEFORE_COUNT prior transmissions came back - up to a 24h ceiling so
  // one click can't turn into an unbounded fetch loop on a quiet channel.
  var LOOKBACK_BACKOFF_STEPS_SEC = [2 * 3600, 6 * 3600, 24 * 3600];
  var MAX_FETCH_PAGES_PER_ATTEMPT = 2;
  var PER_PAGE = 300;

  // Results come back descending by transmission_time_stamp (see docs/FINDINGS.md),
  // and a fetch attempt is capped at MAX_FETCH_PAGES_PER_ATTEMPT * PER_PAGE records.
  // If the window's end were always "now", clicking Summarize on a lead that's been
  // sitting a while - on a busy, non-talkgroup-scoped system - would burn that whole
  // cap on traffic between the trigger and now and never reach back far enough to
  // even see the anchor, no matter how far LOOKBACK_BACKOFF_STEPS_SEC widens the
  // start. Anchoring the end to the trigger instead keeps the fetch centered on the
  // actual incident regardless of how stale the lead is by the time she clicks.
  var AFTER_TRIGGER_WINDOW_SEC = 30 * 60;

  // Buffer around a cited transmission's timestamp when jumping the Data Feed to
  // it from a Summarize hyperlink - wider than the anchor-match tolerance so the
  // page's own custom-range fetch reliably includes it.
  var JUMP_WINDOW_MINUTES = 2;

  var api = {
    DEFAULT_LLM_SETTINGS: DEFAULT_LLM_SETTINGS,
    GEMINI_ORIGIN: GEMINI_ORIGIN,
    GEMINI_MODEL: GEMINI_MODEL,
    GEMINI_GENERATE_PATH: GEMINI_GENERATE_PATH,
    GEMINI_REQUEST_TIMEOUT_MS: GEMINI_REQUEST_TIMEOUT_MS,
    GEMINI_RATE_LIMIT_RETRY_MS: GEMINI_RATE_LIMIT_RETRY_MS,
    GEMINI_MIN_GAP_MS: GEMINI_MIN_GAP_MS,
    SUMMARIZE_BEFORE_COUNT: SUMMARIZE_BEFORE_COUNT,
    EPOCH_TOLERANCE_SEC: EPOCH_TOLERANCE_SEC,
    LOOKBACK_BACKOFF_STEPS_SEC: LOOKBACK_BACKOFF_STEPS_SEC,
    MAX_FETCH_PAGES_PER_ATTEMPT: MAX_FETCH_PAGES_PER_ATTEMPT,
    PER_PAGE: PER_PAGE,
    AFTER_TRIGGER_WINDOW_SEC: AFTER_TRIGGER_WINDOW_SEC,
    JUMP_WINDOW_MINUTES: JUMP_WINDOW_MINUTES
  };

  root.APA = root.APA || {};
  root.APA.summarizeSettings = api;

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : self);
