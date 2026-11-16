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
var TRANS = require(path.join(ROOT, 'extension/lib/transmissions.js'));
var SUM = require(path.join(ROOT, 'extension/lib/summarize.js'));
var SSC = require(path.join(ROOT, 'extension/config/summarize-settings.js'));
// Config before lib: lib/relevance.js reads the category list off globalThis.APA
// when it is already there, exactly as it does under importScripts in the worker.
var RC = require(path.join(ROOT, 'extension/config/relevance.js'));
var REL = require(path.join(ROOT, 'extension/lib/relevance.js'));

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

describe('extractEpochFromAudioUrl', function () {
  it('reads the epoch from an icecast filename (ltp_id_talkgroup_epoch.mp3)', function () {
    eq(TRANS.extractEpochFromAudioUrl(
      'https://media-alrtpg.s3.us-east-va.io.cloud.ovh.us/icecast/spotsylvania_va_fire/777527_999999_1789054874.mp3'
    ), 1789054874);
  });

  it('reads the epoch from an OpenMHz filename (slug-tgid-epoch.m4a)', function () {
    eq(TRANS.extractEpochFromAudioUrl(
      'https://media-alrtpg.s3.us-east-va.io.cloud.ovh.us/openmhz/pittsburgh_police_and_fire/pghpdfd-7-1789054652.m4a'
    ), 1789054652);
  });

  it('reads the epoch from the older grammar (epoch-unidentified.m4a)', function () {
    eq(TRANS.extractEpochFromAudioUrl(
      'https://media-alrtpg.s3.us-east-va.io.cloud.ovh.us/bcfy_calls/fdny_analog/1787763340-223670.m4a'
    ), 1787763340);
  });

  it('prefers the run immediately before the extension when two are plausible', function () {
    eq(TRANS.extractEpochFromAudioUrl('https://example.com/a/1789054652-1600000000.mp3'), 1600000000);
  });

  it('returns null when two plausible runs are ambiguous (neither adjacent to the extension)', function () {
    eq(TRANS.extractEpochFromAudioUrl('https://example.com/a/1789054652_1600000000_999999.mp3'), null);
  });

  it('returns null when nothing plausible is present', function () {
    eq(TRANS.extractEpochFromAudioUrl('https://example.com/a/no-numbers-here.mp3'), null);
  });

  it('returns null for an empty or missing URL', function () {
    eq(TRANS.extractEpochFromAudioUrl(''), null);
    eq(TRANS.extractEpochFromAudioUrl(null), null);
  });

  // Live-captured 2026-09-10 (Monroe/Ontario Counties lead). The token decodes to
  // {"b":"media-alrtpg","e":1789146046,"k":"1789057280890-294f75e0.m4a"} - `e` is
  // the signed URL's own expiry (also plausible-epoch-shaped) and must NOT be
  // picked; the real transmission time is `k`'s embedded millisecond epoch.
  it('decodes a signal.alertpage.net proxy URL and reads the epoch from its embedded filename, not the expiry', function () {
    eq(TRANS.extractEpochFromAudioUrl(
      'https://signal.alertpage.net/media/eyJiIjoibWVkaWEtYWxydHBnIiwiZSI6MTc4OTE0NjA0NiwiayI6IjE3ODkwNTcyODA4OTAtMjk0Zjc1ZTAubTRhIn0'
    ), 1789057281);
  });

  it('returns null for a proxy URL whose token is not valid base64/JSON', function () {
    eq(TRANS.extractEpochFromAudioUrl('https://signal.alertpage.net/media/not-valid-base64-json!!!'), null);
  });

  it('returns null for an RDIO-relay link with no per-transmission file at all', function () {
    eq(TRANS.extractEpochFromAudioUrl('https://5042.rdio.alertpagesdr.com'), null);
  });
});

describe('classifyResults', function () {
  var transmission = {
    id_transmission: 'd8d32e819bd747608a975a8b0aeab0ae',
    audio_path: 'https://media-alrtpg.s3.us-east-va.io.cloud.ovh.us/icecast/x/777527_999999_1789055531.mp3',
    transmission_time_stamp: 1789055531,
    transcription_text: 'Battalion 1701 I\'m on scene.',
    talkgroup_decimal: 999999
  };
  var alertDoc = {
    _doc_id: 'rCkFjKABcV6hFskL4c7Z',
    id_transsmission: 'd8d32e819bd747608a975a8b0aeab0ae',
    categories: ['General Fire'],
    keywords: ['primary search'],
    transmission_time_stamp: 1789055531.0
  };

  it('separates real transmissions from alert-document siblings', function () {
    var out = TRANS.classifyResults([transmission, alertDoc]);
    eq(out.transmissions.length, 1);
    eq(out.alertDocs.length, 1);
    eq(out.transmissions[0].id_transmission, transmission.id_transmission);
    eq(out.alertDocs[0].id_transsmission, transmission.id_transmission);
  });

  it('handles an empty or missing array', function () {
    eq(TRANS.classifyResults([]), { transmissions: [], alertDocs: [] });
    eq(TRANS.classifyResults(null), { transmissions: [], alertDocs: [] });
  });
});

