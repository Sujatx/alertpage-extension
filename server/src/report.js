// GET /report?key=<REPORT_KEY>: read-only daily check-in page. Counts only, no lead or chat text.
// shortcut: scans dispositions and upload_batches on every visit (tens of thousands of rows at 90 days); precompute in the cron if opened often.
const DAY = 86400000, QUOTA = 100000, MAX_MB = 500; // D1 Free limits
const ACTIONS = [['mark_as_duplicate', 'Duplicate', '#2a78d6'], ['do_not_send', 'Do not send', '#eb6834'], ['send_supervisor', 'Send supervisor', '#1baf7a', 'supervisor']];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (n) => n.toLocaleString('en-US');
const sum = (rows) => rows.reduce((t, r) => t + r.n, 0);
const sha = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

export async function report(req, env, now = Date.now()) {
  const key = new URL(req.url).searchParams.get('key') ?? '';
  // Hashes are compared so response timing says nothing about the key. No key set = route off.
  const [a, b] = await Promise.all([sha(key), sha(env.REPORT_KEY ?? '')]);
  if (req.method !== 'GET' || !env.REPORT_KEY || !a.every((x, i) => x === b[i])) return new Response('not found', { status: 404 });

  const db = env.DB;
  const [batches, actions, leads, pending, started] = await db.batch([
    db.prepare(`SELECT dispatcher_id AS id, max(received_at) AS last, sum(received_at > ?1) AS batches,
                       sum(CASE WHEN received_at > ?1 THEN accepted ELSE 0 END) AS accepted,
                       sum(CASE WHEN received_at > ?1 THEN rejected ELSE 0 END) AS rejected,
                       sum(received_at > ?2 AND identity_check = 'mismatch') AS mismatch
                  FROM upload_batches GROUP BY dispatcher_id`).bind(now - DAY, now - 7 * DAY),
    db.prepare('SELECT dispatcher_id AS id, action, count(*) AS n FROM dispositions GROUP BY dispatcher_id, action'),
    db.prepare('SELECT dispatcher_id AS id, count(DISTINCT lead_id) AS n FROM dispositions GROUP BY dispatcher_id'),
    db.prepare(`SELECT count(*) AS n FROM dispositions WHERE outcome_status = 'pending' AND submitted_at < ?1`).bind(now - DAY),
    db.prepare('SELECT min(created_at) AS t FROM dispatchers'),
  ]);

  const mb = started.meta.size_after / 1e6;
  const start = started.results[0].t;
  const ids = batches.results.filter((r) => r.id != null);
  const written = batches.results.reduce((t, r) => t + r.accepted * 5 + r.batches * 3, 0); // estimate, as in ops/health.mjs
  const warn = [];
  for (const r of ids) {
    if (now - r.last > DAY) warn.push(`${r.id} has sent nothing for more than 24 hours`);
    if (r.mismatch) warn.push(`${r.id}: ${r.mismatch} identity mismatches in 7 days`);
  }
  const rejected = batches.results.reduce((t, r) => t + r.rejected, 0);
  if (rejected) warn.push(`${num(rejected)} uploaded items rejected in 24 hours`);
  if (pending.results[0].n) warn.push(`${num(pending.results[0].n)} dispositions pending for more than a day`);
  if (written > QUOTA * 0.6) warn.push('Daily write quota is over 60% used');
  if (mb > MAX_MB * 0.8) warn.push(`Database is over 80% of the ${MAX_MB} MB limit`);

  const since = start == null ? null : new Date(start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const cards = [['Leads handled', num(sum(leads.results))], ['Dataset size', `${mb.toFixed(1)} MB`],
    [since ? `Days since ${since}` : 'Days collecting', start == null ? 0 : Math.floor(now / DAY) - Math.floor(start / DAY)]];
  const legend = ACTIONS.map(([, label, color]) => `<span><i style="background:${color}"></i>${label}</span>`).join('');

  const max = Math.max(1, ...leads.results.map((l) => l.n));
  const dispatchers = leads.results.map((r) => {
    const mine = actions.results.filter((d) => d.id === r.id), total = sum(mine), n = r.n;
    const parts = ACTIONS.map(([action, label, color, short = label.toLowerCase()]) => ({ label: short, color, n: sum(mine.filter((d) => d.action === action)) }));
    return `<h2>${esc(r.id)}: ${num(n)}</h2>
<div class="bar" style="width:${((n / max) * 100).toFixed(1)}%">${parts.map((p) => `<i style="flex:${p.n};background:${p.color}" title="${p.label} ${num(p.n)}"></i>`).join('')}</div>
<p class="m">${parts.map((p) => `${num(p.n)} ${p.label} (${total ? Math.round((p.n / total) * 100) : 0}%)`).join(' · ')}</p>`;
  }).join('');

  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Collector check-in</title>
<style>:root{color-scheme:dark}body{background:#1a1a1a;color:#eee;font:14px/1.5 system-ui,sans-serif;margin:0;padding:16px}main{max-width:680px;margin:auto;border:1px solid #8883;border-radius:8px;padding:24px 15px 4px}h2,b{font-weight:500}h2{font-size:14px;margin:0 0 4px}
.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:20px}.cards div{background:#8881;border-radius:8px;padding:12px;font-size:13px}.cards b{display:block;font-size:24px}
.legend{display:flex;flex-wrap:wrap;gap:16px;font-size:12px;color:#888;margin-bottom:12px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px}
.bar{display:flex;gap:2px;height:20px}.m{font-size:12px;opacity:.65;margin:4px 0 14px}ul{margin-top:0;padding-left:20px}</style>
<main>${warn.length ? `<ul>${warn.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
<div class="cards">${cards.map(([l, v]) => `<div>${l}<b>${v}</b></div>`).join('')}</div><div class="legend">${legend}</div>${dispatchers}</main></html>`;

  return new Response(html, { headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  } });
}
