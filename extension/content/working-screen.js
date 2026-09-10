/*
 * AlertPage Working Screen Assist - Phase 1 content script.
 *
 *   1A  reformat the lead-detail blob (Transcript on its own line, bold, black)
 *   1B  highlight configurable incident keywords inside the transcription
 *   1C  embed an audio player
 *   3   a Data Feed link carrying this lead's system, county and time
 *       a Monitor button that fills (never sends) the chat with /m <county>
 *
 * Guardrails, deliberate:
 *   - never clicks, submits, enables, or disables anything on the form
 *   - never makes a network request from this script. Both of that need lives in
 *     background.js, behind chrome.runtime.sendMessage: the Data Feed's system list
 *     (Phase 3), and (Summarize feature, 2026-09-10) /get_transmissions and Gemini.
 *   - never removes existing functionality (the raw audio link stays)
 *   - if anything fails to parse, the page is left exactly as the server rendered it
 *
 * readLeadContext() also captures the lead's own audio URL and, from it, the exact
 * epoch second the transmission that triggered this alert was sent - used later, from
 * the Data Feed side, to anchor the Summarize feature's transcript window (see
 * lib/transmissions.js). Nothing here makes a network request; it just reads the same
 * link findAudioLink()/enhanceAudio() already use for the inline player.
 *
 * The Working Screen is torn down and re-rendered by the server after every lead
 * action (302 -> /web/working-queue/), so this script re-runs from scratch on every
 * load. Every mutation below is idempotent and guarded by a data-apa-* marker.
 */
