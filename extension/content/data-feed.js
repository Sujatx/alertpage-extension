/*
 * AlertPage Data Feed Assist - Phase 3.
 *
 * Runs on https://ap-portal.alertpage.net/data_feed - a different host from the
 * Working Screen. Reads the lead context the Working Screen left in
 * chrome.storage.local and pre-sets this page's filters to match it.
 *
 * How the page works, from the live capture (2026-09-02):
 *
 *   - It reads ?ltp_id= itself on load and pre-selects the system, then chains
 *     fetchTalkgroups() -> populateTalkgroupsAndFilters(), which is what fills
 *     #county_selection. So the system is already handled before this script does
 *     anything; everything here waits on that chain finishing.
 *   - Every filter <select> carries an inline onchange= attribute. Its JS lives in a
 *     classic inline script, which our isolated world cannot reach - but a dispatched
 *     change event still runs the inline handler. That is the whole mechanism.
 *   - A custom time range is only reachable through the page's own "Apply Range"
 *     button (onclick="applyCustomRange()"). Clicking it is a read-only search
 *     refresh on a search page. One thing drives it, an agreed decision and not a
 *     precedent for anything else: syncing a lead's time window on page load (agreed
 *     2026-09-02).
 *   - The page re-fires /get_transmissions on its own every ~30s. Ours is not the
 *     only request in flight and must not assume it is.
 *
  * Guardrails held: no network request from here, nothing removed, nothing submitted.
 */
