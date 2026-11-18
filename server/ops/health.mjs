// Read-only health report for the collector database.
//   node server/ops/health.mjs            (production D1, needs `npx wrangler login`)
//   node server/ops/health.mjs --local    (local D1, e.g. after test/ingest.test.mjs)
// One wrangler call per query: D1 takes one statement per --command.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const where = process.argv.includes('--local') ? '--local' : '--remote';
const DAY = 86400000, now = Date.now(), QUOTA = 100000;

function q(sql) {
  const p = spawnSync('npx', ['wrangler', 'd1', 'execute', 'apc_core', where, '--json', '--command', `"${sql.replace(/\s+/g, ' ')}"`], { cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 1 << 26 });
  try { return JSON.parse(p.stdout.slice(p.stdout.indexOf('[')))[0].results; } catch { throw new Error('query failed: ' + (p.stderr || p.stdout).slice(0, 300)); }
}
const ago = (ms) => (ms == null ? 'never' : ms < 3600000 ? `${Math.round(ms / 60000)} min ago` : `${(ms / 3600000).toFixed(1)} h ago`);
const when = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const line = (warn, text) => console.log((warn ? 'WARN ' : 'ok   ') + text);

console.log(`Collector health (${where.slice(2)} D1) at ${when(now)}\n`);

const d1 = now - DAY;
const per = q(`SELECT dispatcher_id, count(*) AS batches, sum(accepted) AS accepted, sum(duplicate) AS duplicate, sum(rejected) AS rejected
               FROM upload_batches WHERE received_at > ${d1} AND dispatcher_id IS NOT NULL GROUP BY dispatcher_id`);
const lastSeen = Object.fromEntries(q(`SELECT dispatcher_id AS id, max(received_at) AS t FROM upload_batches WHERE dispatcher_id IS NOT NULL GROUP BY dispatcher_id`).map((r) => [r.id, r.t]));
const disp = q(`SELECT dispatcher_id, status, created_at, ap_user_id IS NOT NULL AS ap_set FROM dispatchers ORDER BY created_at`);

console.log('Dispatchers (every ID the Worker has ever accepted; an unfamiliar ID is someone new or a typo):');
if (!disp.length) console.log('  none yet');
for (const d of disp) {
  const p = per.find((x) => x.dispatcher_id === d.dispatcher_id);
  const silent = now - (lastSeen[d.dispatcher_id] ?? 0) > DAY && d.status === 'active';
  line(silent, `${d.dispatcher_id} [${d.status}] since ${when(d.created_at)}, AlertPage account ${d.ap_set ? 'recorded' : 'not recorded'}; last 24 h: ` +
    (p ? `${p.batches} batches, ${p.accepted} accepted, ${p.duplicate} duplicate, ${p.rejected} rejected` : 'no batches') +
    `; last seen ${ago(lastSeen[d.dispatcher_id] == null ? null : now - lastSeen[d.dispatcher_id])}` + (silent ? ' (silent more than 24 h)' : ''));
}

const nul = q(`SELECT count(*) AS n, sum(event_count) AS e FROM upload_batches WHERE dispatcher_id IS NULL AND received_at > ${d1}`)[0];
line(nul.n > 0, `${nul.n} batches (${nul.e ?? 0} events) in the last 24 h had a missing or malformed dispatcher ID and were rejected`);

const mm = q(`SELECT dispatcher_id, count(*) AS n FROM upload_batches WHERE identity_check = 'mismatch' AND received_at > ${now - 7 * DAY} GROUP BY dispatcher_id`);
line(mm.length > 0, mm.length ? `identity mismatches in 7 days: ${mm.map((r) => `${r.dispatcher_id} x${r.n}`).join(', ')} (page account or chat handle differs from the first one recorded)` : 'no identity mismatches in 7 days');

const pend = q(`SELECT count(*) AS n FROM dispositions WHERE outcome_status = 'pending' AND submitted_at < ${now - DAY}`)[0].n;
const mix = q(`SELECT outcome_status AS s, count(*) AS n FROM dispositions WHERE submitted_at > ${now - 7 * DAY} GROUP BY outcome_status`);
line(pend > 0, `${pend} dispositions still pending after more than a day (the daily cron should have reconciled them)`);
console.log('     outcomes, last 7 days: ' + (mix.length ? mix.map((r) => `${r.s} ${r.n}`).join(', ') : 'none'));

// Rough: an accepted event costs about 5 rows written (row, two indexes, lead/snapshot/chat extras) and each batch about 3.
const w = q(`SELECT count(*) AS b, coalesce(sum(accepted),0) AS a FROM upload_batches WHERE received_at > ${d1}`)[0];
const est = w.a * 5 + w.b * 3;
line(est > QUOTA * 0.6, `about ${est.toLocaleString('en-US')} rows written in 24 h from ${w.a} accepted items in ${w.b} batches = ${Math.round((est / QUOTA) * 100)}% of the ${QUOTA.toLocaleString('en-US')}/day Free quota (estimate; excludes the daily cron)`);
