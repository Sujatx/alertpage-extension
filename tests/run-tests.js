#!/usr/bin/env node
/*
 * Tests for the pure lib/ + config/ layer. No browser, no dependencies.
 *
 *     node tests/run-tests.js
 *
 * The lead-parsing fixture is extracted from working-screen/working-screen.html at
 * run time from captures/working-screen, rather than hardcoded, so these tests fail if the capture and the
 * parser ever drift apart.
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var LEAD = require(path.join(ROOT, 'extension/lib/parse-lead.js'));
var HL = require(path.join(ROOT, 'extension/lib/highlight.js'));
var K = require(path.join(ROOT, 'extension/config/keywords.js'));
var NOTES = require(path.join(ROOT, 'extension/lib/notes.js'));
var PC = require(path.join(ROOT, 'extension/config/pills.js'));
var FEED = require(path.join(ROOT, 'extension/lib/lead-feed.js'));
var DFC = require(path.join(ROOT, 'extension/config/data-feed-settings.js'));
var CC = require(path.join(ROOT, 'extension/config/collector-settings.js'));
var CANON = require(path.join(ROOT, 'extension/lib/collect-canon.js'));
var ENV = require(path.join(ROOT, 'extension/lib/collect-envelope.js'));
var RED = require(path.join(ROOT, 'extension/lib/collect-redact.js'));
var CHAT = require(path.join(ROOT, 'extension/lib/collect-chat.js'));
var Q = require(path.join(ROOT, 'extension/lib/collect-queue.js'));

var passed = 0;
var failed = [];
var group = '';

function describe(name, fn) { group = name; fn(); }

function it(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed.push({ name: group + ' > ' + name, message: err.message });
  }
}

var pending = [];

// For tests that return a promise; the report waits for all of them.
function itAsync(name, fn) {
  var label = group + ' > ' + name;
  pending.push(Promise.resolve().then(fn).then(function () { passed++; }, function (err) {
    failed.push({ name: label, message: err.message });
  }));
}

function eq(actual, expected, label) {
  var a = JSON.stringify(actual);
  var e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error((label ? label + ': ' : '') + 'expected ' + e + ', got ' + a);
  }
}

function ok(value, label) {
  if (!value) { throw new Error((label || 'assertion') + ' was falsy'); }
}

// --------------------------------------------------------------- the fixture

/**
 * The header timestamp as the server renders it, scraped from the same capture as the
 * lead blob and for the same reason: if AlertPage ever changes the format,
 * parseLeadTime stops matching and this fails, rather than the Data Feed silently
 * being filtered to the wrong fifteen minutes.
 */
function realLeadTimeText() {
  var file = path.join(ROOT, 'captures/working-screen/working-screen.html');
  if (!fs.existsSync(file)) { return null; }
  var html = fs.readFileSync(file, 'utf8');
  var m = /<span id="working_lead_id">[^<]*<\/span>\s*<span class="text-muted[^"]*">([^<]*)<\/span>/.exec(html);
  return m ? m[1].trim() : null;
}

