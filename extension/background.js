/*
 * Service worker. Three jobs: the /get_systems fetch, pointing the Data Feed link at
 * the right tab, and the Summarize feature's two calls.
 *
 * The toolbar button is handled entirely by action.default_popup (popup/popup.html),
 * so there is no onClicked listener here - Chrome never fires chrome.action.onClicked
 * once a default_popup is set, so one would be dead code that looks alive.
 *
 * Phase 3 gave this file its first real work: fetching the Data Feed's system list so
 * content/working-screen.js can turn a lead's feed string into an ltp_id.
 *
 * THE NETWORK CALLS THIS EXTENSION MAKES.
 *
 * "Never makes a network request" was a hard guardrail through Phase 1 and is now
 * three narrow, explicit carve-outs (see CLAUDE.md):
 *
 *   1. A read-only GET to AlertPage's own ap-portal host for /get_systems (agreed
 *      2026-09-02) - turns a lead's feed string into a Data Feed system id.
 *   2. A read-only GET to the same host for /get_transmissions (agreed 2026-09-10,
 *      Summarize feature) - fetches the transcript window a dispatcher's Summarize
 *      click needs, so the model has more than whatever page she happens to have
 *      open. Fires only when she clicks Summarize.
 *   3. A generateContent call to Google's Gemini API (agreed 2026-09-10, Summarize
 *      feature), using a per-dispatcher key she pastes into the popup and that never
 *      leaves chrome.storage.local except in this one request. Fires only when she
 *      clicks Summarize, and only if she's saved a key. No other third-party host is
 *      contacted anywhere in the extension.
 *
 * Do not widen this list without another decision.
 *
 * Why here and not in the content script: a fetch from a content script runs against
 * that page's own origin and CORS would block a cross-origin one. The worker's fetch
 * is covered by host_permissions instead, and (for the two AlertPage calls) carries
 * her existing ap-portal session cookie so the response is what her account can see.
 */
'use strict';

importScripts('config/data-feed-settings.js', 'config/summarize-settings.js', 'lib/transmissions.js', 'lib/summarize.js');

var DF = globalThis.APA.dataFeed;
var SS = globalThis.APA.summarizeSettings;
var TRANS = globalThis.APA.transmissions;
var SUM = globalThis.APA.summarize;

var LLM_SETTINGS_KEY = 'apa.llmSettings';

var INDEX_KEY = 'apa.systemIndex';

// Floor on how often a `force` refetch is honoured. The Working Screen sets force after
// a failed lookup, and a system genuinely missing from her catalogue fails every time -
// without this floor, every such lead would pull the whole ~843 KB list again.
var MIN_REFETCH_MS = 5 * 60 * 1000;

// One in-flight fetch shared by every tab that asks. Two Working Screen tabs opening
// at once would otherwise pull ~843 KB twice.
var inFlight = null;

function readCache() {
  return new Promise(function (resolve) {
    try {
      chrome.storage.local.get([INDEX_KEY], function (got) {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve((got || {})[INDEX_KEY] || null);
      });
    } catch (err) {
      resolve(null);
    }
  });
}

function writeCache(payload) {
  return new Promise(function (resolve) {
    var patch = {};
    patch[INDEX_KEY] = payload;
    try {
      chrome.storage.local.set(patch, function () { resolve(); });
    } catch (err) {
      resolve();
    }
  });
}

/**
 * Everything except ltp_id and system_name is dropped. The raw response carries
 * stream URLs, worker ids and container ids we have no use for, and storing it whole
 * would put most of a megabyte into chrome.storage.local for no reason.
 */
function slim(systems) {
  var out = [];
  if (!Array.isArray(systems)) { return out; }
  for (var i = 0; i < systems.length; i++) {
    var s = systems[i];
    if (!s || s.ltp_id == null || !s.system_name) { continue; }
    out.push({ ltp_id: s.ltp_id, system_name: String(s.system_name).trim() });
  }
  return out;
}

function fetchIndex() {
  if (inFlight) { return inFlight; }

  inFlight = fetch(DF.DATA_FEED_ORIGIN + DF.SYSTEMS_PATH, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-cache'
  }).then(function (response) {
    if (!response.ok) { throw new Error('server returned ' + response.status); }
    // A signed-out session is answered with the login page, not a 401 - so a
    // non-JSON content type is the signal, not the status code.
    var type = response.headers.get('content-type') || '';
    if (type.indexOf('json') === -1) { throw new Error('not signed in to ap-portal'); }
    return response.json();
  }).then(function (systems) {
    var index = slim(systems);
    if (!index.length) { throw new Error('empty system list'); }
    var payload = { index: index, fetchedAt: Date.now() };
    return writeCache(payload).then(function () { return payload; });
  }).finally(function () {
    inFlight = null;
  });

  return inFlight;
}

