/*
 * Event envelope (event-schema-v1 section 2). Pure: callers pass in clocks and context, so
 * this runs the same in a content script, the service worker and Node tests.
 *
 * Content scripts call buildEvent(); the service worker later stamps session_id, tab_id and
 * dispatcher_id (stampForBatch) when it builds a batch, so a late pill fix attributes the backlog.
 */
(function (root) {
  'use strict';

  var C = root.APA && root.APA.collectorConfig;
  if (!C && typeof require === 'function') { C = require('../config/collector-settings.js'); }

  /** userID pill text -> dispatcher_id, or null when missing, placeholder or malformed. */
  function normaliseDispatcherId(text) {
    if (typeof text !== 'string') { return null; }
    var id = text.trim().toLowerCase();
    if (!id || id === C.DISPATCHER_ID_PLACEHOLDER) { return null; }
    return C.DISPATCHER_ID_RE.test(id) ? id : null;
  }

  /** Why an id cannot be used: 'missing' (absent or placeholder), 'invalid', or null if fine. */
  function dispatcherIdProblem(text) {
    var id = typeof text === 'string' ? text.trim().toLowerCase() : '';
    if (!id || id === C.DISPATCHER_ID_PLACEHOLDER) { return 'missing'; }
    return C.DISPATCHER_ID_RE.test(id) ? null : 'invalid';
  }

  /** The userID pill's text from an apa.pills array (matched by id, not text). */
  function pillDispatcherText(pills) {
    if (!Array.isArray(pills)) { return null; }
    for (var i = 0; i < pills.length; i++) {
      if (pills[i] && pills[i].id === 'userID') { return pills[i].text; }
    }
    return null;
  }

  /**
   * ctx: { source, occurredAt, tzOffsetMin, tzName, extensionVersion, pageLoadId?, seq?,
   *        leadId?, workingQueueId?, timeOrigin?, perfNow?, parserVersion?, uuid }
   */
  function buildEvent(type, payload, ctx) {
    var category = C.CATEGORY[type];
    if (!category) { throw new Error('unknown event type: ' + type); }
    if (C.SOURCES.indexOf(ctx.source) < 0) { throw new Error('unknown source: ' + ctx.source); }
    var e = {
      event_id: ctx.uuid(),
      event_type: type,
      category: category,
      schema_version: C.SCHEMA_VERSION,
      source: ctx.source,
      occurred_at: ctx.occurredAt,
      tz_offset_min: ctx.tzOffsetMin,
      tz_name: ctx.tzName,
      extension_version: ctx.extensionVersion,
      collector_version: C.COLLECTOR_VERSION,
      lead_id: ctx.leadId == null ? null : ctx.leadId,
      working_queue_id: ctx.workingQueueId == null ? null : ctx.workingQueueId,
      payload: payload || {}
    };
    if (ctx.pageLoadId) { e.page_load_id = ctx.pageLoadId; }
    if (ctx.seq != null) { e.seq = ctx.seq; }
    if (ctx.timeOrigin != null) { e.time_origin = ctx.timeOrigin; }
    if (ctx.perfNow != null) { e.perf_now = ctx.perfNow; }
    if (ctx.parserVersion) { e.parser_version = ctx.parserVersion; }
    return e;
  }

  /** Service-worker stamp at batch build. Returns a copy; the queued record stays unstamped. */
  function stampForBatch(event, sessionId, tabId, dispatcherId) {
    var e = Object.assign({}, event, { session_id: event.session_id || sessionId, dispatcher_id: dispatcherId });
    if (tabId != null && e.tab_id == null) { e.tab_id = tabId; }
    return e;
  }

  var api = {
    normaliseDispatcherId: normaliseDispatcherId,
    dispatcherIdProblem: dispatcherIdProblem,
    pillDispatcherText: pillDispatcherText,
    buildEvent: buildEvent,
    stampForBatch: stampForBatch
  };

  root.APA = root.APA || {};
  root.APA.envelope = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : self);
