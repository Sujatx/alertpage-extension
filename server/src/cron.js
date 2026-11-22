// Daily cron (12:30 UTC): reconcile outcomes, roll up yesterday, purge past retention (ADR-0015).
// Each part is bounded and isolated so one failure does not stop the others; all are safe to re-run.
const DAY = 86400000, WINDOW_MS = 120000, RAW_KEEP_DAYS = 90, AGG_KEEP_DAYS = 366, RECONCILE_LIMIT = 500, RECONCILE_PASSES = 4, EXACT_MS = 600000, PURGE_CHUNK = 5000;
const MAX_INT = 9223372036854775807n.toString();

export async function runCron(env, now = Date.now()) {
  const out = {};
  for (const [name, fn] of [['reconcile', reconcile], ['aggregate', aggregate], ['purge', purge]]) {
    try { out[name] = await fn(env.DB, now); } catch (err) { out[name] = { error: String(err.message ?? err).slice(0, 200) }; }
  }
  console.log('cron', JSON.stringify(out));
  return out;
}

// event-schema-v1 section 6 (rule rc-2). A flash is a candidate for a disposition of the same dispatcher within WINDOW_MS after submit,
// or, with no time limit inside EXACT_MS, when its previous_page_load_id names the disposition's own page load (the exact match).
// An exact match wins over everything else: dispatchers submit every few seconds, so many flashes share one window.
// Runs up to RECONCILE_PASSES batches of RECONCILE_LIMIT per call, so the nightly run drains the backlog.
export async function reconcile(db, now) {
  let total = 0;
  for (let pass = 0; pass < RECONCILE_PASSES; pass++) {
    const n = await reconcileBatch(db, now);
    total += n;
    if (n < RECONCILE_LIMIT) break;
  }
  return { reconciled: total };
}

async function reconcileBatch(db, now) {
  const { results } = await db.prepare(`
    SELECT d.event_id, d.tab_id, d.page_load_id, f.event_id AS flash_id, f.tab_id AS flash_tab,
           json_extract(f.payload, '$.previous_page_load_id') AS prev, f.occurred_at AS flash_at
      FROM (SELECT event_id, dispatcher_id, tab_id, page_load_id, submitted_at FROM dispositions
             WHERE outcome_status = 'pending' AND submitted_at < ?1 ORDER BY submitted_at LIMIT ?2) d
      LEFT JOIN events f ON f.dispatcher_id = d.dispatcher_id AND f.event_type = 'flash_observed'
                        AND f.occurred_at BETWEEN d.submitted_at AND d.submitted_at + ?4
                        AND (f.occurred_at <= d.submitted_at + ?3 OR json_extract(f.payload, '$.previous_page_load_id') = d.page_load_id)`)
    .bind(now - WINDOW_MS, RECONCILE_LIMIT, WINDOW_MS, EXACT_MS).all();
  if (!results.length) return 0;

  const byDisp = new Map(); // disposition -> {row, flashes[]}
  for (const r of results) {
    const d = byDisp.get(r.event_id) ?? { row: r, flashes: [] };
    byDisp.set(r.event_id, d);
    if (r.flash_id) d.flashes.push(r);
  }
  const isExact = (row, f) => f.prev && f.prev === row.page_load_id;
  // A flash that names one disposition's page load is that disposition's evidence, not a candidate for the others.
  const exactUse = new Map();
  for (const { row, flashes } of byDisp.values()) for (const f of flashes) if (isExact(row, f)) exactUse.set(f.flash_id, (exactUse.get(f.flash_id) ?? 0) + 1);
  const taken = (f) => exactUse.has(f.flash_id);

  const flashUse = new Map(); // flash -> number of dispositions still claiming it
  for (const d of byDisp.values()) {
    d.exact = d.flashes.find((f) => isExact(d.row, f) && exactUse.get(f.flash_id) === 1);
    if (!d.exact) { d.flashes = d.flashes.filter((f) => !taken(f) || isExact(d.row, f)); for (const f of d.flashes) flashUse.set(f.flash_id, (flashUse.get(f.flash_id) ?? 0) + 1); }
  }
  const verdicts = [];
  for (const [id, { row, flashes, exact }] of byDisp) {
    let status, outcome = null;
    if (exact) { status = 'confirmed'; outcome = exact.flash_id; }
    else if (!flashes.length) status = 'unconfirmed';
    else if (flashes.length > 1 || flashUse.get(flashes[0].flash_id) > 1) { status = 'ambiguous'; outcome = (flashes.find((f) => isExact(row, f)) ?? flashes.sort((a, b) => a.flash_at - b.flash_at)[0]).flash_id; }
    else { status = 'probable'; outcome = flashes[0].flash_id; }
    verdicts.push({ id, status, outcome });
  }
  await db.batch([db.prepare(`
    UPDATE dispositions SET outcome_status = j.status, outcome_event_id = j.outcome, reconciled_at = ?2, reconcile_rule_version = 'rc-2'
      FROM (SELECT json_extract(value,'$.id') AS id, json_extract(value,'$.status') AS status, json_extract(value,'$.outcome') AS outcome FROM json_each(?1)) j
     WHERE dispositions.event_id = j.id AND dispositions.outcome_status = 'pending'`).bind(JSON.stringify(verdicts), now)]);
  return verdicts.length;
}

