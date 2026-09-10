/*
 * AlertPage Data Feed Assist - Phase 3, plus the Summarize feature.
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
 *     refresh on a search page. Two things drive it, both agreed decisions, neither a
 *     precedent for anything else: syncing a lead's time window on page load (agreed
 *     2026-09-02), and jumping to a transmission cited by a Summarize hyperlink
 *     (agreed 2026-09-10).
 *   - The page re-fires /get_transmissions on its own every ~30s. Ours is not the
 *     only request in flight and must not assume it is.
 *
 * Summarize (2026-09-10): a manually-triggered button in the banner sends
 * {type:'apa.summarizeLead'} to background.js, which does the actual /get_transmissions
 * and Gemini fetches (see background.js and lib/summarize.js) - nothing here ever
 * calls fetch(). This script only renders the button/loading/result states and, on a
 * hyperlink click, drives the page's own Apply Range to jump to the cited transmission.
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
  var LLM_SETTINGS_KEY = 'apa.llmSettings';

  // The page's own chain is several fetches deep. Ten seconds is generous for it and
  // still short enough that a genuinely broken load gives up rather than hanging a
  // MutationObserver on the document for the rest of the shift.
  var READY_TIMEOUT_MS = 10000;

  // Buffer around a cited transmission's timestamp when jumping to it - wider than
  // background.js's anchor-match tolerance so the page's own fetch reliably includes
  // it. A local constant rather than config/summarize-settings.js, since this page
  // doesn't otherwise need that file loaded.
  var JUMP_WINDOW_MINUTES = 2;
  var JUMP_RENDER_TIMEOUT_MS = 10000;

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
        chrome.storage.local.get([DATA_FEED_KEY, ACTIVE_LEAD_KEY, SETTINGS_KEY, LLM_SETTINGS_KEY], function (got) {
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

    // Summarize: only offered when the lead's own audio URL yielded a trigger epoch
    // (see content/working-screen.js readLeadContext()) and there's an ltp_id to
    // query. A disabled button with a tooltip beats hiding it outright - she should
    // see the feature exists and why it isn't available for this particular lead.
    if (context.ltpId) {
      var summaryRow = el('div', 'apa-df-summary');
      var summarizeBtn = button('apa-df-banner-btn apa-df-summarize-btn', 'Summarize');

      if (!context.triggerEpochSec) {
        summarizeBtn.disabled = true;
        summarizeBtn.title = "Could not read a timestamp from this lead's audio link.";
      } else {
        summarizeBtn.title = 'Read the transmissions around this alert and draft an incident summary';
        summarizeBtn.addEventListener('click', function () {
          handleSummarizeClick(summarizeBtn, summaryRow, context);
        });
      }

      actions.insertBefore(summarizeBtn, dismiss);
      bar.appendChild(summaryRow);
    }

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
   * Switch the page to a custom range around a timestamp - the lead's own (Phase 3
   * sync) or a transmission cited by a Summarize hyperlink (jumpToTransmission below).
   * Same mechanism either way: this is the one function that drives Apply Range.
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

  // ---------------------------------------------------------------- summarize

  /**
   * Wait for a specific transmission row to appear after jumpToTimestamp() re-fetches
   * the page. #transmission-list is rebuilt wholesale (innerHTML = "") on every fetch,
   * so this cannot just check once - it has to watch for the rebuild to land.
   */
  function whenTransmissionRendered(epochMs, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var list = find(S.transmissionList);
      if (!list) { reject(new Error('no transmission list')); return; }

      function find_() {
        var rows = list.querySelectorAll(S.transmissionTimestamp.sel);
        for (var i = 0; i < rows.length; i++) {
          if (String(rows[i].dataset.timestamp) === String(epochMs)) { return rows[i]; }
        }
        return null;
      }

      var already = find_();
      if (already) { resolve(already); return; }

      var timer = setTimeout(function () {
        observer.disconnect();
        reject(new Error('transmission did not render within ' + timeoutMs + 'ms'));
      }, timeoutMs);

      var observer = new MutationObserver(function () {
        var row = find_();
        if (!row) { return; }
        observer.disconnect();
        clearTimeout(timer);
        resolve(row);
      });
      observer.observe(list, { childList: true, subtree: true });
    });
  }

  /**
   * A Summarize hyperlink's target: jump the page to the cited transmission's
   * county + talkgroup, plus a tight window around its timestamp, then
   * scroll/highlight it.
   *
   * Sets county and talkgroup silently (no change dispatch) before the one trigger,
   * the same "set-then-single-trigger" discipline applyFilters() already uses - the
   * summary is built from the whole system, all talkgroups, so a cited transmission
   * routinely sits outside whatever county/talkgroup happens to be selected right now.
   * Leaving either one as-is was the actual bug behind "transmission did not render":
   * the fetch would silently exclude the very row being jumped to.
   */
  function jumpToTransmission(chip, note) {
    if (!chip || !chip.link) { return; }

    var county = find(S.countySelect);
    if (county && chip.link.talkgroupCounty != null) {
      setByValue(county, String(chip.link.talkgroupCounty));
    }

    var talkgroup = find(S.talkgroupSelect);
    if (talkgroup && chip.link.talkgroupDecimal != null) {
      setByValue(talkgroup, String(chip.link.talkgroupDecimal));
    }

    var epochMs = chip.link.transmissionTimeStamp * 1000;
    if (!jumpToTimestamp(epochMs, JUMP_WINDOW_MINUTES)) { return; }

    whenTransmissionRendered(epochMs, JUMP_RENDER_TIMEOUT_MS).then(function (timestampEl) {
      if (note) { note.textContent = ''; }
      // The class targets the whole row, not just the timestamp span the observer
      // matched on - .transmission-entry is the page's own row wrapper.
      var row = timestampEl.closest('.transmission-entry') || timestampEl;
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.add('apa-df-transmission-highlight');
      setTimeout(function () { row.classList.remove('apa-df-transmission-highlight'); }, 4000);
    }).catch(function (err) {
      warn('jump to transmission', err);
      if (note) { note.textContent = 'Could not locate that transmission on screen.'; }
    });
  }

  // Lucide's "copy" and "check" icons (ISC-licensed, https://lucide.dev), inlined as
  // static markup - this page's CSP-relevant policy is about fetching scripts, not
  // about SVG the extension itself writes, and there's no icon font/library loaded
  // here otherwise. stroke="currentColor" so .apa-df-summary-copy's `color` (and dark
  // mode's override of it) is all that needs touching to theme these.
  var ICON_COPY_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="8" y="8" width="14" height="14" rx="2" ry="2"></rect>' +
    '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>' +
    '</svg>';
  var ICON_CHECK_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M20 6 9 17l-5-5"></path>' +
    '</svg>';

  /**
   * Copy the assembled line's plain text (no hyperlinks - she's pasting this into
   * Incident Notes, not into something that preserves buttons) to the clipboard.
   * navigator.clipboard.writeText needs no extra permission when called from a
   * user-gesture handler on an https page, which every caller here is.
   */
  function copySummaryText(chips, copyBtn) {
    var text = chips.map(function (c) { return c.text; }).join('');
    navigator.clipboard.writeText(text).then(function () {
      copyBtn.innerHTML = ICON_CHECK_SVG;
      setTimeout(function () { copyBtn.innerHTML = ICON_COPY_SVG; }, 1500);
    }).catch(function (err) { warn('copy summary', err); });
  }

  /**
   * Render an assembled Chip[] (see lib/summarize.js) as a hyperlinked line, plus a
   * copy-to-clipboard button for pasting the plain text into Incident Notes. A linked
   * chip is a real <button> so it is keyboard-reachable; an unlinked one (a literal
   * like " BUILDING", or a field that didn't survive verification) is plain text.
   */
  function renderChips(container, chips) {
    container.textContent = '';
    var note = el('span', 'apa-df-summary-note');

    for (var i = 0; i < chips.length; i++) {
      var chip = chips[i];
      if (chip.link) {
        var link = button('apa-df-summary-chip', chip.text);
        link.title = 'Jump to the transmission this came from';
        link.addEventListener('click', function (c) {
          return function () { jumpToTransmission(c, note); };
        }(chip));
        container.appendChild(link);
      } else {
        container.appendChild(el('span', 'apa-df-summary-plain', chip.text));
      }
    }

    if (chips.length) {
      var copyBtn = button('apa-df-summary-copy', null);
      copyBtn.innerHTML = ICON_COPY_SVG;
      copyBtn.title = 'Copy this summary';
      copyBtn.setAttribute('aria-label', 'Copy this summary');
      copyBtn.addEventListener('click', function () { copySummaryText(chips, copyBtn); });
      container.appendChild(copyBtn);
    }

    container.appendChild(note);
  }

  var SUMMARIZE_ERROR_TEXT = {
    'no-api-key': 'Add your Gemini API key in the toolbar settings to use Summarize.',
    'no-transmissions': 'No transmissions found for this system in the search window.',
    'anchor-not-found': 'Could not confirm which transmission triggered this lead in the Data Feed.',
    'anchor-ambiguous': 'Could not confirm which transmission triggered this lead in the Data Feed.',
    'gemini-error': 'Gemini API error - try again.',
    'timeout': 'Gemini did not respond in time - try again.',
    'bad-response-shape': 'Gemini returned something unusable - try again.'
  };

  function handleSummarizeClick(btn, summaryRow, context) {
    btn.disabled = true;
    btn.textContent = 'Summarizing…';
    summaryRow.textContent = '';

    chrome.storage.local.get([LLM_SETTINGS_KEY], function (got) {
      if (chrome.runtime.lastError) { return; }
      var apiKey = ((got || {})[LLM_SETTINGS_KEY] || {}).apiKey;

      if (!apiKey) {
        btn.disabled = false;
        btn.textContent = 'Summarize';
        summaryRow.appendChild(el('span', 'apa-df-summary-error', SUMMARIZE_ERROR_TEXT['no-api-key']));
        return;
      }

      try {
        chrome.runtime.sendMessage(
          { type: 'apa.summarizeLead', ltpId: context.ltpId, triggerEpochSec: context.triggerEpochSec },
          function (reply) {
            btn.disabled = false;
            btn.textContent = 'Summarize';

            if (chrome.runtime.lastError || !reply) {
              summaryRow.appendChild(el('span', 'apa-df-summary-error', SUMMARIZE_ERROR_TEXT['gemini-error']));
              return;
            }
            if (!reply.ok) {
              // The generic line stays short on purpose; the actual reason (a
              // quota message, an invalid-key message, an HTTP status) goes to the
              // console so it's not lost, without cluttering the banner with raw
              // API text.
              var text = SUMMARIZE_ERROR_TEXT[reply.reason] || SUMMARIZE_ERROR_TEXT['gemini-error'];
              summaryRow.appendChild(el('span', 'apa-df-summary-error', text));
              if (reply.detail || reply.status) {
                warn('summarize (' + reply.reason + (reply.status ? ', HTTP ' + reply.status : '') + ')', reply.detail);
              }
              return;
            }
            renderChips(summaryRow, reply.chips);
          }
        );
      } catch (err) {
        warn('summarize', err);
        btn.disabled = false;
        btn.textContent = 'Summarize';
      }
    });
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