describe('findAnchor', function () {
  function tx(id, ts, tg) {
    return { id_transmission: id, audio_path: 'x', transmission_time_stamp: ts, talkgroup_decimal: tg };
  }

  it('finds a single match within tolerance and confirms it with a matching alert doc', function () {
    var anchor = TRANS.findAnchor(
      [tx('a', 1000, 7), tx('b', 5000, 7)],
      [{ id_transsmission: 'a', transmission_time_stamp: 1000 }],
      1001, 2
    );
    eq(anchor.idTransmission, 'a');
    eq(anchor.confirmedBy, ['epoch', 'alert-doc']);
    eq(anchor.ambiguous, false);
  });

  it('finds a single match with epoch only, no alert doc', function () {
    var anchor = TRANS.findAnchor([tx('a', 1000, 7)], [], 1000, 2);
    eq(anchor.confirmedBy, ['epoch']);
  });

  it('returns null when nothing is within tolerance', function () {
    eq(TRANS.findAnchor([tx('a', 1000, 7)], [], 5000, 2), null);
  });

  it('tie-breaks on a matching alert doc when more than one transmission is in range', function () {
    var anchor = TRANS.findAnchor(
      [tx('a', 1000, 7), tx('b', 1001, 9)],
      [{ id_transsmission: 'b', transmission_time_stamp: 1001 }],
      1000, 2
    );
    eq(anchor.idTransmission, 'b');
  });

  it('reports ambiguous when it cannot break the tie', function () {
    var anchor = TRANS.findAnchor([tx('a', 1000, 7), tx('b', 1001, 9)], [], 1000, 2);
    ok(anchor.ambiguous, 'ambiguous');
  });
});

describe('buildTranscriptWindow', function () {
  function tx(id, ts) { return { id_transmission: id, transmission_time_stamp: ts }; }

  it('keeps up to beforeCount transmissions before the anchor, through the latest', function () {
    var list = [tx('a', 100), tx('b', 200), tx('c', 300), tx('anchor', 400), tx('d', 500)];
    var out = TRANS.buildTranscriptWindow(list, { idTransmission: 'anchor' }, 2);
    eq(out.window.map(function (t) { return t.id_transmission; }), ['b', 'c', 'anchor', 'd']);
    eq(out.truncatedBefore, false);
  });

  it('flags truncatedBefore when fewer than beforeCount transmissions came before it', function () {
    var list = [tx('a', 100), tx('anchor', 200), tx('d', 300)];
    var out = TRANS.buildTranscriptWindow(list, { idTransmission: 'anchor' }, 10);
    eq(out.truncatedBefore, true);
  });

  it('dedupes by id_transmission and sorts ascending regardless of input order', function () {
    var list = [tx('anchor', 300), tx('a', 100), tx('a', 100), tx('b', 200)];
    var out = TRANS.buildTranscriptWindow(list, { idTransmission: 'anchor' }, 10);
    eq(out.window.map(function (t) { return t.id_transmission; }), ['a', 'b', 'anchor']);
  });

  it('returns an empty window if the anchor is not actually in the list', function () {
    var out = TRANS.buildTranscriptWindow([tx('a', 100)], { idTransmission: 'missing' }, 10);
    eq(out.window, []);
  });
});

describe('selectSummarizationWindow', function () {
  function tx(id, ts) {
    return { id_transmission: id, audio_path: 'x', transmission_time_stamp: ts, transcription_text: 't' };
  }

  it('returns no-transmissions when the fetch came back empty', function () {
    eq(TRANS.selectSummarizationWindow([], 1000), { ok: false, reason: 'no-transmissions' });
  });

  it('returns anchor-not-found when nothing matches the trigger epoch', function () {
    eq(TRANS.selectSummarizationWindow([tx('a', 5000)], 1000), { ok: false, reason: 'anchor-not-found' });
  });

  it('returns anchor-ambiguous when the tie cannot be broken', function () {
    var result = TRANS.selectSummarizationWindow([tx('a', 1000), tx('b', 1001)], 1000);
    eq(result, { ok: false, reason: 'anchor-ambiguous' });
  });

  it('returns the window on success', function () {
    var result = TRANS.selectSummarizationWindow([tx('a', 900), tx('b', 1000)], 1000, { beforeCount: 10 });
    eq(result.ok, true);
    eq(result.anchor.idTransmission, 'b');
    eq(result.window.map(function (t) { return t.id_transmission; }), ['a', 'b']);
  });
});

describe('buildPrompt / buildRequestBody', function () {
  var window_ = [
    { id_transmission: 'a', transcription_text: 'Engine 1 on scene.' },
    { id_transmission: 'b', transcription_text: 'No Transcript' },
    { id_transmission: 'c', transcription_text: 'Working fire, second floor.' }
  ];

  it('lists each transmission tagged with its id and flags the anchor', function () {
    var prompt = SUM.buildPrompt(window_, 'c');
    ok(prompt.indexOf('[id=a] Engine 1 on scene.') !== -1, 'transmission a present');
    ok(prompt.indexOf('[id=c] Working fire, second floor.  (this is the transmission that triggered the alert)') !== -1, 'anchor tagged');
  });

  it('drops "No Transcript" sentinel entries', function () {
    var prompt = SUM.buildPrompt(window_, 'c');
    eq(prompt.indexOf('[id=b]'), -1);
  });

  it('states the extractive-only rule', function () {
    var prompt = SUM.buildPrompt(window_, 'c');
    ok(prompt.indexOf('VERBATIM') !== -1, 'extractive instruction present');
  });

  it('builds a request body carrying the response schema', function () {
    var body = SUM.buildRequestBody(window_, 'c');
    eq(body.generationConfig.responseMimeType, 'application/json');
    eq(body.generationConfig.responseSchema, SUM.RESPONSE_SCHEMA);
    ok(body.contents[0].parts[0].text.indexOf('[id=a]') !== -1, 'prompt embedded in request body');
  });
});

