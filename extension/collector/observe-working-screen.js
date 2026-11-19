/*
 * Passive data collector for the Working Screen (event-schema-v1 rev 4, sections 3.1-3.3).
 * Loaded LAST. READ-ONLY: it never clicks, submits or dispositions anything, never calls
 * preventDefault/stopPropagation, and never reads the chat input, keystrokes, cookies or tokens.
 * Every listener is {capture:true, passive:true} (or bubble+passive for the one defaultPrevented check).
 *
 * Delivery (every event and chat item), so it survives the submit navigation:
 *   (a) sync write to window.localStorage PENDING_PREFIX+id, (b) chrome.storage.local OUTBOX_PREFIX+id,
 *   (c) remove (a) once (b) resolved. Leftover (a) keys are re-handed on the next load.
 */
(function () {
  'use strict';

  var APA = window.APA || {};
  var C = APA.collectorConfig, ENV = APA.envelope, R = APA.redact, CHAT = APA.chat, CANON = APA.canon;
  var S = APA.selectors || {};
  if (!C || !ENV || !R || !CHAT || !CANON) { return; }

  var SETTINGS_KEY = 'apa.settings';
  var IDENT_KEY = 'apc.identity';
  var COUNT_KEY = 'apa.counters';
  var COUNT_PENDING_KEY = 'apa.counters.pending';
  var CAPTURE = { capture: true, passive: true };
  var ATTEMPT_IDS = ['do-not-send-button', 'send-supervisor-button', 'mark-as-duplicate-button',
    'send-confirmed-button', 'send-admin-button'];
  var NO_PROV = { working_queue_id: 1, lead_id: 1, event_type: 1, latitude: 1, longitude: 1, countyid: 1, formatted_address: 1 };

  var pageLoadId = crypto.randomUUID();
  var seq = 0;
  var tabId = null;
  var active = true;
  var TZ = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
  var VERSION = chrome.runtime.getManifest().version;

  function safe(fn) { return function () { try { return fn.apply(this, arguments); } catch (err) { /* never break the page */ } }; }
  function $(sel) { return sel ? document.querySelector(sel) : null; }
  function txt(node) { return node ? String(node.textContent || '').trim() : ''; }
  function uuid() { return crypto.randomUUID(); }

  // ---------------------------------------------------------------- delivery

  function deliver(rec) {
    try {
      if (!active) { return; }
      var id = rec.event_id;
      try { localStorage.setItem(C.PENDING_PREFIX + id, JSON.stringify(rec)); } catch (e) { /* storage full or blocked */ }
      var o = {};
      o[C.OUTBOX_PREFIX + id] = rec;
      chrome.storage.local.set(o, function () {
        if (chrome.runtime.lastError) { return; }
        try { localStorage.removeItem(C.PENDING_PREFIX + id); } catch (e) { /* ignore */ }
      });
    } catch (err) { /* ignore */ }
  }

  function reHandLeftovers() {
    var keys = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(C.PENDING_PREFIX) === 0) { keys.push(k); }
      }
    } catch (e) { return; }
    keys.forEach(function (k) {
      try {
        var rec = JSON.parse(localStorage.getItem(k));
        if (rec && rec.event_id) {
          var o = {};
          o[C.OUTBOX_PREFIX + rec.event_id] = rec;
          chrome.storage.local.set(o, function () {
            if (!chrome.runtime.lastError) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
          });
        } else { localStorage.removeItem(k); }
      } catch (e) { /* unreadable leftover: leave it */ }
    });
  }

  // ------------------------------------------------------------ event making

  function leadIds() {
    var l = $('#lead_id'), q = $('#working_queue_id');
    var lead = l ? parseInt(l.value, 10) : NaN, wq = q ? parseInt(q.value, 10) : NaN;
    return { lead: isNaN(lead) ? null : lead, wq: isNaN(wq) ? null : wq };
  }

  function make(type, payload) {
    var ids = leadIds();
    var ev = ENV.buildEvent(type, payload, {
      source: 'working_screen', occurredAt: Date.now(), tzOffsetMin: new Date().getTimezoneOffset(), tzName: TZ,
      extensionVersion: VERSION, pageLoadId: pageLoadId, seq: seq++, leadId: ids.lead, workingQueueId: ids.wq,
      timeOrigin: performance.timeOrigin, perfNow: performance.now(), uuid: uuid
    });
    if (tabId != null) { ev.tab_id = tabId; }
    return ev;
  }

  function emit(type, payload) { var ev = make(type, R.fitPayload(payload)); deliver(ev); return ev; }

  // ------------------------------------------------------------ form reading

  function readForm(form) {
    var m = {};
    R.FORM_FIELDS.forEach(function (name) {
      var els = form.querySelectorAll('[name="' + name + '"]');
      if (!els.length) { return; }
      var first = els[0], vals = [];
      if (name === 'logout' || name === 'send_technical') { m[name] = !!first.checked; return; }
      if (first.type === 'checkbox') {
        Array.prototype.forEach.call(els, function (e) { if (e.checked) { vals.push(e.value); } });
        m[name] = vals;
      } else if (first.tagName === 'SELECT') {
        m[name] = Array.prototype.map.call(first.selectedOptions, function (o) { return o.value; });
      } else if (name === 'event_type') {
        m[name] = els[els.length - 1].value;
      } else { m[name] = first.value; }
    });
    return m;
  }

  function cmp(v) { return typeof v === 'string' ? v : JSON.stringify(v); }

  // Captured synchronously at script load: working-screen.js rewrites the blob after its storage read.
  var leadForm = $('#lead-form');
  var initialForm = leadForm ? readForm(leadForm) : {};
  var snapshot = readSnapshot();
  var flashText = readFlash();
  // Counter hand-off across the submit navigation (see flushSubmit); read once, synchronously.
  var pendingCount = null;
  try {
    pendingCount = JSON.parse(localStorage.getItem(COUNT_PENDING_KEY));
    localStorage.removeItem(COUNT_PENDING_KEY);
  } catch (e) { pendingCount = null; }

  function readSnapshot() {
    var anchor = $(S.leadIdAnchor && S.leadIdAnchor.sel);
    if (!anchor) { return null; }
    var group = anchor.closest('.form-group');
    var blob = group && group.querySelector(S.leadBlobWithinGroup.sel);
    var link = $(S.audioLink && S.audioLink.sel);
    var audio = '';
    if (link) {
      var m = /openFullScreen\('([^']+)'/.exec(link.getAttribute('onclick') || '');
      audio = R.stripQuery(m ? m[1] : link.getAttribute('href'));
    }
    var epoch = /\/(\d{9,11})-\d+\.\w+$/.exec(audio);
    var val = function (id) { var e = $(id); return e ? String(e.value || '').trim() : ''; };
    return {
      header: group ? (group.querySelector('label') ? txt(group.querySelector('label')).replace(/\s+/g, ' ') : '') : '',
      body: {
        blob_text: blob ? blob.textContent : '',
        audio_url: audio,
        audio_epoch: epoch ? parseInt(epoch[1], 10) : null,
        county: val('#countyname'), state: val('#statename'), city: val('#cityname'), jurisdiction: val('#jurisdiction')
      }
    };
  }

  function readFlash() {
    var f = document.querySelector('.alert.alert-success');
    return f ? txt(f).replace(/\s+/g, ' ') : null;
  }

  // -------------------------------------------------------------- identity

  var ident = { ap: null, handle: null, last: undefined };
  var identReady = Promise.resolve();

  function apUserId() {
    var a = document.querySelector('a[href^="/web/auth/users/"]');
    var m = a && /\/users\/(\d+)\//.exec(a.getAttribute('href'));
    return m ? parseInt(m[1], 10) : null;
  }

  function checkIdentity() {
    if (ident.last === undefined) { return; }   // stored pair not loaded yet
    var cur = { ap_user_id: ident.ap, own_chat_handle: ident.handle };
    if (cur.ap_user_id == null && cur.own_chat_handle == null) { return; }
    var l = ident.last;
    if (l && l.ap_user_id === cur.ap_user_id && l.own_chat_handle === cur.own_chat_handle) { return; }
    ident.last = cur;
    emit('identity_observed', cur);
    var o = {};
    o[IDENT_KEY] = cur;
    chrome.storage.local.set(o, function () { void chrome.runtime.lastError; });
  }

  function noteHandle(author) {
    if (author && ident.handle !== author) { ident.handle = author; checkIdentity(); }
  }

  // ------------------------------------------------------------------- chat

  var counter = CHAT.createCounter();

  function handleChatNode(node, live) {
    if (!node || node.nodeType !== 1) { return; }
    var own = node.classList.contains('outgoing-chats');
    if (!own && !node.classList.contains('received-msg')) { return; }
    var p = node.querySelector('.msg-inbox p');
    var author = txt(node.querySelector('.user-id'));
    if (!p || !author) { return; }
    var ctx = { observedAt: Date.now(), tzOffsetMin: new Date().getTimezoneOffset(), uuid: uuid };
    var ids = leadIds();   // the lead this tab shows right now
    CHAT.buildItem({ author: author, displayedTime: txt(node.querySelector('.time')), text: p.textContent }, ctx, counter)
      .then(function (item) {
        deliver(item);
        if (!own) { return; }
        noteHandle(author);
        if (live) {
          emit('own_chat_message_sent', {
            room_id: item.room_id, minute_utc: item.minute_utc, occurrence: item.occurrence, text_sha256: item.text_sha256,
            context_lead_id: ids.lead, context_working_queue_id: ids.wq
          });
        }
      }).catch(function () { /* ignore */ });
  }

  function observeChat() {
    var box = $(S.chatContainer && S.chatContainer.sel);
    if (!box) { return; }
    Array.prototype.forEach.call(box.children, function (n) { handleChatNode(n, false); });
    // History is prepended and live messages appended (FINDINGS chat section), so "appended with
    // something before it" is live. shortcut: the very first live message into an empty box is
    // only counted live after 5 s of page life, so a replay is never mistaken for a send.
    new MutationObserver(safe(function (muts) {
      muts.forEach(function (rec) {
        var live = rec.nextSibling === null && (rec.previousSibling !== null || performance.now() > 5000);
        Array.prototype.forEach.call(rec.addedNodes, function (n) { handleChatNode(n, live); });
      });
    })).observe(box, { childList: true });
  }

  // -------------------------------------------------------- provenance state

  var trusted = {};   // field -> { at }
  function provState(field) { return { ext: APA.collector && APA.collector.latestExt(field), trusted: trusted[field] || null }; }

  // ------------------------------------------------------------- listeners

  var pendingSubmit = null;
  function flushSubmit(blocked) {
    var p = pendingSubmit;
    if (!p) { return; }
    pendingSubmit = null;
    p.ev.payload.blocked = blocked;
    deliver(p.ev);
  }

  // ---- footer-button counters: independent of the collector toggle (registered always) ----
  var pendingAct = null;
  function flushCount(blocked) {
    var act = pendingAct;
    pendingAct = null;
    try {
      if (act && !blocked && APA.counters && APA.counters.ACTIONS.indexOf(act) >= 0) {
        localStorage.setItem(COUNT_PENDING_KEY, JSON.stringify({ action: act, at: Date.now() }));
      }
    } catch (e) { /* ignore */ }
  }
  var onCountCapture = safe(function (e) {
    var f = e.target;
    if (!f || f.id !== 'lead-form') { return; }
    var vals = Array.prototype.map.call(f.querySelectorAll('input[name="event_type"]'), function (i) { return i.value; });
    pendingAct = vals.length ? vals[vals.length - 1] : null;
    setTimeout(safe(function () { flushCount(false); }), 0);   // fallback if propagation is stopped
  });
  var onCountBubble = safe(function (e) {
    if (e.target && e.target.id === 'lead-form') { flushCount(e.defaultPrevented === true); }
  });

  // Applies the count handed over by the previous page's submit once the flash confirms it.
  function countConfirmed() {
    try {
      if (pendingCount && APA.counters && flashText && /lead processed/i.test(flashText) && Date.now() - pendingCount.at < 5 * 60 * 1000) {
        chrome.storage.local.get([COUNT_KEY], function (got) {
          try {
            var o = {};
            o[COUNT_KEY] = APA.counters.applyConfirmed(got && got[COUNT_KEY], pendingCount.action, Date.now());
            chrome.storage.local.set(o, function () { void chrome.runtime.lastError; });
          } catch (e) { /* ignore */ }
        });
      }
    } catch (e) { /* ignore */ }
  }

  var onSubmitCapture = safe(function (e) {
    var f = e.target;
    if (!f || f.id !== 'lead-form') { return; }
    var form = readForm(f);
    var vals = Array.prototype.map.call(f.querySelectorAll('input[name="event_type"]'), function (i) { return i.value; });
    var prov = {};
    Object.keys(form).forEach(function (k) {
      if (!NO_PROV[k]) { prov[k] = R.provenance(provState(k), cmp(form[k]), initialForm[k] === undefined ? undefined : cmp(initialForm[k])); }
    });
    var ev = make('disposition_submitted', R.fitPayload({
      submitter_id: (e.submitter && e.submitter.id) || null,
      event_type_values: vals,
      event_type_value: vals.length ? vals[vals.length - 1] : null,
      form: R.pickAllowed(form), provenance: prov, blocked: false
    }));
    pendingSubmit = { ev: ev };
    // The page's own handler runs after us; the bubble listener below learns whether it cancelled.
    // This timeout is only the fallback if something stops propagation.
    setTimeout(safe(function () { flushSubmit(false); }), 0);
  });

  var onSubmitBubble = safe(function (e) {
    if (e.target && e.target.id === 'lead-form') { flushSubmit(e.defaultPrevented === true); }
  });

  var onClick = safe(function (e) {
    var t = e.target;
    if (!t || !t.closest) { return; }
    var btn = t.closest('button[id$="-button"]');
    if (btn && ATTEMPT_IDS.indexOf(btn.id) >= 0) { emit('disposition_attempt', { button_id: btn.id, validation_blocked: null }); return; }
    if (t.closest('#new_lead')) { emit('new_lead_tab_opened', {}); return; }
    if (t.closest('a[href*="/web/auth/logout"]')) { emit('logout_clicked', {}); return; }
    if (t.closest('#timerModal_yes_btn')) { emit('timer_response', { answer: 'yes' }); return; }
    if (t.closest('#timerModal_no_btn')) { emit('timer_response', { answer: 'no' }); return; }
    if (t.closest('a.apa-data-feed-link')) { emit('data_feed_opened', {}); }
  });

  var onChange = safe(function (e) {
    var t = e.target;
    if (!e.isTrusted || !t || !t.name || R.CHANGE_FIELDS.indexOf(t.name) < 0) { return; }
    if (!t.closest || !t.closest('#lead-form')) { return; }
    var after;
    if (t.type === 'checkbox') {
      after = Array.prototype.filter.call(document.querySelectorAll('#lead-form [name="' + t.name + '"]'), function (x) { return x.checked; })
        .map(function (x) { return x.value; }).join(',');
    } else if (t.tagName === 'SELECT') {
      after = Array.prototype.map.call(t.selectedOptions, function (o) { return o.value; }).join(',');
    } else { after = String(t.value); }
    trusted[t.name] = { at: performance.now() };
    emit('field_changed', { field: t.name, value_after: after });
  });

  var onPlay = safe(function (e) {
    if (e.target && e.target.tagName === 'AUDIO' && e.target.currentTime < 0.5) { emit('audio_played', {}); }
  });

  var onVisibility = safe(function () {
    emit('page_visibility_changed', { state: document.visibilityState === 'hidden' ? 'hidden' : 'visible' });
  });

  function observeTimerModal() {
    var tm = $('#timerModal');
    if (!tm) { return; }
    var shown = false;
    new MutationObserver(safe(function () {
      var now = tm.classList.contains('show');
      if (now && !shown) { emit('timer_modal_shown', {}); }
      shown = now;
    })).observe(tm, { attributes: true, attributeFilter: ['class'] });
  }

  // ------------------------------------------------------------------ start

  function loadEvents(hello) {
    tabId = hello && hello.tabId != null ? hello.tabId : null;
    if (flashText) { emit('flash_observed', { flash_text: flashText, previous_page_load_id: (hello && hello.previousPageLoadId) || null }); }
    identReady.then(function () { ident.ap = apUserId(); checkIdentity(); });
    if (!snapshot) { return; }
    var ev = make('lead_viewed', {});   // seq/time taken now; payload completes after the hash
    var body = R.fitPayload(snapshot.body, 20 * 1024);
    CANON.sha256Hex(CANON.canonical(body)).then(function (hash) {
      ev.payload = {
        header_text: R.truncate(snapshot.header, 1024),
        snapshot_sha256: hash, snapshot: body,
        initial_fields: R.fitPayload(R.pickAllowed(initialForm), 6 * 1024)
      };
      deliver(ev);
    }).catch(function () { /* ignore */ });
  }

  function start() {
    document.addEventListener('submit', onSubmitCapture, CAPTURE);
    document.addEventListener('submit', onSubmitBubble, { passive: true });
    document.addEventListener('click', onClick, CAPTURE);
    document.addEventListener('change', onChange, CAPTURE);
    document.addEventListener('play', onPlay, CAPTURE);
    document.addEventListener('visibilitychange', onVisibility, { passive: true });
    observeTimerModal();
    observeChat();

    if (APA.collector) {
      APA.collector.onExt(safe(function (m) {
        if (m.kind === 'ext_field_written') { emit('ext_field_written', { field: m.field, feature: m.feature, value_written: m.value }); }
        else if (m.kind === 'ext_chat_autosend') { emit('ext_chat_autosend', { county_bare: m.county_bare }); }
      }));
    }

    identReady = new Promise(function (resolve) {
      chrome.storage.local.get([IDENT_KEY], function (got) {
        ident.last = (got && got[IDENT_KEY]) || null;
        if (ident.last && ident.handle == null) { ident.handle = ident.last.own_chat_handle; }
        resolve();
      });
    });

    var done = false;
    var go = function (reply) { if (!done) { done = true; safe(loadEvents)(reply); } };
    try {
      chrome.runtime.sendMessage({ type: 'apc.hello', pageLoadId: pageLoadId }, function (reply) {
        void chrome.runtime.lastError;
        go(reply);
      });
    } catch (err) { go(null); }
    setTimeout(function () { go(null); }, 1500);

    chrome.storage.onChanged.addListener(safe(function (changes, area) {
      var s = area === 'local' && changes[SETTINGS_KEY];
      if (s && s.newValue && s.newValue.collectorEnabled === false) { active = false; }
    }));
  }

  try {
    document.addEventListener('submit', onCountCapture, CAPTURE);
    document.addEventListener('submit', onCountBubble, { passive: true });
    countConfirmed();
    reHandLeftovers();
    chrome.storage.local.get([SETTINGS_KEY], function (got) {
      try {
        var s = (got && got[SETTINGS_KEY]) || {};
        if (s.collectorEnabled === false) { if (APA.collector) { APA.collector.off(); } return; }
        start();
      } catch (err) { /* ignore */ }
    });
  } catch (err) { /* extension context invalidated */ }
})();
