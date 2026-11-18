-- Production schema: docs/architecture/data-model.md section 3 (Spike B DDL, unchanged).

CREATE TABLE dispatchers (
  dispatcher_id TEXT PRIMARY KEY CHECK (dispatcher_id = lower(trim(dispatcher_id))),
  label         TEXT NOT NULL,
  ap_user_id    INTEGER,
  chat_handle   TEXT,
  status        TEXT NOT NULL CHECK (status IN ('active','disabled')),
  created_at    INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE upload_batches (
  batch_id        TEXT PRIMARY KEY,
  dispatcher_id   TEXT REFERENCES dispatchers (dispatcher_id),
  claimed_dispatcher_id TEXT NOT NULL,
  received_at     INTEGER NOT NULL,
  client_sent_at  INTEGER,
  event_count     INTEGER NOT NULL,
  accepted        INTEGER,
  duplicate       INTEGER,
  rejected        INTEGER,
  bytes           INTEGER,
  first_event_seq INTEGER,
  last_event_seq  INTEGER,
  identity_check  TEXT
) WITHOUT ROWID;

CREATE INDEX ix_batches_dispatcher_time ON upload_batches (dispatcher_id, received_at);
CREATE INDEX ix_batches_time        ON upload_batches (received_at);

CREATE TABLE leads (
  lead_id                    INTEGER PRIMARY KEY,
  first_seen_at              INTEGER NOT NULL,
  first_seen_by_dispatcher_id TEXT NOT NULL REFERENCES dispatchers (dispatcher_id)
);

CREATE TABLE events (
  event_seq         INTEGER PRIMARY KEY,
  event_id          TEXT NOT NULL UNIQUE,
  event_type        TEXT NOT NULL,
  category          TEXT NOT NULL,
  schema_version    INTEGER NOT NULL,
  source            TEXT NOT NULL,
  dispatcher_id     TEXT NOT NULL REFERENCES dispatchers (dispatcher_id),
  batch_id          TEXT NOT NULL REFERENCES upload_batches (batch_id),
  session_id        TEXT NOT NULL,
  page_load_id      TEXT,
  tab_id            INTEGER,
  seq               INTEGER,
  lead_id           INTEGER REFERENCES leads (lead_id),
  working_queue_id  INTEGER,
  occurred_at       INTEGER NOT NULL,
  received_at       INTEGER NOT NULL,
  tz_offset_min     INTEGER NOT NULL,
  tz_name           TEXT NOT NULL,
  extension_version TEXT NOT NULL,
  collector_version TEXT NOT NULL,
  parser_version    TEXT,
  payload           TEXT NOT NULL CHECK (json_valid(payload)),
  payload_sha256    TEXT NOT NULL
);

CREATE INDEX ix_events_lead_time
  ON events (lead_id, occurred_at) WHERE lead_id IS NOT NULL;
CREATE INDEX ix_events_dispatcher_time
  ON events (dispatcher_id, occurred_at);

CREATE TABLE lead_snapshots (
  snapshot_sha256   TEXT PRIMARY KEY,
  lead_id           INTEGER NOT NULL REFERENCES leads (lead_id),
  first_observed_at INTEGER NOT NULL,
  first_event_id    TEXT NOT NULL,
  header_text       TEXT,
  body              TEXT NOT NULL CHECK (json_valid(body))
) WITHOUT ROWID;

CREATE INDEX ix_snapshots_lead ON lead_snapshots (lead_id);

CREATE TABLE chat_messages (
  chat_message_id   INTEGER PRIMARY KEY,
  room_id           INTEGER NOT NULL,
  author_key        TEXT NOT NULL,
  author_is_dispatcher INTEGER NOT NULL,
  minute_utc        INTEGER NOT NULL,
  occurrence        INTEGER NOT NULL,
  text_sha256       TEXT NOT NULL,
  text_raw          TEXT NOT NULL,
  displayed_time    TEXT NOT NULL,
  first_observed_at INTEGER NOT NULL,
  first_dispatcher_id TEXT NOT NULL REFERENCES dispatchers (dispatcher_id),
  UNIQUE (room_id, author_key, minute_utc, text_sha256, occurrence)
);

CREATE INDEX ix_chat_time ON chat_messages (minute_utc);

CREATE TABLE dispositions (
  event_id               TEXT PRIMARY KEY REFERENCES events (event_id),
  lead_id                INTEGER NOT NULL REFERENCES leads (lead_id),
  working_queue_id       INTEGER,
  dispatcher_id          TEXT NOT NULL REFERENCES dispatchers (dispatcher_id),
  tab_id                 INTEGER,
  page_load_id           TEXT,
  action                 TEXT NOT NULL CHECK (action IN ('do_not_send','send_supervisor','mark_as_duplicate')),
  submitted_at           INTEGER NOT NULL,
  internal_notes         TEXT,
  dup_marker             INTEGER NOT NULL,
  dup_referenced_lead_id INTEGER,
  provenance             TEXT CHECK (json_valid(provenance)),
  outcome_status         TEXT NOT NULL CHECK (outcome_status IN ('pending','confirmed','probable','ambiguous','unconfirmed')),
  outcome_event_id       TEXT,
  reconciled_at          INTEGER,
  reconcile_rule_version TEXT,
  derive_rule_version    TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX ix_disp_lead       ON dispositions (lead_id, submitted_at);
CREATE INDEX ix_disp_dispatcher ON dispositions (dispatcher_id, submitted_at);
CREATE INDEX ix_disp_pending    ON dispositions (submitted_at) WHERE outcome_status = 'pending';
CREATE INDEX ix_disp_dup        ON dispositions (submitted_at) WHERE dup_marker = 1;

CREATE TABLE monitoring_claims (
  claim_id        INTEGER PRIMARY KEY,
  chat_message_id INTEGER NOT NULL UNIQUE REFERENCES chat_messages (chat_message_id),
  claim_kind      TEXT NOT NULL CHECK (claim_kind IN ('monitoring','paging')),
  author_key      TEXT NOT NULL,
  dispatcher_id   TEXT REFERENCES dispatchers (dispatcher_id),
  claimed_at      INTEGER NOT NULL,
  county_raw      TEXT,
  county_norm     TEXT,
  state_token     TEXT,
  state_code      TEXT,
  free_text       TEXT,
  parse_status    TEXT NOT NULL CHECK (parse_status IN ('parsed','partial','unparsed')),
  parser_version  TEXT NOT NULL
);

CREATE INDEX ix_claims_place_time ON monitoring_claims (county_norm, state_code, claimed_at);
CREATE INDEX ix_claims_time       ON monitoring_claims (claimed_at);

CREATE TABLE claim_lead_links (
  claim_id        INTEGER NOT NULL REFERENCES monitoring_claims (claim_id),
  lead_id         INTEGER NOT NULL REFERENCES leads (lead_id),
  match_method    TEXT NOT NULL CHECK (match_method IN ('same_tab_context','county_state_time','county_time')),
  match_status    TEXT NOT NULL CHECK (match_status IN ('matched','ambiguous')),
  candidate_count INTEGER NOT NULL,
  rule_version    TEXT NOT NULL,
  PRIMARY KEY (claim_id, lead_id, rule_version)
) WITHOUT ROWID;

CREATE INDEX ix_links_lead ON claim_lead_links (lead_id);