/**
 * @param {boolean} force  skip the cache. The Working Screen sets this after a lookup
 *                         against the cached index came back empty, on the theory that
 *                         a system it has never seen is more likely new than absent.
 */
function getIndex(force) {
  return readCache().then(function (cached) {
    var age = Date.now() - ((cached && cached.fetchedAt) || 0);
    var usable = cached && cached.index && cached.index.length;
    var fresh = usable && age < DF.SYSTEM_INDEX_TTL_MS;

    if (fresh && (!force || age < MIN_REFETCH_MS)) { return cached; }

    return fetchIndex().catch(function (err) {
      // A stale cache still answers most lookups, and answering with it beats
      // rendering an unfiltered link because ap-portal happened to be logged out.
      if (cached && cached.index && cached.index.length) { return cached; }
      return { index: null, fetchedAt: 0, error: String(err && err.message || err) };
    });
  });
}

/**
 * Open the Data Feed in a tab that is not the Working Screen's, reusing the one that is
 * already open rather than stacking up a tab per lead.
 *
 * This lives here because the obvious version does not work. The link used to carry
 * target="apa-data-feed" and rely on the browser to find the tab by name - but the tab's
 * first navigation is cross-origin (dispatch -> ap-portal), and Chrome clears
 * window.name on cross-origin navigation. The name was gone before the second click
 * looked for it, so every click opened a new tab. chrome.tabs.query finds the tab by URL
 * instead, which also picks up a Data Feed tab she opened herself.
 *
 * No "tabs" permission: querying a pattern the extension already has host permission for
 * is enough. Nothing here is a network request - it is the browser's own tab list.
 */
function dataFeedUrl(raw) {
  var base = DF.DATA_FEED_ORIGIN + DF.DATA_FEED_PATH;
  var url = String(raw == null ? '' : raw);
  // Anything that is not a Data Feed URL collapses to the bare page rather than being
  // opened as given.
  return url.slice(0, base.length) === base ? url : base;
}

function openDataFeed(raw) {
  var url = dataFeedUrl(raw);

  return new Promise(function (resolve) {
    chrome.tabs.query({ url: DF.DATA_FEED_MATCH }, function (tabs) {
      if (chrome.runtime.lastError) { tabs = null; }
      var existing = (tabs && tabs.length) ? tabs[0] : null;

      if (!existing) {
        chrome.tabs.create({ url: url, active: true }, function () {
          void chrome.runtime.lastError;
          resolve({ ok: true, reused: false });
        });
        return;
      }

      chrome.tabs.update(existing.id, { url: url, active: true }, function () {
        if (chrome.runtime.lastError) {
          // The tab went away between the query and the update.
          chrome.tabs.create({ url: url, active: true }, function () {
            void chrome.runtime.lastError;
            resolve({ ok: true, reused: false });
          });
          return;
        }
        // Raise its window too - reusing a tab in a background window would otherwise
        // look like nothing happened.
        chrome.windows.update(existing.windowId, { focused: true }, function () {
          void chrome.runtime.lastError;
          resolve({ ok: true, reused: true });
        });
      });
    });
  });
}

// ---------------------------------------------------------------- summarize

function readLlmSettings() {
  return new Promise(function (resolve) {
    try {
      chrome.storage.local.get([LLM_SETTINGS_KEY], function (got) {
        if (chrome.runtime.lastError) { resolve(SS.DEFAULT_LLM_SETTINGS); return; }
        resolve(Object.assign({}, SS.DEFAULT_LLM_SETTINGS, (got || {})[LLM_SETTINGS_KEY] || {}));
      });
    } catch (err) {
      resolve(SS.DEFAULT_LLM_SETTINGS);
    }
  });
}

/**
 * One /get_transmissions page. Not scoped to a talkgroup - see lib/transmissions.js's
 * header comment on why the whole system's traffic is wanted, not just the alerting
 * talkgroup.
 */
function fetchTransmissionsPage(ltpId, startDateSec, endDateSec, page) {
  var params = new URLSearchParams({
    ltp_id: String(ltpId),
    per_page: String(SS.PER_PAGE),
    page: String(page),
    include_alerts: '1',
    start_date: String(Math.floor(startDateSec)),
    end_date: String(Math.floor(endDateSec))
  });

  return fetch(DF.DATA_FEED_ORIGIN + '/get_transmissions?' + params.toString(), {
    method: 'GET',
    credentials: 'include',
    cache: 'no-cache'
  }).then(function (response) {
    if (!response.ok) { throw new Error('server returned ' + response.status); }
    var type = response.headers.get('content-type') || '';
    if (type.indexOf('json') === -1) { throw new Error('not signed in to ap-portal'); }
    return response.json();
  });
}

