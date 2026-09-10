/*
 * Toolbar popup - the only settings UI. It saves as you type; there is no Save button.
 *
 * What it writes:
 *
 *   apa.pills             - entirely
 *   apa.rules             - the terms of the first category only
 *   apa.settings          - highlightEnabled, footerReshuffleEnabled,
 *                           monitorAutoSendEnabled, darkMode only
 *   apa.dataFeedSettings  - every field except syncEnabled
 *   apa.llmSettings       - apiKey, enabled (BYOK Gemini key for Summarize)
 *
 * The keyword editor is deliberately one flat list. apa.rules supports several
 * categories with their own colours (see config/keywords.js), but the default ruleset
 * is one category on purpose, and a colour picker per category does not belong in a
 * 320px panel. Terms typed here go into that first category and inherit its colours;
 * extra categories added in the file are left untouched and keep working.
 *
 * legendEnabled and syncEnabled have no UI. Every write here merges over whatever is
 * in storage rather than rebuilding the object from the controls alone, so a field this
 * panel does not show survives a save from it. apa.dataFeedSettings gets its own merged
 * write for the same reason - folding it into the apa.settings literal would have made
 * it easy to clobber.
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
  var SS = globalThis.APA.summarizeSettings;

  var SETTINGS_KEY = 'apa.settings';
  var RULES_KEY = 'apa.rules';
  var PILLS_KEY = 'apa.pills';
  var DATA_FEED_KEY = 'apa.dataFeedSettings';
  var LLM_KEY = 'apa.llmSettings';

  var SAVE_DEBOUNCE_MS = 300;

  var els = {
    highlightEnabled: document.getElementById('highlightEnabled'),
    footerReshuffleEnabled: document.getElementById('footerReshuffleEnabled'),
    monitorAutoSendEnabled: document.getElementById('monitorAutoSendEnabled'),
    syncSource: document.getElementById('syncSource'),
    syncCounty: document.getElementById('syncCounty'),
    syncTalkgroup: document.getElementById('syncTalkgroup'),
    syncTimeRange: document.getElementById('syncTimeRange'),
    timeWindowMinutes: document.getElementById('timeWindowMinutes'),
    llmEnabled: document.getElementById('llmEnabled'),
    llmApiKey: document.getElementById('llmApiKey'),
    llmApiKeyToggle: document.getElementById('llmApiKeyToggle'),
    keywords: document.getElementById('keywords'),
    addKeyword: document.getElementById('addKeyword'),
    pills: document.getElementById('pills'),
    addPill: document.getElementById('addPill'),
    reset: document.getElementById('reset'),
    status: document.getElementById('status'),
    themeToggle: document.getElementById('themeToggle')
  };

  var state = { settings: null, rules: null, pills: null, dataFeed: null, llm: null };

  // ------------------------------------------------------------------ helpers

  function say(message) {
    els.status.textContent = message;
    if (say.timer) { clearTimeout(say.timer); }
    say.timer = setTimeout(function () { els.status.textContent = ''; }, 2000);
  }

  // ---------------------------------------------------------------- persisting

  // A blank row is a keyword still being typed, not a term. Storing '' would put an
  // empty alternative into the matcher, so they are dropped on the way out - the row
  // stays on screen until the panel is reopened.
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
  // survive a write from here. Both settings objects are merged the same way; neither
  // is rebuilt from the controls alone.
  function write() {
    chrome.storage.local.get([SETTINGS_KEY, DATA_FEED_KEY, LLM_KEY], function (got) {
      var stored = got || {};
      var patch = {};

      patch[SETTINGS_KEY] = Object.assign({}, K.DEFAULT_SETTINGS, stored[SETTINGS_KEY] || {}, {
        highlightEnabled: els.highlightEnabled.checked,
        footerReshuffleEnabled: els.footerReshuffleEnabled.checked,
        monitorAutoSendEnabled: els.monitorAutoSendEnabled.checked,
        darkMode: state.settings.darkMode === true
      });
      patch[DATA_FEED_KEY] = Object.assign({}, DF.DEFAULT_DATA_FEED_SETTINGS, stored[DATA_FEED_KEY] || {}, {
        syncSource: els.syncSource.checked,
        syncCounty: els.syncCounty.checked,
        syncTalkgroup: els.syncTalkgroup.checked,
        syncTimeRange: els.syncTimeRange.checked,
        timeWindowMinutes: readWindowMinutes()
      });
      // Its own merged write, same reason apa.dataFeedSettings gets one - folding an
      // API key into the apa.settings literal would make it easy to clobber.
      patch[LLM_KEY] = Object.assign({}, SS.DEFAULT_LLM_SETTINGS, stored[LLM_KEY] || {}, {
        apiKey: els.llmApiKey.value.trim(),
        enabled: els.llmEnabled.checked
      });
      patch[RULES_KEY] = cleanRules();
      patch[PILLS_KEY] = state.pills;

      chrome.storage.local.set(patch, function () {
        say(chrome.runtime.lastError ? 'Could not save.' : 'Saved');
      });
    });
  }

  // Coalesces a burst of keystrokes into one write, so a name typed into the keyword
  // list is one storage write rather than one per character.
  function schedule() {
    if (schedule.timer) { clearTimeout(schedule.timer); }
    schedule.timer = setTimeout(write, SAVE_DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------- rendering

  var TRASH_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>'
    + '<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>'
    + '<line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';

  // Shown for the action a click will take, not the current state: light mode shows
  // the moon (click to go dark), dark mode shows the sun (click to go light).
  var MOON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/></svg>';
  var SUN_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41'
    + 'M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';

  // Shown for the action a click will take, same convention as the theme toggle above:
  // the key is masked by default, so this starts as the "show it" eye.
  var EYE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.3 21.3 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a21.3 21.3 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/>'
    + '<line x1="1" y1="1" x2="23" y2="23"/></svg>';

  /**
   * One editable row: a text box and a trash button. Both lists in this panel are just
   * a list of strings, so they share it - onInput takes the new value, onRemove takes
   * nothing and is expected to re-render.
   */
  function buildRow(value, placeholder, removeLabel, onInput, onRemove) {
    var card = document.createElement('div');
    card.className = 'rule';

    var head = document.createElement('div');
    head.className = 'rule-head';

    var text = document.createElement('input');
    text.type = 'text';
    text.value = value || '';
    text.placeholder = placeholder;
    text.addEventListener('input', function () {
      onInput(text.value);
      schedule();
    });

    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn remove icon-btn';
    remove.title = 'Remove';
    remove.setAttribute('aria-label', removeLabel);
    remove.innerHTML = TRASH_SVG;
    remove.addEventListener('click', function () {
      onRemove();
      schedule();
    });

    head.appendChild(text);
    head.appendChild(remove);
    card.appendChild(head);
    return card;
  }

  // Focus the row just added so a new entry can be typed straight away.
  function focusLast(container) {
    var inputs = container.querySelectorAll('input[type="text"]');
    if (inputs.length) { inputs[inputs.length - 1].focus(); }
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
    els.keywords.textContent = '';
    rule.terms.forEach(function (term, index) {
      els.keywords.appendChild(buildRow(term, 'Keyword', 'Remove keyword',
        function (value) { rule.terms[index] = value; },
        function () { rule.terms.splice(index, 1); renderKeywords(); }));
    });
  }

  function renderPills() {
    els.pills.textContent = '';
    state.pills.forEach(function (pill, index) {
      els.pills.appendChild(buildRow(pill.text, 'Text', 'Remove pill',
        function (value) { state.pills[index].text = value; },
        function () { state.pills.splice(index, 1); renderPills(); }));
    });
  }

  // The popup is its own document (chrome-extension:// origin, not a content
  // script), so apa.settings.darkMode driving working-screen.js/data-feed.js's
  // html[data-apa-theme] never touched this page - it stayed light regardless of the
  // toggle below. Same attribute, same convention, applied to this document too.
  function applyTheme() {
    var dark = state.settings.darkMode === true;
    if (dark) {
      document.documentElement.setAttribute('data-apa-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-apa-theme');
    }
  }

  function renderThemeToggle() {
    var dark = state.settings.darkMode === true;
    applyTheme();
    els.themeToggle.innerHTML = dark ? SUN_SVG : MOON_SVG;
    els.themeToggle.setAttribute('aria-pressed', String(dark));
    els.themeToggle.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    els.themeToggle.setAttribute('aria-label', els.themeToggle.title);
  }

  function renderSettings() {
    els.highlightEnabled.checked = state.settings.highlightEnabled !== false;
    els.footerReshuffleEnabled.checked = state.settings.footerReshuffleEnabled !== false;
    // monitorAutoSendEnabled defaults off, so it's read as `=== true` rather than
    // `!== false` - see config/keywords.js.
    els.monitorAutoSendEnabled.checked = state.settings.monitorAutoSendEnabled === true;
    renderThemeToggle();

    // syncTalkgroup and syncTimeRange default off, so both are read as `=== true`
    // rather than `!== false` - see config/data-feed-settings.js for why.
    els.syncSource.checked = state.dataFeed.syncSource !== false;
    els.syncCounty.checked = state.dataFeed.syncCounty !== false;
    els.syncTalkgroup.checked = state.dataFeed.syncTalkgroup === true;
    els.syncTimeRange.checked = state.dataFeed.syncTimeRange === true;
    els.timeWindowMinutes.value = state.dataFeed.timeWindowMinutes;

    els.llmEnabled.checked = state.llm.enabled !== false;
    els.llmApiKey.value = state.llm.apiKey || '';
    els.llmApiKeyToggle.innerHTML = EYE_SVG;
    els.llmApiKeyToggle.setAttribute('aria-pressed', 'false');
  }

  // ------------------------------------------------------------------- wiring

  function load() {
    chrome.storage.local.get([SETTINGS_KEY, RULES_KEY, PILLS_KEY, DATA_FEED_KEY, LLM_KEY], function (got) {
      var stored = got || {};
      state.settings = Object.assign({}, K.DEFAULT_SETTINGS, stored[SETTINGS_KEY] || {});
      state.dataFeed = Object.assign({}, DF.DEFAULT_DATA_FEED_SETTINGS, stored[DATA_FEED_KEY] || {});
      state.llm = Object.assign({}, SS.DEFAULT_LLM_SETTINGS, stored[LLM_KEY] || {});
      state.rules = HL.normalizeRules(stored[RULES_KEY], K.DEFAULT_RULES);
      state.pills = NOTES.normalizePills(stored[PILLS_KEY], PC.DEFAULT_PILLS);
      renderSettings();
      renderKeywords();
      renderPills();
    });
  }

  ['highlightEnabled', 'footerReshuffleEnabled', 'monitorAutoSendEnabled',
    'syncSource', 'syncCounty', 'syncTalkgroup', 'syncTimeRange', 'llmEnabled'].forEach(function (id) {
    els[id].addEventListener('change', schedule);
  });

  // 'input' rather than 'change' so it saves as she types, like every other control
  // here - the debounce is what keeps that to one write.
  els.timeWindowMinutes.addEventListener('input', schedule);
  els.llmApiKey.addEventListener('input', schedule);

  els.llmApiKeyToggle.addEventListener('click', function () {
    var showing = els.llmApiKey.type === 'text';
    els.llmApiKey.type = showing ? 'password' : 'text';
    els.llmApiKeyToggle.innerHTML = showing ? EYE_SVG : EYE_OFF_SVG;
    els.llmApiKeyToggle.title = showing ? 'Show key' : 'Hide key';
    els.llmApiKeyToggle.setAttribute('aria-label', els.llmApiKeyToggle.title);
    els.llmApiKeyToggle.setAttribute('aria-pressed', String(!showing));
  });

  // No schedule() here or on addPill: the new row is empty, so there is nothing to
  // save until something is typed into it.
  els.addKeyword.addEventListener('click', function () {
    primaryRule().terms.push('');
    renderKeywords();
    focusLast(els.keywords);
  });

  els.addPill.addEventListener('click', function () {
    state.pills.push({ id: 'custom-' + Date.now().toString(36), text: '' });
    renderPills();
    focusLast(els.pills);
  });

  els.themeToggle.addEventListener('click', function () {
    state.settings.darkMode = state.settings.darkMode !== true;
    renderThemeToggle();
    schedule();
  });

  els.reset.addEventListener('click', function () {
    state.settings = Object.assign({}, K.DEFAULT_SETTINGS);
    state.dataFeed = Object.assign({}, DF.DEFAULT_DATA_FEED_SETTINGS);
    state.llm = Object.assign({}, SS.DEFAULT_LLM_SETTINGS);
    state.rules = K.DEFAULT_RULES.map(function (r) {
      return Object.assign({}, r, { terms: r.terms.slice() });
    });
    state.pills = PC.DEFAULT_PILLS.map(function (p) { return Object.assign({}, p); });
    renderSettings();
    renderKeywords();
    renderPills();
    write();
  });

  load();
})();
