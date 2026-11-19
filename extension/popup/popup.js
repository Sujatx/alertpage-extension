/*
 * Toolbar popup - the only settings UI. It saves as you type; there is no Save button.
 *
 * What it writes:
 *
 *   apa.pills             - entirely
 *   apa.rules             - the terms of the first category only
 *   apa.settings          - highlightEnabled, footerReshuffleEnabled,
 *                           monitorAutoSendEnabled, collectorEnabled, darkMode only
 *   apa.dataFeedSettings  - every field except syncEnabled
 *   apa.dispatcherId      - the "Your ID" box, only once she has typed in it (never by
 *                           load or Restore defaults)
 *
 * The keyword editor is deliberately one flat list. apa.rules supports several
 * categories with their own colours (see config/keywords.js), but the default ruleset
 * is one category on purpose, and a colour picker per category does not belong in a
 * 300px panel. Terms typed here go into that first category and inherit its colours;
 * extra categories added in the file are left untouched and keep working.
 *
 * legendEnabled and syncEnabled have no UI. Every write here merges over whatever is
 * in storage rather than rebuilding the object from the controls alone, so a field this
 * panel does not show survives a save from it.
 *
 * It never touches apa.activeLead or apa.systemIndex. Those are written by the content
 * script and the service worker and are caches, not settings.
 */
