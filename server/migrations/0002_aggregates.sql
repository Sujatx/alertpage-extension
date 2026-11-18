-- Text-free daily rollup kept 12 months (ADR-0015). day_utc = start of the UTC day, ms.
CREATE TABLE daily_counts (
  day_utc       INTEGER NOT NULL,
  dispatcher_id TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  n             INTEGER NOT NULL,
  PRIMARY KEY (day_utc, dispatcher_id, event_type)
) WITHOUT ROWID;