describe('parseGeminiResponse', function () {
  function fieldObj(value) { return { value: value, evidence: [] }; }

  function validStructured() {
    var out = {};
    SUM.FIELDS.forEach(function (key) { out[key] = fieldObj(null); });
    return out;
  }

  function apiResponse(structured) {
    return { candidates: [{ content: { parts: [{ text: JSON.stringify(structured) }] } }] };
  }

  it('parses a well-shaped response', function () {
    var result = SUM.parseGeminiResponse(apiResponse(validStructured()));
    eq(result.ok, true);
  });

  it('rejects a response missing a required field', function () {
    var structured = validStructured();
    delete structured.address;
    var result = SUM.parseGeminiResponse(apiResponse(structured));
    eq(result, { ok: false, reason: 'bad-response-shape' });
  });

  it('rejects non-JSON text', function () {
    var result = SUM.parseGeminiResponse({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] });
    eq(result, { ok: false, reason: 'bad-response-shape' });
  });

  it('rejects a malformed API response envelope', function () {
    eq(SUM.parseGeminiResponse({}), { ok: false, reason: 'bad-response-shape' });
  });
});

describe('verifyExtractive', function () {
  var byId = {
    a: { id_transmission: 'a', transcription_text: 'Two story commercial building, fire in the kitchen.', transmission_time_stamp: 100 },
    b: { id_transmission: 'b', transcription_text: 'Fire is out, smoke condition.', transmission_time_stamp: 200, talkgroup_decimal: 4321, talkgroup_county: 'Berkeley' }
  };

  function fieldObj(value, evidence) { return { value: value, evidence: evidence || [] }; }

  it('links a field whose quote genuinely appears in the cited transmission', function () {
    var structured = { buildingType: fieldObj('Commercial', [{ idTransmission: 'a', quote: 'commercial building' }]) };
    var out = SUM.verifyExtractive(structured, byId);
    eq(out.buildingType.value, 'Commercial');
    eq(out.buildingType.link.idTransmission, 'a');
  });

  it('is case- and whitespace-insensitive when matching the quote', function () {
    var structured = { buildingType: fieldObj('Commercial', [{ idTransmission: 'a', quote: '  COMMERCIAL   building  ' }]) };
    var out = SUM.verifyExtractive(structured, byId);
    ok(out.buildingType.link, 'still linked');
  });

  it('drops a field whose quote does not actually appear in the cited transmission', function () {
    var structured = { buildingType: fieldObj('Residential', [{ idTransmission: 'a', quote: 'residential home' }]) };
    var out = SUM.verifyExtractive(structured, byId);
    eq(out.buildingType.value, null);
    eq(out.buildingType.link, null);
  });

  it('drops a field that cites a transmission not in the fetched window', function () {
    var structured = { buildingType: fieldObj('Commercial', [{ idTransmission: 'not-in-window', quote: 'commercial building' }]) };
    var out = SUM.verifyExtractive(structured, byId);
    eq(out.buildingType.link, null);
  });

  it('leaves a genuinely null field alone', function () {
    var structured = { address: fieldObj(null, []) };
    var out = SUM.verifyExtractive(structured, byId);
    eq(out.address, { value: null, link: null });
  });

  it('carries the cited transmission\'s talkgroup_decimal and talkgroup_county onto the link, so jump-to-source can select the right filters', function () {
    var structured = { incidentStatus: fieldObj('OUT', [{ idTransmission: 'b', quote: 'fire is out' }]) };
    var out = SUM.verifyExtractive(structured, byId);
    eq(out.incidentStatus.link.talkgroupDecimal, 4321);
    eq(out.incidentStatus.link.talkgroupCounty, 'Berkeley');
  });

  it('sets talkgroupDecimal/talkgroupCounty to null, not undefined, when the cited transmission has neither', function () {
    var structured = { buildingType: fieldObj('Commercial', [{ idTransmission: 'a', quote: 'commercial building' }]) };
    var out = SUM.verifyExtractive(structured, byId);
    eq(out.buildingType.link.talkgroupDecimal, null);
    eq(out.buildingType.link.talkgroupCounty, null);
  });
});

describe('assembleSummaryLine', function () {
  function linked(value, id) { return { value: value, link: value == null ? null : { idTransmission: id, transmissionTimeStamp: 1 } }; }

  it('matches the required output shape end to end', function () {
    var verified = {
      buildingStories: linked('Two story', 'a'),
      buildingType: linked('Commercial', 'a'),
      incidentLocation: linked('fire in the kitchen', 'b'),
      incidentStatus: linked('OUT', 'c'),
      conditions: linked('smoke condition', 'c'),
      address: linked(null, null)
    };
    var chips = SUM.assembleSummaryLine(verified);
    var text = chips.map(function (c) { return c.text; }).join('');
    eq(text, 'TWO STORY COMMERCIAL BUILDING - FIRE IN THE KITCHEN - FIRE IS OUT - SMOKE CONDITION');
  });

  it('omits an absent field and its separator, never a dangling one', function () {
    var verified = {
      buildingStories: linked(null, null),
      buildingType: linked(null, null),
      incidentLocation: linked(null, null),
      incidentStatus: linked('OUT', 'c'),
      conditions: linked(null, null),
      address: linked(null, null)
    };
    var text = SUM.assembleSummaryLine(verified).map(function (c) { return c.text; }).join('');
    eq(text, 'FIRE IS OUT');
  });

  it('returns nothing when every field is unconfirmed', function () {
    var verified = {};
    SUM.FIELDS.forEach(function (key) { verified[key] = linked(null, null); });
    eq(SUM.assembleSummaryLine(verified), []);
  });

  it('appends a trailing address chip when present', function () {
    var verified = {
      buildingStories: linked(null, null),
      buildingType: linked(null, null),
      incidentLocation: linked(null, null),
      incidentStatus: linked(null, null),
      conditions: linked(null, null),
      address: linked('123 Main St', 'a')
    };
    var chips = SUM.assembleSummaryLine(verified);
    eq(chips.map(function (c) { return c.text; }).join(''), '123 Main St');
    eq(chips[0].link.idTransmission, 'a');
  });
});