(function () {
  'use strict';

  var K = globalThis.APA.keywords;
  var PC = globalThis.APA.pillsConfig;
  var DF = globalThis.APA.dataFeed;
  var HL = globalThis.APA.highlight;
  var NOTES = globalThis.APA.notes;

  var SETTINGS_KEY = 'apa.settings';
  var RULES_KEY = 'apa.rules';
  var PILLS_KEY = 'apa.pills';
  var DATA_FEED_KEY = 'apa.dataFeedSettings';
  var ID_KEY = 'apa.dispatcherId';

  var SAVE_DEBOUNCE_MS = 300;
  var RESET_ARM_MS = 3000;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    highlightEnabled: $('highlightEnabled'),
    footerReshuffleEnabled: $('footerReshuffleEnabled'),
    monitorAutoSendEnabled: $('monitorAutoSendEnabled'),
    collectorEnabled: $('collectorEnabled'),
    collectorStatus: $('collectorStatus'),
    collectorHint: $('collectorHint'),
    dispatcherId: $('dispatcherId'),
    syncSource: $('syncSource'),
    syncCounty: $('syncCounty'),
    syncTalkgroup: $('syncTalkgroup'),
    syncTimeRange: $('syncTimeRange'),
    timeWindowMinutes: $('timeWindowMinutes'),
    minutesWrap: $('minutesWrap'),
    keywords: $('keywords'),
    keywordInput: $('keywordInput'),
    keywordCount: $('keywordCount'),
    pills: $('pills'),
    pillCount: $('pillCount'),
    addPill: $('addPill'),
    reset: $('reset'),
    status: $('status'),
    themeToggle: $('themeToggle')
  };

  // dispatcherId stays undefined until she edits it, so an untouched popup never writes ''.
  var state = { settings: null, rules: null, pills: null, dataFeed: null, dispatcherId: undefined };

  // ------------------------------------------------------------------ helpers

  function say(message, isError) {
    els.status.textContent = message;
    els.status.style.color = isError ? 'var(--danger)' : '';
    els.status.classList.add('show');
    if (say.timer) { clearTimeout(say.timer); }
    say.timer = setTimeout(function () { els.status.classList.remove('show'); }, 1500);
  }

  // ---------------------------------------------------------------- persisting

  // A blank entry is one still being typed, not a term. Storing '' would put an empty
  // alternative into the matcher, so they are dropped on the way out.
  function cleanRules() {
    return state.rules.map(function (rule) {
      return Object.assign({}, rule, {
        terms: (rule.terms || [])
          .map(function (t) { return String(t).trim(); })
          .filter(Boolean)
      });
    });
  }

  // A half-typed "" or "0" in the minutes box is not a window she wants; fall back to
  // the default rather than writing a range the Data Feed would reject.
  function readWindowMinutes() {
    var n = parseInt(els.timeWindowMinutes.value, 10);
    if (!isFinite(n) || n < 1) { return DF.DEFAULT_DATA_FEED_SETTINGS.timeWindowMinutes; }
    return Math.min(n, 720);
  }

  // Re-reads first so the fields this popup does not show (legendEnabled, syncEnabled)
  // survive a write from here.
  function write() {
    chrome.storage.local.get([SETTINGS_KEY, DATA_FEED_KEY], function (got) {
      var stored = got || {};
      var patch = {};

      patch[SETTINGS_KEY] = Object.assign({}, K.DEFAULT_SETTINGS, stored[SETTINGS_KEY] || {}, {
        highlightEnabled: els.highlightEnabled.checked,
        footerReshuffleEnabled: els.footerReshuffleEnabled.checked,
        monitorAutoSendEnabled: els.monitorAutoSendEnabled.checked,
        collectorEnabled: els.collectorEnabled.checked,
        darkMode: state.settings.darkMode === true
      });
      patch[DATA_FEED_KEY] = Object.assign({}, DF.DEFAULT_DATA_FEED_SETTINGS, stored[DATA_FEED_KEY] || {}, {
        syncSource: els.syncSource.checked,
        syncCounty: els.syncCounty.checked,
        syncTalkgroup: els.syncTalkgroup.checked,
        syncTimeRange: els.syncTimeRange.checked,
        timeWindowMinutes: readWindowMinutes()
      });
      patch[RULES_KEY] = cleanRules();
      patch[PILLS_KEY] = state.pills;
      if (state.dispatcherId !== undefined) { patch[ID_KEY] = state.dispatcherId; }

      chrome.storage.local.set(patch, function () {
        if (chrome.runtime.lastError) { say('Could not save', true); } else { say('Saved'); }
      });
    });
  }

  // Coalesces a burst of keystrokes into one write.
  function schedule() {
    if (schedule.timer) { clearTimeout(schedule.timer); }
    schedule.timer = setTimeout(write, SAVE_DEBOUNCE_MS);
    renderCollectorHint();
  }

  // ---------------------------------------------------------------- rendering

  // Shown for the action a click will take: light mode shows the moon (go dark).
  var MOON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/></svg>';
  var SUN_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41'
    + 'M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';

  function xButton(label, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'x-btn';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.textContent = '×';
    b.addEventListener('click', onClick);
    return b;
  }

  // Terms are edited on the first category only - see the note at the top of the file.
  function primaryRule() {
    if (!state.rules.length) {
      state.rules.push(Object.assign({}, K.DEFAULT_RULES[0], { terms: [] }));
    }
    return state.rules[0];
  }

  function renderKeywords() {
    var rule = primaryRule();
    rule.terms = rule.terms.filter(function (t) { return String(t).trim(); });
    Array.prototype.slice.call(els.keywords.querySelectorAll('.chip')).forEach(function (c) { c.remove(); });
    rule.terms.forEach(function (term, index) {
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.appendChild(document.createTextNode(term));
      chip.appendChild(xButton('Remove ' + term, function () {
        rule.terms.splice(index, 1);
        renderKeywords();
        schedule();
        els.keywordInput.focus();
      }));
      els.keywords.insertBefore(chip, els.keywordInput);
    });
    els.keywordCount.textContent = rule.terms.length;
  }

  // Returns true if the box held a term (added, or already present).
  function addKeywordFromInput() {
    var term = els.keywordInput.value.replace(/,/g, ' ').trim();
    if (!term) { return false; }
    var rule = primaryRule();
    var exists = rule.terms.some(function (t) { return String(t).toLowerCase() === term.toLowerCase(); });
    if (!exists) { rule.terms.push(term); }
    els.keywordInput.value = '';
    renderKeywords();
    if (!exists) { schedule(); } else { say('Already listed'); }
    return true;
  }

  function renderPills() {
    els.pills.textContent = '';
    state.pills.forEach(function (pill, index) {
      var row = document.createElement('div');
      row.className = 'pill-row';
      var input = document.createElement('input');
      input.type = 'text';
      input.value = pill.text || '';
      input.placeholder = 'Pill text';
      input.setAttribute('aria-label', 'Pill text');
      input.addEventListener('input', function () {
        state.pills[index].text = input.value;
        schedule();
      });
      row.appendChild(input);
      row.appendChild(xButton('Remove pill', function () {
        state.pills.splice(index, 1);
        renderPills();
        schedule();
      }));
      els.pills.appendChild(row);
    });
    els.pillCount.textContent = state.pills.length;
  }

  // The popup is its own document, so the html[data-apa-theme] the content scripts
  // set never reaches it - same attribute, applied here too.
  function renderThemeToggle() {
    var dark = state.settings.darkMode === true;
    if (dark) {
      document.documentElement.setAttribute('data-apa-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-apa-theme');
    }
    els.themeToggle.innerHTML = dark ? SUN_SVG : MOON_SVG;
    els.themeToggle.setAttribute('aria-pressed', String(dark));
    els.themeToggle.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    els.themeToggle.setAttribute('aria-label', els.themeToggle.title);
  }

  // The minutes only matter while the time window is synced; dim them otherwise.
  function renderMinutesState() {
    var on = els.syncTimeRange.checked;
    els.minutesWrap.classList.toggle('off', !on);
    els.timeWindowMinutes.disabled = !on;
  }

  function renderSettings() {
    els.highlightEnabled.checked = state.settings.highlightEnabled !== false;
    els.footerReshuffleEnabled.checked = state.settings.footerReshuffleEnabled !== false;
    // Defaults off, so read as `=== true` - see config/keywords.js.
    els.monitorAutoSendEnabled.checked = state.settings.monitorAutoSendEnabled === true;
    els.collectorEnabled.checked = state.settings.collectorEnabled !== false;
    renderThemeToggle();

    // syncTalkgroup and syncTimeRange default off - see config/data-feed-settings.js.
    els.syncSource.checked = state.dataFeed.syncSource !== false;
    els.syncCounty.checked = state.dataFeed.syncCounty !== false;
    els.syncTalkgroup.checked = state.dataFeed.syncTalkgroup === true;
    els.syncTimeRange.checked = state.dataFeed.syncTimeRange === true;
    els.timeWindowMinutes.value = state.dataFeed.timeWindowMinutes;
    renderMinutesState();
  }

  // apc.status is written by the service worker; this panel only reads it.
  function renderCollectorStatus(status) {
    status = status || {};
    els.collectorStatus.textContent = (status.queued || 0) + ' queued · ' + (status.sent || 0) +
      ' sent · ' + (status.quarantined || 0) + ' quarantined';
    renderCollectorHint();
  }

  // Read from the box as typed, not from the service worker, so the hint clears at once.
  function renderCollectorHint() {
    els.collectorHint.hidden = !globalThis.APA.envelope.dispatcherIdProblem(els.dispatcherId.value);
  }

  function renderAll() {
    renderSettings();
    renderKeywords();
    renderPills();
  }

  // ------------------------------------------------------------------- wiring

  function load() {
    chrome.storage.local.get([SETTINGS_KEY, RULES_KEY, PILLS_KEY, DATA_FEED_KEY, ID_KEY, 'apc.status'], function (got) {
      var stored = got || {};
      var prefill = globalThis.APA.envelope.migrateDispatcherId(stored[PILLS_KEY], stored[ID_KEY]);
      if (typeof stored[ID_KEY] === 'string') { els.dispatcherId.value = stored[ID_KEY]; }
      else if (prefill !== null) { els.dispatcherId.value = prefill; state.dispatcherId = prefill; schedule(); }
      state.settings = Object.assign({}, K.DEFAULT_SETTINGS, stored[SETTINGS_KEY] || {});
      state.dataFeed = Object.assign({}, DF.DEFAULT_DATA_FEED_SETTINGS, stored[DATA_FEED_KEY] || {});
      state.rules = HL.normalizeRules(stored[RULES_KEY], K.DEFAULT_RULES);
      state.pills = NOTES.normalizePills(stored[PILLS_KEY], PC.DEFAULT_PILLS);
      renderAll();
      renderCollectorStatus(stored['apc.status']);
    });
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes['apc.status']) { renderCollectorStatus(changes['apc.status'].newValue); }
  });

  ['highlightEnabled', 'footerReshuffleEnabled', 'monitorAutoSendEnabled', 'collectorEnabled',
    'syncSource', 'syncCounty', 'syncTalkgroup', 'syncTimeRange'].forEach(function (id) {
    els[id].addEventListener('change', schedule);
  });
  els.syncTimeRange.addEventListener('change', renderMinutesState);
  els.timeWindowMinutes.addEventListener('input', schedule);
  els.dispatcherId.addEventListener('input', function () {
    state.dispatcherId = els.dispatcherId.value.trim().toLowerCase();
    schedule();
  });

  els.keywordInput.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ',') {
      ev.preventDefault();
      addKeywordFromInput();
    } else if (ev.key === 'Backspace' && !els.keywordInput.value) {
      // Same as any tag field: Backspace on an empty box takes the last chip.
      var rule = primaryRule();
      if (rule.terms.length) { rule.terms.pop(); renderKeywords(); schedule(); }
    }
  });
  // Clicking away with a half-typed term keeps it rather than silently dropping it.
  els.keywordInput.addEventListener('blur', addKeywordFromInput);
  els.keywords.addEventListener('click', function (ev) {
    if (ev.target === els.keywords) { els.keywordInput.focus(); }
  });

  // No schedule() here: the new row is empty, so there is nothing to save yet.
  els.addPill.addEventListener('click', function () {
    state.pills.push({ id: 'custom-' + Date.now().toString(36), text: '' });
    renderPills();
    var inputs = els.pills.querySelectorAll('input');
    if (inputs.length) { inputs[inputs.length - 1].focus(); }
  });

  els.themeToggle.addEventListener('click', function () {
    state.settings.darkMode = state.settings.darkMode !== true;
    renderThemeToggle();
    schedule();
  });

  // Two clicks: it wipes her keywords and pills, so the first one only arms it.
  els.reset.addEventListener('click', function () {
    if (!els.reset.classList.contains('armed')) {
      els.reset.classList.add('armed');
      els.reset.textContent = 'Click again to restore';
      els.reset.timer = setTimeout(function () {
        els.reset.classList.remove('armed');
        els.reset.textContent = 'Restore defaults';
      }, RESET_ARM_MS);
      return;
    }
    clearTimeout(els.reset.timer);
    els.reset.classList.remove('armed');
    els.reset.textContent = 'Restore defaults';
    state.settings = Object.assign({}, K.DEFAULT_SETTINGS);
    state.dataFeed = Object.assign({}, DF.DEFAULT_DATA_FEED_SETTINGS);
    state.rules = K.DEFAULT_RULES.map(function (r) {
      return Object.assign({}, r, { terms: r.terms.slice() });
    });
    state.pills = PC.DEFAULT_PILLS.map(function (p) { return Object.assign({}, p); });
    renderAll();
    write();
  });

  load();
})();