(function () {
  'use strict';

  var APA = globalThis.APA || {};
  var S = (APA.selectors || {}).dataFeed || {};
  var DF = APA.dataFeed || {};

  var DATA_FEED_KEY = 'apa.dataFeedSettings';
  var ACTIVE_LEAD_KEY = 'apa.activeLead';
  var SETTINGS_KEY = 'apa.settings';

  // The page's own chain is several fetches deep. Ten seconds is generous for it and
  // still short enough that a genuinely broken load gives up rather than hanging a
  // MutationObserver on the document for the rest of the shift.
  var READY_TIMEOUT_MS = 10000;

  // ---------------------------------------------------------------- utilities

  function warn(what, err) {
    try { console.warn('[AlertPage Assist] ' + what + ' skipped:', err); } catch (e) { /* noop */ }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text != null) { node.appendChild(document.createTextNode(text)); }
    return node;
  }

  function button(className, text) {
    var node = document.createElement('button');
    node.type = 'button';
    if (className) { node.className = className; }
    if (text != null) { node.appendChild(document.createTextNode(text)); }
    return node;
  }

  function find(entry) {
    return entry && entry.sel ? document.querySelector(entry.sel) : null;
  }

  // A CSS hook only - data-feed.css repaints under html[data-apa-theme="dark"]. This
  // page's manifest entry does not load config/keywords.js, so darkMode is read
  // straight off the stored apa.settings object rather than through K.DEFAULT_SETTINGS.
  function applyTheme(stored) {
    var settings = stored[SETTINGS_KEY] || {};
    var root = document.documentElement;
    if (settings.darkMode === true) {
      root.setAttribute('data-apa-theme', 'dark');
    } else {
      root.removeAttribute('data-apa-theme');
    }
  }

  function readStorage() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([DATA_FEED_KEY, ACTIVE_LEAD_KEY, SETTINGS_KEY], function (got) {
          if (chrome.runtime.lastError) { resolve({}); return; }
          resolve(got || {});
        });
      } catch (err) {
        resolve({});
      }
    });
  }

  /**
   * Record that she cleared the filters, so a reload does not helpfully put them
   * straight back. Nothing else consumes the context, so marking it beats deleting
   * it - the Working Screen still owns the key and will overwrite it next lead.
   */
  function markCleared(context) {
    var patch = {};
    patch[ACTIVE_LEAD_KEY] = Object.assign({}, context, { cleared: true });
    try {
      chrome.storage.local.set(patch, function () { void chrome.runtime.lastError; });
    } catch (err) { /* noop */ }
  }

  // --------------------------------------------------------------- select ops

  // Values are only ever set to something the page itself put in the list. Inventing
  // an option value would leave the select showing nothing while the request went out
  // with a filter she cannot see.
  function hasValue(select, value) {
    if (!select) { return false; }
    for (var i = 0; i < select.options.length; i++) {
      if (select.options[i].value === value) { return true; }
    }
    return false;
  }

  function setByValue(select, value) {
    if (!hasValue(select, value)) { return false; }
    select.value = value;
    return true;
  }

  // The talkgroup select's option *value* is talkgroup_decimal; the name we carry
  // from the lead only matches its *text*.
  function setByText(select, text) {
    if (!select || !text) { return false; }
    var want = String(text).trim().toLowerCase();
    for (var i = 0; i < select.options.length; i++) {
      if (String(select.options[i].text || '').trim().toLowerCase() === want) {
        select.value = select.options[i].value;
        return true;
      }
    }
    return false;
  }

  function fire(node) {
    if (node) { node.dispatchEvent(new Event('change', { bubbles: true })); }
  }

  // ------------------------------------------------------------------ waiting

  /**
   * Resolve once the page's own system -> talkgroups -> filters chain has finished.
   *
   * #county_selection is the signal: it is served with zero options, cleared to zero
   * again by clearElementContent(), and only ever gains any at the very end of
   * populateTalkgroupsAndFilters(). Counting options avoids depending on how many
   * counties a given system happens to have.
   */
  function whenFiltersReady(select) {
    return new Promise(function (resolve, reject) {
      if (!select) { reject(new Error('no county select')); return; }
      if (select.options.length) { resolve(); return; }

      var timer = setTimeout(function () {
        observer.disconnect();
        reject(new Error('filters did not populate within ' + READY_TIMEOUT_MS + 'ms'));
      }, READY_TIMEOUT_MS);

      var observer = new MutationObserver(function () {
        if (!select.options.length) { return; }
        observer.disconnect();
        clearTimeout(timer);
        resolve();
      });
      observer.observe(select, { childList: true });
    });
  }

  // ------------------------------------------------------------------- banner

  /**
   * Say what was changed and offer a way out. Auto-applying filters she cannot see
   * the provenance of would make an empty result set look like an empty feed.
   */
  function renderBanner(context, applied, skipped, clearable) {
    var anchor = find(S.filterPanel);
    if (!anchor || !anchor.parentNode) { return; }

    var bar = el('div', 'apa-df-banner');

    var text = 'Filtered from lead ' + (context.leadId || '?');
    if (applied.length) { text += ' — ' + applied.join(', '); }
    bar.appendChild(el('span', 'apa-df-banner-text', text));

    if (skipped.length) {
      bar.appendChild(el('span', 'apa-df-banner-note', 'Not applied: ' + skipped.join(', ')));
    }

    var actions = el('span', 'apa-df-banner-actions');

    // Only when there is something clearFilters() can actually undo. The system is
    // not one of those things - it stays selected either way - so a lead where only
    // the system matched gets no button that would appear to do nothing.
    if (clearable) {
      var clear = button('apa-df-banner-btn', 'Clear filters');
      clear.addEventListener('click', function () {
        clearFilters();
        markCleared(context);
        bar.remove();
      });
      actions.appendChild(clear);
    }

    var dismiss = button('apa-df-banner-btn apa-df-banner-dismiss', 'Dismiss');
    dismiss.setAttribute('aria-label', 'Dismiss this notice');
    dismiss.addEventListener('click', function () { bar.remove(); });
    actions.appendChild(dismiss);

    bar.appendChild(actions);

    anchor.parentNode.insertBefore(bar, anchor);
  }

  /**
   * Back to the page's own defaults for the filters we touched - and only those. The
   * system stays selected, because clearing that would leave her looking at "Select
   * a System" rather than at unfiltered traffic, which is not what "clear filters"
   * means here.
   *
   * Resetting the time select last and firing only that one change means a single
   * refresh: onTimeChanged() hides the custom range and calls fetchTransmissions(),
   * which reads the cleared county and talkgroup on its way past.
   */
  function clearFilters() {
    var county = find(S.countySelect);
    var talkgroup = find(S.talkgroupSelect);
    var time = find(S.timeSelect);

    if (county) { county.value = ''; }
    if (talkgroup) { talkgroup.value = ''; }
    if (time) { time.value = time.options.length ? time.options[0].value : '1'; }
    fire(time || county);
  }

  // -------------------------------------------------------------------- apply

  /**
   * One pass, one extra request.
   *
   * County and talkgroup are set without dispatching, so their inline handlers do not
   * each fire a search. The single trigger comes at the end - either the page's own
   * Apply Range button (custom range) or one change event on the county select.
   */
  function applyFilters(context, settings) {
    var applied = [];
    var skipped = [];
    // True once a filter is set but not yet sent. The system does not count - the
    // page already searched on it during its own load.
    var pending = false;

    if (context.systemName) {
      applied.push('system ' + context.systemName + (context.ambiguous ? ' (name not unique)' : ''));
    }

    if (settings.syncCounty !== false && context.county) {
      if (setByValue(find(S.countySelect), context.county)) {
        applied.push('county ' + context.county);
        pending = true;
      } else {
        // Statewide systems carry talkgroups for counties this one is not in.
        skipped.push('county ' + context.county + ' (not on this system)');
      }
    }

    if (settings.syncTalkgroup === true && context.talkgroupName) {
      if (setByText(find(S.talkgroupSelect), context.talkgroupName)) {
        applied.push('talkgroup ' + context.talkgroupName);
        pending = true;
      } else {
        skipped.push('talkgroup ' + context.talkgroupName + ' (no such talkgroup)');
      }
    }

    var minutes = Number(settings.timeWindowMinutes) || DF.DEFAULT_DATA_FEED_SETTINGS.timeWindowMinutes;
    var wantsTime = settings.syncTimeRange === true && context.timestamp;
    var timeApplied = wantsTime && jumpToTimestamp(context.timestamp, minutes);

    if (wantsTime && timeApplied) {
      applied.push('±' + minutes + ' min around ' + context.timeLabel);
    } else if (wantsTime) {
      skipped.push('time window');
    } else if (settings.syncTimeRange === true && !context.timestamp) {
      skipped.push('time window (lead time unreadable)');
    }

    // applyTimeRange already triggered the search via the page's Apply Range button,
    // and that request carries county and talkgroup with it. Without it, they are
    // sitting set but unsent, so one change event has to go out.
    if (pending && !timeApplied) { fire(find(S.countySelect)); }

    return { applied: applied, skipped: skipped, clearable: pending || timeApplied };
  }

  /**
   * Switch the page to a custom range around the lead's own timestamp (Phase 3 sync).
   * This is the one function that drives Apply Range.
   *
   * Deliberately not the page's own applyTimeRangeFromTimestamp(): that hard-codes
   * ±10 minutes and also blanks the search box. This does the same three steps it
   * does - select "custom", fill the inputs, apply - with the configured window.
   *
   * Setting #time_selection and dispatching change is safe here: onTimeChanged()
   * reveals #customRangeContainer and returns *before* fetching when the value is
   * "custom", so this costs no request of its own.
   */
  function jumpToTimestamp(epochMs, minutes) {
    var time = find(S.timeSelect);
    var start = find(S.startDate);
    var end = find(S.endDate);
    var apply = find(S.applyRange);
    if (!time || !start || !end || !apply) { return false; }
    if (!hasValue(time, 'custom')) { return false; }

    var range = APA.leadFeed.timeWindow(epochMs, minutes);

    time.value = 'custom';
    fire(time);

    // After onTimeChanged(), not before - it fills these with a default hour when
    // they are empty, which would overwrite the range we want.
    start.value = APA.leadFeed.toDateTimeLocal(range.start);
    end.value = APA.leadFeed.toDateTimeLocal(range.end);

    apply.click();
    return true;
  }

  // ------------------------------------------------------------------- entry

  function run(stored) {
    applyTheme(stored);

    var settings = Object.assign({}, DF.DEFAULT_DATA_FEED_SETTINGS, stored[DATA_FEED_KEY] || {});
    if (settings.syncEnabled === false) { return; }

    var context = stored[ACTIVE_LEAD_KEY];
    if (!context || context.cleared) { return; }
    if (Date.now() - (context.writtenAt || 0) > DF.LEAD_CONTEXT_TTL_MS) { return; }

    // The context has to belong to the lead this page was opened for. ?ltp_id is the
    // page's own idea of which system it is showing; if the stored lead disagrees,
    // the context is stale or from another tab and applying it would filter this
    // system by another lead's county and time - while the banner cheerfully named a
    // lead that is nowhere on screen.
    //
    // Only when the URL actually carries an ltp_id. A bare /data_feed is the
    // syncSource-off case, where the lead context is still the right one to use.
    var urlLtpId = new URLSearchParams(location.search).get('ltp_id');
    if (urlLtpId && String(context.ltpId) !== String(urlLtpId)) { return; }

    // Nothing was matched on the Working Screen side, so the system was never
    // pre-selected and the filter dropdowns will never populate. Say so rather than
    // waiting ten seconds for a chain that is not running.
    if (!context.ltpId) {
      renderBanner(context, [], ['system "' + (context.feed || 'unknown') + '" (not in your Data Feed systems)'], false);
      return;
    }

    context.timeLabel = context.timestamp
      ? APA.leadFeed.toDateTimeLocal(context.timestamp).replace('T', ' ')
      : '';

    whenFiltersReady(find(S.countySelect)).then(function () {
      var result = applyFilters(context, settings);
      renderBanner(context, result.applied, result.skipped, result.clearable);
    }).catch(function (err) {
      warn('data feed filters', err);
    });
  }

  // A visible auth gate means the session is gone; there is nothing to filter and
  // touching the page would only get in the way of signing back in.
  function loginGateShowing() {
    var modals = [find(S.loginModal), find(S.mustLoginModal)];
    for (var i = 0; i < modals.length; i++) {
      if (modals[i] && modals[i].classList.contains('show')) { return true; }
    }
    return false;
  }

  if (!APA.leadFeed || !APA.leadFeed.timeWindow || !S.countySelect) {
    warn('startup', new Error('lib not loaded'));
    return;
  }

  var root = document.documentElement;
  if (root.dataset.apaDataFeed === '1') { return; }
  root.dataset.apaDataFeed = '1';

  if (loginGateShowing()) { return; }

  readStorage().then(run).catch(function (err) { warn('startup', err); });

  // Same reasoning as working-screen.js: the theme toggle should not need a reload to
  // be seen on a tab already open here.
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[SETTINGS_KEY]) { return; }
      var patch = {};
      patch[SETTINGS_KEY] = changes[SETTINGS_KEY].newValue || {};
      applyTheme(patch);
    });
  } catch (err) { warn('theme live update', err); }
})();
