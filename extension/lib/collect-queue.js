/*
 * Client queue logic (ingestion-pipeline.md section 4-7, ADR-0014). Pure, no IndexedDB:
 * the service worker feeds it records and persists whatever it returns.
 *
 * A queue record: { event_id, status: pending|inflight|acked|quarantined, record, enqueued_at,
 *                   attempts, batch_id, last_error, bytes, acked_at? }
 * Nothing here removes a record. Only canPurge() says one may go, and only if acked 7 days ago.
 */
(function (root) {
  'use strict';

  var C = root.APA && root.APA.collectorConfig;
  if (!C && typeof require === 'function') { C = require('../config/collector-settings.js'); }
  var CANON = root.APA && root.APA.canon;
  if (!CANON && typeof require === 'function') { CANON = require('./collect-canon.js'); }

  var BODY_OVERHEAD = 200;   // {batch_id, client_sent_at, events} wrapper
  var STAMP_SLACK = 160;     // session_id, tab_id, dispatcher_id added at batch build
  var MAX_RETRY_AFTER_MS = 24 * 3600 * 1000;
  var STOP_MS = 6 * 3600 * 1000;

  function makeRecord(record, now) {
    return {
      event_id: record.event_id, status: 'pending', record: record, enqueued_at: now,
      attempts: 0, batch_id: null, last_error: null,
      bytes: CANON.byteLength(JSON.stringify(record))
    };
  }

  function patched(r, patch) { return Object.assign({}, r, patch); }

  /**
   * Oldest pending first, up to 50 records and 128 KB of request body. A set that already has
   * a batch_id (a retry) is returned whole so the retry is the same set. caps.limit narrows
   * the batch after a bisect. Always returns at least one record when any is pending.
   */
  function pickBatch(pending, caps) {
    caps = caps || {};
    var maxEvents = Math.min(caps.maxEvents || C.MAX_BATCH_EVENTS, caps.limit || Infinity);
    var maxBytes = caps.maxBytes || C.MAX_BATCH_BYTES;
    var list = pending.filter(function (r) { return r.status === 'pending'; }).sort(function (a, b) {
      return a.enqueued_at - b.enqueued_at || (a.event_id < b.event_id ? -1 : 1);
    });
    if (!list.length) { return []; }
    if (list[0].batch_id) {
      return list.filter(function (r) { return r.batch_id === list[0].batch_id; });
    }
    var out = [], size = BODY_OVERHEAD;
    for (var i = 0; i < list.length && out.length < maxEvents; i++) {
      var add = list[i].bytes + STAMP_SLACK + 1;
      if (out.length && size + add > maxBytes) { break; }
      out.push(list[i]);
      size += add;
    }
    return out;
  }

  /**
   * stats: { pending, pendingBytes, oldestPendingAt, inflight, retryAt, lastBatchAt, retrying }
   * Triggers: 50 events, 64 KB or 60 s old; a failed batch awaiting retry goes when due.
   */
  function shouldUpload(stats, now) {
    if (!stats.pending || stats.inflight) { return false; }
    if (stats.retryAt && now < stats.retryAt) { return false; }
    if (stats.lastBatchAt && now - stats.lastBatchAt < C.DRAIN_GAP_MS) { return false; }
    if (stats.retrying) { return true; }
    return stats.pending >= C.TRIGGER_EVENTS || stats.pendingBytes >= C.TRIGGER_BYTES ||
      now - stats.oldestPendingAt >= C.TRIGGER_AGE_MS;
  }

  /**
   * records: the batch's inflight records; response: the 200 body. Only ids present in
   * results are acked; rejected are quarantined (kept); an id the server did not mention
   * goes back to pending.
   */
  function applyAck(records, response, now) {
    var byId = {};
    ((response && response.results) || []).forEach(function (x) { if (x && x.event_id) { byId[x.event_id] = x; } });
    var acked = 0, quarantined = [];
    var out = records.map(function (r) {
      var res = byId[r.event_id];
      if (res && (res.status === 'accepted' || res.status === 'duplicate')) {
        acked++;
        return patched(r, { status: 'acked', acked_at: now, last_error: null });
      }
      if (res && res.status === 'rejected') {
        quarantined.push({ event_id: r.event_id, code: res.code || 'rejected' });
        return patched(r, { status: 'quarantined', last_error: res.code || 'rejected' });
      }
      return patched(r, { status: 'pending', attempts: r.attempts + 1, last_error: 'no_result' });
    });
    return { records: out, acked: acked, quarantined: quarantined };
  }

  /** Wait before retry n (1-based): schedule with +-20% jitter; Retry-After wins. rand in [0,1). */
  function nextBackoffMs(attempts, rand, retryAfterMs) {
    if (retryAfterMs > 0) { return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS); }
    var steps = C.BACKOFF_MS;
    var base = steps[Math.min(Math.max(attempts, 1), steps.length) - 1];
    return Math.round(base * (1 + (rand * 2 - 1) * C.BACKOFF_JITTER));
  }

  function bisect(records) {
    var mid = Math.ceil(records.length / 2);
    return [records.slice(0, mid), records.slice(mid)];
  }

  /**
   * After a non-200 (res.status 0 = network error). Returns { records, action, delayMs, splitLimit }.
   * action: retry | split | newid | stop | quarantine. Every returned record is pending or
   * quarantined, none is dropped.
   */
  function planFailure(records, res, now, rand) {
    var st = res.status, n = records.length;
    var pend = function (patch) {
      return records.map(function (r) { return patched(r, Object.assign({ status: 'pending' }, patch)); });
    };
    var err = st ? 'http_' + st : 'network';

    if (st === 403) {
      return { records: pend({ last_error: 'origin_refused' }), action: 'stop', delayMs: STOP_MS };
    }
    if (st === 409) {
      return { records: pend({ batch_id: null, last_error: 'batch_conflict' }), action: 'newid', delayMs: 0 };
    }
    if (st === 400 || st === 413) {
      if (n > 1) {
        return { records: pend({ batch_id: null, last_error: err }), action: 'split', delayMs: 0, splitLimit: bisect(records)[0].length };
      }
      var r = records[0], tries = r.attempts + 1;
      if (st === 413 || tries >= C.POISON_ATTEMPTS) {
        return { records: [patched(r, { status: 'quarantined', attempts: tries, batch_id: null, last_error: st === 413 ? 'too_large' : 'poison' })],
          action: 'quarantine', delayMs: 0 };
      }
      return { records: [patched(r, { status: 'pending', attempts: tries, batch_id: null, last_error: err })],
        action: 'retry', delayMs: nextBackoffMs(tries, rand, 0) };
    }
    // 429, 5xx, network, anything else: back off, same batch_id, same set.
    var attempts = Math.max.apply(null, records.map(function (x) { return x.attempts; })) + 1;
    var delay = nextBackoffMs(attempts, rand, res.retryAfterMs);
    if (n > 1 && attempts >= C.POISON_ATTEMPTS && st !== 429) {
      return { records: pend({ attempts: attempts, batch_id: null, last_error: err }), action: 'split', delayMs: delay, splitLimit: bisect(records)[0].length };
    }
    return { records: pend({ attempts: attempts, last_error: err }), action: 'retry', delayMs: delay };
  }

  /** Offline cap (ADR-0014): suppress only chat and extension_action; never a disposition. */
  function capPolicy(stats, record) {
    if (stats.count < C.QUEUE_CAP_EVENTS && stats.bytes < C.QUEUE_CAP_BYTES) { return 'keep'; }
    if (record.item_type === 'chat_message_observed') { return 'suppress'; }
    return C.CATEGORY[record.event_type] === 'extension_action' ? 'suppress' : 'keep';
  }

  /** SW restart: inflight goes back to pending, batch_id kept so the retry is the same set. */
  function recoverInflight(records) {
    return records.map(function (r) { return r.status === 'inflight' ? patched(r, { status: 'pending' }) : r; });
  }

  function canPurge(r, now) { return r.status === 'acked' && now - (r.acked_at || 0) >= C.ACKED_KEEP_MS; }

  var api = {
    makeRecord: makeRecord, pickBatch: pickBatch, shouldUpload: shouldUpload, applyAck: applyAck,
    nextBackoffMs: nextBackoffMs, bisect: bisect, planFailure: planFailure, capPolicy: capPolicy,
    recoverInflight: recoverInflight, canPurge: canPurge
  };

  root.APA = root.APA || {};
  root.APA.queue = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : self);
