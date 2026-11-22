// End-to-end test of the ingest Worker against local D1. No dependencies.
//   node server/test/ingest.test.mjs        (from anywhere; needs network-free `npx wrangler`)
// It wipes server/.wrangler/state, applies migrations, seeds old rows, spawns
//   wrangler dev --local --port 8787 --test-scheduled      (the real Worker)
//   wrangler dev --local --port 8788 -c test/wrangler.harness.toml   (same Worker, write batch poisoned: AC-6)
// runs the cases, kills both, and exits non-zero on any failure.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import C from '../../extension/config/collector-settings.js';
import canon from '../../extension/lib/collect-canon.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = 'http://127.0.0.1:8787', HARNESS = 'http://127.0.0.1:8788';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const DAY = 86400000, now0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash('sha256').update(s).digest('hex');

// ---- local D1 via wrangler (one statement per --command; single quotes only inside SQL for cmd.exe) ----
const wr = (args) => spawnSync('npx', ['wrangler', ...args], { cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 1 << 26 });
function sql(cmd) {
  const p = wr(['d1', 'execute', 'apc_core', '--local', '--json', '--command', `"${cmd.replace(/\s+/g, ' ')}"`]);
  try { return JSON.parse(p.stdout.slice(p.stdout.indexOf('[')))[0].results; } catch { throw new Error('d1 failed: ' + (p.stderr || p.stdout).slice(0, 400)); }
}
const one = (cmd) => sql(cmd)[0];
const counts = (d) => one(`SELECT
  (SELECT count(*) FROM upload_batches WHERE dispatcher_id='${d}') AS batches,
  (SELECT count(*) FROM events WHERE dispatcher_id='${d}') AS events,
  (SELECT count(*) FROM dispositions WHERE dispatcher_id='${d}') AS dispositions,
  (SELECT count(*) FROM leads WHERE first_seen_by_dispatcher_id='${d}') AS leads,
  (SELECT count(*) FROM lead_snapshots WHERE lead_id IN (SELECT lead_id FROM leads WHERE first_seen_by_dispatcher_id='${d}')) AS snaps,
  (SELECT count(*) FROM chat_messages WHERE first_dispatcher_id='${d}') AS chat,
  (SELECT count(*) FROM dispatchers WHERE dispatcher_id='${d}') AS dispatchers`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- wrangler dev processes ----
const procs = [];
function start(args, base) {
  const p = spawn('npx', ['wrangler', 'dev', '--local', ...args], { cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', (d) => (log += d)); p.stderr.on('data', (d) => (log += d));
  procs.push(p);
  return (async () => {
    for (let i = 0; i < 90; i++) {
      try { if ((await fetch(base + '/ready')).status === 404) return; } catch {}
      await sleep(1000);
    }
    throw new Error('wrangler dev not ready: ' + log.slice(-600));
  })();
}
function killAll() {
  for (const p of procs) process.platform === 'win32' ? spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F']) : p.kill('SIGKILL');
}

// ---- request builders ----
const SESS = randomUUID();
const ev = (disp, type, payload = {}, o = {}) => ({
  event_id: randomUUID(), event_type: type, category: C.CATEGORY[type], schema_version: 1, source: 'working_screen', dispatcher_id: disp,
  session_id: SESS, page_load_id: o.pl ?? randomUUID(), tab_id: o.tab ?? 1, seq: 0, lead_id: o.lead ?? null, working_queue_id: null,
  occurred_at: o.at ?? Date.now(), tz_offset_min: 240, tz_name: 'America/New_York', extension_version: '1.0.0', collector_version: C.COLLECTOR_VERSION, payload,
});
const snapshot = (n) => ({ blob_text: 'synthetic ' + n, audio_url: `/audio/${n}.mp3`, county: 'Alpha', state: 'OH', city: 'Synville', jurisdiction: 'SYN-FD' });
const leadViewed = async (disp, lead, o = {}) => {
  const snap = snapshot(lead);
  return ev(disp, 'lead_viewed', { header_text: 'Syn ' + lead, snapshot_sha256: await canon.sha256Hex(canon.canonical(snap)), snapshot: snap, initial_fields: { city: 'Synville' } }, { lead, ...o });
};
const dispo = (disp, lead, o = {}) => ev(disp, 'disposition_submitted', { submitter_id: 'do-not-send-button', event_type_value: 'do_not_send', form: { internal_notes: 'dup of 1' }, provenance: {}, blocked: false }, { lead, ...o });
const chatItem = (disp, author, text, minute, o = {}) => ({
  item_type: 'chat_message_observed', event_id: randomUUID(), dispatcher_id: disp, room_id: 1, author, minute_utc: minute, occurrence: 0,
  text_sha256: sha(text), text_raw: text, displayed_time: '12:00 PM', observed_at: Date.now(), ...o,
});
const batch = (events, o = {}) => ({ batch_id: o.id ?? randomUUID(), client_sent_at: Date.now(), events });
async function post(body, { base = MAIN, origin = ORIGIN, raw, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', connection: 'close', ...headers };
  if (origin) h.origin = origin;
  const r = await fetch(base + '/v1/events:batch', { method: 'POST', headers: h, body: raw ?? JSON.stringify(body) });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = { raw: t.slice(0, 200) }; }
  return { status: r.status, body: b, headers: r.headers };
}

// ---- tiny runner ----
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ' :: ' + (e.message ?? e)); }
}
const ok = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => ok(same(a, b), `${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);

// ---- setup ----
try {
  rmSync(join(ROOT, '.wrangler', 'state'), { recursive: true, force: true });
  const m = wr(['d1', 'migrations', 'apply', 'apc_core', '--local']);
  if (m.status !== 0) throw new Error('migrations failed: ' + (m.stderr || m.stdout).slice(-500));

  // Old and yesterday rows go in FIRST so their event_seq values are lower than anything the cases insert, as in real life.
  const OLD = now0 - 100 * DAY, YDAY = Math.floor(now0 / DAY) * DAY - 12 * 3600000, VERY_OLD = now0 - 400 * DAY;
  const ins = (id, at, first, last) => `INSERT INTO upload_batches (batch_id, dispatcher_id, claimed_dispatcher_id, received_at, event_count, accepted, duplicate, rejected, bytes, first_event_seq, last_event_seq, identity_check)
    VALUES ('${id}','tseed','tseed',${at},1,1,0,0,10,${first},${last},'unknown');`;
  const evRow = (id, batchId, type, at, lead) => `INSERT INTO events (event_id, event_type, category, schema_version, source, dispatcher_id, batch_id, session_id, lead_id, occurred_at, received_at, tz_offset_min, tz_name, extension_version, collector_version, payload, payload_sha256)
    VALUES ('${id}','${type}','page_observation',1,'working_screen','tseed','${batchId}','s',${lead},${at},${at},0,'UTC','1','1','{}','x');`;
  const seed = [
    `INSERT INTO dispatchers VALUES ('tseed','tseed',NULL,NULL,'active',${OLD});`,
    `INSERT INTO leads VALUES (900001,${OLD},'tseed'),(900002,${OLD},'tseed');`,
    ins('old-batch', OLD, 1, 2), evRow('old-ev-1', 'old-batch', 'flash_observed', OLD, 900001), evRow('old-ev-2', 'old-batch', 'flash_observed', OLD, 900001),
    `INSERT INTO dispositions (event_id, lead_id, dispatcher_id, action, submitted_at, dup_marker, outcome_status, derive_rule_version) VALUES ('old-ev-2',900001,'tseed','do_not_send',${OLD},0,'pending','dr-1');`,
    `INSERT INTO lead_snapshots VALUES ('oldsnap',900001,${OLD},'old-ev-1','h','{}');`,
    `INSERT INTO chat_messages (chat_message_id, room_id, author_key, author_is_dispatcher, minute_utc, occurrence, text_sha256, text_raw, displayed_time, first_observed_at, first_dispatcher_id) VALUES (7001,1,'h_x',0,${OLD},0,'t','MONITORING Alpha OH','1',${OLD},'tseed');`,
    `INSERT INTO monitoring_claims (chat_message_id, claim_kind, author_key, claimed_at, parse_status, parser_version) VALUES (7001,'monitoring','h_x',${OLD},'parsed','p');`,
    `INSERT INTO daily_counts VALUES (${VERY_OLD},'tseed','flash_observed',5);`,
    ins('yday-batch', YDAY, 3, 5), evRow('yday-1', 'yday-batch', 'queue_stats', YDAY, 'NULL'), evRow('yday-2', 'yday-batch', 'queue_stats', YDAY, 'NULL'), evRow('yday-3', 'yday-batch', 'flash_observed', YDAY, 'NULL'),
  ].join('\n');
  const f = join(mkdtempSync(join(tmpdir(), 'apc-seed-')), 'seed.sql');
  writeFileSync(f, seed);
  const s = wr(['d1', 'execute', 'apc_core', '--local', '--file', `"${f}"`]);
  if (s.status !== 0) throw new Error('seed failed: ' + (s.stderr || s.stdout).slice(-500));

  await start(['--port', '8787', '--test-scheduled'], MAIN);
  await start(['--port', '8788', '-c', 'test/wrangler.harness.toml', '--persist-to', '.wrangler/state', '--var', 'HMAC_SECRET:harness-secret'], HARNESS);
} catch (e) { console.log('SETUP FAILED: ' + e.message); killAll(); process.exit(2); }

// ---- cases ----
try {
  await test('origin: wrong or missing Origin -> 403 origin_refused (no D1 touched)', async () => {
    for (const origin of ['https://evil.example', 'chrome-extension://short', null]) {
      const r = await post(batch([ev('t01', 'queue_stats')]), { origin });
      ok(r.status === 403 && r.body.error === 'origin_refused', `origin ${origin}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    eq(counts('t01'), { batches: 0, events: 0, dispositions: 0, leads: 0, snaps: 0, chat: 0, dispatchers: 0 }, 'rows');
  });

  await test('dispatcher_id: missing / placeholder / malformed -> all rejected, metadata batch row only', async () => {
    for (const [id, code] of [[undefined, 'missing_dispatcher_id'], ['AP***', 'missing_dispatcher_id'], ['Bad Id!', 'invalid_dispatcher_id']]) {
      const e = ev(id, 'queue_stats'); if (id === undefined) delete e.dispatcher_id;
      const r = await post(batch([e]));
      ok(r.status === 200 && r.body.rejected === 1 && r.body.results[0].code === code, `${id}: ${JSON.stringify(r.body)}`);
    }
    const n = one(`SELECT count(*) AS n FROM upload_batches WHERE dispatcher_id IS NULL`).n;
    ok(n === 3, 'expected 3 NULL-dispatcher batch rows, got ' + n);
    ok(one(`SELECT count(*) AS n FROM events WHERE dispatcher_id LIKE 'bad%'`).n === 0, 'event stored');
  });

  await test('size: 51 events -> 413; body > 128 KB -> 413; mixed dispatcher ids -> 400', async () => {
    const many = await post(batch(Array.from({ length: C.MAX_BATCH_EVENTS + 1 }, () => ev('t03', 'queue_stats'))));
    ok(many.status === 413, 'events: ' + many.status);
    const big = await post(null, { raw: JSON.stringify(batch([ev('t03', 'queue_stats', { pad: 'x'.repeat(C.MAX_BATCH_BYTES) })])) });
    ok(big.status === 413, 'bytes: ' + big.status);
    const mixed = await post(batch([ev('t03', 'queue_stats'), ev('t04', 'queue_stats')]));
    ok(mixed.status === 400 && mixed.body.error === 'mixed_dispatcher_id', 'mixed: ' + mixed.status);
    eq(counts('t03').events, 0, 'events stored');
  });

  const b5 = batch([await leadViewed('t05', 910005), dispo('t05', 910005), ev('t05', 'field_changed', { field: 'internal_notes', value_after: 'x' }, { lead: 910005 })]);
  await test('valid batch accepted, rows present, snapshot stored as canonical text', async () => {
    const r = await post(b5);
    ok(r.status === 200 && r.body.accepted === 3 && r.body.duplicate === 0 && r.body.rejected === 0, JSON.stringify(r.body));
    eq(counts('t05'), { batches: 1, events: 3, dispositions: 1, leads: 1, snaps: 1, chat: 0, dispatchers: 1 }, 'rows');
    const s = one(`SELECT body, snapshot_sha256 FROM lead_snapshots WHERE lead_id=910005`);
    ok(s.body === canon.canonical(snapshot(910005)) && s.snapshot_sha256 === sha(s.body), 'snapshot body is not canonical');
    const b = one(`SELECT first_event_seq, last_event_seq, identity_check FROM upload_batches WHERE dispatcher_id='t05'`);
    ok(b.last_event_seq - b.first_event_seq === 2 && b.identity_check === 'unknown', JSON.stringify(b));
  });

  await test('replay x3 of the same batch -> identical row counts, all duplicate (AC-5)', async () => {
    const before = counts('t05');
    for (let i = 0; i < 3; i++) {
      const r = await post(b5);
      ok(r.status === 200 && r.body.duplicate === 3 && r.body.accepted === 0 && r.body.replay === true, `replay ${i}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    eq(counts('t05'), before, 'row counts changed');
    const conflict = await post({ ...b5, events: b5.events.slice(0, 2) });
    ok(conflict.status === 409, 'same batch_id, different content: ' + conflict.status);
  });

  await test('429 rate_limited on a second distinct batch within 2 s; replay still answered', async () => {
    const first = batch([ev('t14', 'queue_stats')]);
    const r0 = await post(first);
    const r = await post(batch([ev('t14', 'queue_stats')]));
    ok(r0.status === 200 && r.status === 429 && r.body.error === 'rate_limited' && Number(r.headers.get('retry-after')) >= 1, `${r0.status} ${r.status} ${JSON.stringify(r.body)}`);
    const rp = await post(first);
    ok(rp.status === 200 && rp.body.replay, 'replay was punished: ' + rp.status);
    eq(counts('t14').batches, 1, 'batch rows');
  });

  await test('mid-transaction failure leaves no rows; the retry then succeeds (AC-6)', async () => {
    const b = batch([await leadViewed('t06', 910006), dispo('t06', 910006), chatItem('t06', 'someone', 'hello there', now0)]);
    const r = await post(b, { base: HARNESS });
    ok(r.status === 503 && r.body.error === 'd1_error', `${r.status} ${JSON.stringify(r.body)}`);
    eq(counts('t06'), { batches: 0, events: 0, dispositions: 0, leads: 0, snaps: 0, chat: 0, dispatchers: 0 }, 'rows survived the failure');
    const retry = await post(b);
    ok(retry.status === 200 && retry.body.accepted === 3, 'retry: ' + JSON.stringify(retry.body));
    eq(counts('t06'), { batches: 1, events: 2, dispositions: 1, leads: 1, snaps: 1, chat: 1, dispatchers: 1 }, 'rows after retry');
  });

  await test('forbidden key rejected, valid sibling stored (AC-9 scan after)', async () => {
    const bad = ev('t07', 'field_changed', { field: 'x', nested: { deep: [{ 'CSRF-Token': 'abc' }] } });
    const tooDeep = ev('t07', 'field_changed', { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 1 } } } } } } } } } });
    const good = ev('t07', 'field_changed', { field: 'city', value_after: 'Synville' });
    const r = await post(batch([bad, good, tooDeep]));
    ok(r.status === 200 && r.body.accepted === 1 && r.body.rejected === 2 && r.body.results[0].code === 'forbidden_key', JSON.stringify(r.body));
    eq(counts('t07').events, 1, 'events stored');
  });

  await test('rejected events counted on the batch row, not stored (AC-15)', async () => {
    const good = ev('t08', 'queue_stats', { queued: 1 });
    const unknownType = { ...ev('t08', 'queue_stats'), event_type: 'ext_vote_recorded', category: 'extension_action' };
    const serverField = { ...ev('t08', 'queue_stats'), received_at: 1 };
    const wrongCat = { ...ev('t08', 'queue_stats'), category: 'dispatcher_action' };
    const proto = { ...ev('t08', 'queue_stats'), event_type: 'constructor' };
    const r = await post(batch([good, unknownType, serverField, wrongCat, proto]));
    eq(r.body.results.map((x) => x.code ?? x.status), ['accepted', 'unknown_event_type', 'client_server_field', 'category_mismatch', 'unknown_event_type'], 'results');
    eq(counts('t08').events, 1, 'events stored');
    const b = one(`SELECT accepted, duplicate, rejected, event_count FROM upload_batches WHERE dispatcher_id='t08'`);
    eq(b, { accepted: 1, duplicate: 0, rejected: 4, event_count: 5 }, 'batch row');
  });

  await test('snapshot hash mismatch rejected', async () => {
    const e = await leadViewed('t09', 910009);
    e.payload.snapshot.county = 'Tampered';
    const r = await post(batch([e]));
    ok(r.body.rejected === 1 && r.body.results[0].code === 'snapshot_hash_mismatch', JSON.stringify(r.body));
    eq(counts('t09'), { batches: 1, events: 0, dispositions: 0, leads: 0, snaps: 0, chat: 0, dispatchers: 1 }, 'rows');
  });

  await test('chat: own vs pseudonymised author, MONITORING claim parsed, duplicate key across dispatchers', async () => {
    const minute = Math.floor(now0 / 60000) * 60000;
    const items = [chatItem('t10', 'T10', 'MONITORING Greene OH working it', minute), chatItem('t10', 'Other', 'PAGING Clark OH', minute), chatItem('t10', 'Other', 'bad hash', minute, { text_sha256: 'f'.repeat(64) })];
    const r = await post(batch(items));
    eq(r.body.results.map((x) => x.code ?? x.status), ['accepted', 'accepted', 'chat_hash_mismatch'], 'results');
    const rows = sql(`SELECT m.author_key, m.author_is_dispatcher AS own, c.claim_kind, c.county_norm, c.state_code, c.free_text, c.parse_status FROM chat_messages m LEFT JOIN monitoring_claims c ON c.chat_message_id = m.chat_message_id WHERE m.first_dispatcher_id='t10' ORDER BY m.chat_message_id`);
    eq(rows[0], { author_key: 't10', own: 1, claim_kind: 'monitoring', county_norm: 'greene', state_code: 'OH', free_text: 'working it', parse_status: 'parsed' }, 'own monitoring row');
    ok(rows[1].own === 0 && /^h_[0-9a-f]{16}$/.test(rows[1].author_key) && rows[1].claim_kind === 'paging', JSON.stringify(rows[1]));
    // A second dispatcher sees the same message: duplicate, no second row.
    const r2 = await post(batch([chatItem('t11', 'Other', 'PAGING Clark OH', minute)]));
    ok(r2.body.duplicate === 1, JSON.stringify(r2.body));
    eq(one(`SELECT count(*) AS n FROM chat_messages WHERE text_raw = 'PAGING Clark OH'`).n, 1, 'chat rows');
  });

  await test('identity_check: unknown -> match -> mismatch; first pair recorded; data never blocked', async () => {
    const idEv = (ap, h) => ev('t12', 'identity_observed', { ap_user_id: ap, own_chat_handle: h });
    const r1 = await post(batch([idEv(4242, 'AP422X')]));
    ok(r1.body.accepted === 1, JSON.stringify(r1.body));
    await sleep(C.MIN_BATCH_GAP_MS + 150);
    const r2 = await post(batch([idEv(4242, 'ap422x')]));
    await sleep(C.MIN_BATCH_GAP_MS + 150);
    const r3 = await post(batch([idEv(9999, 'someone-else'), ev('t12', 'queue_stats')]));
    ok(r2.body.accepted === 1 && r3.body.accepted === 2, 'data was blocked: ' + JSON.stringify([r2.body, r3.body]));
    eq(sql(`SELECT identity_check AS c FROM upload_batches WHERE dispatcher_id='t12' ORDER BY received_at`).map((x) => x.c), ['unknown', 'match', 'mismatch'], 'identity_check');
    eq(one(`SELECT ap_user_id, chat_handle FROM dispatchers WHERE dispatcher_id='t12'`), { ap_user_id: 4242, chat_handle: 'ap422x' }, 'recorded pair');
  });

  // Cron fixtures: five dispositions in separate windows, all submitted > 120 s ago.
  const T = now0 - 3600000, ld = 920000;
  const mk = async () => {
    const a = dispo('t13', ld + 1, { at: T, pl: randomUUID(), tab: 1 });
    const flashA = ev('t13', 'flash_observed', { flash_text: 'Lead Processed', previous_page_load_id: a.page_load_id }, { at: T + 30000, tab: 1, lead: 900002 });
    const b = dispo('t13', ld + 2, { at: T + 600000, tab: 1 });
    const flashB = ev('t13', 'flash_observed', { flash_text: 'Lead Processed', previous_page_load_id: randomUUID() }, { at: T + 630000, tab: 2 });
    const c = dispo('t13', ld + 3, { at: T + 1200000 });
    const d = dispo('t13', ld + 4, { at: T + 1800000 }), e = dispo('t13', ld + 5, { at: T + 1810000 });
    const flashD = ev('t13', 'flash_observed', { flash_text: 'Lead Processed', previous_page_load_id: null }, { at: T + 1840000, tab: 3 });
    // Production shape: two submits 5 s apart, each flash names its own page load, so both are confirmed (rc-2),
    // one flash arriving 300 s after its submit (outside the 120 s window, inside the exact-match limit).
    const f = dispo('t13', ld + 6, { at: T + 2400000, pl: randomUUID(), tab: 1 }), g = dispo('t13', ld + 7, { at: T + 2405000, pl: randomUUID(), tab: 1 });
    const flashF = ev('t13', 'flash_observed', { flash_text: 'Lead Processed', previous_page_load_id: f.page_load_id }, { at: T + 2403000, tab: 1 });
    const flashG = ev('t13', 'flash_observed', { flash_text: 'Lead Processed', previous_page_load_id: g.page_load_id }, { at: T + 2405000 + 300000, tab: 1 });
    const evs = [a, flashA, b, flashB, c, d, e, flashD, f, flashF, g, flashG];
    return { evs, ids: { a, b, c, d, e, f, g, flashA, flashB, flashF, flashG } };
  };
  const cron = await mk();
  await test('cron: reconciler -> confirmed / probable / unconfirmed / ambiguous; aggregates; 90-day purge in FK order', async () => {
    const r = await post(batch(cron.evs));
    ok(r.body.accepted === 12, JSON.stringify(r.body));
    eq(counts('t13').dispositions, 7, 'dispositions before');
    const c = await fetch(MAIN + '/__scheduled?cron=30+12+*+*+*');
    ok(c.status === 200, 'scheduled trigger: ' + c.status);
    const I = cron.ids, out = {};
    for (let i = 0; i < 20 && !out.done; i++) { // the handler is awaited by wrangler, but poll anyway
      const rows = sql(`SELECT event_id, outcome_status AS s, outcome_event_id AS o, reconcile_rule_version AS v FROM dispositions WHERE dispatcher_id='t13'`);
      for (const x of rows) out[x.event_id] = x;
      out.done = rows.every((x) => x.s !== 'pending');
      if (!out.done) await sleep(1000);
    }
    ok(out.done, 'still pending after cron');
    eq(out[I.a.event_id].s, 'confirmed', 'a'); eq(out[I.a.event_id].o, I.flashA.event_id, 'a outcome');
    eq(out[I.b.event_id].s, 'probable', 'b'); eq(out[I.b.event_id].o, I.flashB.event_id, 'b outcome');
    eq(out[I.c.event_id].s, 'unconfirmed', 'c'); eq(out[I.c.event_id].o, null, 'c outcome');
    eq([out[I.d.event_id].s, out[I.e.event_id].s], ['ambiguous', 'ambiguous'], 'd,e');
    eq(out[I.a.event_id].v, 'rc-2', 'rule version');
    eq([out[I.f.event_id].s, out[I.g.event_id].s], ['confirmed', 'confirmed'], 'f,g exact');
    eq([out[I.f.event_id].o, out[I.g.event_id].o], [I.flashF.event_id, I.flashG.event_id], 'f,g outcomes');

    // aggregates: yesterday's seeded events
    eq(sql(`SELECT event_type, n FROM daily_counts WHERE dispatcher_id='tseed' AND n < 5 ORDER BY event_type`), [{ event_type: 'flash_observed', n: 1 }, { event_type: 'queue_stats', n: 2 }], 'daily_counts');
    // purge: old rows gone, 400-day aggregate gone, referenced old lead kept, recent data untouched
    eq(one(`SELECT (SELECT count(*) FROM events WHERE dispatcher_id='tseed' AND received_at < ${now0 - 90 * DAY}) AS ev,
      (SELECT count(*) FROM dispositions WHERE dispatcher_id='tseed') AS dsp, (SELECT count(*) FROM lead_snapshots WHERE snapshot_sha256='oldsnap') AS snap,
      (SELECT count(*) FROM chat_messages WHERE chat_message_id=7001) AS chat, (SELECT count(*) FROM monitoring_claims WHERE chat_message_id=7001) AS claim,
      (SELECT count(*) FROM upload_batches WHERE batch_id='old-batch') AS old_batch, (SELECT count(*) FROM upload_batches WHERE batch_id='yday-batch') AS yday_batch,
      (SELECT count(*) FROM leads WHERE lead_id=900001) AS lead_gone, (SELECT count(*) FROM leads WHERE lead_id=900002) AS lead_kept,
      (SELECT count(*) FROM daily_counts WHERE n = 5) AS old_counts`),
      { ev: 0, dsp: 0, snap: 0, chat: 0, claim: 0, old_batch: 0, yday_batch: 1, lead_gone: 0, lead_kept: 1, old_counts: 0 }, 'purge');
    eq(counts('t13').events, 12, 'recent events survived');
  });

  await test('AC-9 scan: no stored payload, snapshot or chat text contains token/csrf/cookie/password/api_key', async () => {
    const n = one(`SELECT (SELECT count(*) FROM events WHERE instr(lower(payload),'token')>0 OR instr(lower(payload),'csrf')>0 OR instr(lower(payload),'cookie')>0 OR instr(lower(payload),'password')>0 OR instr(lower(payload),'api_key')>0 OR instr(lower(payload),'apikey')>0)
      + (SELECT count(*) FROM lead_snapshots WHERE instr(lower(body),'token')>0 OR instr(lower(body),'csrf')>0 OR instr(lower(body),'cookie')>0 OR instr(lower(body),'password')>0 OR instr(lower(body),'api_key')>0 OR instr(lower(body),'apikey')>0) AS n`).n;
    eq(n, 0, 'sensitive keys stored');
  });
} finally {
  killAll();
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
