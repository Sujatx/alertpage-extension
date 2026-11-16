/*
 * Pure prompt-building and response-handling for the Lead Status traffic light.
 * No fetch here - that stays in background.js, the one place this extension is
 * allowed to make a network call. This file only builds the request body and
 * interprets whatever background.js got back.
 *
 * Phase 1 of the workflow bot: it reads a lead and judges whether the incident is
 * one her team works. It decides nothing else and triggers nothing else. The
 * verdict is decoration on a lead that renders in full either way.
 *
 * The asymmetry that shapes every rule below: a wrong RED is the expensive
 * mistake, because she could skip a real incident on the strength of it. A wrong
 * GREEN costs her a few seconds of reading. So green has to be earned - the model
 * must cite a verbatim quote from the transcript and verifyVerdict() checks that
 * quote against the real text before it is ever shown - while anything doubtful,
 * garbled, or broken falls back to UNCLEAR (grey, "read it yourself"), never to
 * NOT_RELEVANT. The model is never allowed to talk the UI into a red.
 */
(function (root) {
  'use strict';

  var RC = root.APA && root.APA.relevanceConfig;
  // Node (tests/run-tests.js). In a content script or the service worker `require`
  // does not exist and the config has already been loaded onto root.APA above.
  if (!RC && typeof require === 'function') { RC = require('../config/relevance.js'); }

  var STATUS_VALUES = [RC.STATUS.RELEVANT, RC.STATUS.NOT_RELEVANT, RC.STATUS.UNCLEAR];

  var RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
      status: { type: 'string', enum: STATUS_VALUES },
      category: { type: 'string', enum: RC.CATEGORY_IDS, nullable: true },
      quote: { type: 'string', nullable: true },
      reason: { type: 'string' }
    },
    required: ['status', 'category', 'quote', 'reason']
  };

  function labelFor(categoryId) {
    for (var i = 0; i < RC.CATEGORIES.length; i++) {
      if (RC.CATEGORIES[i].id === categoryId) { return RC.CATEGORIES[i].label; }
    }
    return '';
  }

  /* ------------------------------------------------------- embeddings + k-NN */

  /**
   * Rounded to EMBED_PRECISION before storage. 4 decimals is far below the noise
   * floor of the similarities we compare, and roughly halves what a vector costs in
   * chrome.storage.local.
   */
  function packVector(values) {
    if (!Array.isArray(values) || !values.length) { return null; }
    var factor = Math.pow(10, RC.EMBED_PRECISION);
    var out = [];
    for (var i = 0; i < values.length; i++) {
      var n = Number(values[i]);
      if (!isFinite(n)) { return null; }
      out.push(Math.round(n * factor) / factor);
    }
    return out;
  }

  /**
   * True cosine, not a dot product: the stored vectors are rounded, so assuming they
   * are still exactly unit-length would quietly skew every comparison.
   */
  function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) { return 0; }
    var dot = 0;
    var na = 0;
    var nb = 0;
    for (var i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (!na || !nb) { return 0; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /**
   * @returns {Array<{item:object, similarity:number}>} most similar first
   */
  function nearestNeighbors(vector, feedback, k) {
    var list = Array.isArray(feedback) ? feedback : [];
    var cap = k == null ? RC.NEIGHBOR_COUNT : k;
    if (!Array.isArray(vector) || !vector.length || cap <= 0) { return []; }

    var scored = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var stored = usableVector(item);
      if (!stored || !item.transcript) { continue; }
      if (item.label !== RC.FEEDBACK_LABELS.OURS && item.label !== RC.FEEDBACK_LABELS.NOT_OURS) { continue; }
      scored.push({ item: item, similarity: cosineSimilarity(vector, stored) });
    }

    scored.sort(function (a, b) { return b.similarity - a.similarity; });
    return scored.slice(0, cap);
  }

  /**
   * Similarity-weighted vote over the neighbours, so a near-duplicate counts for
   * more than something merely adjacent.
   *
   * @returns {{label:string|null, agreement:number, count:number, confident:boolean,
   *            topSimilarity:number}}
   */
  function knnVote(neighbors) {
    var considered = [];
    var i;
    for (i = 0; i < (neighbors || []).length; i++) {
      if (neighbors[i].similarity >= RC.NEIGHBOR_MIN_SIMILARITY) { considered.push(neighbors[i]); }
    }

    var blank = { label: null, agreement: 0, count: considered.length, confident: false, topSimilarity: 0 };
    if (!considered.length) { return blank; }

    var weights = {};
    var total = 0;
    for (i = 0; i < considered.length; i++) {
      var label = considered[i].item.label;
      weights[label] = (weights[label] || 0) + considered[i].similarity;
      total += considered[i].similarity;
    }

    var best = null;
    for (var key in weights) {
      if (Object.prototype.hasOwnProperty.call(weights, key) && (best === null || weights[key] > weights[best])) {
        best = key;
      }
    }

    var agreement = total ? weights[best] / total : 0;
    return {
      label: best,
      agreement: agreement,
      count: considered.length,
      topSimilarity: considered[0].similarity,
      confident: considered.length >= RC.NEIGHBOR_MIN_COUNT && agreement >= RC.NEIGHBOR_MIN_AGREEMENT
    };
  }

  /**
   * The second opinion, applied one-directionally on purpose.
   *
   * A confident run of her own NOT_OURS rulings on leads like this one is good
   * reason to distrust a green - so green falls to grey. It is NOT reason enough to
   * print a red she never asked for: neighbours are evidence about similar leads,
   * not about this one, and a wrong red is the mistake that costs her an incident.
   * So this can only ever remove confidence, never add it.
   */
  function applyNeighborCheck(verdict, vote) {
    var v = verdict || {};
    if (!vote || !vote.confident || !vote.label) { return v; }

    var contradictsGreen = v.status === RC.STATUS.RELEVANT && vote.label === RC.FEEDBACK_LABELS.NOT_OURS;
    if (!contradictsGreen) { return v; }

    return {
      status: RC.STATUS.UNCLEAR,
      categoryId: null,
      categoryLabel: '',
      reason: 'You marked ' + vote.count + ' similar lead' + (vote.count === 1 ? '' : 's') +
        ' as not yours, which disagrees with this read - worth a look.',
      quote: null,
      overruledBy: 'neighbors'
    };
  }

  /**
   * gemini-embedding-2 takes no task_type - the task rides as a prefix on the text.
   * The same prefix must be used for both sides of every comparison, which here is
   * automatic since every transcript goes through this one function.
   *
   * outputDimensionality is proto-JSON camelCase, which the v1beta REST endpoint
   * accepts; Google's Python samples show output_dimensionality for the same field.
   * If a vector ever comes back 3072 long, the field is being ignored and that
   * spelling is the first thing to check.
   */
  function buildEmbedRequestBody(text) {
    var body = String(text == null ? '' : text).trim();
    return {
      content: { parts: [{ text: RC.EMBED_TASK_PREFIX + body }] },
      outputDimensionality: RC.EMBED_DIMENSIONS
    };
  }

  /**
   * A stored vector is only usable if it came from the embedding space we are
   * currently comparing in. Entries from an older model, an older dimensionality, or
   * from before vectors were stored at all, return null and fall out of every
   * similarity path - they stay perfectly good as recency-ranked prompt examples.
   */
  function usableVector(item) {
    if (!item || !Array.isArray(item.vector) || !item.vector.length) { return null; }
    if (item.ev !== RC.EMBED_VERSION) { return null; }
    return item.vector;
  }

  /**
   * embedContent answers with `embedding`, batchEmbedContents with `embeddings[]`.
   * Both shapes are accepted so a later switch to batching needs no parser change.
   *
   * @returns {{ok:true, vector:number[]}|{ok:false, reason:string}}
   */
  function parseEmbedResponse(apiResponse) {
    try {
      var r = apiResponse || {};
      var values = (r.embedding && r.embedding.values) ||
        (Array.isArray(r.embeddings) && r.embeddings[0] && r.embeddings[0].values);

      var vector = packVector(values);
      if (!vector) { return { ok: false, reason: 'bad-embed-shape' }; }
      return { ok: true, vector: vector };
    } catch (err) {
      return { ok: false, reason: 'bad-embed-shape' };
    }
  }

  function truncate(text, max) {
    var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }

  /**
   * Pick which of her corrections to put in front of the model.
   *
   * Newest first, because her most recent rulings are the most current read on what
   * the team is taking. But drawn alternately from OURS and NOT_OURS rather than
   * straight off the end: a run of corrections that are all one label would
   * otherwise teach the model to answer that way by default, which is the exact
   * failure a set of examples is supposed to prevent.
   *
   * @param {Array<{transcript:string, label:string, category:string|null, at:number}>} feedback
   * @param {number} max
   * @returns {Array<object>} oldest-first, ready to render into the prompt
   */
  function selectFeedbackExamples(feedback, max, vector) {
    var list = Array.isArray(feedback) ? feedback.slice() : [];
    var cap = max == null ? RC.FEEDBACK_PROMPT_MAX : max;
    if (cap <= 0) { return []; }

    // With a vector in hand, rank by how much each past ruling resembles THIS lead
    // rather than by when she made it. This is the whole point of storing vectors:
    // recency stops improving once she is past a couple of dozen labels, similarity
    // keeps improving for as long as she keeps labelling.
    var ranked = false;
    if (Array.isArray(vector) && vector.length) {
      var scored = [];
      for (var v = 0; v < list.length; v++) {
        var stored = usableVector(list[v]);
        if (stored) {
          scored.push({ item: list[v], similarity: cosineSimilarity(vector, stored) });
        }
      }
      if (scored.length) {
        scored.sort(function (a, b) { return b.similarity - a.similarity; });
        list = scored.map(function (x) { return x.item; });
        ranked = true;
      }
    }

    if (!ranked) {
      list.sort(function (a, b) { return (b && b.at || 0) - (a && a.at || 0); });
    }

    var ours = [];
    var notOurs = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || !item.transcript) { continue; }
      if (item.label === RC.FEEDBACK_LABELS.OURS) { ours.push(item); }
      else if (item.label === RC.FEEDBACK_LABELS.NOT_OURS) { notOurs.push(item); }
    }

    var picked = [];
    var a = 0;
    var b = 0;
    while (picked.length < cap && (a < ours.length || b < notOurs.length)) {
      if (a < ours.length) { picked.push(ours[a++]); }
      if (picked.length < cap && b < notOurs.length) { picked.push(notOurs[b++]); }
    }

    // When ranked by similarity, order is already meaningful and must be preserved -
    // most similar last, so the closest match is the final thing read before the
    // lead. Otherwise fall back to oldest-first by time, for the same reason.
    if (ranked) { picked.reverse(); }
    else { picked.sort(function (x, y) { return (x.at || 0) - (y.at || 0); }); }
    return picked;
  }

  /**
   * @param {{feed:string, category:string, keywords:string, transcript:string,
   *          county:string, state:string}} lead
   * @param {Array<object>} [feedback]  her past corrections, newest-inclusive
   * @returns {string}
   *
   * The whole lead goes in, but the transcript is the only thing the verdict may
   * rest on. AlertPage's own Alert Category/Keywords are its coarse first-pass
   * tagging - they are what produced this lead in the first place, so treating
   * them as evidence would just launder that guess into a green light.
   */
  function buildPrompt(lead, feedback, vector) {
    var l = lead || {};
    var lines = [];

    lines.push(
      'You are triaging a fire/EMS radio dispatch lead for a human dispatcher who ' +
      'will read the full lead herself regardless of what you say. Your job is to ' +
      'tell her whether this incident is one her team works.',
      '',
      'Her team works exactly these incident types:'
    );

    for (var i = 0; i < RC.CATEGORIES.length; i++) {
      lines.push('- ' + RC.CATEGORIES[i].id + ': ' + RC.CATEGORIES[i].description);
    }

    lines.push(
      '',
      'Her team does NOT work anything else. Incidents that are not hers include:'
    );

    for (var j = 0; j < RC.NOT_OURS_EXAMPLES.length; j++) {
      lines.push('- ' + RC.NOT_OURS_EXAMPLES[j]);
    }

    lines.push(
      '',
      'How to decide:',
      '- Read the whole transcript and work out what actually happened. Judge the ' +
      'incident, not the vocabulary. Do not match on individual words: a transcript ' +
      'can say "fire" repeatedly and not be one of her types, and it can be one of ' +
      'her types without using any of the wording above.',
      '- An alarm is not the thing it is reporting. An automatic activation, an ' +
      'alarm-company call, or a report that something MIGHT be happening is not the ' +
      'same as the incident itself. A waterflow or sprinkler alarm activation is an ' +
      'alarm, NOT a water leak. A fire alarm or smoke detector activation is an ' +
      'alarm, NOT a structure fire. Treat these as NOT_RELEVANT unless the ' +
      'transcript says crews actually found fire, or actual water escaping or ' +
      'standing in the building.',
      '- Mentioning an incident is not reporting one. A lead counts only if the ' +
      'transmission is actually reporting or working the incident. Radio traffic ' +
      'that is only unit or administrative business - a unit going to or coming back ' +
      'from rehab, staffing, returning to quarters, going available, a status or ' +
      'time check, a dispatch acknowledgement - is NOT_RELEVANT even when it refers ' +
      'to a fire that happened.',
      '- Weigh how much the transmission actually tells you about an incident. If it ' +
      'carries no real incident information - no location, no conditions, no what ' +
      'happened - it is not something she can work, even if the words sound related.',
      '- The transcript is automatic speech-to-text of a radio transmission. It will ' +
      'contain mis-transcriptions, run-on text, missing punctuation, unit numbers ' +
      'rendered as words, and partial sentences. Read through obvious transcription ' +
      'errors and judge what was actually being said.',
      '- If the transcript is too garbled, too short, or too ambiguous to tell what ' +
      'kind of incident it is, answer UNCLEAR. Answering UNCLEAR is always better ' +
      'than guessing. Never answer NOT_RELEVANT just because you are unsure - ' +
      'NOT_RELEVANT means you understood the incident and it is genuinely not one ' +
      'of her types.',
      '- The Alert Category and Alert Keywords below are AlertPage\'s own automatic ' +
      'tagging, not a human judgement. They are context only. Never treat them as ' +
      'evidence on their own; the transcript decides.',
      '',
      'Answer with:',
      '- status: RELEVANT if the incident is one of her types, NOT_RELEVANT if you ' +
      'understood it and it is not, UNCLEAR if you could not tell.',
      '- category: which of her types it is, when status is RELEVANT. Otherwise null.',
      '- quote: when status is RELEVANT, the shortest span of text copied VERBATIM ' +
      'from the Transcript below that shows this is that type of incident. It must ' +
      'appear in the transcript character for character. Otherwise null.',
      '- reason: one short sentence, for a dispatcher, saying why. Always required.',
      '',
      '--- LEAD ---'
    );

    // Her own rulings go in last, immediately before the lead, and are framed as
    // ground truth that outranks everything above - the rules are my guess at her
    // judgement, these are her judgement.
    var examples = selectFeedbackExamples(feedback, null, vector);
    if (examples.length) {
      var ex = [
        '',
        '--- HER OWN PAST RULINGS ---',
        'She has already ruled on these real leads. Her labels are ground truth: ' +
        'where one of them conflicts with the guidance above, she is right. Apply ' +
        'the same judgement to the lead below.',
        ''
      ];
      for (var e = 0; e < examples.length; e++) {
        var item = examples[e];
        var verdict = item.label === RC.FEEDBACK_LABELS.OURS
          ? 'OURS' + (item.category ? ' (' + item.category + ')' : '')
          : 'NOT OURS';
        ex.push('[' + verdict + '] ' + truncate(item.transcript, RC.FEEDBACK_TRANSCRIPT_MAX_CHARS));
      }
      lines = lines.slice(0, lines.length - 1).concat(ex, ['', '--- LEAD ---']);
    }

    if (l.feed) { lines.push('Source: ' + l.feed); }
    if (l.county || l.state) {
      lines.push('Location: ' + [l.county, l.state].filter(Boolean).join(', '));
    }
    if (l.category) { lines.push('Alert Category (AlertPage own tagging): ' + l.category); }
    if (l.keywords) { lines.push('Alert Keywords (AlertPage own tagging): ' + l.keywords); }
    lines.push('', 'Transcript:', String(l.transcript == null ? '' : l.transcript).trim());

    return lines.join('\n');
  }

  function buildRequestBody(lead, feedback, vector) {
    return {
      contents: [{ parts: [{ text: buildPrompt(lead, feedback, vector) }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA
      }
    };
  }

  /**
   * @param {object} apiResponse  the full parsed JSON body Gemini returned
   * @returns {{ok:true, structured:object}|{ok:false, reason:string}}
   */
  function parseRelevanceResponse(apiResponse) {
    try {
      var text = apiResponse.candidates[0].content.parts[0].text;
      var structured = JSON.parse(text);

      if (!structured || typeof structured !== 'object') {
        return { ok: false, reason: 'bad-response-shape' };
      }
      if (STATUS_VALUES.indexOf(structured.status) === -1) {
        return { ok: false, reason: 'bad-response-shape' };
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
   * The load-bearing hallucination check, and the thing that enforces the
   * green-costs-more-than-red asymmetry described at the top of this file.
   *
   * RELEVANT survives only if the model named one of her real categories AND its
   * quote is genuinely in the transcript. Anything that fails is demoted to
   * UNCLEAR - deliberately not to NOT_RELEVANT, because a model that just
   * fabricated a quote has given us no reason to believe the lead is safe to skip.
   *
   * @param {object} structured  parseRelevanceResponse()'s structured output
   * @param {string} transcript  the real transcript text from the lead
   * @returns {{status:string, categoryId:string|null, categoryLabel:string,
   *            reason:string, quote:string|null}}
   */
  function verifyVerdict(structured, transcript) {
    var s = structured || {};
    var reason = typeof s.reason === 'string' ? s.reason.trim() : '';

    function unclear(why) {
      return {
        status: RC.STATUS.UNCLEAR,
        categoryId: null,
        categoryLabel: '',
        reason: why || reason,
        quote: null
      };
    }

    if (s.status === RC.STATUS.NOT_RELEVANT) {
      return {
        status: RC.STATUS.NOT_RELEVANT,
        categoryId: null,
        categoryLabel: '',
        reason: reason,
        quote: null
      };
    }

    if (s.status !== RC.STATUS.RELEVANT) { return unclear(); }

    if (RC.CATEGORY_IDS.indexOf(s.category) === -1) {
      return unclear(reason || 'Model reported a relevant lead without naming a category.');
    }

    var haystack = normalizeForMatch(transcript);
    var needle = normalizeForMatch(s.quote);
    if (!needle || haystack.indexOf(needle) === -1) {
      return unclear('Could not verify the quote against the transcript.');
    }

    return {
      status: RC.STATUS.RELEVANT,
      categoryId: s.category,
      categoryLabel: labelFor(s.category),
      reason: reason,
      quote: String(s.quote).trim()
    };
  }

  var api = {
    RESPONSE_SCHEMA: RESPONSE_SCHEMA,
    STATUS_VALUES: STATUS_VALUES,
    buildPrompt: buildPrompt,
    buildRequestBody: buildRequestBody,
    selectFeedbackExamples: selectFeedbackExamples,
    packVector: packVector,
    usableVector: usableVector,
    cosineSimilarity: cosineSimilarity,
    nearestNeighbors: nearestNeighbors,
    knnVote: knnVote,
    applyNeighborCheck: applyNeighborCheck,
    buildEmbedRequestBody: buildEmbedRequestBody,
    parseEmbedResponse: parseEmbedResponse,
    parseRelevanceResponse: parseRelevanceResponse,
    verifyVerdict: verifyVerdict,
    labelFor: labelFor
  };

  root.APA = root.APA || {};
  root.APA.relevance = api;

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : self);
