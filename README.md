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
- **Summarize (beta)** — drafts a one-line, hyperlinked incident summary from the transmissions around the alert, using your own Gemini API key
- **Lead status (beta)** — an opt-in traffic light on each lead: green if the incident is one your team works, red if it isn't, grey if it couldn't tell — and it learns from your corrections

## Install

```bash
chrome://extensions → Developer mode → Load unpacked → select the extension/ folder
```

Then open a lead at `https://dispatch.alertpage.net/web/working-queue/<lead id>/`.

The Data Feed link needs you signed in to `ap-portal.alertpage.net` in the same browser.
If you aren't, the link still works — it just opens the Data Feed unfiltered.

## Usage

Open a lead and the layout, highlighting, audio player, and jurisdiction auto-fill are
already applied — nothing to turn on.

- **Monitor** fills the chat with `/m <county>` for you to review and send. Turn on
  "Monitor autosend" in the toolbar popup to have it send instantly instead.
- **Data Feed ↗** opens the Data Feed pre-filtered to that lead's system, county, and
  time window, reusing one tab across leads instead of piling up new ones.
- **Summarize**, in the Data Feed's banner, drafts a one-line incident summary from the
  transmissions around the alert. Click any segment of the result to jump straight to
  the transmission it came from.
- The toolbar icon is the only settings surface: display toggles, Data Feed sync
  toggles, the keyword list, quick-fill pills (set your Agent ID pill once), and your
  Gemini API key for Summarize — everything saves as you type.

- **Lead status**, off by default, reads each lead as it opens and marks it green
  (one of your incident types), red (not one of them), or grey (not enough to go on).
  Hover the pill for the reasoning and the line it was based on. It is advisory only —
  nothing is hidden, filtered, or actioned, and the full lead reads exactly as it
  always has. When it gets one wrong, the **Ours / Not ours** buttons beside it
  record your call; those corrections are carried into every later check as worked
  examples. Matching is semantic, not keyword-based: each transcript is embedded as a
  vector, and a new lead is checked against the past rulings most *like* it, which
  also act as a second opinion on the answer. So it keeps improving as you label
  rather than levelling off. The toolbar popup shows how many corrections it has
  learned from and can clear them.

Summarize and Lead status share one free-tier Gemini API key, pasted into the
"Summarize AI(beta)" card. It's stored only in your own browser.

## Network

Four requests, all read-only:

- `GET /get_systems` on `ap-portal.alertpage.net`, to turn a lead's feed name into the
  Data Feed's system id. Cached for 12 hours.
- `GET /get_transmissions` on the same host, only when you click Summarize — fetches
  the transcripts it needs to work from.
- Two calls to `generativelanguage.googleapis.com` (Google's Gemini API), using the
  API key you supplied: `generateContent` when you click Summarize, and — if you've
  switched Lead status on — `generateContent` plus one small `embedContent` per lead
  you open. This is the one third-party call this
  extension ever makes, and it's opt-in: leave the key blank and it never happens.
  Verdicts are cached per lead, so reopening one costs nothing.

## Tests

```bash
node tests/run-tests.js
```
