<div align="center">
  <img src="assets/icon.png" width="80" alt="AlertPage Working Screen Assist icon">

  # AlertPage Working Screen Assist
</div>

A Chrome MV3 extension that reformats AlertPage's Working Screen for faster triage and
links each lead straight through to the matching Data Feed search.

## Features

- **Cleaner lead details** — transcript, source, category, and keywords reordered into a readable block
- **Keyword highlighting** in the transcript
- **Inline audio player** for the transmission link
- **Jurisdiction auto-fill** from City, closing a gap in AlertPage's own address autocomplete
- **Reworked footer buttons** making it intuitive
- **Monitor button** that fills (or, opt-in, sends) the chat with `/m <county>` in one click
- **Data Feed link** that opens the Data Feed pre-filtered to a lead's system, county, and time window, reusing one tab across leads
- **Collector** — passively records what you see and do on the Working Screen and uploads it, so the team's workflow can be measured. It never clicks or submits anything for you.

## Install

```bash
chrome://extensions → Developer mode → Load unpacked → select the extension/ folder
```

Then open a lead at `https://dispatch.alertpage.net/web/working-queue/<lead id>/`.

The Data Feed link needs you signed in to `ap-portal.alertpage.net` in the same browser.
If you aren't, the link still works — it just opens the Data Feed unfiltered.

**One-time setup:** open the toolbar popup → Collector → **Your ID**, and enter your
company ID (for example `ap422`). It is filled in from your old ID note pill if you had one.
The collector uses it to tell dispatchers apart and won't upload until it's set.

## Update

Double-click `Update AlertPage.bat` (see [tools/README.md](tools/README.md)), or download the
latest zip from GitHub and extract it over the **same** folder. Then click the reload icon on
the extension in `chrome://extensions`. Your settings are kept.

## Usage

Open a lead and the layout, highlighting, audio player, and jurisdiction auto-fill are
already applied — nothing to turn on.

- **Monitor** fills the chat with `/m <county>` for you to review and send. Turn on
  "Monitor sends instantly" in the toolbar popup to have it send instantly instead.
- **Data Feed ↗** opens the Data Feed pre-filtered to that lead's system, county, and
  time window, reusing one tab across leads instead of piling up new ones.
- The toolbar icon is the only settings surface: display toggles, Data Feed link
  options, the collector switch, Your ID and its counts, the keyword list, and quick-fill note
  pills — everything saves as you type.

## Collector

On by default; switch it off under **Collector** in the popup. It records leads viewed,
dispositions you submit, field changes on allow-listed fields, team chat in room 1,
and what the extension itself wrote. It never reads passwords, cookies, CSRF tokens,
the chat input box, or keystrokes. Events queue in the browser (offline is fine) and
upload in small batches; nothing is deleted locally until the server confirms it.
The popup shows how many are queued, sent, and quarantined.

The backend is a Cloudflare Worker + D1 database in [`server/`](server/README.md),
with a daily job that reconciles outcomes and deletes raw data after 90 days.

## Network

- `GET /get_systems` on `ap-portal.alertpage.net`, to turn a lead's feed name into the
  Data Feed's system id. Cached for 12 hours.
- `POST /v1/events:batch` on `apc-ingest.sujat.workers.dev` — the collector's uploads
  to our own Worker. No other third-party calls, and no AI.

## Tests

```bash
node tests/run-tests.js
node server/test/ingest.test.mjs   # Worker + D1, runs locally with wrangler
```
