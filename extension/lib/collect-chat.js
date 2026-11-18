/*
 * Chat observation (event-schema-v1 section 5). Pure except hashing: turns a rendered
 * message (author, displayed time, text) into a chat_message_observed item.
 */
(function (root) {
  'use strict';

  var C = root.APA && root.APA.collectorConfig;
  if (!C && typeof require === 'function') { C = require('../config/collector-settings.js'); }
  var CANON = root.APA && root.APA.canon;
  if (!CANON && typeof require === 'function') { CANON = require('./collect-canon.js'); }

  /** "9:24 PM" -> minutes since local midnight, or null. */
  function parseDisplayedTime(text) {
    var m = /^\s*(\d{1,2}):(\d{2})\s*([AP])\.?M\.?\s*$/i.exec(String(text == null ? '' : text));
    if (!m) { return null; }
    var hour = parseInt(m[1], 10), min = parseInt(m[2], 10);
    if (min > 59 || hour > 12 || hour < 1) { return null; }
    return ((hour % 12) + (m[3].toUpperCase() === 'P' ? 12 : 0)) * 60 + min;
  }

  /**
   * The most recent minute at or before observedAt whose local h:mm equals the displayed
   * time, as UTC ms. shortcut: uses the offset at observation for the whole <=24 h look-back,
   * so a DST change inside that window shifts old replays by an hour; fine for ~20 messages.
   */
  function minuteUtc(displayedTime, observedAt, tzOffsetMin) {
    var t = parseDisplayedTime(displayedTime);
    if (t == null) { return null; }
    var localMin = Math.floor((observedAt - tzOffsetMin * 60000) / 60000);
    var ofDay = ((localMin % 1440) + 1440) % 1440;
    var back = (((ofDay - t) % 1440) + 1440) % 1440;
    return (localMin - back + tzOffsetMin) * 60000;
  }

  /** Counts identical (author, minute, text) messages seen so far in this page load. */
  function createCounter() {
    var seen = {};
    return {
      next: function (author, minute, text) {
        var k = author + '\u0000' + minute + '\u0000' + text;
        seen[k] = (seen[k] || 0) + 1;
        return seen[k];
      }
    };
  }

  /**
   * msg: { author, displayedTime, text }; ctx: { observedAt, tzOffsetMin, uuid, roomId? }.
   * Occurrence is taken synchronously so hashing latency cannot reorder it.
   */
  function buildItem(msg, ctx, counter) {
    var minute = minuteUtc(msg.displayedTime, ctx.observedAt, ctx.tzOffsetMin);
    if (minute == null) { minute = Math.floor(ctx.observedAt / 60000) * 60000; }
    var occurrence = counter.next(msg.author, minute, msg.text);
    return CANON.sha256Hex(msg.text).then(function (hash) {
      return {
        item_type: 'chat_message_observed',
        event_id: ctx.uuid(),
        room_id: ctx.roomId || C.CHAT_ROOM_ID,
        author: msg.author,
        minute_utc: minute,
        occurrence: occurrence,
        text_raw: msg.text,
        text_sha256: hash,
        displayed_time: msg.displayedTime,
        observed_at: ctx.observedAt
      };
    });
  }

  var api = { parseDisplayedTime: parseDisplayedTime, minuteUtc: minuteUtc, createCounter: createCounter, buildItem: buildItem };

  root.APA = root.APA || {};
  root.APA.chat = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : self);