// Yesterday's (UTC) events by dispatcher and type. The event_seq range comes from upload_batches so events is never full-scanned.
export async function aggregate(db, now) {
  const end = Math.floor(now / DAY) * DAY, start = end - DAY;
  const range = await db.prepare(`SELECT MIN(first_event_seq) AS lo, MAX(last_event_seq) AS hi FROM upload_batches
                                   WHERE received_at >= ?1 AND received_at < ?2 AND first_event_seq IS NOT NULL`).bind(start, end).first();
  if (range?.lo == null) return { day: start, groups: 0 };
  const r = await db.prepare(`INSERT OR REPLACE INTO daily_counts (day_utc, dispatcher_id, event_type, n)
                              SELECT ?1, dispatcher_id, event_type, count(*) FROM events
                               WHERE event_seq BETWEEN ?2 AND ?3 AND received_at >= ?1 AND received_at < ?4
                               GROUP BY dispatcher_id, event_type`).bind(start, range.lo, range.hi, end).run();
  return { day: start, groups: r.meta.changes };
}

// Children before parents (foreign keys are enforced). Per run at most PURGE_CHUNK rows per table.
export async function purge(db, now) {
  const cut = now - RAW_KEEP_DAYS * DAY;
  const stmts = [];

  // Events: the newest batch older than the cutoff bounds the seq range; take the first PURGE_CHUNK of it.
  const b = await db.prepare(`SELECT last_event_seq AS s FROM upload_batches WHERE received_at < ?1 AND last_event_seq IS NOT NULL
                               ORDER BY received_at DESC LIMIT 1`).bind(cut).first();
  if (b) {
    const c = await db.prepare('SELECT MAX(event_seq) AS s FROM (SELECT event_seq FROM events WHERE event_seq <= ?1 ORDER BY event_seq LIMIT ?2)').bind(b.s, PURGE_CHUNK).first();
    if (c?.s != null) stmts.push(
      db.prepare('DELETE FROM dispositions WHERE event_id IN (SELECT event_id FROM events WHERE event_seq <= ?1)').bind(c.s), // + claim_lead_links: nothing writes it yet
      db.prepare('DELETE FROM events WHERE event_seq <= ?1').bind(c.s));
  }
  // Chat by minute_utc: claims (and their links) first, then the messages.
  const chatIds = `SELECT chat_message_id FROM chat_messages WHERE minute_utc < ?1 ORDER BY minute_utc LIMIT ${PURGE_CHUNK}`;
  stmts.push(
    db.prepare(`DELETE FROM claim_lead_links WHERE claim_id IN (SELECT claim_id FROM monitoring_claims WHERE chat_message_id IN (${chatIds}))`).bind(cut),
    db.prepare(`DELETE FROM monitoring_claims WHERE chat_message_id IN (${chatIds})`).bind(cut),
    db.prepare(`DELETE FROM chat_messages WHERE chat_message_id IN (${chatIds})`).bind(cut),
    // Snapshots, then leads nothing references any more (a lead seen again recently stays), then batches whose events are gone.
    db.prepare(`DELETE FROM lead_snapshots WHERE snapshot_sha256 IN (SELECT snapshot_sha256 FROM lead_snapshots WHERE first_observed_at < ?1 LIMIT ${PURGE_CHUNK})`).bind(cut),
    db.prepare(`DELETE FROM leads WHERE lead_id IN (SELECT l.lead_id FROM leads l WHERE l.first_seen_at < ?1
                  AND NOT EXISTS (SELECT 1 FROM events e WHERE e.lead_id = l.lead_id)
                  AND NOT EXISTS (SELECT 1 FROM lead_snapshots s WHERE s.lead_id = l.lead_id)
                  AND NOT EXISTS (SELECT 1 FROM dispositions d WHERE d.lead_id = l.lead_id)
                  AND NOT EXISTS (SELECT 1 FROM claim_lead_links k WHERE k.lead_id = l.lead_id) LIMIT ${PURGE_CHUNK})`).bind(cut),
    db.prepare(`DELETE FROM upload_batches WHERE batch_id IN (SELECT batch_id FROM upload_batches WHERE received_at < ?1
                  AND (last_event_seq IS NULL OR last_event_seq < COALESCE((SELECT MIN(event_seq) FROM events), ${MAX_INT})) LIMIT ${PURGE_CHUNK})`).bind(cut),
    db.prepare('DELETE FROM daily_counts WHERE day_utc < ?1').bind(now - AGG_KEEP_DAYS * DAY));
  const res = await db.batch(stmts);
  return { deleted: res.map((r) => r.meta.changes) };
}
