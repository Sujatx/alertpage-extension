# apc-ingest

Cloudflare Worker + D1 that receives the extension's collector batches (`POST /v1/events:batch`),
stores them idempotently, and runs a daily cron (reconcile outcomes, daily counts, 90-day purge).
Contract values come from `extension/config/collector-settings.js` and `extension/lib/collect-canon.js`
(bundled by wrangler, no copies). No dependencies, no package.json.

Layout: `src/index.js` (ingest), `src/cron.js`, `src/report.js`, `migrations/`, `test/` (end-to-end), `ops/health.mjs`.

## Test locally

    node server/test/ingest.test.mjs

Wipes `server/.wrangler/state`, applies migrations, spawns two `wrangler dev --local` processes
(ports 8787 and 8788), prints PASS/FAIL per case, kills them, exits non-zero on failure (~2 min).
Needs `server/.dev.vars` with `HMAC_SECRET=anything` (git-ignored).

## Deploy (done 2026-11-18/19; steps kept for redeploys)

    cd server
    npx wrangler d1 create apc_core --location apac         # near the dispatchers (India); copy database_id into wrangler.toml
    npx wrangler d1 migrations apply apc_core --remote
    npx wrangler secret put HMAC_SECRET                     # long random string; losing it re-pseudonymises chat authors
    npx wrangler deploy

Then put the printed `*.workers.dev` URL in `ENDPOINT` in `extension/config/collector-settings.js`.
The Worker answers 500 `server_misconfigured` until `HMAC_SECRET` is set.

## Health

    node server/ops/health.mjs            # production, read-only
    node server/ops/health.mjs --local

Per-dispatcher activity, unknown IDs, identity mismatches, pending outcomes, rows written vs the Free quota.

## Check-in page

`GET /report?key=<REPORT_KEY>` is a read-only page: health warnings, leads and actions per dispatcher,
dataset size, days collecting. Counts only, no lead or chat text. It answers 404 until the secret is
set and for a wrong key. To set (or rotate) the key and get the link, in PowerShell from `server/`:

    $k = [guid]::NewGuid().ToString('N'); $k | npx wrangler secret put REPORT_KEY; "https://apc-ingest.sujat.workers.dev/report?key=$k"
