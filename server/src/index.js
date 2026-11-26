// apc-ingest: POST /v1/events:batch (docs/architecture/ingestion-pipeline.md, ADR-0014/0015/0016).
// Contract values come from the extension's shared files so client and server cannot disagree.
import C from '../../extension/config/collector-settings.js';
import canon from '../../extension/lib/collect-canon.js';
import { runCron } from './cron.js';
import { report } from './report.js';

const ACTIONS = new Set(['do_not_send', 'send_supervisor', 'mark_as_duplicate']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const enc = new TextEncoder();

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
const isInt = (v) => Number.isSafeInteger(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const normStr = (s) => s.trim().toLowerCase();

// Too-deep nesting counts as forbidden: it would otherwise hide a bad key below the scan depth.
function hasBadKey(o, depth = 0) {
  if (o === null || typeof o !== 'object') return false;
  if (depth > 8) return true;
  if (Array.isArray(o)) return o.some((v) => hasBadKey(v, depth + 1));
  return Object.keys(o).some((k) => C.FORBIDDEN_KEY_RE.test(k) || hasBadKey(o[k], depth + 1));
}

let hmacKey, hmacSecret;
async function pseudonym(secret, author) {
  if (hmacSecret !== secret) {
    hmacKey = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacSecret = secret;
  }
  return 'h_' + hex(await crypto.subtle.sign('HMAC', hmacKey, enc.encode(author))).slice(0, 16);
}

// Returns {code} on rejection or {row, identity?} on success (row is the stamped record for json_each).
async function validateEvent(e) {
  if (!isObj(e)) return { code: 'malformed_event' };
  if (typeof e.event_id !== 'string' || !UUID.test(e.event_id)) return { code: 'invalid_event_id' };
  if ('batch_id' in e || 'received_at' in e || 'payload_sha256' in e) return { code: 'client_server_field' };
  if (e.schema_version !== C.SCHEMA_VERSION) return { code: 'unknown_schema_version' };
  if (typeof e.event_type !== 'string' || !Object.hasOwn(C.CATEGORY, e.event_type)) return { code: 'unknown_event_type' };
  const cat = C.CATEGORY[e.event_type];
  if (e.category !== cat) return { code: 'category_mismatch' };
  if (!C.SOURCES.includes(e.source)) return { code: 'invalid_source' };
  if (!isInt(e.occurred_at) || !isInt(e.tz_offset_min)) return { code: 'invalid_field' };
  for (const k of ['tz_name', 'session_id', 'extension_version', 'collector_version'])
    if (typeof e[k] !== 'string' || !e[k]) return { code: 'invalid_field' };
  for (const k of ['tab_id', 'seq', 'lead_id', 'working_queue_id'])
    if (e[k] != null && !isInt(e[k])) return { code: 'invalid_field' };
  for (const k of ['page_load_id', 'parser_version'])
    if (e[k] != null && typeof e[k] !== 'string') return { code: 'invalid_field' };
  if (!isObj(e.payload)) return { code: 'invalid_payload' };
  if (hasBadKey(e.payload)) return { code: 'forbidden_key' };

  const row = {
    event_id: e.event_id, event_type: e.event_type, category: cat, schema_version: e.schema_version, source: e.source,
    session_id: e.session_id, page_load_id: e.page_load_id ?? null, tab_id: e.tab_id ?? null, seq: e.seq ?? null,
    lead_id: e.lead_id ?? null, working_queue_id: e.working_queue_id ?? null, occurred_at: e.occurred_at,
    tz_offset_min: e.tz_offset_min, tz_name: e.tz_name, extension_version: e.extension_version,
    collector_version: e.collector_version, parser_version: e.parser_version ?? null,
  };
  let payload = e.payload, identity;
  const p = e.payload;
  if (e.event_type === 'lead_viewed') {
    if (typeof p.header_text !== 'string' || typeof p.snapshot_sha256 !== 'string' || !isObj(p.snapshot) || !isObj(p.initial_fields) || e.lead_id == null)
      return { code: 'invalid_payload' };
    const snapText = canon.canonical(p.snapshot);
    if ((await canon.sha256Hex(snapText)) !== p.snapshot_sha256) return { code: 'snapshot_hash_mismatch' };
    row.snap_sha = p.snapshot_sha256; row.snap_text = snapText; row.header_text = p.header_text;
    payload = { header_text: p.header_text, snapshot_sha256: p.snapshot_sha256, initial_fields: p.initial_fields }; // body stored once, not in events.payload
  } else if (e.event_type === 'disposition_submitted') {
    const form = isObj(p.form) ? p.form : {};
    const notes = typeof form.internal_notes === 'string' ? form.internal_notes : null;
    row.action = ACTIONS.has(p.event_type_value) ? p.event_type_value : null;
    row.dup_marker = notes && /\bdup\b/i.test(notes) ? 1 : 0;
    row.internal_notes = notes;
    row.provenance_text = JSON.stringify(isObj(p.provenance) ? p.provenance : {});
  } else if (e.event_type === 'identity_observed') {
    if ((p.ap_user_id != null && !isInt(p.ap_user_id)) || (p.own_chat_handle != null && (typeof p.own_chat_handle !== 'string' || p.own_chat_handle.length > 64)))
      return { code: 'invalid_payload' };
    identity = { ap: p.ap_user_id ?? null, handle: p.own_chat_handle ? normStr(p.own_chat_handle) || null : null };
  }
  const text = JSON.stringify(payload);
  if (enc.encode(text).length > C.MAX_PAYLOAD_BYTES) return { code: 'payload_too_large' };
  row.payload_text = text;
  row.payload_sha256 = await canon.sha256Hex(text);
  return { row, identity };
}

async function validateChat(secret, e, dispatcherId, ownHandle) {
  if (typeof e.event_id !== 'string' || !UUID.test(e.event_id)) return { code: 'invalid_event_id' };
  if (!isInt(e.room_id) || typeof e.author !== 'string' || !e.author.trim() || !isInt(e.minute_utc) || !isInt(e.occurrence) ||
      typeof e.text_raw !== 'string' || typeof e.displayed_time !== 'string' || !isInt(e.observed_at) || typeof e.text_sha256 !== 'string')
    return { code: 'invalid_chat_item' };
  if (enc.encode(e.text_raw).length > C.MAX_PAYLOAD_BYTES) return { code: 'payload_too_large' };
  if ((await canon.sha256Hex(e.text_raw)) !== e.text_sha256) return { code: 'chat_hash_mismatch' };
  const author = normStr(e.author);
  const own = author === dispatcherId || (ownHandle != null && author === ownHandle);
  const row = { event_id: e.event_id, room_id: e.room_id, author_key: own ? author : await pseudonym(secret, author), author_is_dispatcher: own ? 1 : 0,
    minute_utc: e.minute_utc, occurrence: e.occurrence, text_sha256: e.text_sha256, text_raw: e.text_raw, displayed_time: e.displayed_time, observed_at: e.observed_at };
  if (/^\s*(MONITORING|PAGING)\b/i.test(e.text_raw)) {
    const m = /^\s*(MONITORING|PAGING)\s+([A-Za-z .'-]+?)\s+([A-Za-z]{2})\b\s*(.*)$/i.exec(e.text_raw);
    row.claim_kind = /^\s*MONITORING/i.test(e.text_raw) ? 'monitoring' : 'paging';
    row.county_raw = m?.[2] ?? null; row.county_norm = m ? m[2].toLowerCase() : null;
    row.state_token = m?.[3] ?? null; row.state_code = m ? m[3].toUpperCase() : null; row.free_text = m?.[4] ?? null;
    row.parse_status = m ? 'parsed' : 'partial';
  }
  return { row };
}

async function rateLimited(env, req, dispatcherId) {
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const keys = [`ip:${ip}`, ...(dispatcherId ? [`id:${dispatcherId}`] : [])];
  return (await Promise.all(keys.map((key) => env.RL.limit({ key })))).some((r) => !r.success);
}

const d1Down = () => json({ error: 'd1_error' }, 503, { 'retry-after': '30' });

async function ingest(req, env) {
  // 1. Origin gate before the body is read. A junk filter only: curl can forge it (ADR-0016).
  if (!C.ORIGIN_RE.test(req.headers.get('origin') ?? '')) return json({ error: 'origin_refused' }, 403);
  if (!env.HMAC_SECRET || !env.RL || !env.DB) return json({ error: 'server_misconfigured' }, 500);
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return json({ error: 'bad_content_type' }, 400);
  if (Number(req.headers.get('content-length') ?? 0) > C.MAX_BATCH_BYTES) return json({ error: 'too_large' }, 413);
  const buf = await req.arrayBuffer();
  if (buf.byteLength > C.MAX_BATCH_BYTES) return json({ error: 'too_large' }, 413);

  let body;
  try { body = JSON.parse(new TextDecoder().decode(buf)); } catch { return json({ error: 'bad_json' }, 400); }
  if (!isObj(body) || typeof body.batch_id !== 'string' || !UUID.test(body.batch_id) || !Array.isArray(body.events) || body.events.length < 1)
    return json({ error: 'bad_shape' }, 400);
  if (body.events.length > C.MAX_BATCH_EVENTS) return json({ error: 'too_many_events' }, 413); // client splits the batch
  const events = body.events;
  const ids = new Set(events.map((e) => (isObj(e) && typeof e.dispatcher_id === 'string' ? normStr(e.dispatcher_id) : '')));
  if (ids.size > 1) return json({ error: 'mixed_dispatcher_id' }, 400);
  const claimed = [...ids][0];
  const received_at = Date.now(), bytes = buf.byteLength, db = env.DB;
  const clientSentAt = isInt(body.client_sent_at) ? body.client_sent_at : null;

  const ack = (results, extra = {}) => {
    const c = { accepted: 0, duplicate: 0, rejected: 0 };
    for (const r of results) c[r.status]++;
    return { batch_id: body.batch_id, results, ...c, server_time: Date.now(), ...extra };
  };
  const evId = (e) => (isObj(e) && typeof e.event_id === 'string' ? e.event_id : null);
  const rejectAll = (code) => events.map((e) => ({ event_id: evId(e), status: 'rejected', code }));
  // OR IGNORE: a retry of an all-rejected batch must not fail on the batch_id primary key.
  const metaInsert = (dispatcherId, c) =>
    db.prepare(`INSERT OR IGNORE INTO upload_batches (batch_id, dispatcher_id, claimed_dispatcher_id, received_at, client_sent_at, event_count, accepted, duplicate, rejected, bytes, first_event_seq, last_event_seq, identity_check)
                VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULL,NULL,'unknown')`)
      .bind(body.batch_id, dispatcherId, claimed.slice(0, 32), received_at, clientSentAt, events.length, c.accepted, c.duplicate, c.rejected, bytes);

  // 4. Missing or malformed dispatcher id: reject every event, write only a metadata batch row.
  const idProblem = !claimed || claimed === C.DISPATCHER_ID_PLACEHOLDER ? 'missing_dispatcher_id' : !C.DISPATCHER_ID_RE.test(claimed) ? 'invalid_dispatcher_id' : null;
  if (idProblem) {
    if (await rateLimited(env, req, null)) return json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });
    const out = ack(rejectAll(idProblem));
    try { await db.batch([metaInsert(null, out)]); } catch { return d1Down(); }
    return json(out);
  }
  // 5a. Coarse rate guard (per dispatcher and per IP).
  if (await rateLimited(env, req, claimed)) return json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });

  // 6. Per-event validation and server stamping. Non-chat first so identity_observed can name the own chat handle.
  const results = new Array(events.length), valid = [], chat = [], idx = [];
  const reject = (i, code) => { results[i] = { event_id: evId(events[i]), status: 'rejected', code }; };
  const isChat = (e) => isObj(e) && (e.item_type === 'chat_message_observed' || e.event_type === 'chat_message_observed');
  const seen = new Set(), identities = [];
  for (let i = 0; i < events.length; i++) {
    if (isChat(events[i])) continue;
    const r = await validateEvent(events[i]);
    if (r.code) reject(i, r.code);
    else if (seen.has(r.row.event_id)) results[i] = { event_id: r.row.event_id, status: 'duplicate' }; // same id twice in one batch: stored once
    else { seen.add(r.row.event_id); valid.push(r.row); idx.push({ i, chat: false, n: valid.length - 1 }); if (r.identity) identities.push(r.identity); }
  }

  // 5b. Read-only prelude (one D1 query): dispatcher row, existing ids, existing chat keys, batch replay, last batch time.
  let pre;
  try {
    pre = await db.batch([
      db.prepare('SELECT status, ap_user_id, chat_handle FROM dispatchers WHERE dispatcher_id = ?1').bind(claimed),
      db.prepare('SELECT event_id FROM events WHERE event_id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(valid.map((v) => v.event_id))),
      db.prepare('SELECT event_count FROM upload_batches WHERE batch_id = ?1').bind(body.batch_id),
      db.prepare('SELECT MAX(received_at) AS t FROM upload_batches WHERE dispatcher_id = ?1').bind(claimed),
    ]);
  } catch { return d1Down(); }
  const drow = pre[0].results[0]; // missing row = first sight, created below
  const status = drow?.status ?? 'active';
  const existing = new Set(pre[1].results.map((r) => r.event_id));
  const batchRow = pre[2].results[0], lastAt = pre[3].results[0]?.t ?? null;

  if (status === 'disabled') {
    const out = ack(rejectAll('disabled_dispatcher'));
    try { await db.batch([metaInsert(claimed, out)]); } catch { return d1Down(); }
    return json(out);
  }

  // identity_check (ADR-0016 point 3): the first observed value per field is recorded, later ones are compared. Never blocks.
  let apUser = drow?.ap_user_id ?? null, handle = drow?.chat_handle ?? null, matched = false, mismatch = false;
  for (const o of identities) {
    for (const [obs, cur, set] of [[o.ap, apUser, (v) => (apUser = v)], [o.handle, handle, (v) => (handle = v)]]) {
      if (obs == null) continue;
      if (cur == null) set(obs); else if (cur === obs) matched = true; else mismatch = true;
    }
  }
  const identityCheck = mismatch ? 'mismatch' : matched ? 'match' : 'unknown';

  // Chat items (need the own handle just resolved) and their existing-key check, a second small read.
  for (let i = 0; i < events.length; i++) {
    if (!isChat(events[i])) continue;
    const r = await validateChat(env.HMAC_SECRET, events[i], claimed, handle);
    if (r.code) { reject(i, r.code); continue; }
    const k = [r.row.room_id, r.row.author_key, r.row.minute_utc, r.row.text_sha256, r.row.occurrence].join('|');
    if (seen.has(k)) { results[i] = { event_id: r.row.event_id, status: 'duplicate' }; continue; }
    seen.add(k); chat.push(r.row); idx.push({ i, chat: true, n: chat.length - 1 });
  }
  let chatExisting = new Set();
  if (chat.length) {
    try {
      const r = await db.prepare(`SELECT j.key AS k FROM json_each(?1) j JOIN chat_messages m
                      ON m.room_id = json_extract(j.value,'$.room_id') AND m.author_key = json_extract(j.value,'$.author_key')
                     AND m.minute_utc = json_extract(j.value,'$.minute_utc') AND m.text_sha256 = json_extract(j.value,'$.text_sha256')
                     AND m.occurrence = json_extract(j.value,'$.occurrence')`).bind(JSON.stringify(chat)).all();
      chatExisting = new Set(r.results.map((x) => Number(x.k)));
    } catch { return d1Down(); }
  }

  let allKnown = true, nNewEvents = 0;
  for (const { i, chat: isC, n } of idx) {
    const dup = isC ? chatExisting.has(n) : existing.has(valid[n].event_id);
    if (!dup && !isC) nNewEvents++;
    if (!dup) allKnown = false;
    results[i] = { event_id: events[i].event_id, status: dup ? 'duplicate' : 'accepted' };
  }

  // Replay of a stored batch is answered before the gap check, so a retry after a lost response is not punished (7.3).
  if (batchRow) {
    if (batchRow.event_count === events.length && allKnown) {
      return json({ ...ack(results.map((r) => (r.status === 'accepted' ? { ...r, status: 'duplicate' } : r))), replay: true });
    }
    return json({ error: 'batch_id_conflict' }, 409);
  }
  // 5c. Exact gap: one batch per dispatcher per MIN_BATCH_GAP_MS.
  if (lastAt != null && received_at - lastAt < C.MIN_BATCH_GAP_MS)
    return json({ error: 'rate_limited' }, 429, { 'retry-after': String(Math.max(1, Math.ceil((C.MIN_BATCH_GAP_MS - (received_at - lastAt)) / 1000))) });

  const out = ack(results);
  const stmts = [
    db.prepare(`INSERT INTO dispatchers (dispatcher_id, label, ap_user_id, chat_handle, status, created_at) VALUES (?1,?1,NULL,NULL,'active',?2) ON CONFLICT DO NOTHING`).bind(claimed, received_at),
  ];
  if (apUser != null || handle != null)
    stmts.push(db.prepare('UPDATE dispatchers SET ap_user_id = COALESCE(ap_user_id, ?2), chat_handle = COALESCE(chat_handle, ?3) WHERE dispatcher_id = ?1').bind(claimed, apUser, handle));
  stmts.push(
    // Seq range assumes the events below insert consecutively (one writer per D1; same-batch duplicate ids were removed above).
    db.prepare(`INSERT INTO upload_batches (batch_id, dispatcher_id, claimed_dispatcher_id, received_at, client_sent_at, event_count, accepted, duplicate, rejected, bytes, first_event_seq, last_event_seq, identity_check)
                VALUES (?1,?2,?2,?3,?4,?5,?6,?7,?8,?9,
                        CASE WHEN ?10 > 0 THEN (SELECT COALESCE(MAX(event_seq),0)+1 FROM events) END,
                        CASE WHEN ?10 > 0 THEN (SELECT COALESCE(MAX(event_seq),0)+?10 FROM events) END, ?11)`)
      .bind(body.batch_id, claimed, received_at, clientSentAt, events.length, out.accepted, out.duplicate, out.rejected, bytes, nNewEvents, identityCheck),
  );
  const evJson = JSON.stringify(valid);
  if (valid.length) {
    stmts.push(
      db.prepare(`INSERT OR IGNORE INTO leads (lead_id, first_seen_at, first_seen_by_dispatcher_id)
                  SELECT DISTINCT json_extract(value,'$.lead_id'), ?2, ?3 FROM json_each(?1) WHERE json_extract(value,'$.lead_id') IS NOT NULL`).bind(evJson, received_at, claimed),
      db.prepare(`INSERT OR IGNORE INTO lead_snapshots (snapshot_sha256, lead_id, first_observed_at, first_event_id, header_text, body)
                  SELECT json_extract(value,'$.snap_sha'), json_extract(value,'$.lead_id'), json_extract(value,'$.occurred_at'), json_extract(value,'$.event_id'),
                         json_extract(value,'$.header_text'), json_extract(value,'$.snap_text')
                    FROM json_each(?1) WHERE json_extract(value,'$.event_type') = 'lead_viewed'`).bind(evJson),
      db.prepare(`INSERT INTO events (event_id, event_type, category, schema_version, source, dispatcher_id, batch_id, session_id, page_load_id, tab_id, seq, lead_id, working_queue_id,
                                      occurred_at, received_at, tz_offset_min, tz_name, extension_version, collector_version, parser_version, payload, payload_sha256)
                  SELECT json_extract(value,'$.event_id'), json_extract(value,'$.event_type'), json_extract(value,'$.category'), json_extract(value,'$.schema_version'), json_extract(value,'$.source'),
                         ?2, ?3, json_extract(value,'$.session_id'), json_extract(value,'$.page_load_id'), json_extract(value,'$.tab_id'), json_extract(value,'$.seq'),
                         json_extract(value,'$.lead_id'), json_extract(value,'$.working_queue_id'), json_extract(value,'$.occurred_at'), ?4, json_extract(value,'$.tz_offset_min'),
                         json_extract(value,'$.tz_name'), json_extract(value,'$.extension_version'), json_extract(value,'$.collector_version'), json_extract(value,'$.parser_version'),
                         json_extract(value,'$.payload_text'), json_extract(value,'$.payload_sha256')
                    FROM json_each(?1) WHERE true
                  ON CONFLICT(event_id) DO NOTHING`).bind(evJson, claimed, body.batch_id, received_at),
    );
  }
  if (chat.length) {
    const chJson = JSON.stringify(chat);
    stmts.push(
      db.prepare(`INSERT OR IGNORE INTO chat_messages (room_id, author_key, author_is_dispatcher, minute_utc, occurrence, text_sha256, text_raw, displayed_time, first_observed_at, first_dispatcher_id)
                  SELECT json_extract(value,'$.room_id'), json_extract(value,'$.author_key'), json_extract(value,'$.author_is_dispatcher'), json_extract(value,'$.minute_utc'),
                         json_extract(value,'$.occurrence'), json_extract(value,'$.text_sha256'), json_extract(value,'$.text_raw'), json_extract(value,'$.displayed_time'),
                         json_extract(value,'$.observed_at'), ?2 FROM json_each(?1)`).bind(chJson, claimed),
    );
    if (chat.some((c) => c.claim_kind))
      stmts.push(db.prepare(`INSERT OR IGNORE INTO monitoring_claims (chat_message_id, claim_kind, author_key, dispatcher_id, claimed_at, county_raw, county_norm, state_token, state_code, free_text, parse_status, parser_version)
                  SELECT m.chat_message_id, json_extract(j.value,'$.claim_kind'), m.author_key, NULL, m.minute_utc, json_extract(j.value,'$.county_raw'), json_extract(j.value,'$.county_norm'),
                         json_extract(j.value,'$.state_token'), json_extract(j.value,'$.state_code'), json_extract(j.value,'$.free_text'), json_extract(j.value,'$.parse_status'), 'mon-parse-1'
                    FROM json_each(?1) j JOIN chat_messages m
                      ON m.room_id = json_extract(j.value,'$.room_id') AND m.author_key = json_extract(j.value,'$.author_key') AND m.minute_utc = json_extract(j.value,'$.minute_utc')
                     AND m.text_sha256 = json_extract(j.value,'$.text_sha256') AND m.occurrence = json_extract(j.value,'$.occurrence')
                   WHERE json_extract(j.value,'$.claim_kind') IS NOT NULL`).bind(chJson));
    // claim_lead_links (rule mon-1) is deferred: nothing is written to it.
  }
  if (valid.some((v) => v.event_type === 'disposition_submitted' && v.action && v.lead_id != null))
    stmts.push(db.prepare(`INSERT OR IGNORE INTO dispositions (event_id, lead_id, working_queue_id, dispatcher_id, tab_id, page_load_id, action, submitted_at, internal_notes, dup_marker, dup_referenced_lead_id, provenance, outcome_status, derive_rule_version)
                  SELECT json_extract(value,'$.event_id'), json_extract(value,'$.lead_id'), json_extract(value,'$.working_queue_id'), ?2, json_extract(value,'$.tab_id'), json_extract(value,'$.page_load_id'),
                         json_extract(value,'$.action'), json_extract(value,'$.occurred_at'), json_extract(value,'$.internal_notes'), json_extract(value,'$.dup_marker'), NULL,
                         json_extract(value,'$.provenance_text'), 'pending', 'dr-1'
                    FROM json_each(?1) WHERE json_extract(value,'$.event_type') = 'disposition_submitted' AND json_extract(value,'$.action') IS NOT NULL AND json_extract(value,'$.lead_id') IS NOT NULL`).bind(evJson, claimed));

  try { await db.batch(stmts); } catch { return d1Down(); } // one transaction: all rows or none (AC-6)
  return json(out);
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (pathname === '/report') {
      try { return await report(req, env); } catch { return d1Down(); }
    }
    if (pathname !== '/v1/events:batch') return json({ error: 'not_found' }, 404);
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    return ingest(req, env);
  },
  async scheduled(_event, env) { await runCron(env); },
};
