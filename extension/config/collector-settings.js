/*
 * Collector wire contract and limits. Pure data, shared by the content scripts, the
 * service worker, tests/run-tests.js and the Worker in server/ (imported there via esbuild),
 * so client and server can never disagree on a cap or an event type.
 *
 * Design: docs/architecture/event-schema-v1.md (rev 4), ingestion-pipeline.md, ADR-0014, ADR-0016.
 */
(function (root) {
  'use strict';

  var CATEGORY = {
    lead_viewed: 'page_observation',
    flash_observed: 'page_observation',
    timer_modal_shown: 'page_observation',
    identity_observed: 'page_observation',
    disposition_attempt: 'dispatcher_action',
    disposition_submitted: 'dispatcher_action',
    field_changed: 'dispatcher_action',
    own_chat_message_sent: 'dispatcher_action',
    new_lead_tab_opened: 'dispatcher_action',
    timer_response: 'dispatcher_action',
    logout_clicked: 'dispatcher_action',
    page_visibility_changed: 'dispatcher_action',
    data_feed_opened: 'dispatcher_action',
    audio_played: 'dispatcher_action',
    ext_field_written: 'extension_action',
    ext_chat_autosend: 'extension_action',
    collector_started: 'collector_health',
    queue_stats: 'collector_health',
    upload_failed: 'collector_health',
    events_quarantined: 'collector_health',
    queue_cap_reached: 'collector_health',
    settings_changed: 'collector_health',
    dispatcher_id_missing: 'collector_health'
  };

  var api = {
    ENDPOINT: 'https://apc-ingest.sujat.workers.dev/v1/events:batch',
    SCHEMA_VERSION: 1,
    COLLECTOR_VERSION: '1.0.0',
    CATEGORY: CATEGORY,
    SOURCES: ['working_screen', 'data_feed', 'extension_ui', 'service_worker'],
    CHAT_ROOM_ID: 1,

    // ADR-0016: the userID pill, trimmed + lowercased; format-only check.
    DISPATCHER_ID_RE: /^[a-z0-9][a-z0-9_-]{0,31}$/,
    DISPATCHER_ID_PLACEHOLDER: 'ap***',
    // Origin is a junk filter, not identity: each unpacked install has its own id.
    ORIGIN_RE: /^chrome-extension:\/\/[a-p]{32}$/,
    FORBIDDEN_KEY_RE: /token|csrf|cookie|password|api_?key/i,

    // Batch caps lowered after Spike B (p95 9 ms CPU at 100 items vs the 10 ms Free limit).
    MAX_BATCH_EVENTS: 50,
    MAX_BATCH_BYTES: 128 * 1024,
    MAX_PAYLOAD_BYTES: 32 * 1024,
    TRIGGER_EVENTS: 50,
    TRIGGER_BYTES: 64 * 1024,
    TRIGGER_AGE_MS: 60 * 1000,

    ALARM_PERIOD_MIN: 0.5,
    DRAIN_GAP_MS: 3000,
    BACKOFF_MS: [30000, 60000, 120000, 240000, 480000, 900000],
    BACKOFF_JITTER: 0.2,
    POISON_ATTEMPTS: 3,
    SESSION_IDLE_MS: 30 * 60 * 1000,
    ACKED_KEEP_MS: 7 * 24 * 3600 * 1000,
    QUEUE_CAP_EVENTS: 20000,
    QUEUE_CAP_BYTES: 30 * 1024 * 1024,

    // Server-side rate guard (Worker): RL binding per dispatcher_id plus an exact minimum gap.
    // 30/min leaves headroom over a backlog drain at DRAIN_GAP_MS (20/min).
    RATE_LIMIT: { limit: 30, periodSec: 60 },
    MIN_BATCH_GAP_MS: 2000,

    OUTBOX_PREFIX: 'apc.outbox.',
    PENDING_PREFIX: 'apc.pending.'
  };

  root.APA = root.APA || {};
  root.APA.collectorConfig = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : self);