/**
 * Fetches (possibly several pages of) one lookback window and asks
 * TRANS.selectSummarizationWindow whether it's enough. Widens the lookback and
 * retries when the anchor isn't found yet or there weren't enough transmissions
 * before it, up to LOOKBACK_BACKOFF_STEPS_SEC's ceiling - never an unbounded loop.
 */
function fetchTransmissionWindow(ltpId, triggerEpochSec) {
  var now = Math.floor(Date.now() / 1000);

  function attempt(stepIndex) {
    var lookbackSec = SS.LOOKBACK_BACKOFF_STEPS_SEC[stepIndex];
    var startDateSec = triggerEpochSec - lookbackSec;

    function fetchPages(page, accumulated) {
      return fetchTransmissionsPage(ltpId, startDateSec, now, page).then(function (body) {
        var all = accumulated.concat((body && body.results) || []);
        var hasMorePages = body && body.total_pages > page && page < SS.MAX_FETCH_PAGES_PER_ATTEMPT;
        if (hasMorePages) { return fetchPages(page + 1, all); }
        return all;
      });
    }

    return fetchPages(1, []).then(function (allResults) {
      var result = TRANS.selectSummarizationWindow(allResults, triggerEpochSec, {
        beforeCount: SS.SUMMARIZE_BEFORE_COUNT,
        toleranceSec: SS.EPOCH_TOLERANCE_SEC
      });

      var shouldWiden = (!result.ok && result.reason === 'anchor-not-found') ||
        (result.ok && result.truncatedBefore);

      if (shouldWiden && stepIndex + 1 < SS.LOOKBACK_BACKOFF_STEPS_SEC.length) {
        return attempt(stepIndex + 1);
      }

      return result;
    });
  }

  return attempt(0);
}

function callGemini(apiKey, requestBody) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, SS.GEMINI_REQUEST_TIMEOUT_MS);

  var url = SS.GEMINI_ORIGIN + SS.GEMINI_GENERATE_PATH + '?key=' + encodeURIComponent(apiKey);

  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: controller.signal
  }).then(function (response) {
    clearTimeout(timer);
    if (!response.ok) {
      return response.json().catch(function () { return null; }).then(function (errBody) {
        var detail = errBody && errBody.error && errBody.error.message;
        var err = new Error('gemini-error');
        err.status = response.status;
        err.detail = detail;
        throw err;
      });
    }
    return response.json();
  }).catch(function (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      var timeoutErr = new Error('timeout');
      timeoutErr.reason = 'timeout';
      throw timeoutErr;
    }
    err.reason = err.reason || 'gemini-error';
    throw err;
  });
}

function summarizeLead(ltpId, triggerEpochSec) {
  return readLlmSettings().then(function (settings) {
    if (!settings.apiKey) { return { ok: false, reason: 'no-api-key' }; }

    return fetchTransmissionWindow(ltpId, triggerEpochSec).then(function (windowResult) {
      if (!windowResult.ok) { return windowResult; }

      var transmissionsById = {};
      for (var i = 0; i < windowResult.window.length; i++) {
        transmissionsById[windowResult.window[i].id_transmission] = windowResult.window[i];
      }

      var requestBody = SUM.buildRequestBody(windowResult.window, windowResult.anchor.idTransmission);

      return callGemini(settings.apiKey, requestBody).then(function (apiResponse) {
        var parsed = SUM.parseGeminiResponse(apiResponse);
        if (!parsed.ok) { return { ok: false, reason: parsed.reason }; }

        var verified = SUM.verifyExtractive(parsed.structured, transmissionsById);
        var chips = SUM.assembleSummaryLine(verified);
        return { ok: true, chips: chips, anchor: windowResult.anchor };
      }).catch(function (err) {
        return { ok: false, reason: err.reason || 'gemini-error', status: err.status, detail: err.detail || String(err && err.message || err) };
      });
    });
  });
}

// ------------------------------------------------------------------ routing

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message) { return false; }

  if (message.type === 'apa.openDataFeed') {
    openDataFeed(message.url)
      .then(sendResponse)
      .catch(function (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      });
    return true;
  }

  if (message.type === 'apa.systemIndex') {
    getIndex(!!message.force)
      .then(sendResponse)
      .catch(function (err) {
        sendResponse({ index: null, fetchedAt: 0, error: String(err && err.message || err) });
      });
    return true;
  }

  if (message.type === 'apa.summarizeLead') {
    summarizeLead(message.ltpId, message.triggerEpochSec)
      .then(sendResponse)
      .catch(function (err) {
        sendResponse({ ok: false, reason: 'gemini-error', detail: String(err && err.message || err) });
      });
    return true;
  }

  return false;
});