(function () {
  'use strict';

  var APA = globalThis.APA || {};
  var S = APA.selectors || {};
  var K = APA.keywords || {};
  var LEAD = APA.lead || {};
  var HL = APA.highlight || {};
  var PC = APA.pillsConfig || {};
  var NOTES = APA.notes || {};
  var DF = APA.dataFeed || {};
  var FEED = APA.leadFeed || {};
  var TRANS = APA.transmissions || {};

  var RULES_KEY = 'apa.rules';
  var SETTINGS_KEY = 'apa.settings';
  var PILLS_KEY = 'apa.pills';
  var DATA_FEED_KEY = 'apa.dataFeedSettings';
  var ACTIVE_LEAD_KEY = 'apa.activeLead';

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

  // el() cannot build these: a <button> inside AlertPage's <form> defaults to
  // type="submit", and every button this extension adds must be type="button" or
  // clicking it submits the lead. That is the guardrail, not a detail.
  function button(className, text) {
    var node = document.createElement('button');
    node.type = 'button';
    if (className) { node.className = className; }
    if (text != null) { node.appendChild(document.createTextNode(text)); }
    return node;
  }

  function readStorage() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([RULES_KEY, SETTINGS_KEY, PILLS_KEY, DATA_FEED_KEY], function (got) {
          if (chrome.runtime.lastError) { resolve({}); return; }
          resolve(got || {});
        });
      } catch (err) {
        resolve({});   // extension context invalidated mid-navigation, etc.
      }
    });
  }

  // ------------------------------------------------------------ 1A + 1B: lead

  /**
   * Primary path is the verified unique id #working_lead_id, walked up to its
   * .form-group. That avoids depending on the generic Bootstrap utility classes
   * that happen to sit on the blob itself. Fallback is content-based, never
   * class-based, so a template restyle does not break it.
   */
  function findLeadBlob() {
    var anchor = document.querySelector(S.leadIdAnchor.sel);
    if (anchor) {
      var group = anchor.closest('.form-group');
      if (group) {
        var span = group.querySelector(S.leadBlobWithinGroup.sel);
        if (span && LEAD.looksLikeLeadBlob(span.textContent)) { return span; }
      }
    }
    var candidates = document.querySelectorAll(S.leadBlobFallback.sel);
    for (var i = 0; i < candidates.length; i++) {
      if (LEAD.looksLikeLeadBlob(candidates[i].textContent)) { return candidates[i]; }
    }
    return null;
  }

  /**
   * Turn the transcript into text nodes plus <mark>/<a> elements. Built node by node -
   * page text is never passed through innerHTML.
   *
   * Links are found independently of the keyword-highlight toggle - a URL in the
   * transcript (e.g. a feed link) should stay clickable whether or not highlighting
   * is on. A keyword range that overlaps a link range loses to the link, since the
   * two features would otherwise fight over the same characters.
   */
  function renderTranscript(text, rules, highlightEnabled) {
    var frag = document.createDocumentFragment();
    var used = [];

    var linkRanges = HL.findLinkRanges(text);
    var kwRanges = highlightEnabled ? HL.findRanges(text, rules) : [];

    var ranges = linkRanges.map(function (r) {
      return { start: r.start, end: r.end, type: 'link', text: r.text };
    });
    for (var k = 0; k < kwRanges.length; k++) {
      var kr = kwRanges[k];
      var overlapsLink = linkRanges.some(function (lr) {
        return kr.start < lr.end && kr.end > lr.start;
      });
      if (!overlapsLink) {
        ranges.push({ start: kr.start, end: kr.end, type: 'mark', ruleId: kr.ruleId, text: kr.text });
      }
    }
    ranges.sort(function (a, b) { return a.start - b.start; });

    var byId = Object.create(null);
    for (var i = 0; i < rules.length; i++) { byId[rules[i].id] = rules[i]; }

    var cursor = 0;
    for (var j = 0; j < ranges.length; j++) {
      var r = ranges[j];
      if (r.start > cursor) {
        frag.appendChild(document.createTextNode(text.slice(cursor, r.start)));
      }

      if (r.type === 'link') {
        var link = el('a', 'apa-transcript-link', r.text);
        link.href = r.text;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        frag.appendChild(link);
      } else {
        var rule = byId[r.ruleId];
        var mark = el('mark', 'apa-kw');
        mark.dataset.apaRule = r.ruleId;
        if (rule) {
          mark.style.backgroundColor = rule.bg;
          mark.style.color = rule.fg;
          mark.title = rule.label;
          if (used.indexOf(r.ruleId) === -1) { used.push(r.ruleId); }
        }
        mark.appendChild(document.createTextNode(r.text));
        frag.appendChild(mark);
      }

      cursor = r.end;
    }

    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }
    return { frag: frag, used: used };
  }

  function buildField(labelText, valueText, extraClass) {
    var field = el('div', 'apa-field' + (extraClass ? ' ' + extraClass : ''));
    field.appendChild(el('span', 'apa-label', labelText));
    field.appendChild(el('span', 'apa-value', valueText));
    return field;
  }

  function buildLegend(usedIds, rules) {
    var byId = Object.create(null);
    for (var i = 0; i < rules.length; i++) { byId[rules[i].id] = rules[i]; }

    var legend = el('div', 'apa-legend');
    legend.appendChild(el('span', 'apa-legend-title', 'Highlighted:'));
    for (var j = 0; j < usedIds.length; j++) {
      var rule = byId[usedIds[j]];
      if (!rule) { continue; }
      var chip = el('span', 'apa-legend-chip', rule.label);
      chip.style.backgroundColor = rule.bg;
      chip.style.color = rule.fg;
      legend.appendChild(chip);
    }
    return legend;
  }

  /*
   * Order is the reading order she actually uses: transcript first, then source,
   * then the low-value alert metadata compressed into a single two-column row.
   * County is not here - it sits in the header, opposite the lead id.
   */
  function buildLeadBlock(parsed, settings, rules) {
    var block = el('div', 'apa-lead');
    block.setAttribute('data-apa-block', 'lead');

    var usedIds = [];
    if (parsed.transcript) {
      var field = el('div', 'apa-field apa-field-transcript');
      field.appendChild(el('span', 'apa-label apa-label-transcript', 'Transcript'));

      var body = el('div', 'apa-value apa-transcript');
      var rendered = renderTranscript(parsed.transcript, rules, settings.highlightEnabled !== false);
      body.appendChild(rendered.frag);
      usedIds = rendered.used;
      field.appendChild(body);
      block.appendChild(field);
    }

    if (settings.legendEnabled !== false && usedIds.length) {
      block.appendChild(buildLegend(usedIds, rules));
    }

    if (parsed.feed) {
      block.appendChild(buildField('Source', parsed.feed, 'apa-field-feed'));
    }

    if (parsed.category || parsed.keywords) {
      var meta = el('div', 'apa-meta-row');
      if (parsed.category) { meta.appendChild(buildField('Alert Category', parsed.category)); }
      if (parsed.keywords) { meta.appendChild(buildField('Alert Keywords', parsed.keywords)); }
      block.appendChild(meta);
    }

    // Anything the parser could not place is still shown, so no text is ever lost.
    if (parsed.extra && parsed.extra.length) {
      block.appendChild(buildField('Other', parsed.extra.join(' — '), 'apa-field-extra'));
    }

    return block;
  }

  /**
   * Click-to-reveal arrow for the original server text behind `blob`. Always
   * present, above the Transcript field - some leads say things we do not
   * track, so the original text must stay reachable rather than vanish behind
   * our rendering of it.
   */
  function buildRawToggle(blob) {
    var arrow = el('span', 'apa-toggle-arrow', String.fromCharCode(0x25B8));
    var toggle = button('apa-lead-raw-toggle');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.appendChild(arrow);
    toggle.appendChild(document.createTextNode(' Show original text'));

    toggle.addEventListener('click', function () {
      var expanded = toggle.getAttribute('aria-expanded') === 'true';
      if (expanded) {
        blob.setAttribute('hidden', '');
        blob.style.setProperty('display', 'none', 'important');
        toggle.setAttribute('aria-expanded', 'false');
        arrow.textContent = String.fromCharCode(0x25B8);
        toggle.lastChild.textContent = ' Show original text';
      } else {
        blob.removeAttribute('hidden');
        blob.style.removeProperty('display');
        toggle.setAttribute('aria-expanded', 'true');
        arrow.textContent = String.fromCharCode(0x25BE);
        toggle.lastChild.textContent = ' Hide original text';
      }
    });

    return toggle;
  }

  function enhanceLeadDetail(settings, rules) {
    var blob = findLeadBlob();
    if (!blob || blob.dataset.apaDone === '1') { return; }

    var parsed = LEAD.parseLead(blob.textContent);
    if (!parsed.ok) { return; }   // unrecognised shape - leave the server output alone

    var block = buildLeadBlock(parsed, settings, rules);

    var toggle = buildRawToggle(blob);

    blob.dataset.apaDone = '1';
    blob.setAttribute('hidden', '');
    // Must be inline AND !important. The blob carries Bootstrap's .d-block, whose
    // `display: block !important` beats both a plain inline style and reboot's [hidden].
    blob.style.setProperty('display', 'none', 'important');

    // Order: toggle, then (when expanded) the original text, then our formatted
    // block - so "Show original text" always sits directly above the Transcript
    // field, whether or not we found one to render.
    blob.parentNode.insertBefore(toggle, blob);
    blob.parentNode.insertBefore(block, blob.nextSibling);
  }

  /**
   * The bare county value, e.g. "Kent" - what #countyname holds. Shared by the Data
   * Feed context (which wants exactly this) and the Monitor button (/m <county>).
   */
  function countyBareValue() {
    var countyEl = document.querySelector(S.countyName.sel);
    return countyEl ? String(countyEl.value || '').trim() : '';
  }

  /**
   * County lives in the Address section further down the page, not in the lead blob.
   * #countyname is an editable input, so the header mirrors it rather than owning it.
   */
  function readCounty() {
    var stateEl = document.querySelector(S.stateName.sel);
    var county = countyBareValue();
    var state = stateEl ? String(stateEl.value || '').trim() : '';

    if (!county && !state) { return ''; }
    return county && state ? county + ', ' + state : (county || state);
  }

  function buildCountyBlock() {
    var wrap = el('span', 'apa-head-county');
    wrap.appendChild(el('span', 'apa-head-county-label', 'County'));

    var value = el('span', 'apa-head-county-value', readCounty());
    wrap.appendChild(value);

    // She can correct the county on the form; keep the header honest if she does.
    var countyEl = document.querySelector(S.countyName.sel);
    if (countyEl) {
      countyEl.addEventListener('input', function () {
        value.textContent = readCounty();
      });
    }
    return wrap;
  }

  /**
   * Turn the page's own lead-id/time label into a two-sided header row:
   * lead id + timestamp on the left, county on the right.
   *
   * The existing children are wrapped, never replaced - #working_lead_id stays in the
   * document with its innerHTML untouched, because the page's own code reads it.
   */
  function enhanceHeader() {
    var anchor = document.querySelector(S.leadIdAnchor.sel);
    if (!anchor) { return; }

    var label = anchor.parentNode;
    if (!label || label.dataset.apaHead === '1') { return; }
    label.dataset.apaHead = '1';

    var time = label.querySelector('.text-muted');
    if (time && time !== anchor) { time.classList.add('apa-lead-time'); }

    var left = el('span', 'apa-head-left');
    while (label.firstChild) { left.appendChild(label.firstChild); }
    label.appendChild(left);

    // Everything on the right shares one cluster so the Data Feed link (Phase 3,
    // added later and asynchronously) has somewhere to land without fighting
    // .apa-head-county's margin-left:auto for the free space.
    var right = el('span', 'apa-head-right');
    if (readCounty()) { right.appendChild(buildCountyBlock()); }
    label.appendChild(right);

    label.classList.add('apa-head');
  }

  // ------------------------------------------------------- 3: Data Feed bridge

  /**
   * The lead's own fields, read straight from the page rather than from anything
   * this script has already built.
   *
   * County is read bare here on purpose - readCounty() returns the header's display
   * string ("Kent, Michigan"), and the Data Feed's county filter wants just "Kent",
   * which is exactly what #countyname holds.
   */
  function readLeadContext() {
    var anchor = document.querySelector(S.leadIdAnchor.sel);
    var timeEl = document.querySelector('.apa-lead-time');
    var blob = findLeadBlob();
    var parsed = blob ? LEAD.parseLead(blob.textContent) : null;

    var audioLink = findAudioLink();
    var audioUrl = audioLink
      ? LEAD.extractAudioUrl(audioLink.textContent, audioLink.getAttribute('onclick'), audioLink.getAttribute('href'))
      : '';

    return {
      leadId: anchor ? String(anchor.textContent || '').trim() : '',
      feed: parsed && parsed.ok ? parsed.feed : '',
      county: countyBareValue(),
      timestamp: timeEl ? FEED.parseLeadTime(timeEl.textContent) : null,
      audioUrl: audioUrl || null,
      triggerEpochSec: audioUrl && TRANS.extractEpochFromAudioUrl ? TRANS.extractEpochFromAudioUrl(audioUrl) : null
    };
  }

  function requestSystemIndex(force) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: 'apa.systemIndex', force: !!force }, function (reply) {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(reply || null);
        });
      } catch (err) {
        resolve(null);   // extension context invalidated mid-navigation
      }
    });
  }

  /**
   * Hand the lead's context to the Data Feed content script. chrome.storage.local is
   * shared across both origins, which is why no background relay is needed for this
   * half - only for the one fetch.
   */
  /**
   * The Data Feed reads this key and filters a live page from it, so only a live
   * Working Screen may write it.
   *
   * Redundant against the manifest today - this script only matches
   * dispatch.alertpage.net - and kept anyway, because the one thing that ever ran it
   * anywhere else did real damage. The removed mock/preview.html harness ran this
   * exact script against captured markup, and under chrome-extension:// it got the
   * real chrome.storage.local: opening it stamped the capture's fixture lead
   * (27253318, FDNY Analog (BCFY Calls), county New York) into apa.activeLead, and
   * the next Data Feed visit filtered an Ohio lead from a New York fixture. Any future
   * page that loads this script needs to trip this guard, not learn that lesson again.
   */
  function writeActiveLead(context) {
    if (location.hostname !== 'dispatch.alertpage.net') { return; }

    var patch = {};
    patch[ACTIVE_LEAD_KEY] = Object.assign({}, context, { writtenAt: Date.now() });
    try {
      chrome.storage.local.set(patch, function () { void chrome.runtime.lastError; });
    } catch (err) {
      warn('active lead', err);
    }
  }

  /**
   * A link to the Data Feed, pre-filtered to this lead.
   *
   * Opens in a *separate, reused* tab. She needs both screens visible at once -
   * navigating away from the Working Screen loses the lead she is triaging, and the
   * 15-minute lead timer with it.
   *
   * The reuse is done by the service worker (chrome.tabs), not by the target name.
   * target="apa-data-feed" was tried and cannot work: Chrome clears window.name on
   * cross-origin navigation, and this link's very first navigation is cross-origin
   * (dispatch -> ap-portal), so the tab lost its name immediately and every click
   * opened a new one. The target attribute stays only as the fallback for when the
   * service worker cannot be reached. See background.js openDataFeed().
   *
   * An <a href> rather than a button so ctrl-click and middle-click still behave,
   * and because an anchor cannot submit the form the way a stray <button> could.
   *
   * Rendered immediately with a bare /data_feed href, then upgraded to
   * ?ltp_id=<n> once the system resolves. If the lookup fails - she is signed out
   * of ap-portal, the fetch is blocked, the system is not in her list - the bare
   * link is what she keeps, which is still one click better than typing the URL.
   */
  /**
   * Hand a plain left-click to the service worker so it can reuse the open Data Feed
   * tab. Modified clicks (ctrl/cmd/shift/alt, middle-click) are left alone so they keep
   * their native meaning - that is half the reason this is an <a> and not a button.
   *
   * If the message cannot be delivered - the extension was reloaded and this content
   * script is orphaned - fall back to window.open. That path can be popup-blocked
   * because the gesture has expired by the time the callback runs; it is the failure
   * mode of a failure mode, and a reload of the page fixes it.
   */
  function openInDataFeedTab(ev) {
    if (ev.defaultPrevented || ev.button !== 0) { return; }
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) { return; }

    var url = ev.currentTarget.href;
    ev.preventDefault();

    try {
      chrome.runtime.sendMessage({ type: 'apa.openDataFeed', url: url }, function (reply) {
        if (chrome.runtime.lastError || !reply || !reply.ok) {
          window.open(url, DF.DATA_FEED_TARGET);
        }
      });
    } catch (err) {
      warn('data feed tab', err);
      window.open(url, DF.DATA_FEED_TARGET);
    }
  }

  function enhanceDataFeedLink(dfSettings) {
    if (dfSettings.syncEnabled === false) { return; }
    if (!FEED.matchSystem) { return; }

    var label = document.querySelector(S.leadIdAnchor.sel);
    label = label && label.closest('.apa-head');
    var right = label && label.querySelector('.apa-head-right');
    if (!right || right.dataset.apaDataFeed === '1') { return; }
    right.dataset.apaDataFeed = '1';

    var link = el('a', 'apa-data-feed-link', 'Data Feed ↗');
    link.href = DF.DATA_FEED_ORIGIN + DF.DATA_FEED_PATH;
    link.target = DF.DATA_FEED_TARGET;
    link.title = 'Open the Data Feed filtered to this lead, in its own tab';
    link.addEventListener('click', openInDataFeedTab);
    right.appendChild(link);

    var context = readLeadContext();
    if (!context.feed) {
      writeActiveLead(context);
      return;
    }

    requestSystemIndex(false).then(function (reply) {
      var index = reply && reply.index;
      var match = index ? FEED.matchSystem(context.feed, index) : null;

      // A system the cached list has never heard of is more likely new than absent,
      // so it is worth one refetch before giving up on it.
      if (!match && index && reply.fetchedAt) {
        return requestSystemIndex(true).then(function (fresh) {
          return fresh && fresh.index ? FEED.matchSystem(context.feed, fresh.index) : null;
        });
      }
      return match;
    }).then(function (match) {
      if (match) {
        context.ltpId = match.ltpId;
        context.systemName = match.systemName;
        context.talkgroupName = match.talkgroupName;
        context.ambiguous = match.ambiguous;
        // ?ltp_id is how the Data Feed pre-selects the system - it reads the param
        // itself on load. With source sync off she gets the bare page and picks the
        // system herself, which is the point of the toggle.
        if (dfSettings.syncSource !== false) {
          link.href = DF.DATA_FEED_ORIGIN + DF.DATA_FEED_PATH + '?ltp_id=' + match.ltpId;
          link.title = 'Open the Data Feed filtered to ' + match.systemName;
        }
      }
      writeActiveLead(context);
    }).catch(function (err) {
      warn('data feed link', err);
      writeActiveLead(context);
    });
  }

  /**
   * A shortcut for the "MONITORING <County> <State>" chat broadcast she'd otherwise
   * type by hand. Always fills the chat textbox with "/m <county>" and focuses it.
   * With monitorAutoSendEnabled off (the default) that's all it does - she reviews
   * (and can add the state) and hits Send herself. Turned on, it also clicks the
   * chat's own Send button (#msg-submit-1) so monitoring starts instantly - the one
   * explicit exception to this script never clicking anything else on the Working
   * Screen.
   */
  function enhanceMonitorButton(settings) {
    var heading = document.querySelector(S.leadDetailsHeading.sel);
    if (!heading || heading.dataset.apaMonitor === '1') { return; }
    heading.dataset.apaMonitor = '1';

    var btn = button('apa-monitor-button', 'Monitor');
    btn.title = 'Fill the chat with /m <county> - review and send it yourself';
    btn.addEventListener('click', function () {
      var input = document.querySelector(S.chatInput.sel);
      if (!input) { return; }
      input.value = '/m ' + countyBareValue();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();

      if (settings.monitorAutoSendEnabled === true) {
        var sendBtn = document.querySelector(S.chatSendButton.sel);
        if (sendBtn) { sendBtn.click(); }

        // Stays "Monitoring" for the rest of this lead - a fresh page load for the
        // next lead builds a brand new button, back to "Monitor".
        btn.textContent = 'Monitoring';
        btn.classList.add('apa-monitor-button--active');
      }
    });
    heading.insertAdjacentElement('afterend', btn);
  }

  // -------------------------------------------------- city -> jurisdiction mirror

  /**
   * Keep Jurisdiction in step with City.
   *
   * Why a poll rather than an event listener: both code paths that populate #cityname
   * do it with jQuery .val() (`:2271` via /web/get-incident-address/, `:2578` via
   * /web/address-details/), which fires no input or change event - and #cityname is
   * `disabled`, so it could not fire one anyway. There is nothing to listen to.
   *
   * The address-autocomplete path is the one that matters: it clears #jurisdiction
   * (`:2562`) and then never puts anything back, so picking an address fills City and
   * leaves Jurisdiction empty. This closes that gap.
   *
   * Writes only when City actually changes, so a Jurisdiction she typed herself is
   * preserved until the next address lookup. Never blanks the field. No events are
   * dispatched - the page sets this field silently with .val(), and doing the same is
   * the conservative choice given app.js and volunteer_dispatcher_script.js were not
   * captured and may hold listeners.
   */
  function mirrorCityToJurisdiction() {
    var city = document.querySelector(S.cityName.sel);
    var jurisdiction = document.querySelector(S.jurisdiction.sel);
    if (!city || !jurisdiction) { return; }

    var lastCity = null;

    function sync() {
      var value = String(city.value == null ? '' : city.value).trim();
      if (value === lastCity) { return; }   // City has not moved - leave her edits alone
      lastCity = value;

      if (!value) { return; }                          // never blank Jurisdiction
      if (jurisdiction.value === value) { return; }    // already correct
      jurisdiction.value = value;
    }

    sync();
    // The page is torn down on every lead action, which clears this along with it.
    setInterval(sync, 500);
  }

  // ---------------------------------------------------- internal notes pills

  /**
   * Quick-fill buttons next to the Internal Notes label. Clicking one replaces the
   * field's entire contents with the pill's preset text - a one-click version of
   * retyping the short codes she already uses there ("dup", her own AP handle).
   *
   * A synthetic 'change' event is dispatched after setting .value so the page's own
   * $('#internal-notes').on('change', ...) handler (working-screen.html:2303) still
   * clears its required-field error styling. Nothing is submitted or clicked - this
   * only re-runs the page's existing error-clear logic for a field we just filled.
   */
  function enhanceNotesPills(pills) {
    if (!pills || !pills.length) { return; }

    var textarea = document.querySelector(S.internalNotes.sel);
    if (!textarea) { return; }

    var group = textarea.closest('.form-group');
    var label = group ? group.querySelector('label.control-label') : null;
    if (!label || label.dataset.apaPills === '1') { return; }
    label.dataset.apaPills = '1';
    label.classList.add('apa-notes-label-row');

    // The 'userID' pill ships with a literal "AP***" placeholder rather than a real
    // handle - nudge a first-time user to replace it (in the toolbar popup) instead
    // of leaving them to click it, get "AP***" in Internal Notes, and wonder why.
    // Only shown while the text is still that placeholder; editing it in the popup
    // removes the tooltip along with the reason for it.
    var defaultPill = (PC.DEFAULT_PILLS || []).filter(function (p) { return p.id === 'userID'; })[0];
    var userIdPlaceholder = defaultPill ? defaultPill.text : null;

    var row = el('span', 'apa-notes-pills');
    for (var i = 0; i < pills.length; i++) {
      (function (pill) {
        var btn = button('apa-pill', pill.text);
        if (pill.id === 'userID' && userIdPlaceholder && pill.text === userIdPlaceholder) {
          btn.title = 'Set your AP ID in the toolbar settings (click the extension icon) to use this pill.';
        }
        btn.addEventListener('click', function () {
          textarea.value = pill.text;
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
        });
        row.appendChild(btn);
      })(pills[i]);
    }
    label.appendChild(row);
  }

  // --------------------------------------------------------- footer layout

  /**
   * Visually regroups the footer action row: Do Not Send / Mark As Duplicate /
   * Send Supervisor move together so their left edge lines up under Internal
   * Notes above them; Logout and Send Technical stay together at the right
   * edge. Mirrors the .row/.col-md-6 grid the Incident Notes / Internal Notes
   * row above already uses, so the alignment comes from the same gutter math
   * rather than a guessed margin.
   *
   * Every node is *moved* (appendChild removes it from its old parent), never
   * cloned - Logout and Send Technical are real submittable inputs
   * (name="logout" / name="send_technical"); a clone would leave two fields
   * with the same name in the form. Nothing is clicked, submitted, or has its
   * onclick/name/value touched.
   */
  function enhanceFooterLayout() {
    var doNotSend = document.querySelector(S.doNotSendButton.sel);
    var markDuplicate = document.querySelector(S.markAsDuplicateButton.sel);
    var sendSupervisor = document.querySelector(S.sendSupervisorButton.sel);
    if (!doNotSend || !markDuplicate || !sendSupervisor) { return; }

    var footer = doNotSend.closest('.applet-footer');
    if (!footer || footer.dataset.apaFooter === '1') { return; }
    footer.dataset.apaFooter = '1';

    var logoutInput = document.querySelector(S.logoutCheckbox.sel);
    var sendTechnicalInput = document.querySelector(S.sendTechnicalCheckbox.sel);
    var logoutLabel = logoutInput ? logoutInput.closest('label') : null;
    var sendTechnicalLabel = sendTechnicalInput ? sendTechnicalInput.closest('label') : null;

    footer.classList.remove('text-end');
    sendSupervisor.classList.remove('me-2');   // now last in its group, not mid-row

    var buttonGroup = el('div', 'd-flex flex-wrap align-items-center gap-2');
    buttonGroup.appendChild(doNotSend);
    buttonGroup.appendChild(markDuplicate);
    buttonGroup.appendChild(sendSupervisor);

    var checkGroup = el('div', 'd-flex flex-wrap align-items-center gap-3');
    if (logoutLabel) { checkGroup.appendChild(logoutLabel); }
    if (sendTechnicalLabel) { checkGroup.appendChild(sendTechnicalLabel); }

    // Two separate groups, not one flat row: gap-4 between them reads as a deliberate
    // pair of clusters (buttons near Internal Notes, checks at the far right) rather
    // than 5 loose items. justify-content-end on the outer row does the right-alignment
    // - no auto-margin on either group to swallow the free space and defeat it, which is
    // what silently pinned the buttons to the left edge (behind the chat panel) last time.
    var footerRow = el('div', 'd-flex flex-wrap justify-content-end align-items-center gap-4');
    footerRow.appendChild(buttonGroup);
    footerRow.appendChild(checkGroup);

    while (footer.firstChild) { footer.removeChild(footer.firstChild); }
    footer.appendChild(footerRow);
  }

  // ---------------------------------------------------------------- 1C: audio

  function buildAudioPlayer(url, onFailure) {
    var wrap = el('div', 'apa-audio');

    var audio = document.createElement('audio');
    audio.className = 'apa-audio-el';
    audio.controls = true;
    audio.preload = 'none';       // the page reloads constantly; do not prefetch
    audio.src = url;

    audio.addEventListener('error', function () {
      if (wrap.querySelector('.apa-audio-error')) { return; }
      wrap.appendChild(el('span', 'apa-audio-error',
        'Inline playback unavailable — original link restored below.'));
      // Never leave her without a way to hear the audio.
      if (typeof onFailure === 'function') { onFailure(); }
    });

    wrap.appendChild(audio);
    return wrap;
  }

  function findAudioLink() {
    // Primary: Locate the dedicated Audio / Transcript form-group
    var formGroups = document.querySelectorAll('.form-group');
    for (var i = 0; i < formGroups.length; i++) {
      var label = formGroups[i].querySelector('.control-label');
      if (label && /Audio/i.test(label.textContent)) {
        var a = formGroups[i].querySelector('a');
        if (a) { return a; }
      }
    }

    // Direct media URL match outside the transcript / lead container
    var mediaCandidates = document.querySelectorAll(
      'a[href*="signal.alertpage.net/media"], a[href*="media-alrtpg"], a[href*="/media/"], a[href$=".m4a"], a[href$=".mp3"], a[onclick*="/media/"], a[onclick*=".m4a"], a[onclick*=".mp3"]'
    );
    for (var j = 0; j < mediaCandidates.length; j++) {
      if (!mediaCandidates[j].closest('.apa-lead') && !mediaCandidates[j].closest('.apa-transcript')) {
        return mediaCandidates[j];
      }
    }

    // Fallback: Selector match outside the transcript / lead container
    var openCandidates = document.querySelectorAll(S.audioLink.sel);
    for (var k = 0; k < openCandidates.length; k++) {
      if (!openCandidates[k].closest('.apa-lead') && !openCandidates[k].closest('.apa-transcript')) {
        return openCandidates[k];
      }
    }

    return null;
  }

  function enhanceAudio() {
    var link = findAudioLink();
    if (!link) { return; }

    var holder = link.closest('.form-group') || link.parentNode;
    if (!holder || holder.dataset.apaAudio === '1') { return; }

    var url = LEAD.extractAudioUrl(link.textContent, link.getAttribute('onclick'), link.getAttribute('href'));
    if (!url) { return; }

    holder.dataset.apaAudio = '1';

    // The player replaces the raw URL on screen, but the original
    // <a onclick="openFullScreen(...)"> is only hidden - never removed, never altered -
    // and is put back if playback turns out not to work. Anchored on the <a> itself
    // (not a climbed ancestor span) so placement can't land on the wrong element when
    // AlertPage's markup nests it differently than the one capture this was built from.
    function restoreLink() {
      link.removeAttribute('hidden');
      link.style.removeProperty('display');
    }

    link.parentNode.insertBefore(buildAudioPlayer(url, restoreLink), link);

    link.setAttribute('hidden', '');
    link.style.setProperty('display', 'none', 'important');   // beats .d-block
  }

  // ------------------------------------------------------------------ theme

  // A CSS hook only - working-screen.css does the actual repainting under
  // html[data-apa-theme="dark"]. Nothing here touches AlertPage's own markup or
  // classes, so it costs nothing to apply before the rest of run() and nothing to
  // re-apply on its own from the storage listener below.
  function applyTheme(settings) {
    var root = document.documentElement;
    if (settings.darkMode === true) {
      root.setAttribute('data-apa-theme', 'dark');
    } else {
      root.removeAttribute('data-apa-theme');
    }
  }

  // ------------------------------------------------------------------- entry

  function run(stored) {
    var settings = Object.assign({}, K.DEFAULT_SETTINGS, stored[SETTINGS_KEY] || {});
    applyTheme(settings);
    var rules = HL.normalizeRules(stored[RULES_KEY], K.DEFAULT_RULES);
    var dfSettings = Object.assign({}, DF.DEFAULT_DATA_FEED_SETTINGS, stored[DATA_FEED_KEY] || {});

    try { enhanceHeader(); } catch (err) { warn('lead header', err); }
    // After enhanceHeader: it is what creates .apa-head-right and tags .apa-lead-time.
    try { enhanceDataFeedLink(dfSettings); } catch (err) { warn('data feed link', err); }
    try { enhanceMonitorButton(settings); } catch (err) { warn('monitor button', err); }
    try { enhanceLeadDetail(settings, rules); } catch (err) { warn('lead detail', err); }
    try { enhanceAudio(); } catch (err) { warn('audio player', err); }
    try { mirrorCityToJurisdiction(); } catch (err) { warn('jurisdiction mirror', err); }
    if (settings.footerReshuffleEnabled !== false) {
      try { enhanceFooterLayout(); } catch (err) { warn('footer layout', err); }
    }
    try {
      var pills = NOTES.normalizePills ? NOTES.normalizePills(stored[PILLS_KEY], PC.DEFAULT_PILLS) : (PC.DEFAULT_PILLS || []);
      enhanceNotesPills(pills);
    } catch (err) { warn('notes pills', err); }
  }

  if (!LEAD.parseLead || !HL.findRanges) {
    warn('startup', new Error('lib not loaded'));
    return;
  }

  var root = document.documentElement;
  if (root.dataset.apaWorkingScreen === '1') { return; }
  root.dataset.apaWorkingScreen = '1';

  readStorage().then(run).catch(function (err) { warn('startup', err); });

  // The popup's theme toggle should not require a page reload to be seen - this tab
  // may be the one she is triaging a lead on right now. Everything else here only
  // ever applies at load, on purpose (re-highlighting live would fight the server's
  // own re-renders); theme is the one exception because it is a single attribute.
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[SETTINGS_KEY]) { return; }
      var settings = Object.assign({}, K.DEFAULT_SETTINGS, changes[SETTINGS_KEY].newValue || {});
      applyTheme(settings);
    });
  } catch (err) { warn('theme live update', err); }
})();
