/*
 * Collector store + uploader, loaded into the service worker with importScripts().
 *
 * Content scripts leave records in chrome.storage.local under apc.outbox.<event_id>. This file
 * drains them into IndexedDB ('apc': queue + meta), then uploads batches to the Worker.
 * Decisions: ADR-0014 (queue/ack), ADR-0016 (dispatcher id), ingestion-pipeline.md.
 * Queue rules are in lib/collect-queue.js (pure, tested); this file is the I/O around them.
 *
 * No record leaves the queue before the server acked it; acked records are purged after 7 days.
 */
'use strict';

importScripts('config/collector-settings.js', 'lib/collect-canon.js', 'lib/collect-envelope.js',
  'lib/collect-queue.js');

(function (root) {
  var C = root.APA.collectorConfig, CANON = root.APA.canon, ENV = root.APA.envelope, Q = root.APA.queue;

  var ALARM = 'apc.tick';
  var STATUS_KEY = 'apc.status';
  var PILLS_KEY = 'apa.pills';
  var SETTINGS_KEY = 'apa.settings';
  var HOUR = 3600 * 1000;
  var FETCH_TIMEOUT_MS = 30000;
  var TZ = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';

  // ------------------------------------------------------------ IndexedDB

  var dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        var r = indexedDB.open('apc', 1);
        r.onupgradeneeded = function () {
          var d = r.result;
          d.createObjectStore('queue', { keyPath: 'event_id' }).createIndex('status', 'status');
          d.createObjectStore('meta', { keyPath: 'key' });
        };
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { dbPromise = null; reject(r.error); };
      });
    }
    return dbPromise;
  }

  // fn(tx) may return an IDBRequest; its result is what the promise resolves with, after commit.
  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(['queue', 'meta'], mode), out;
        try { out = fn(t); } catch (e) { try { t.abort(); } catch (_) { /* already aborted */ } reject(e); return; }
        t.oncomplete = function () { resolve(out instanceof IDBRequest ? out.result : out); };
        t.onerror = t.onabort = function () { reject(t.error); };
      });
    });
  }

  function byStatus(status) {
    return tx('readonly', function (t) { return t.objectStore('queue').index('status').getAll(status); });
  }
  function byStatuses(list) {
    return Promise.all(list.map(byStatus)).then(function (parts) { return [].concat.apply([], parts); });
  }
  function countStatus(status) {
    return tx('readonly', function (t) { return t.objectStore('queue').index('status').count(status); });
  }
  function putMany(records) {
    if (!records.length) { return Promise.resolve(); }
    return tx('readwrite', function (t) {
      var s = t.objectStore('queue');
      records.forEach(function (r) { s.put(r); });
    });
  }

  // ----------------------------------------------------- small persisted state

  var st = null;   // the single meta row 'state'
  function loadState() {
    if (st) { return Promise.resolve(st); }
    return tx('readonly', function (t) { return t.objectStore('meta').get('state'); }).then(function (row) {
      st = (row && row.value) || {};
      return st;
    });
  }
  function saveState() {
    return tx('readwrite', function (t) { t.objectStore('meta').put({ key: 'state', value: st }); });
  }

  function touchSession(now) {
    var s = st.session;
    if (!s || now - s.lastAt > C.SESSION_IDLE_MS) { s = { id: crypto.randomUUID() }; }
    s.lastAt = now;
    st.session = s;
    return s.id;
  }

  // ------------------------------------------------------------ chrome.storage

  function storageGet(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, function (got) { resolve(chrome.runtime.lastError ? {} : (got || {})); });
    });
  }
  function storageRemove(keys) {
    return new Promise(function (resolve) {
      if (!keys.length) { resolve(); return; }
      chrome.storage.local.remove(keys, function () { void chrome.runtime.lastError; resolve(); });
    });
  }
  function storageSet(obj) {
    return new Promise(function (resolve) {
      chrome.storage.local.set(obj, function () { void chrome.runtime.lastError; resolve(); });
    });
  }

  // ---------------------------------------------------------------- serialise

  var chain = Promise.resolve();
  function serial(fn) {
    var run = chain.then(fn);
    chain = run.catch(function (err) { console.warn('[apc]', err); });
    return run;
  }

  // ------------------------------------------------------------------ ingest

  function isRecord(r) {
    return r && typeof r === 'object' && typeof r.event_id === 'string' &&
      (r.item_type === 'chat_message_observed' || !!C.CATEGORY[r.event_type]);
  }

  async function liveStats() {
    var recs = await byStatuses(['pending', 'inflight', 'quarantined']);
    return { count: recs.length, bytes: recs.reduce(function (n, r) { return n + r.bytes; }, 0) };
  }

  /** Write new records into the queue (idempotent by event_id), applying the offline cap policy. */
  async function ingest(recs) {
    recs = recs.filter(isRecord);
    if (!recs.length) { return; }
    var now = Date.now();
    var stats = await liveStats();
    var suppressed = {};
    var session = touchSession(now);
    await tx('readwrite', function (t) {
      var s = t.objectStore('queue');
      recs.forEach(function (rec) {
        var g = s.get(rec.event_id);
        g.onsuccess = function () {
          if (g.result) { return; }
          if (Q.capPolicy(stats, rec) === 'suppress') {
            var k = rec.item_type || rec.event_type;
            suppressed[k] = (suppressed[k] || 0) + 1;
            return;
          }
          if (rec.event_type && !rec.session_id) { rec.session_id = session; }
          var q = Q.makeRecord(rec, now);
          s.put(q);
          stats.count++;
          stats.bytes += q.bytes;
        };
      });
    });
    if (Object.keys(suppressed).length && now - (st.lastCapAt || 0) > HOUR) {
      st.lastCapAt = now;
      await healthEvent('queue_cap_reached', { suppressed: suppressed }, true);
    }
  }

  async function drainEntries(entries) {
    var keys = Object.keys(entries).filter(function (k) { return k.indexOf(C.OUTBOX_PREFIX) === 0; });
    if (!keys.length) { return; }
    await loadState();
    await ingest(keys.map(function (k) { return entries[k]; }));
    // Remove only after the IDB transaction above committed.
    await storageRemove(keys);
  }

  function drainAll() { return storageGet(null).then(drainEntries); }

  // ------------------------------------------------------------------ health

  async function collectorOn() {
    var got = await storageGet([SETTINGS_KEY]);
    return !(got[SETTINGS_KEY] && got[SETTINGS_KEY].collectorEnabled === false);
  }

  /** Queue one collector_health event. `force` skips the collector-off check (settings_changed, cap). */
  async function healthEvent(type, payload, force) {
    if (!force && !(await collectorOn())) { return; }
    var now = Date.now();
    var ev = ENV.buildEvent(type, payload, {
      source: 'service_worker', occurredAt: now, tzOffsetMin: new Date().getTimezoneOffset(), tzName: TZ,
      extensionVersion: chrome.runtime.getManifest().version, uuid: function () { return crypto.randomUUID(); }
    });
    // ingest() is used directly, so a health event never re-enters the cap-suppression branch.
    await ingest([ev]);
  }

  async function maintenance(now) {
    if (now - (st.lastMaintAt || 0) < HOUR) { return; }
    st.lastMaintAt = now;
    var acked = await byStatus('acked');
    var expired = acked.filter(function (r) { return Q.canPurge(r, now); });
    if (expired.length) {
      await tx('readwrite', function (t) {
        var s = t.objectStore('queue');
        expired.forEach(function (r) { s.delete(r.event_id); });
      });
    }
    var live = await byStatuses(['pending', 'inflight', 'quarantined']);
    var pending = live.filter(function (r) { return r.status === 'pending'; });
    var oldest = pending.reduce(function (m, r) { return Math.min(m, r.enqueued_at); }, now);
    var kept = acked.filter(function (r) { return !Q.canPurge(r, now); });
    await healthEvent('queue_stats', {
      pending: pending.length,
      inflight: live.filter(function (r) { return r.status === 'inflight'; }).length,
      acked_24h: kept.filter(function (r) { return now - r.acked_at < 24 * HOUR; }).length,
      quarantined: live.filter(function (r) { return r.status === 'quarantined'; }).length,
      oldest_pending_age_s: pending.length ? Math.round((now - oldest) / 1000) : 0,
      idb_bytes_estimate: live.concat(kept).reduce(function (n, r) { return n + r.bytes; }, 0)
    });
  }

  async function writeStatus() {
    var counts = await Promise.all([countStatus('pending'), countStatus('inflight'), countStatus('quarantined')]);
    await storageSet({
      'apc.status': {
        queued: counts[0] + counts[1], sent: st.sentTotal || 0, quarantined: counts[2],
        lastUploadAt: st.lastUploadAt || null, lastError: st.lastError || null, idProblem: st.idProblem || null
      }
    });
  }

  // ------------------------------------------------------------------ upload

  function retryAfterMs(resp) {
    var h = resp.headers.get('retry-after');
    if (!h) { return 0; }
    if (/^\d+$/.test(h.trim())) { return parseInt(h, 10) * 1000; }
    var t = Date.parse(h);
    return isNaN(t) ? 0 : Math.max(0, t - Date.now());
  }

  async function post(body) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
    try {
      var resp = await fetch(C.ENDPOINT, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal
      });
      if (resp.status === 200) {
        try { return { status: 200, json: await resp.json() }; } catch (e) { return { status: 0 }; }
      }
      return { status: resp.status, retryAfterMs: retryAfterMs(resp) };
    } catch (e) {
      return { status: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  /** One batch. Resolves true when another batch should follow soon. */
  async function uploadOnce(dispatcher) {
    var now = Date.now();
    var pending = await byStatus('pending');
    var stats = {
      pending: pending.length,
      pendingBytes: pending.reduce(function (n, r) { return n + r.bytes; }, 0),
      oldestPendingAt: pending.reduce(function (m, r) { return Math.min(m, r.enqueued_at); }, now),
      inflight: 0, retryAt: st.retryAt || 0, lastBatchAt: st.lastBatchAt || 0,
      retrying: pending.some(function (r) { return !!r.batch_id; })
    };
    if (!Q.shouldUpload(stats, now)) { return false; }

    var picked = Q.pickBatch(pending, { limit: st.splitLimit || undefined });
    if (!picked.length) { return false; }
    var batchId = picked[0].batch_id || crypto.randomUUID();
    var inflight = picked.map(function (r) { return Object.assign({}, r, { status: 'inflight', batch_id: batchId }); });
    await putMany(inflight);   // durable before the request, so a SW kill re-sends the same set

    var session = touchSession(now);
    // Chat items travel in `events` too; the Worker tells them apart by item_type.
    var body = { batch_id: batchId, client_sent_at: now, events: inflight.map(function (r) {
      return r.record.item_type === 'chat_message_observed'
        ? Object.assign({}, r.record, { dispatcher_id: dispatcher })
        : ENV.stampForBatch(r.record, session, null, dispatcher);
    }) };

    var res = await post(body);
    var done = Date.now();
    st.lastBatchAt = done;

    if (res.status === 200) {
      var ack = Q.applyAck(inflight, res.json, done);
      await putMany(ack.records);
      st.sentTotal = (st.sentTotal || 0) + ack.acked;
      st.lastUploadAt = done;
      st.lastError = null;
      st.retryAt = 0;
      st.splitLimit = null;
      var streak = st.streak;
      st.streak = null;
      if (streak && streak.attempts >= 2) { await healthEvent('upload_failed', { http_status: streak.status, attempts: streak.attempts }); }
      if (ack.quarantined.length) { await healthEvent('events_quarantined', { items: ack.quarantined }); }
      return pending.length > picked.length;
    }

    var plan = Q.planFailure(inflight, res, done, Math.random());
    await putMany(plan.records);
    st.retryAt = done + plan.delayMs;
    if (plan.splitLimit) { st.splitLimit = plan.splitLimit; }
    st.lastError = res.status ? 'HTTP ' + res.status : 'network error';
    st.streak = { attempts: ((st.streak && st.streak.attempts) || 0) + 1, status: res.status };
    if (plan.action === 'quarantine') {
      await healthEvent('events_quarantined', {
        items: plan.records.map(function (r) { return { event_id: r.event_id, code: r.last_error }; })
      });
    }
    return false;
  }

  async function tick() {
    await loadState();
    var now = Date.now();
    await drainAll();
    await maintenance(now);

    var got = await storageGet([PILLS_KEY]);
    var text = ENV.pillDispatcherText(got[PILLS_KEY]);
    st.idProblem = ENV.dispatcherIdProblem(text);
    var more = false;
    if (st.idProblem) {
      if (!root.apcIdMissingSent) {
        root.apcIdMissingSent = true;   // once per service-worker session
        await healthEvent('dispatcher_id_missing', { reason: st.idProblem });
      }
    } else {
      more = await uploadOnce(ENV.normaliseDispatcherId(text));
    }
    await saveState();
    await writeStatus();
    if (more) { setTimeout(function () { serial(tick); }, C.DRAIN_GAP_MS); }
  }

  // ---------------------------------------------------------------- lifecycle

  var tabLoads = {};   // in-memory fallback when chrome.storage.session is unavailable

  async function previousPageLoad(tab, pageLoadId) {
    var key = 'apc.tab.' + tab, prev = null;
    try {
      if (chrome.storage.session) {
        var got = await chrome.storage.session.get([key]);
        prev = got[key] || null;
        await chrome.storage.session.set({ [key]: pageLoadId });
        return prev;
      }
    } catch (e) { /* fall through */ }
    prev = tabLoads[key] || null;
    tabLoads[key] = pageLoadId;
    return prev;
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== 'apc.hello') { return false; }
    var tab = sender && sender.tab ? sender.tab.id : null;
    if (tab == null || !message.pageLoadId) { sendResponse({ tabId: tab }); return false; }
    previousPageLoad(tab, String(message.pageLoadId)).then(function (prev) {
      sendResponse({ tabId: tab, previousPageLoadId: prev });
    }, function () { sendResponse({ tabId: tab }); });
    return true;
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') { return; }
    var entries = {};
    Object.keys(changes).forEach(function (k) {
      if (k.indexOf(C.OUTBOX_PREFIX) === 0 && changes[k].newValue) { entries[k] = changes[k].newValue; }
    });
    if (Object.keys(entries).length) {
      serial(function () { return drainEntries(entries).then(function () { return loadState().then(writeStatus); }); });
    }
    var s = changes[SETTINGS_KEY];
    if (s && s.newValue) {
      var bools = {}, changed = false, old = s.oldValue || {};
      Object.keys(s.newValue).forEach(function (k) {
        if (typeof s.newValue[k] === 'boolean') { bools[k] = s.newValue[k]; if (old[k] !== s.newValue[k]) { changed = true; } }
      });
      if (changed) { serial(function () { return loadState().then(function () { return healthEvent('settings_changed', bools, true); }); }); }
    }
  });

  function started(reason) {
    serial(function () {
      return loadState().then(function () {
        st.session = null;   // schema 2.2: a new collector session on browser/extension start
        return healthEvent('collector_started', { reason: reason });
      }).then(tick);
    });
  }
  chrome.runtime.onInstalled.addListener(function (d) {
    if (d && (d.reason === 'install' || d.reason === 'update')) { started(d.reason); }
  });
  chrome.runtime.onStartup.addListener(function () { started('startup'); });

  chrome.alarms.onAlarm.addListener(function (a) { if (a.name === ALARM) { serial(tick); } });

  // Every service-worker start: alarm exists, inflight from a killed worker goes back to pending
  // (batch_id kept so the retry is the same set), then a normal tick drains the outbox.
  chrome.alarms.get(ALARM, function (a) {
    if (!a) { chrome.alarms.create(ALARM, { periodInMinutes: C.ALARM_PERIOD_MIN }); }
  });
  serial(function () {
    return loadState().then(function () { return byStatus('inflight'); }).then(function (stuck) {
      return putMany(Q.recoverInflight(stuck));
    }).then(tick);
  });
})(globalThis);