describe('summarize-settings config', function () {
  it('defaults the API key to empty and Summarize to enabled', function () {
    eq(SSC.DEFAULT_LLM_SETTINGS, { apiKey: '', enabled: true });
  });

  it('carries a non-empty lookback backoff ceiling', function () {
    ok(SSC.LOOKBACK_BACKOFF_STEPS_SEC.length >= 2, 'has backoff steps');
  });

  it('caps the after-trigger window well under a single fetch page', function () {
    ok(SSC.AFTER_TRIGGER_WINDOW_SEC > 0, 'has an after-trigger window');
    ok(SSC.AFTER_TRIGGER_WINDOW_SEC < 3600, 'stays well under an hour');
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

describe('relevance config', function () {
  it('defines exactly the five incident types her team works', function () {
    eq(RC.CATEGORY_IDS, [
      'STRUCTURE_FIRE', 'VEHICLE_INTO_BUILDING', 'WATER_LEAK',
      'BASEMENT_FLOODING', 'APPLIANCE_FIRE'
    ]);
  });

  it('gives every category a label and a prompt description', function () {
    RC.CATEGORIES.forEach(function (c) {
      ok(c.label, c.id + ' has a label');
      ok(c.description && c.description.length > 20, c.id + ' has a description');
    });
  });

  it('carries a not-ours contrast set for the prompt', function () {
    ok(RC.NOT_OURS_EXAMPLES.length >= 4, 'has contrast examples');
  });

  // Bumped whenever the prompt or categories change, so a verdict cached under the
  // old wording is re-asked instead of sitting on screen for the rest of the TTL.
  it('carries a cache version that moves with the prompt', function () {
    ok(RC.VERDICT_CACHE_VERSION >= 1, 'has a cache version');
  });
});

describe('buildPrompt / buildRequestBody (relevance)', function () {
  var lead = {
    feed: 'FDNY Analog (BCFY Calls) - Queens Dispatch',
    category: 'General Fire',
    keywords: 'fire in',
    county: 'Queens',
    state: 'New York',
    transcript: 'All hands for fire in the rear of the first floor of a three story building.'
  };

  it('names every category her team works', function () {
    var prompt = REL.buildPrompt(lead);
    RC.CATEGORY_IDS.forEach(function (id) {
      ok(prompt.indexOf(id) !== -1, id + ' present in prompt');
    });
  });

  it('tells the model to judge the incident rather than match words', function () {
    var prompt = REL.buildPrompt(lead);
    ok(prompt.indexOf('Do not match on individual words') !== -1, 'anti-keyword instruction present');
  });

  // The rule that protects against the one expensive mistake this feature can make.
  it('tells the model to answer UNCLEAR rather than guess NOT_RELEVANT', function () {
    var prompt = REL.buildPrompt(lead);
    ok(prompt.indexOf('answer UNCLEAR') !== -1, 'UNCLEAR instruction present');
    ok(prompt.indexOf('Never answer NOT_RELEVANT just because you are unsure') !== -1,
      'unsure-is-not-red instruction present');
  });

  it('demotes AlertPage own tagging to context rather than evidence', function () {
    var prompt = REL.buildPrompt(lead);
    ok(prompt.indexOf('the transcript decides') !== -1, 'tagging demoted to context');
  });

  /*
   * The regression this rule exists for: a real lead reading "172 water flow
   * activation" - a sprinkler alarm signal - came back green as a WATER_LEAK. An
   * alarm reporting a condition is not the condition, and the same confusion would
   * turn any fire alarm activation into a structure fire.
   */
  it('tells the model an alarm is not the incident it reports', function () {
    var prompt = REL.buildPrompt(lead);
    ok(prompt.indexOf('An alarm is not the thing it is reporting') !== -1,
      'alarm-is-not-the-incident rule present');
    ok(prompt.indexOf('waterflow or sprinkler alarm activation is an alarm, NOT a water leak') !== -1,
      'waterflow case spelled out');
  });

  it('carves alarm signals out of the category definitions themselves', function () {
    var prompt = REL.buildPrompt(lead);
    ok(/WATER_LEAK:.*alarm, not this/.test(prompt), 'WATER_LEAK excludes alarm signals');
    ok(/STRUCTURE_FIRE:.*alarm, not this/.test(prompt), 'STRUCTURE_FIRE excludes alarm signals');
  });

  it('embeds the transcript', function () {
    ok(REL.buildPrompt(lead).indexOf(lead.transcript) !== -1, 'transcript present');
  });

  it('omits absent optional context instead of printing empty labels', function () {
    var prompt = REL.buildPrompt({ transcript: 'Smoke showing.' });
    eq(prompt.indexOf('Source:'), -1);
    eq(prompt.indexOf('Location:'), -1);
  });

  it('builds a request body carrying the response schema', function () {
    var body = REL.buildRequestBody(lead);
    eq(body.generationConfig.temperature, 0);
    eq(body.generationConfig.responseMimeType, 'application/json');
    eq(body.generationConfig.responseSchema, REL.RESPONSE_SCHEMA);
    ok(body.contents[0].parts[0].text.indexOf(lead.transcript) !== -1, 'prompt embedded');
  });
});

describe('parseRelevanceResponse', function () {
  function apiResponse(structured) {
    return { candidates: [{ content: { parts: [{ text: JSON.stringify(structured) }] } }] };
  }

  it('accepts a well-formed verdict', function () {
    var out = REL.parseRelevanceResponse(apiResponse({
      status: 'RELEVANT', category: 'STRUCTURE_FIRE', quote: 'fire in the rear', reason: 'Building fire.'
    }));
    eq(out.ok, true);
    eq(out.structured.category, 'STRUCTURE_FIRE');
  });

  it('rejects an unknown status', function () {
    var out = REL.parseRelevanceResponse(apiResponse({ status: 'MAYBE', category: null, quote: null, reason: 'x' }));
    eq(out, { ok: false, reason: 'bad-response-shape' });
  });

  it('rejects a malformed envelope', function () {
    eq(REL.parseRelevanceResponse({}), { ok: false, reason: 'bad-response-shape' });
  });

  it('rejects text that is not JSON', function () {
    var out = REL.parseRelevanceResponse({ candidates: [{ content: { parts: [{ text: 'sorry, I cannot' }] } }] });
    eq(out, { ok: false, reason: 'bad-response-shape' });
  });
});

/*
 * The adversarial block. Every case here is one where the model has said something
 * the UI must not take at face value, and the required outcome is grey - never red.
 * A fabricated quote is not evidence that a lead is safe to skip.
 */
describe('verifyVerdict', function () {
  var transcript = 'All hands for fire in the rear of the first floor of a three story building.';

  it('passes a relevant verdict whose quote is verbatim', function () {
    var v = REL.verifyVerdict({
      status: 'RELEVANT', category: 'STRUCTURE_FIRE',
      quote: 'fire in the rear of the first floor', reason: 'Fire inside a building.'
    }, transcript);
    eq(v.status, 'RELEVANT');
    eq(v.categoryId, 'STRUCTURE_FIRE');
    eq(v.categoryLabel, 'Structure fire');
    eq(v.quote, 'fire in the rear of the first floor');
  });

  it('accepts a quote that differs only in case and whitespace', function () {
    var v = REL.verifyVerdict({
      status: 'RELEVANT', category: 'STRUCTURE_FIRE',
      quote: '  FIRE IN THE   REAR ', reason: 'Building fire.'
    }, transcript);
    eq(v.status, 'RELEVANT');
  });

  it('demotes an invented quote to UNCLEAR, not NOT_RELEVANT', function () {
    var v = REL.verifyVerdict({
      status: 'RELEVANT', category: 'STRUCTURE_FIRE',
      quote: 'heavy fire showing from the second floor', reason: 'Building fire.'
    }, transcript);
    eq(v.status, 'UNCLEAR');
    eq(v.categoryId, null);
    eq(v.quote, null);
  });

  it('demotes a relevant verdict with no quote at all', function () {
    var v = REL.verifyVerdict({
      status: 'RELEVANT', category: 'STRUCTURE_FIRE', quote: null, reason: 'Building fire.'
    }, transcript);
    eq(v.status, 'UNCLEAR');
  });

  it('demotes a relevant verdict with no category', function () {
    var v = REL.verifyVerdict({
      status: 'RELEVANT', category: null, quote: 'fire in the rear', reason: 'Building fire.'
    }, transcript);
    eq(v.status, 'UNCLEAR');
  });

  it('demotes a category outside her five', function () {
    var v = REL.verifyVerdict({
      status: 'RELEVANT', category: 'BRUSH_FIRE', quote: 'fire in the rear', reason: 'Brush.'
    }, transcript);
    eq(v.status, 'UNCLEAR');
  });

  it('passes NOT_RELEVANT through as red, with its reason', function () {
    var v = REL.verifyVerdict({
      status: 'NOT_RELEVANT', category: null, quote: null, reason: 'Medical call, no structure involved.'
    }, transcript);
    eq(v.status, 'NOT_RELEVANT');
    eq(v.reason, 'Medical call, no structure involved.');
    eq(v.categoryId, null);
  });

  it('keeps UNCLEAR as UNCLEAR', function () {
    var v = REL.verifyVerdict({
      status: 'UNCLEAR', category: null, quote: null, reason: 'Transcript is too garbled to tell.'
    }, transcript);
    eq(v.status, 'UNCLEAR');
    eq(v.reason, 'Transcript is too garbled to tell.');
  });

  it('survives a missing or empty structured object', function () {
    eq(REL.verifyVerdict(null, transcript).status, 'UNCLEAR');
    eq(REL.verifyVerdict({}, transcript).status, 'UNCLEAR');
  });
});

/*
 * Her corrections are the only thing that makes this feature better at her actual
 * job, so the selection rules get the same scrutiny as verifyVerdict.
 */
describe('selectFeedbackExamples', function () {
  function entry(id, label, at, category) {
    return { leadId: id, transcript: 'transcript ' + id, label: label, category: category || null, at: at };
  }

  it('returns nothing when she has not corrected anything', function () {
    eq(REL.selectFeedbackExamples([], 10), []);
    eq(REL.selectFeedbackExamples(null, 10), []);
  });

  it('orders oldest first so the newest ruling is read last', function () {
    var out = REL.selectFeedbackExamples([
      entry('c', 'OURS', 300), entry('a', 'OURS', 100), entry('b', 'OURS', 200)
    ], 10);
    eq(out.map(function (e) { return e.leadId; }), ['a', 'b', 'c']);
  });

  it('keeps the newest when more corrections exist than fit', function () {
    var out = REL.selectFeedbackExamples([
      entry('old', 'OURS', 1), entry('mid', 'OURS', 2), entry('new', 'OURS', 3)
    ], 2);
    eq(out.map(function (e) { return e.leadId; }), ['mid', 'new']);
  });

  // The failure this balancing exists to prevent: a run of NOT_OURS corrections
  // filling the whole example budget would teach the model to answer NOT_OURS by
  // default, which is the expensive direction to be wrong in.
  it('draws from both labels rather than letting one crowd the other out', function () {
    var out = REL.selectFeedbackExamples([
      entry('n1', 'NOT_OURS', 10), entry('n2', 'NOT_OURS', 9),
      entry('n3', 'NOT_OURS', 8), entry('n4', 'NOT_OURS', 7),
      entry('y1', 'OURS', 1)
    ], 3);
    var labels = out.map(function (e) { return e.label; });
    ok(labels.indexOf('OURS') !== -1, 'the lone OURS example survived the cut');
    eq(out.length, 3);
  });

  it('ignores entries with no transcript or an unknown label', function () {
    var out = REL.selectFeedbackExamples([
      { leadId: 'x', label: 'OURS', at: 1 },
      entry('y', 'MAYBE', 2),
      entry('z', 'OURS', 3)
    ], 10);
    eq(out.map(function (e) { return e.leadId; }), ['z']);
  });

  it('respects a zero budget', function () {
    eq(REL.selectFeedbackExamples([entry('a', 'OURS', 1)], 0), []);
  });
});

describe('buildPrompt with her corrections', function () {
  var lead = { transcript: 'Smoke in the basement of a two story.' };
  var feedback = [
    { leadId: '1', transcript: '172 water flow activation, alarm company reporting.', label: 'NOT_OURS', category: null, at: 1 },
    { leadId: '2', transcript: 'Heavy fire showing from the second floor.', label: 'OURS', category: 'STRUCTURE_FIRE', at: 2 }
  ];

  it('adds no rulings section when she has corrected nothing', function () {
    eq(REL.buildPrompt(lead).indexOf('HER OWN PAST RULINGS'), -1);
  });

  it('renders each correction with the label she gave it', function () {
    var prompt = REL.buildPrompt(lead, feedback);
    ok(prompt.indexOf('[NOT OURS] 172 water flow activation') !== -1, 'not-ours example present');
    ok(prompt.indexOf('[OURS (STRUCTURE_FIRE)] Heavy fire showing') !== -1, 'ours example carries its category');
  });

  it('tells the model her labels outrank the written guidance', function () {
    ok(REL.buildPrompt(lead, feedback).indexOf('she is right') !== -1, 'ground-truth framing present');
  });

  it('still puts the lead itself last, after the rulings', function () {
    var prompt = REL.buildPrompt(lead, feedback);
    ok(prompt.indexOf('HER OWN PAST RULINGS') < prompt.indexOf('--- LEAD ---'), 'rulings precede the lead');
    ok(prompt.indexOf(lead.transcript) > prompt.indexOf('--- LEAD ---'), 'lead transcript comes last');
  });

  it('truncates a long correction rather than blowing out the prompt', function () {
    var long = new Array(900).join('x');
    var prompt = REL.buildPrompt(lead, [{ leadId: '1', transcript: long, label: 'OURS', category: null, at: 1 }]);
    ok(prompt.indexOf(long) === -1, 'full long transcript not embedded');
    ok(prompt.indexOf('…') !== -1, 'truncation marker present');
  });

  it('carries the corrections through into the request body', function () {
    var body = REL.buildRequestBody(lead, feedback);
    ok(body.contents[0].parts[0].text.indexOf('HER OWN PAST RULINGS') !== -1, 'rulings reach the request');
  });
});

describe('cosineSimilarity', function () {
  it('is 1 for identical vectors', function () {
    eq(Math.round(REL.cosineSimilarity([1, 2, 3], [1, 2, 3]) * 1000) / 1000, 1);
  });

  it('is scale invariant, so rounding stored vectors cannot skew it', function () {
    eq(Math.round(REL.cosineSimilarity([1, 2, 3], [2, 4, 6]) * 1000) / 1000, 1);
  });

  it('is 0 for orthogonal vectors', function () {
    eq(REL.cosineSimilarity([1, 0], [0, 1]), 0);
  });

  it('returns 0 rather than throwing on mismatched or empty input', function () {
    eq(REL.cosineSimilarity([1, 2], [1, 2, 3]), 0);
    eq(REL.cosineSimilarity([], []), 0);
    eq(REL.cosineSimilarity(null, [1]), 0);
    eq(REL.cosineSimilarity([0, 0], [1, 1]), 0);
  });
});

describe('packVector', function () {
  it('rounds to the configured precision', function () {
    eq(REL.packVector([0.123456789, -0.987654321]), [0.1235, -0.9877]);
  });

  it('rejects empty or non-finite input rather than storing garbage', function () {
    eq(REL.packVector([]), null);
    eq(REL.packVector(null), null);
    eq(REL.packVector([1, NaN]), null);
    eq(REL.packVector([1, Infinity]), null);
  });
});

describe('parseEmbedResponse', function () {
  it('reads the embedContent singular shape', function () {
    eq(REL.parseEmbedResponse({ embedding: { values: [0.5, 0.5] } }), { ok: true, vector: [0.5, 0.5] });
  });

  it('reads the batchEmbedContents plural shape', function () {
    eq(REL.parseEmbedResponse({ embeddings: [{ values: [0.25] }] }), { ok: true, vector: [0.25] });
  });

  it('reports a bad shape instead of throwing', function () {
    eq(REL.parseEmbedResponse({}), { ok: false, reason: 'bad-embed-shape' });
    eq(REL.parseEmbedResponse(null), { ok: false, reason: 'bad-embed-shape' });
    eq(REL.parseEmbedResponse({ embedding: { values: [] } }), { ok: false, reason: 'bad-embed-shape' });
  });
});

describe('buildEmbedRequestBody', function () {
  it('states the task as a prefix, since the model takes no task_type', function () {
    var body = REL.buildEmbedRequestBody('  fire in the rear  ');
    eq(body.content.parts[0].text, RC.EMBED_TASK_PREFIX + 'fire in the rear');
    eq(body.taskType, undefined);
    eq(body.outputDimensionality, RC.EMBED_DIMENSIONS);
  });
});

/*
 * Vectors from different models occupy different spaces, and cosine similarity
 * between them is meaningless rather than merely imprecise - with nothing to signal
 * it. These are the tests that keep stale vectors out of every comparison.
 */
describe('usableVector', function () {
  it('accepts a vector stamped with the current embedding version', function () {
    eq(REL.usableVector({ vector: [1, 2], ev: RC.EMBED_VERSION }), [1, 2]);
  });

  it('rejects a vector from a different model or dimensionality', function () {
    eq(REL.usableVector({ vector: [1, 2], ev: 'gemini-embedding-001:768' }), null);
    eq(REL.usableVector({ vector: [1, 2], ev: RC.EMBED_MODEL + ':256' }), null);
  });

  it('rejects an unstamped or absent vector', function () {
    eq(REL.usableVector({ vector: [1, 2] }), null);
    eq(REL.usableVector({ ev: RC.EMBED_VERSION }), null);
    eq(REL.usableVector(null), null);
  });

  it('derives the version from the model and dimensionality together', function () {
    eq(RC.EMBED_VERSION, RC.EMBED_MODEL + ':' + RC.EMBED_DIMENSIONS);
  });
});

describe('nearestNeighbors', function () {
  function labelled(id, label, vector) {
    return { leadId: id, transcript: 't' + id, label: label, vector: vector, ev: RC.EMBED_VERSION };
  }
  var corpus = [
    labelled('far', 'OURS', [0, 1]),
    labelled('near', 'NOT_OURS', [1, 0.05]),
    labelled('mid', 'OURS', [1, 1])
  ];

  it('ranks by similarity, closest first', function () {
    var out = REL.nearestNeighbors([1, 0], corpus, 3);
    eq(out.map(function (n) { return n.item.leadId; }), ['near', 'mid', 'far']);
  });

  it('honours k', function () {
    eq(REL.nearestNeighbors([1, 0], corpus, 1).length, 1);
  });

  it('skips corrections recorded before vectors existed', function () {
    var mixed = corpus.concat([{ leadId: 'old', transcript: 'x', label: 'OURS' }]);
    var ids = REL.nearestNeighbors([1, 0], mixed, 10).map(function (n) { return n.item.leadId; });
    eq(ids.indexOf('old'), -1);
  });

  it('skips vectors from a superseded embedding model', function () {
    var mixed = corpus.concat([
      { leadId: 'stale', transcript: 'x', label: 'OURS', vector: [1, 0], ev: 'gemini-embedding-001:768' }
    ]);
    var ids = REL.nearestNeighbors([1, 0], mixed, 10).map(function (n) { return n.item.leadId; });
    eq(ids.indexOf('stale'), -1);
  });

  it('returns nothing without a query vector', function () {
    eq(REL.nearestNeighbors(null, corpus, 3), []);
    eq(REL.nearestNeighbors([], corpus, 3), []);
  });
});

describe('knnVote', function () {
  function neighbor(label, similarity) {
    return { item: { label: label }, similarity: similarity };
  }

  it('is not confident when nothing clears the similarity floor', function () {
    var vote = REL.knnVote([neighbor('OURS', 0.1), neighbor('OURS', 0.2)]);
    eq(vote.confident, false);
    eq(vote.count, 0);
  });

  it('is not confident on too few neighbours, however similar', function () {
    var vote = REL.knnVote([neighbor('NOT_OURS', 0.99), neighbor('NOT_OURS', 0.98)]);
    eq(vote.count, 2);
    eq(vote.confident, false);
  });

  it('is confident when enough close neighbours agree', function () {
    var vote = REL.knnVote([
      neighbor('NOT_OURS', 0.95), neighbor('NOT_OURS', 0.9), neighbor('NOT_OURS', 0.85)
    ]);
    eq(vote.label, 'NOT_OURS');
    eq(vote.confident, true);
    eq(Math.round(vote.agreement * 100), 100);
  });

  it('is not confident when close neighbours are split', function () {
    var vote = REL.knnVote([
      neighbor('NOT_OURS', 0.9), neighbor('OURS', 0.88), neighbor('NOT_OURS', 0.85)
    ]);
    eq(vote.confident, false);
  });

  it('weights a near-duplicate above a merely adjacent neighbour', function () {
    var vote = REL.knnVote([
      neighbor('OURS', 0.99), neighbor('OURS', 0.98), neighbor('OURS', 0.97), neighbor('NOT_OURS', 0.73)
    ]);
    eq(vote.label, 'OURS');
    eq(vote.confident, true);
  });
});

/*
 * The cross-check is deliberately one-directional. These tests exist to stop a later
 * "improvement" from letting neighbours manufacture a red, which is the one mistake
 * that could cost her a real incident.
 */
describe('applyNeighborCheck', function () {
  var green = { status: 'RELEVANT', categoryId: 'WATER_LEAK', categoryLabel: 'Water leak', reason: 'r', quote: 'q' };
  var red = { status: 'NOT_RELEVANT', categoryId: null, categoryLabel: '', reason: 'r', quote: null };
  var grey = { status: 'UNCLEAR', categoryId: null, categoryLabel: '', reason: 'r', quote: null };
  var sureNotOurs = { label: 'NOT_OURS', agreement: 1, count: 4, confident: true, topSimilarity: 0.9 };
  var sureOurs = { label: 'OURS', agreement: 1, count: 4, confident: true, topSimilarity: 0.9 };
  var unsure = { label: 'NOT_OURS', agreement: 0.6, count: 1, confident: false, topSimilarity: 0.8 };

  it('pulls a green down to grey when her own rulings contradict it', function () {
    var out = REL.applyNeighborCheck(green, sureNotOurs);
    eq(out.status, 'UNCLEAR');
    eq(out.categoryId, null);
    ok(out.reason.indexOf('4 similar leads') !== -1, 'reason names the neighbour count');
  });

  it('never turns anything into a red', function () {
    eq(REL.applyNeighborCheck(grey, sureNotOurs).status, 'UNCLEAR');
    eq(REL.applyNeighborCheck(green, sureOurs).status, 'RELEVANT');
  });

  it('never promotes a grey to a green, however confident the neighbours', function () {
    eq(REL.applyNeighborCheck(grey, sureOurs).status, 'UNCLEAR');
  });

  it('leaves a red alone', function () {
    eq(REL.applyNeighborCheck(red, sureNotOurs).status, 'NOT_RELEVANT');
    eq(REL.applyNeighborCheck(red, sureOurs).status, 'NOT_RELEVANT');
  });

  it('does nothing on an unconfident or absent vote', function () {
    eq(REL.applyNeighborCheck(green, unsure).status, 'RELEVANT');
    eq(REL.applyNeighborCheck(green, null).status, 'RELEVANT');
  });
});

describe('selectFeedbackExamples ranked by similarity', function () {
  function labelled(id, label, vector, at) {
    return { leadId: id, transcript: 'transcript ' + id, label: label, vector: vector, ev: RC.EMBED_VERSION, at: at };
  }

  // The plateau this whole embedding layer exists to break: recency stops being a
  // good proxy for relevance once she is past a couple of dozen labels.
  it('prefers the most similar correction over the most recent one', function () {
    var corpus = [
      labelled('similar', 'NOT_OURS', [1, 0], 1),
      labelled('recent', 'NOT_OURS', [0, 1], 999)
    ];
    var out = REL.selectFeedbackExamples(corpus, 1, [1, 0.02]);
    eq(out.map(function (e) { return e.leadId; }), ['similar']);
  });

  it('puts the closest match last, nearest the lead itself', function () {
    var corpus = [
      labelled('closest', 'OURS', [1, 0], 1),
      labelled('further', 'OURS', [1, 1], 2)
    ];
    var out = REL.selectFeedbackExamples(corpus, 2, [1, 0]);
    eq(out[out.length - 1].leadId, 'closest');
  });

  it('falls back to recency when every stored vector is from an older model', function () {
    var stale = [
      { leadId: 'old', transcript: 'a', label: 'OURS', vector: [1, 0], ev: 'old:768', at: 1 },
      { leadId: 'new', transcript: 'b', label: 'OURS', vector: [0, 1], ev: 'old:768', at: 2 }
    ];
    eq(REL.selectFeedbackExamples(stale, 1, [1, 0]).map(function (e) { return e.leadId; }), ['new']);
  });

  it('falls back to recency when no correction has a vector yet', function () {
    var corpus = [
      { leadId: 'old', transcript: 'a', label: 'OURS', at: 1 },
      { leadId: 'new', transcript: 'b', label: 'OURS', at: 2 }
    ];
    eq(REL.selectFeedbackExamples(corpus, 1, [1, 0]).map(function (e) { return e.leadId; }), ['new']);
  });

  it('falls back to recency when the lead itself could not be embedded', function () {
    var corpus = [
      labelled('old', 'OURS', [1, 0], 1),
      labelled('new', 'OURS', [0, 1], 2)
    ];
    eq(REL.selectFeedbackExamples(corpus, 1, null).map(function (e) { return e.leadId; }), ['new']);
  });
});

describe('relevance default settings', function () {
  // Off by default: it spends her own Gemini quota on every lead she opens, so an
  // install that has never seen this field must read as off, not on.
  it('defaults the lead status indicator off', function () {
    eq(K.DEFAULT_SETTINGS.relevanceEnabled, false);
  });

  it('round-trips a stored relevanceEnabled through the default merge', function () {
    eq(Object.assign({}, K.DEFAULT_SETTINGS, { relevanceEnabled: true }).relevanceEnabled, true);
  });
});

// -------------------------------------------------------------------- report

if (failed.length) {
  console.log('\n' + failed.length + ' FAILED, ' + passed + ' passed\n');
  failed.forEach(function (f) { console.log('  x ' + f.name + '\n    ' + f.message); });
  console.log('');
  process.exit(1);
}
console.log('\n' + passed + ' tests passed\n');