function realLeadBlob() {
  var file = path.join(ROOT, 'captures/working-screen/working-screen.html');
  if (!fs.existsSync(file)) { return null; }
  var html = fs.readFileSync(file, 'utf8');
  var m = /<span class="form-control-static d-block text-muted ps-2">([\s\S]*?)<\/span>/.exec(html);
  if (!m) { return null; }
  // textContent equivalent: <br> contributes nothing, entities decoded
  return m[1]
    .replace(/<br\s*\/?>/gi, '')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

// ------------------------------------------------------------------- parsing

describe('parseLead', function () {
  var raw = realLeadBlob();

  it('parses the real captured lead blob', function () {
    ok(raw, 'fixture extracted from working-screen.html');
    var got = LEAD.parseLead(raw);
    eq(got.ok, true, 'ok');
    eq(got.feed, 'FDNY Analog (BCFY Calls) - Queens Dispatch', 'feed');
    eq(got.category, 'General Fire', 'category');
    eq(got.keywords, 'fire in', 'keywords');
    ok(/^Division one four of the Queens\./.test(got.transcript), 'transcript start');
    ok(/82-11 Northern Boulevard$/.test(got.transcript), 'transcript end');
    eq(got.extra, [], 'extra');
  });

  it('drops the trailing separator dash instead of appending it to the transcript', function () {
    var got = LEAD.parseLead(raw);
    ok(!/[-–—]\s*$/.test(got.transcript), 'transcript must not end with the filler dash');
  });

  it('keeps a multi-line transcript together', function () {
    var got = LEAD.parseLead([
      '(Some Feed - Dispatch)',
      '',
      'Alert Category - General Fire',
      '',
      'Transcript - first line of speech',
      'second line of speech',
      'third line'
    ].join('\n'));
    eq(got.transcript, 'first line of speech second line of speech third line');
  });

  it('tolerates leading words before the Transcript label', function () {
    var got = LEAD.parseLead('Alert Keywords - fire in\n\nin the Transcript - engine 4 responding');
    eq(got.keywords, 'fire in');
    eq(got.transcript, 'engine 4 responding');
  });

  it('does not mistake a keyword value containing "transcript" for the header', function () {
    var got = LEAD.parseLead('Alert Keywords - see transcript - now\n\nTranscript - real speech here');
    eq(got.keywords, 'see transcript - now');
    eq(got.transcript, 'real speech here');
  });

  it('handles a lead with no keywords line', function () {
    var got = LEAD.parseLead('(Feed)\n\nAlert Category - General Fire\n\nTranscript - smoke showing');
    eq(got.ok, true);
    eq(got.keywords, '');
    eq(got.transcript, 'smoke showing');
  });

  it('accepts a colon separator', function () {
    eq(LEAD.parseLead('Transcript: units responding').transcript, 'units responding');
  });

  it('reports ok:false on text that is not a lead', function () {
    eq(LEAD.parseLead('just some unrelated paragraph').ok, false);
    eq(LEAD.parseLead('').ok, false);
    eq(LEAD.parseLead(null).ok, false);
  });

  it('never loses text - unplaceable lines land in extra', function () {
    var got = LEAD.parseLead('(Feed)\nstray line\nAlert Category - Fire');
    eq(got.feed, 'Feed');
    eq(got.extra, ['stray line']);
  });
});

describe('looksLikeLeadBlob', function () {
  it('is true for the real blob', function () {
    ok(LEAD.looksLikeLeadBlob(realLeadBlob()));
  });
  it('is false for the Sent Alerts sidebar text', function () {
    ok(!LEAD.looksLikeLeadBlob('2026-Aug-26 13:58\n San Bernardino'));
  });
  it('is false for the agency/talkgroup spans', function () {
    ok(!LEAD.looksLikeLeadBlob('FDNY QN Dispatch, Queens Dispatch'));
  });
});

describe('extractAudioUrl', function () {
  var url = 'https://media-alrtpg.s3.us-east-va.io.cloud.ovh.us/bcfy_calls/fdny_analog/1787763340-223670.m4a';
  var longSignalUrl = 'https://signal.alertpage.net/media/eyJiIjoibWVkaWEtYWxydHBnIiwiZSI6MTc4ODEwODMzNiwiayI6IjE3ODgwMjE5MzUyMTAtNTQ3N2NjZTMubTRhIn0.4c6f0f3382ee950be9952876db15e6ac2c691ad07a72cae67735e96fc933270b';

  it('prefers the link text', function () {
    eq(LEAD.extractAudioUrl(url, "openFullScreen('http://other/x.m4a'); return false;"), url);
  });
  it('extracts long signal.alertpage.net URL from link text', function () {
    eq(LEAD.extractAudioUrl(longSignalUrl, ''), longSignalUrl);
  });
  it('falls back to the onclick argument', function () {
    eq(LEAD.extractAudioUrl('Listen', "openFullScreen('" + url + "'); return false;"), url);
  });
  it('handles double-quoted onclick arguments', function () {
    eq(LEAD.extractAudioUrl('', 'openFullScreen("' + url + '"); return false;'), url);
  });
  it('extracts long signal.alertpage.net URL from onclick argument', function () {
    eq(LEAD.extractAudioUrl('Listen', "openFullScreen('" + longSignalUrl + "'); return false;"), longSignalUrl);
  });
  it('extracts URL from href attribute when link text is not a URL and onclick is absent', function () {
    eq(LEAD.extractAudioUrl('Listen to audio', '', longSignalUrl), longSignalUrl);
  });
  it('ignores # href attribute', function () {
    eq(LEAD.extractAudioUrl('Listen', '', '#'), '');
  });
  it('returns empty when there is nothing to extract', function () {
    eq(LEAD.extractAudioUrl('Listen', 'somethingElse()'), '');
    eq(LEAD.extractAudioUrl(null, null), '');
  });
});

// ------------------------------------------------------------------ matching

// Matcher behaviour is tested against a fixed local ruleset, not against the shipped
// config, so tuning keywords.js can never silently weaken these.
var FIXTURE_RULES = [
  {
    id: 'a', label: 'A', bg: '#ffd8a8', fg: '#6b3000', enabled: true,
    terms: ['structure fire', 'fire is out', 'fire', 'signal 10-75', 'heavy smoke']
  },
  {
    id: 'b', label: 'B', bg: '#c5e4ff', fg: '#0b4a6f', enabled: true,
    terms: ['mayday', 'fire']
  }
];

function texts(ranges) { return ranges.map(function (r) { return r.text; }); }
function ids(ranges) { return ranges.map(function (r) { return r.ruleId; }); }

describe('findRanges', function () {
  it('is whole-token, not substring', function () {
    eq(HL.findRanges('firefighter bonfire backfired', FIXTURE_RULES), []);
  });

  it('prefers the longest phrase at a position', function () {
    eq(texts(HL.findRanges('the fire is out now', FIXTURE_RULES)), ['fire is out']);
    eq(texts(HL.findRanges('a structure fire', FIXTURE_RULES)), ['structure fire']);
  });

  it('is case-insensitive', function () {
    eq(ids(HL.findRanges('MAYDAY', FIXTURE_RULES)), ['b']);
    eq(texts(HL.findRanges('STRUCTURE FIRE', FIXTURE_RULES)), ['STRUCTURE FIRE']);
  });

  it('matches terms containing digits and punctuation', function () {
    eq(texts(HL.findRanges('signal 10-75 transmitted', FIXTURE_RULES)), ['signal 10-75']);
  });

  it('lets a space in a term match any whitespace run', function () {
    eq(ids(HL.findRanges('heavy\n  smoke', FIXTURE_RULES)), ['a']);
  });

  it('gives a shared term to the first rule that claims it', function () {
    eq(ids(HL.findRanges('fire', FIXTURE_RULES)), ['a']);
  });

  it('returns non-overlapping ranges in document order', function () {
    var got = HL.findRanges('structure fire with heavy smoke, mayday', FIXTURE_RULES);
    ok(got.length >= 2, 'expected several matches');
    for (var i = 1; i < got.length; i++) {
      ok(got[i].start >= got[i - 1].end, 'range ' + i + ' must not overlap the previous one');
      ok(got[i].start > got[i - 1].start, 'ranges must be in document order');
    }
  });

  it('skips disabled rules', function () {
    var off = FIXTURE_RULES.map(function (r) {
      return Object.assign({}, r, { enabled: r.id !== 'b' });
    });
    eq(HL.findRanges('mayday', off), []);
  });

  it('survives a malformed user-entered term', function () {
    var bad = [{ id: 'x', label: 'X', bg: '#ffffff', fg: '#000000', enabled: true, terms: ['a(b', '['] }];
    ok(Array.isArray(HL.findRanges('a(b and [ here', bad)), 'must return an array, not throw');
  });

  it('handles an empty or absent ruleset', function () {
    eq(HL.findRanges('mayday', []), []);
    eq(HL.findRanges('mayday', null), []);
    eq(HL.findRanges('', FIXTURE_RULES), []);
  });
});

describe('findLinkRanges', function () {
  it('finds a bare https URL', function () {
    var got = HL.findLinkRanges('Terminating 1244. https://www.broadcastify.com/listen/feed/16005');
    eq(texts(got), ['https://www.broadcastify.com/listen/feed/16005']);
  });

  it('finds a bare http URL', function () {
    eq(texts(HL.findLinkRanges('see http://example.com/x for details')), ['http://example.com/x']);
  });

  it('trims a trailing sentence period that is not part of the URL', function () {
    eq(texts(HL.findLinkRanges('link is https://example.com/a.')), ['https://example.com/a']);
  });

  it('trims trailing punctuation like commas and closing brackets', function () {
    eq(texts(HL.findLinkRanges('(see https://example.com/a), then https://example.com/b;')),
      ['https://example.com/a', 'https://example.com/b']);
  });

  it('finds multiple links in document order, non-overlapping', function () {
    var got = HL.findLinkRanges('first https://a.example/1 then https://b.example/2 done');
    eq(texts(got), ['https://a.example/1', 'https://b.example/2']);
    ok(got[1].start >= got[0].end, 'ranges must not overlap');
  });

  it('does not match a bare domain with no protocol', function () {
    eq(HL.findLinkRanges('visit www.example.com for info'), []);
  });

  it('returns an empty array when there is nothing to find', function () {
    eq(HL.findLinkRanges('units responding, no links here'), []);
    eq(HL.findLinkRanges(''), []);
    eq(HL.findLinkRanges(null), []);
  });
});

describe('normalizeRules', function () {
  it('falls back to defaults when storage is empty', function () {
    eq(HL.normalizeRules(null, K.DEFAULT_RULES).length, K.DEFAULT_RULES.length);
    eq(HL.normalizeRules([], K.DEFAULT_RULES).length, K.DEFAULT_RULES.length);
  });

  it('fills missing fields from the matching default', function () {
    var got = HL.normalizeRules([{ id: 'structure' }], K.DEFAULT_RULES)[0];
    eq(got.label, 'Structure');
    ok(got.terms.length > 0, 'terms restored from default');
  });

  it('keeps unknown custom categories', function () {
    var got = HL.normalizeRules([{ id: 'custom-1', label: 'Mine', terms: ['foo'] }], K.DEFAULT_RULES);
    eq(got.length, 1);
    eq(got[0].id, 'custom-1');
    eq(got[0].terms, ['foo']);
    ok(got[0].bg, 'a colour is supplied even when the user did not pick one');
  });

  it('honours enabled:false', function () {
    eq(HL.normalizeRules([{ id: 'structure', enabled: false }], K.DEFAULT_RULES)[0].enabled, false);
  });
});

describe('default ruleset', function () {
  it('has unique category ids', function () {
    var ids2 = K.DEFAULT_RULES.map(function (r) { return r.id; });
    eq(ids2.length, new Set(ids2).size, 'duplicate rule id');
  });

  it('gives every category a colour pair and at least one term', function () {
    K.DEFAULT_RULES.forEach(function (r) {
      ok(/^#[0-9a-f]{6}$/i.test(r.bg), r.id + ' bg');
      ok(/^#[0-9a-f]{6}$/i.test(r.fg), r.id + ' fg');
      ok(r.terms.length > 0, r.id + ' terms');
    });
  });

  it('compiles into a working matcher', function () {
    ok(HL.buildMatcher(K.DEFAULT_RULES), 'matcher built');
  });

  it('stays minimal - one category, few terms', function () {
    eq(K.DEFAULT_RULES.length, 1, 'category count');
    ok(K.DEFAULT_RULES[0].terms.length <= 6,
      'default term list should stay short; got ' + K.DEFAULT_RULES[0].terms.length);
  });

  it('matches the default terms', function () {
    eq(texts(HL.findRanges('we have a structure fire on the second floor', K.DEFAULT_RULES)),
      ['structure', 'fire']);
    eq(ids(HL.findRanges('heavy smoke from the structure', K.DEFAULT_RULES)), ['structure']);
    eq(ids(HL.findRanges('water damage in the basement', K.DEFAULT_RULES)), ['structure']);
  });

  // The intent guard for the whole ruleset: generic architectural and address words
  // appear in nearly every transmission, so highlighting them highlights nothing.
  // Tuning the term list is expected; re-adding this vocabulary is not.
  it('does NOT highlight ordinary architectural or address vocabulary', function () {
    var noise = 'the basement and the roof of the first floor of a three story building, '
      + 'address is 82-11 Northern Boulevard, rear of the setback, class 3, confirmed address';
    eq(HL.findRanges(noise, K.DEFAULT_RULES), []);
  });
});

describe('normalizePills', function () {
  it('falls back to defaults when storage is empty', function () {
    eq(NOTES.normalizePills(null, PC.DEFAULT_PILLS).length, PC.DEFAULT_PILLS.length);
    eq(NOTES.normalizePills([], PC.DEFAULT_PILLS).length, PC.DEFAULT_PILLS.length);
  });

  it('fills missing text from the matching default', function () {
    var got = NOTES.normalizePills([{ id: 'dup' }], PC.DEFAULT_PILLS)[0];
    eq(got.text, 'dup');
  });

  it('keeps unknown custom pills', function () {
    var got = NOTES.normalizePills([{ id: 'custom-1', text: 'hello' }], PC.DEFAULT_PILLS);
    eq(got.length, 1);
    eq(got[0].id, 'custom-1');
    eq(got[0].text, 'hello');
  });

  it('drops entries with no id', function () {
    var got = NOTES.normalizePills([{ text: 'no id' }, { id: 'dup' }], PC.DEFAULT_PILLS);
    eq(got.length, 1);
    eq(got[0].id, 'dup');
  });
});

describe('default pills', function () {
  it('has unique pill ids', function () {
    var ids2 = PC.DEFAULT_PILLS.map(function (p) { return p.id; });
    eq(ids2.length, new Set(ids2).size, 'duplicate pill id');
  });

  it('gives every pill non-empty text', function () {
    PC.DEFAULT_PILLS.forEach(function (p) {
      ok(p.text, p.id + ' text');
    });
  });
});

// ------------------------------------------------------- Phase 3: data feed

// A stand-in for the slimmed /get_systems index, with the shapes that actually
// matter, all taken from the live 2026-09-02 response: an exact match, its
// "(BCFY Calls)" twin sharing a base name, a system whose own name contains " - ",
// and a shorter name that is a prefix of a longer one. Local rather than shipped
// config, so tuning the real list cannot weaken these.
var FIXTURE_SYSTEMS = [
  { ltp_id: 100,    system_name: "Michigan's Public Safety Communications System (MPSCS)" },
  { ltp_id: 444100, system_name: "Michigan's Public Safety Communications System (MPSCS) (BCFY Calls)" },
  { ltp_id: 7017,   system_name: '5-City Radio System (P25) (BCFY Calls)' },
  { ltp_id: 2001,   system_name: 'Arizona Department of Public Safety - District 4' },
  { ltp_id: 2002,   system_name: 'Arizona Department of Public Safety' },
  { ltp_id: 3683,   system_name: 'Wayne County, OH' }
];

describe('matchSystem', function () {
  it('splits an exact system name off the front of the feed string', function () {
    var m = FEED.matchSystem("Michigan's Public Safety Communications System (MPSCS) - Fire East", FIXTURE_SYSTEMS);
    eq(m.ltpId, 100);
    eq(m.systemName, "Michigan's Public Safety Communications System (MPSCS)");
    eq(m.talkgroupName, 'Fire East');
  });

  it('prefers the (BCFY Calls) twin when the feed carries that suffix', function () {
    var m = FEED.matchSystem("Michigan's Public Safety Communications System (MPSCS) (BCFY Calls) - Fire East", FIXTURE_SYSTEMS);
    eq(m.ltpId, 444100);
    eq(m.talkgroupName, 'Fire East');
  });

  // The whole reason this is prefix matching and not a split on the last " - ".
  it('keeps a system name that contains its own " - "', function () {
    var m = FEED.matchSystem('Arizona Department of Public Safety - District 4 - Fire', FIXTURE_SYSTEMS);
    eq(m.ltpId, 2001);
    eq(m.systemName, 'Arizona Department of Public Safety - District 4');
    eq(m.talkgroupName, 'Fire');
  });

  it('takes the longest matching name, not the first', function () {
    var reversed = FIXTURE_SYSTEMS.slice().reverse();
    eq(FEED.matchSystem('Arizona Department of Public Safety - District 4 - Fire', reversed).ltpId, 2001);
  });

  it('matches a feed string with no talkgroup at all', function () {
    var m = FEED.matchSystem('Wayne County, OH', FIXTURE_SYSTEMS);
    eq(m.ltpId, 3683);
    eq(m.talkgroupName, '');
  });

  it('only matches at a name boundary', function () {
    eq(FEED.matchSystem('Wayne County, OHIO Fire - Dispatch', FIXTURE_SYSTEMS), null);
  });

  it('flags a name carried by more than one ltp_id', function () {
    var dupes = [
      { ltp_id: 11, system_name: 'Cheboygan County MI Fire' },
      { ltp_id: 22, system_name: 'Cheboygan County MI Fire' }
    ];
    ok(FEED.matchSystem('Cheboygan County MI Fire - Dispatch', dupes).ambiguous, 'ambiguous');
    ok(!FEED.matchSystem('Wayne County, OH', FIXTURE_SYSTEMS).ambiguous, 'not ambiguous');
  });

  it('returns null rather than guessing', function () {
    eq(FEED.matchSystem('Some System Nobody Has - Dispatch', FIXTURE_SYSTEMS), null);
    eq(FEED.matchSystem('', FIXTURE_SYSTEMS), null);
    eq(FEED.matchSystem('Wayne County, OH', []), null);
  });
});

describe('parseLeadTime', function () {
  it('parses the captured header timestamp', function () {
    var text = realLeadTimeText();
    ok(text, 'timestamp not found in the capture');
    var ms = FEED.parseLeadTime(text);
    ok(ms !== null, 'capture timestamp did not parse: ' + text);
    var d = new Date(ms);
    eq([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()],
      [2026, 7, 26, 12, 56], 'captured 2026-Aug-26 12:56');
  });

  it('handles every month abbreviation', function () {
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    months.forEach(function (name, index) {
      var ms = FEED.parseLeadTime('2026-' + name + '-15 08:30');
      ok(ms !== null, name + ' did not parse');
      eq(new Date(ms).getMonth(), index, name);
    });
  });

  it('accepts optional seconds and a T separator', function () {
    eq(new Date(FEED.parseLeadTime('2026-Sep-02 11:52:07')).getSeconds(), 7);
    eq(new Date(FEED.parseLeadTime('2026-Sep-02T11:52')).getHours(), 11);
  });

  it('returns null rather than falling back to Date.parse', function () {
    ['', 'not a date', '2026-Xyz-02 11:52', '2026-Feb-30 11:52',
      '2026-Sep-02 25:00', '09/02/2026 11:52'].forEach(function (bad) {
      eq(FEED.parseLeadTime(bad), null, JSON.stringify(bad));
    });
  });
});

describe('timeWindow and toDateTimeLocal', function () {
  var noon = new Date(2026, 8, 2, 12, 0, 0).getTime();

  it('brackets a timestamp symmetrically', function () {
    var w = FEED.timeWindow(noon, 15);
    eq(FEED.toDateTimeLocal(w.start), '2026-09-02T11:45');
    eq(FEED.toDateTimeLocal(w.end), '2026-09-02T12:15');
  });

  it('crosses midnight and the month boundary', function () {
    var w = FEED.timeWindow(new Date(2026, 8, 30, 23, 55, 0).getTime(), 15);
    eq(FEED.toDateTimeLocal(w.start), '2026-09-30T23:40');
    eq(FEED.toDateTimeLocal(w.end), '2026-10-01T00:10');
  });

  // The page refuses start >= end with an alert(), so a zero or junk window must
  // never reach it.
  it('never produces an empty window', function () {
    [0, -5, NaN, undefined].forEach(function (bad) {
      var w = FEED.timeWindow(noon, bad);
      ok(w.end > w.start, 'window for ' + String(bad));
    });
  });

  it('pads to the format the page reads back', function () {
    eq(FEED.toDateTimeLocal(new Date(2026, 0, 5, 9, 7, 0).getTime()), '2026-01-05T09:07');
  });
});

describe('default data feed settings', function () {
  // Locking to the dispatch talkgroup hides the tactical channels the follow-up
  // traffic is on. If this ever flips it should be a decision, not a drift.
  it('leaves talkgroup sync off', function () {
    eq(DFC.DEFAULT_DATA_FEED_SETTINGS.syncTalkgroup, false);
  });

  // Opt-in: narrowing to a time window can hide the very transmission she's after if
  // the lead's timestamp is off by more than timeWindowMinutes.
  it('leaves time range sync off', function () {
    eq(DFC.DEFAULT_DATA_FEED_SETTINGS.syncTimeRange, false);
  });

  it('has a usable default window', function () {
    ok(DFC.DEFAULT_DATA_FEED_SETTINGS.timeWindowMinutes >= 1, 'timeWindowMinutes');
  });

  // The host is the correction that started Phase 3: the Data Feed is not on
  // dispatch.alertpage.net, and the path has an underscore.
  it('points at the ap-portal host, not dispatch', function () {
    eq(DFC.DATA_FEED_ORIGIN, 'https://ap-portal.alertpage.net');
    eq(DFC.DATA_FEED_PATH, '/data_feed');
  });
});

describe('default settings', function () {
  // Every boolean here is consumed as `x !== false`, so a stored settings object
  // missing darkMode entirely (anyone who saved before this field existed) must read
  // as light, not dark - opting existing installs into dark mode silently would be
  // the wrong default to ship.
  it('defaults dark mode off', function () {
    eq(K.DEFAULT_SETTINGS.darkMode, false);
  });

  it('round-trips a stored darkMode value through the default merge', function () {
    var stored = { darkMode: true };
    var merged = Object.assign({}, K.DEFAULT_SETTINGS, stored);
    eq(merged.darkMode, true);
  });
});

// ---------------------------------------------------------------- collector contract

describe('collector dispatcher id', function () {
  it('trims and lowercases the userID pill', function () {
    eq(ENV.normaliseDispatcherId('  AP422 '), 'ap422');
  });
  it('treats the AP*** placeholder and empty text as missing', function () {
    eq(ENV.normaliseDispatcherId('AP***'), null);
    eq(ENV.normaliseDispatcherId('   '), null);
    eq(ENV.dispatcherIdProblem('AP***'), 'missing');
    eq(ENV.dispatcherIdProblem(undefined), 'missing');
  });
  it('rejects malformed ids by format only', function () {
    eq(ENV.normaliseDispatcherId('ap 422'), null);
    eq(ENV.dispatcherIdProblem('-ap422'), 'invalid');
    eq(ENV.dispatcherIdProblem('a'.repeat(33)), 'invalid');
    eq(ENV.dispatcherIdProblem('ap_4-2'), null);
  });
  it('finds the userID pill by id, not by text', function () {
    eq(ENV.pillDispatcherText([{ id: 'dup', text: 'dup' }, { id: 'userID', text: 'ap9' }]), 'ap9');
    eq(ENV.pillDispatcherText(null), null);
  });
});

describe('collector envelope', function () {
  var ctx = { source: 'working_screen', occurredAt: 1700000000000, tzOffsetMin: 240, tzName: 'America/New_York',
    extensionVersion: '1.2.3', pageLoadId: 'p1', seq: 0, leadId: 42, uuid: function () { return 'u1'; } };
  it('fills category and versions from the contract', function () {
    var e = ENV.buildEvent('lead_viewed', { a: 1 }, ctx);
    eq([e.event_id, e.category, e.schema_version, e.collector_version, e.lead_id, e.seq],
      ['u1', 'page_observation', 1, CC.COLLECTOR_VERSION, 42, 0]);
    ok(!('dispatcher_id' in e), 'no dispatcher_id before batch build');
  });
  it('throws on an unknown event type or source', function () {
    var threw = 0;
    try { ENV.buildEvent('ext_vote_recorded', {}, ctx); } catch (e) { threw++; }
    try { ENV.buildEvent('lead_viewed', {}, Object.assign({}, ctx, { source: 'x' })); } catch (e) { threw++; }
    eq(threw, 2);
  });
  it('stamps session, tab and dispatcher at batch build without mutating the queued record', function () {
    var e = ENV.buildEvent('audio_played', {}, ctx);
    var s = ENV.stampForBatch(e, 's1', 7, 'ap422');
    eq([s.session_id, s.tab_id, s.dispatcher_id], ['s1', 7, 'ap422']);
    ok(!('dispatcher_id' in e), 'original untouched');
  });
  it('keeps the contract caps from Spike B', function () {
    eq([CC.MAX_BATCH_EVENTS, CC.MAX_BATCH_BYTES, CC.TRIGGER_BYTES], [50, 131072, 65536]);
    ok(CC.ORIGIN_RE.test('chrome-extension://abcdefghijklmnopabcdefghijklmnop'), 'any extension id');
    ok(!CC.ORIGIN_RE.test('https://evil.example'), 'web origin refused');
  });
});

describe('collector canonical json', function () {
  it('sorts keys at every depth and drops undefined', function () {
    eq(CANON.canonical({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[2,{"y":2,"z":1}]},"b":1}');
  });
  it('is stable for integer-like keys that JSON.parse reorders', function () {
    eq(CANON.canonical(JSON.parse('{"b":1,"10":2,"2":3}')), CANON.canonical({ '2': 3, '10': 2, b: 1 }));
  });
  itAsync('hashes with SHA-256 hex', function () {
    return CANON.sha256Hex('abc').then(function (h) {
      eq(h, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });
  });
});

describe('collector redaction', function () {
  it('keeps only allow-listed form fields', function () {
    eq(Object.keys(RED.pickAllowed({ internal_notes: 'dup', csrfmiddlewaretoken: 'x', chat: 'y', lead_id: '1' })).sort(), ['internal_notes', 'lead_id']);
  });
  it('scrubs forbidden keys at every depth', function () {
    var out = RED.scrub({ a: { csrf_token: 1, ok: 2, deep: [{ Cookie: 1, v: 3 }] }, api_key: 'k', password: 'p' });
    eq(out, { a: { ok: 2, deep: [{ v: 3 }] } });
  });
  it('strips url query and fragment', function () {
    eq(RED.stripQuery('https://m.example/a/b.m4a?sig=abc#t=1'), 'https://m.example/a/b.m4a');
  });
  it('truncates by UTF-8 bytes without splitting a surrogate pair', function () {
    eq(RED.truncate('a😀b', 2), 'a');
    ok(CANON.byteLength(RED.truncate('x'.repeat(100), 10)) <= 10, 'ascii cut');
  });
  it('fits a payload under the 32 KB cap by shortening the longest string', function () {
    var out = RED.fitPayload({ snapshot: { blob_text: 'z'.repeat(60000) }, header_text: 'keep me', token: 'no' });
    ok(CANON.byteLength(JSON.stringify(out)) <= CC.MAX_PAYLOAD_BYTES, 'under cap');
    eq(out.header_text, 'keep me');
    ok(!('token' in out), 'token scrubbed');
  });
  it('classifies provenance per schema section 7', function () {
    eq(RED.provenance({}, 'a', 'a'), 'page_initial');
    eq(RED.provenance({ trusted: { at: 5 } }, 'b', 'a'), 'dispatcher');
    eq(RED.provenance({ ext: { value: 'x', at: 1 } }, 'x', 'a'), 'extension');
    eq(RED.provenance({ ext: { value: 'x', at: 1 }, trusted: { at: 2 } }, 'y', 'a'), 'extension_then_dispatcher');
    eq(RED.provenance({ ext: { value: 'x', at: 1 }, trusted: { at: 0 } }, 'x', 'a'), 'extension');
    eq(RED.provenance({}, 'b', 'a'), 'page_script');
    eq(RED.provenance({}, 'b', undefined), 'unknown');
  });
});

describe('collector chat key', function () {
  // 21:25 in UTC-4 (offset 240) is 01:25 UTC the next day.
  var obs = Date.UTC(2026, 7, 27, 1, 25, 30);
  it('parses displayed times', function () {
    eq([CHAT.parseDisplayedTime('12:05 AM'), CHAT.parseDisplayedTime('12:05 PM'), CHAT.parseDisplayedTime('9:24 PM'), CHAT.parseDisplayedTime('nope')], [5, 725, 1284, null]);
  });
  it('picks the latest minute at or before observation with that local h:mm', function () {
    eq(CHAT.minuteUtc('9:24 PM', obs, 240), Date.UTC(2026, 7, 27, 1, 24));
    eq(CHAT.minuteUtc('9:25 PM', obs, 240), Date.UTC(2026, 7, 27, 1, 25));
  });
  it('rolls back a day for a time later than now on the clock', function () {
    eq(CHAT.minuteUtc('9:26 PM', obs, 240), Date.UTC(2026, 7, 26, 1, 26));
  });
  it('handles UTC+ zones', function () {
    eq(CHAT.minuteUtc('2:25 AM', Date.UTC(2026, 0, 1, 1, 25, 10), -60), Date.UTC(2026, 0, 1, 1, 25));
  });
  itAsync('counts occurrence of identical messages and hashes the raw text', function () {
    var counter = CHAT.createCounter();
    var ctx = { observedAt: obs, tzOffsetMin: 240, uuid: function () { return 'u'; } };
    var m = { author: 'AP411', displayedTime: '9:24 PM', text: ' brb ' };
    return Promise.all([CHAT.buildItem(m, ctx, counter), CHAT.buildItem(m, ctx, counter),
      CHAT.buildItem({ author: 'AP411', displayedTime: '9:24 PM', text: 'other' }, ctx, counter)]).then(function (r) {
      eq([r[0].occurrence, r[1].occurrence, r[2].occurrence], [1, 2, 1]);
      eq(r[0].item_type, 'chat_message_observed');
      eq(r[0].room_id, 1);
      return CANON.sha256Hex(' brb ').then(function (h) { eq(r[0].text_sha256, h); });
    });
  });
});

describe('collector queue', function () {
  function mk(n, over) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var r = Q.makeRecord({ event_id: 'e' + (1000 + i), event_type: 'audio_played', payload: {} }, 1000 + i);
      out.push(Object.assign(r, over || {}));
    }
    return out;
  }
  it('picks at most 50 events, oldest first', function () {
    var b = Q.pickBatch(mk(120));
    eq(b.length, 50);
    eq(b[0].event_id, 'e1000');
  });
  it('keeps the body under 128 KB', function () {
    var big = mk(10).map(function (r) { return Object.assign(r, { bytes: 30000 }); });
    var b = Q.pickBatch(big);
    ok(b.length >= 1 && b.length <= 4, 'fits: ' + b.length);
    ok(b.reduce(function (n, r) { return n + r.bytes + 161; }, 200) <= CC.MAX_BATCH_BYTES, 'under cap');
  });
  it('always returns one record even if it alone exceeds the cap', function () {
    eq(Q.pickBatch([Object.assign(mk(1)[0], { bytes: 500000 })]).length, 1);
  });
  it('returns a retry set whole under its batch_id', function () {
    var recs = mk(5).map(function (r, i) { return Object.assign(r, { batch_id: i < 3 ? 'B' : null }); });
    eq(Q.pickBatch(recs).map(function (r) { return r.event_id; }), ['e1000', 'e1001', 'e1002']);
  });
  it('limit narrows a fresh batch (bisect)', function () { eq(Q.pickBatch(mk(10), { limit: 4 }).length, 4); });

  it('upload triggers: 50 events, 64 KB or 60 s; never while inflight or backing off', function () {
    var base = { pending: 1, pendingBytes: 100, oldestPendingAt: 0, inflight: 0, retryAt: 0, lastBatchAt: 0 };
    ok(!Q.shouldUpload(base, 10000), 'young and small waits');
    ok(Q.shouldUpload(base, 60000), '60 s');
    ok(Q.shouldUpload(Object.assign({}, base, { pending: 50 }), 10), '50 events');
    ok(Q.shouldUpload(Object.assign({}, base, { pendingBytes: 65536 }), 10), '64 KB');
    ok(!Q.shouldUpload(Object.assign({}, base, { inflight: 1 }), 99999), 'inflight');
    ok(!Q.shouldUpload(Object.assign({}, base, { retryAt: 5e6 }), 99999), 'backoff');
    ok(!Q.shouldUpload(Object.assign({}, base, { lastBatchAt: 99000 }), 100000), 'drain gap');
    ok(Q.shouldUpload(Object.assign({}, base, { retrying: true }), 5), 'retry when due');
    ok(!Q.shouldUpload(Object.assign({}, base, { pending: 0 }), 99999), 'nothing pending');
  });

  it('ack: accepted and duplicate are acked, rejected is quarantined and kept, missing goes back (AC-4, AC-15)', function () {
    var recs = mk(4, { status: 'inflight', batch_id: 'B' });
    var r = Q.applyAck(recs, { results: [
      { event_id: 'e1000', status: 'accepted' }, { event_id: 'e1001', status: 'duplicate' },
      { event_id: 'e1002', status: 'rejected', code: 'invalid_field' }] }, 5000);
    eq(r.records.length, 4, 'nothing dropped');
    eq(r.records.map(function (x) { return x.status; }), ['acked', 'acked', 'quarantined', 'pending']);
    eq(r.records[2].last_error, 'invalid_field');
    eq(r.records[0].acked_at, 5000);
    eq(r.quarantined, [{ event_id: 'e1002', code: 'invalid_field' }]);
    eq(r.acked, 2);
    ok(!Q.canPurge(r.records[2], 5000 + 1e12), 'quarantined is never purged');
  });
  it('purges acked records only after 7 days', function () {
    var a = { status: 'acked', acked_at: 1000 };
    ok(!Q.canPurge(a, 1000 + CC.ACKED_KEEP_MS - 1), 'not yet');
    ok(Q.canPurge(a, 1000 + CC.ACKED_KEEP_MS), 'after 7 d');
    ok(!Q.canPurge({ status: 'pending' }, 1e15), 'pending never');
  });
  it('a failed attempt never removes a record before ack (AC-4)', function () {
    [0, 429, 500, 503, 400, 403, 409, 413].forEach(function (status) {
      var out = Q.planFailure(mk(3, { status: 'inflight', batch_id: 'B' }), { status: status }, 1, 0.5);
      eq(out.records.length, 3, 'status ' + status);
      out.records.forEach(function (r) { ok(r.status === 'pending' || r.status === 'quarantined', 'kept'); });
    });
  });
  it('backoff follows the schedule with jitter and honours Retry-After', function () {
    eq(Q.nextBackoffMs(1, 0.5, 0), 30000);
    eq(Q.nextBackoffMs(3, 0.5, 0), 120000);
    eq(Q.nextBackoffMs(9, 0.5, 0), 900000);
    eq(Q.nextBackoffMs(1, 0, 0), 24000);
    ok(Q.nextBackoffMs(1, 0.9999, 0) <= 36000, 'upper jitter bound');
    eq(Q.nextBackoffMs(1, 0.5, 77000), 77000);
    eq(Q.nextBackoffMs(1, 0.5, 9e9), 24 * 3600 * 1000);
  });
  it('5xx and network keep the same batch_id and set, with backoff', function () {
    var recs = mk(3, { status: 'inflight', batch_id: 'B' });
    var p = Q.planFailure(recs, { status: 503, retryAfterMs: 90000 }, 1, 0.5);
    eq(p.action, 'retry');
    eq(p.delayMs, 90000);
    eq(p.records.map(function (r) { return r.batch_id; }), ['B', 'B', 'B']);
    eq(p.records[0].attempts, 1);
  });
  it('409 gets a new batch_id; 403 stops uploads but keeps the queue', function () {
    var recs = mk(2, { status: 'inflight', batch_id: 'B' });
    var n = Q.planFailure(recs, { status: 409 }, 1, 0.5);
    eq([n.action, n.records[0].batch_id], ['newid', null]);
    var s = Q.planFailure(recs, { status: 403 }, 1, 0.5);
    eq(s.action, 'stop');
    ok(s.delayMs >= 3600000, 'long pause');
    eq(s.records[0].status, 'pending');
  });
  it('400 and 413 bisect a multi-event batch', function () {
    var recs = mk(5, { status: 'inflight', batch_id: 'B' });
    var p = Q.planFailure(recs, { status: 400 }, 1, 0.5);
    eq([p.action, p.splitLimit, p.records[0].batch_id], ['split', 3, null]);
    eq(Q.bisect(recs).map(function (h) { return h.length; }), [3, 2]);
    eq(Q.planFailure(recs, { status: 413 }, 1, 0.5).action, 'split');
  });
  it('a single event: 413 quarantines at once, 400 only after POISON_ATTEMPTS', function () {
    var one = mk(1, { status: 'inflight', batch_id: 'B' });
    eq(Q.planFailure(one, { status: 413 }, 1, 0.5).records[0].status, 'quarantined');
    var r = one;
    for (var i = 1; i < CC.POISON_ATTEMPTS; i++) {
      var p = Q.planFailure(r, { status: 400 }, 1, 0.5);
      eq(p.records[0].status, 'pending');
      r = [Object.assign({}, p.records[0], { status: 'inflight' })];
    }
    var last = Q.planFailure(r, { status: 400 }, 1, 0.5);
    eq([last.records[0].status, last.records[0].last_error], ['quarantined', 'poison']);
  });
  it('repeated 5xx on a multi-event batch bisects after POISON_ATTEMPTS', function () {
    var recs = mk(4, { status: 'inflight', batch_id: 'B', attempts: CC.POISON_ATTEMPTS - 1 });
    var p = Q.planFailure(recs, { status: 500 }, 1, 0.5);
    eq([p.action, p.splitLimit], ['split', 2]);
  });
  it('restarts: inflight returns to pending keeping its batch_id', function () {
    var out = Q.recoverInflight(mk(2, { status: 'inflight', batch_id: 'B' }).concat(mk(1, { status: 'acked' })));
    eq(out.map(function (r) { return r.status; }), ['pending', 'pending', 'acked']);
    eq(out[0].batch_id, 'B');
  });
  it('cap policy: suppresses chat and extension_action at the cap, never a disposition', function () {
    var under = { count: 1, bytes: 1 }, over = { count: CC.QUEUE_CAP_EVENTS, bytes: 1 }, overBytes = { count: 1, bytes: CC.QUEUE_CAP_BYTES };
    eq(Q.capPolicy(under, { item_type: 'chat_message_observed' }), 'keep');
    eq(Q.capPolicy(over, { item_type: 'chat_message_observed' }), 'suppress');
    eq(Q.capPolicy(overBytes, { event_type: 'ext_field_written' }), 'suppress');
    eq(Q.capPolicy(over, { event_type: 'ext_chat_autosend' }), 'suppress');
    ['disposition_submitted', 'disposition_attempt', 'field_changed', 'flash_observed', 'lead_viewed', 'queue_stats', 'dispatcher_id_missing'].forEach(function (t) {
      eq(Q.capPolicy(over, { event_type: t }), 'keep');
    });
  });
});

// -------------------------------------------------------------------- report

Promise.all(pending).then(function () {
  if (failed.length) {
    console.log('\n' + failed.length + ' FAILED, ' + passed + ' passed\n');
    failed.forEach(function (f) { console.log('  x ' + f.name + '\n    ' + f.message); });
    console.log('');
    process.exit(1);
  }
  console.log('\n' + passed + ' tests passed\n');
});
