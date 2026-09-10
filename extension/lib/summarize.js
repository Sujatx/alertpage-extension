/*
 * Pure prompt-building and response-handling for the Summarize feature. No fetch
 * here - that stays in background.js, the one place this extension is allowed to
 * make a network call. This file only builds the request body and interprets
 * whatever background.js got back.
 *
 * The prompt is extractive-only: the model may only quote verbatim from the
 * supplied transmissions, must cite which one, and must say a field was not
 * mentioned rather than guess. verifyExtractive() is the actual enforcement of
 * that rule - every citation is checked against the real transcript text before
 * it is ever rendered as a link. A citation that doesn't hold up is dropped, not
 * shown, no matter what the model claimed.
 */
(function (root) {
  'use strict';

  // Six fields, all extractive, all optional. `conditions` covers the kind of
  // extra clause AlertPage's own dispatchers already write by hand (see
  // docs/agent-workflow.md step 9: "SMOKE CONDITION", "NEED A FAN FOR
  // VENTILATION") - it doesn't fit stories/type/location/status/address, but the
  // required output shape needs it (e.g. "... - SMOKE CONDITION").
  var FIELDS = ['buildingStories', 'buildingType', 'incidentLocation', 'incidentStatus', 'conditions', 'address'];

  var STATUS_VALUES = ['ACTIVE', 'OUT', 'UNDER CONTROL', 'KNOCKED DOWN'];

  var STATUS_DISPLAY = {
    ACTIVE: 'FIRE IS ACTIVE',
    OUT: 'FIRE IS OUT',
    'UNDER CONTROL': 'FIRE IS UNDER CONTROL',
    'KNOCKED DOWN': 'FIRE IS KNOCKED DOWN'
  };

  var NO_TRANSCRIPT_SENTINEL = 'No Transcript';

  var EVIDENCE_SCHEMA = {
    type: 'object',
    properties: {
      idTransmission: { type: 'string' },
      quote: { type: 'string' }
    },
    required: ['idTransmission', 'quote']
  };

  function fieldSchema(valueEnum) {
    var value = valueEnum
      ? { type: 'string', enum: valueEnum, nullable: true }
      : { type: 'string', nullable: true };
    return {
      type: 'object',
      properties: {
        value: value,
        evidence: { type: 'array', items: EVIDENCE_SCHEMA }
      },
      required: ['value', 'evidence']
    };
  }

  var RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
      buildingStories: fieldSchema(null),
      buildingType: fieldSchema(null),
      incidentLocation: fieldSchema(null),
      incidentStatus: fieldSchema(STATUS_VALUES),
      conditions: fieldSchema(null),
      address: fieldSchema(null)
    },
    required: FIELDS
  };

  /**
   * @param {object[]} window  chronologically-ordered transmissions (oldest first),
   *                           the last of which may or may not be the anchor -
   *                           callers pass anchorId so it can be flagged in the text.
   * @param {string} anchorId  the id_transmission that triggered the alert
   * @returns {string} the full prompt text
   */
  function buildPrompt(window, anchorId) {
    var list = Array.isArray(window) ? window : [];
    var lines = [];

    lines.push(
      'You are extracting facts from real fire/EMS radio dispatch transcripts for a ' +
      'human dispatcher who will review every answer before using it. Do not use ' +
      'outside knowledge. Do not infer, guess, or paraphrase beyond normalizing ' +
      'case that is clearly present in the text.',
      '',
      'Rules:',
      '- Every non-null field\'s value must be directly supported by a VERBATIM quote ' +
      'from exactly one of the transmissions below.',
      '- Every non-null field must cite the id_transmission of the transmission the ' +
      'quote came from.',
      '- If a field is not mentioned anywhere below, its value must be null and its ' +
      'evidence must be an empty array. Do not guess an address, a status, or a ' +
      'building type that isn\'t actually stated.',
      '- Never combine information from a transmission with your own outside ' +
      'knowledge (e.g. do not assume a building type from an address).',
      '',
      'Transmissions, oldest to newest:',
      ''
    );

    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var text = String((t && t.transcription_text) || '').trim();
      if (!text || text === NO_TRANSCRIPT_SENTINEL) { continue; }
      var tag = (t.id_transmission === anchorId) ? '  (this is the transmission that triggered the alert)' : '';
      lines.push('[id=' + t.id_transmission + '] ' + text + tag);
    }

    lines.push('', 'Return the structured fields described in the response schema.');

    return lines.join('\n');
  }

  /**
   * @param {object[]} window
   * @param {string} anchorId
   * @returns {object} a ready-to-POST Gemini generateContent request body
   */
  function buildRequestBody(window, anchorId) {
    return {
      contents: [{ parts: [{ text: buildPrompt(window, anchorId) }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA
      }
    };
  }

  function isFieldShape(f) {
    return !!f && typeof f === 'object' && ('value' in f) && Array.isArray(f.evidence);
  }

  /**
   * @param {object} apiResponse  the full parsed JSON body Gemini returned
   * @returns {{ok:true, structured:object}|{ok:false, reason:string}}
   */
  function parseGeminiResponse(apiResponse) {
    try {
      var text = apiResponse.candidates[0].content.parts[0].text;
      var structured = JSON.parse(text);

      for (var i = 0; i < FIELDS.length; i++) {
        if (!isFieldShape(structured[FIELDS[i]])) {
          return { ok: false, reason: 'bad-response-shape' };
        }
      }

      return { ok: true, structured: structured };
    } catch (err) {
      return { ok: false, reason: 'bad-response-shape' };
    }
  }

  function normalizeForMatch(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /**
   * The load-bearing hallucination check. Drops any evidence entry that cites a
   * transmission not in the fetched window, or a quote that isn't actually a
   * substring of that transmission's real transcript. A field with nothing left
   * is demoted to unconfirmed - never rendered as a confident, linked claim.
   *
   * @param {object} structured  parseGeminiResponse()'s structured output
   * @param {Object<string,object>} transmissionsById  id_transmission -> transmission
   * @returns {Object<string,{value:string|null, link:object|null}>}
   */
  function verifyExtractive(structured, transmissionsById) {
    var byId = transmissionsById || {};
    var verified = {};

    for (var i = 0; i < FIELDS.length; i++) {
      var key = FIELDS[i];
      var field = structured[key] || { value: null, evidence: [] };

      if (field.value == null) {
        verified[key] = { value: null, link: null };
        continue;
      }

      var link = null;
      for (var j = 0; j < field.evidence.length; j++) {
        var ev = field.evidence[j];
        var t = byId[ev && ev.idTransmission];
        if (!t) { continue; }
        var haystack = normalizeForMatch(t.transcription_text);
        var needle = normalizeForMatch(ev.quote);
        if (needle && haystack.indexOf(needle) !== -1) {
          link = {
            idTransmission: t.id_transmission,
            transmissionTimeStamp: Number(t.transmission_time_stamp),
            talkgroupDecimal: t.talkgroup_decimal != null ? t.talkgroup_decimal : null,
            talkgroupCounty: t.talkgroup_county != null ? t.talkgroup_county : null
          };
          break;
        }
      }

      verified[key] = link ? { value: field.value, link: link } : { value: null, link: null };
    }

    return verified;
  }

  /**
   * @param {Object<string,{value:string|null, link:object|null}>} verified
   * @returns {Array<{text:string, link:object|null}>} Chip[]
   *
   * Deterministic client-side template. Every rule here is "omit the field and
   * its glue, never render an empty or dangling segment."
   */
  function assembleSummaryLine(verified) {
    var chips = [];

    function chip(text, link) { chips.push({ text: text, link: link || null }); }
    function sep() { chips.push({ text: ' - ', link: null }); }

    var stories = verified.buildingStories;
    var type = verified.buildingType;
    if ((stories && stories.value) || (type && type.value)) {
      if (stories && stories.value) { chip(stories.value.toUpperCase(), stories.link); }
      if (stories && stories.value && type && type.value) { chip(' ', null); }
      if (type && type.value) { chip(type.value.toUpperCase(), type.link); }
      chip(' BUILDING', null);
    }

    var location = verified.incidentLocation;
    if (location && location.value) {
      if (chips.length) { sep(); }
      chip(location.value.toUpperCase(), location.link);
    }

    var status = verified.incidentStatus;
    if (status && status.value) {
      if (chips.length) { sep(); }
      chip(STATUS_DISPLAY[status.value] || status.value.toUpperCase(), status.link);
    }

    var conditions = verified.conditions;
    if (conditions && conditions.value) {
      if (chips.length) { sep(); }
      chip(conditions.value.toUpperCase(), conditions.link);
    }

    var address = verified.address;
    if (address && address.value) {
      if (chips.length) { sep(); }
      chip(address.value, address.link);
    }

    return chips;
  }

  var api = {
    FIELDS: FIELDS,
    STATUS_VALUES: STATUS_VALUES,
    RESPONSE_SCHEMA: RESPONSE_SCHEMA,
    buildPrompt: buildPrompt,
    buildRequestBody: buildRequestBody,
    parseGeminiResponse: parseGeminiResponse,
    verifyExtractive: verifyExtractive,
    assembleSummaryLine: assembleSummaryLine
  };

  root.APA = root.APA || {};
  root.APA.summarize = api;

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : self);
