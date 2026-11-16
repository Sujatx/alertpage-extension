/*
 * Data only. The definition of "ours" for the Lead Status traffic light, plus the
 * verdict-cache constants. Read by lib/relevance.js (prompt + schema) in the
 * service worker and by content/working-screen.js (labels, cache) on the page.
 *
 * CATEGORIES is a business rule, not a preference - it lives here rather than in
 * the popup so there is exactly one place to change what her team works. The
 * `description` of each is what goes into the prompt: the model is asked to judge
 * the incident against these definitions by reading the transcript, NOT to look
 * for the words in them. Keyword matching is what lib/highlight.js does, and it is
 * the wrong tool for this - "fire" appears in plenty of leads that aren't ours and
 * is missing from some that are.
 *
 * NOT_OURS_EXAMPLES exists for the same reason: it gives the model the contrast
 * class in plain language so a vehicle fire in the open doesn't get swept in with
 * a vehicle into a building.
 */
(function (root) {
  'use strict';

  var CATEGORIES = [
    {
      id: 'STRUCTURE_FIRE',
      label: 'Structure fire',
      description: 'Fire in, on, or involving a building or other permanent structure. A fire alarm or detector activation on its own is an alarm, not this.'
    },
    {
      id: 'VEHICLE_INTO_BUILDING',
      label: 'Vehicle into building',
      description: 'A vehicle has struck, driven into, or come to rest inside a building or structure.'
    },
    {
      id: 'WATER_LEAK',
      label: 'Water leak',
      description: 'Water actually escaping inside a building - a burst or broken pipe, a failed sprinkler or water main, a leak coming through a ceiling or wall. A waterflow or sprinkler alarm signal on its own is an alarm, not this.'
    },
    {
      id: 'BASEMENT_FLOODING',
      label: 'Basement flooding',
      description: 'Water accumulating in a basement, cellar, or below-grade level of a building.'
    },
    {
      id: 'APPLIANCE_FIRE',
      label: 'Appliance fire',
      description: 'Fire originating in an appliance or fixed equipment inside a building - stove, oven, dryer, furnace, boiler, electrical panel and the like.'
    }
  ];

  var CATEGORY_IDS = [];
  for (var i = 0; i < CATEGORIES.length; i++) { CATEGORY_IDS.push(CATEGORIES[i].id); }

  // Deliberately phrased as incident types, not as words to avoid. These are the
  // near-misses that share vocabulary with the five above.
  var NOT_OURS_EXAMPLES = [
    'a vehicle fire in the open, with no building involved',
    'a brush, grass, woods, or rubbish/dumpster fire',
    'a medical call, injury, or cardiac/overdose response',
    'a vehicle crash that does not involve a building',
    'an automatic alarm activation of any kind - fire alarm, smoke or CO detector, ' +
      'sprinkler or waterflow alarm, alarm-company call - where the transcript does ' +
      'not say crews actually found fire or actual water damage',
    'a smell or report of smoke with no fire located',
    'routine unit or administrative radio traffic - rehab, staffing or manpower, ' +
      'returning to quarters, going available, status or time checks, roll calls, ' +
      'dispatch acknowledgements - even when a fire is mentioned in passing',
    'a wire down, pole fire, or transformer in the street',
    'a rescue, lockout, public assist, or standby with no fire or water damage'
  ];

  var STATUS = {
    RELEVANT: 'RELEVANT',
    NOT_RELEVANT: 'NOT_RELEVANT',
    UNCLEAR: 'UNCLEAR'
  };

  // Verdicts are cached by lead id so reopening or reloading a lead she has already
  // looked at costs nothing. A lead's text never changes once it exists, so the TTL
  // is about bounding storage growth, not staleness.
  var VERDICT_TTL_MS = 24 * 60 * 60 * 1000;
  var VERDICT_CACHE_MAX = 50;

  // Bump whenever the categories or the prompt change: a cached verdict produced by
  // an older prompt is stale even though the lead's text never moved. Without this,
  // tuning the prompt leaves yesterday's wrong answers pinned on screen for a day.
  var VERDICT_CACHE_VERSION = 4;

  /*
   * Her corrections. The only way this feature gets better: a label she sets is
   * ground truth, and later prompts carry the ones she has already ruled on as
   * worked examples. There is no training and no backend - just her judgement on
   * real transcripts, shown to the model alongside the abstract rules, which is
   * what the rules on their own keep failing to capture.
   *
   * FEEDBACK_MAX bounds storage; FEEDBACK_PROMPT_MAX bounds how many reach any one
   * prompt, since every example is tokens she pays for on every lead.
   */
  var FEEDBACK_LABELS = { OURS: 'OURS', NOT_OURS: 'NOT_OURS' };
  var FEEDBACK_MAX = 60;
  var FEEDBACK_PROMPT_MAX = 20;
  var FEEDBACK_TRANSCRIPT_MAX_CHARS = 400;

  /*
   * Embeddings. Every labelled transcript is stored as a vector, and a new lead is
   * matched against them by cosine similarity - so the examples put in front of the
   * model are the ones most like THIS lead, not merely the most recent. That is what
   * stops the feature plateauing: at 20 labels recency and similarity pick the same
   * set, at 500 they do not, and only similarity keeps improving.
   *
   * gemini-embedding-2 (free tier, currently preview). It dropped the task_type
   * field its predecessor took - the task is now stated as a prefix on the text
   * itself, and "sentence similarity" is the symmetric form, which is what comparing
   * one transcript against another calls for. Verified against
   * ai.google.dev/gemini-api/docs/embeddings, 2026-09-11.
   *
   * 768 dimensions is one of the model's recommended sizes; values are rounded to 4
   * decimals before storage, which costs nothing in similarity terms and roughly
   * halves what each vector takes up in chrome.storage.local.
   *
   * EMBED_VERSION is the load-bearing one. Vectors from different models - or the
   * same model at a different dimensionality - live in different spaces, and cosine
   * similarity between them is meaningless rather than merely wrong. Nothing warns
   * you: the numbers still come out between -1 and 1 and the feature quietly starts
   * recommending nonsense. So it is derived from both, stamped on every stored
   * vector, and checked before any comparison. Changing either constant above
   * retires the old vectors automatically.
   */
  var EMBED_MODEL = 'gemini-embedding-2';
  var EMBED_PATH = '/v1beta/models/' + EMBED_MODEL + ':embedContent';
  var EMBED_DIMENSIONS = 768;
  var EMBED_TASK_PREFIX = 'task: sentence similarity | query: ';
  var EMBED_PRECISION = 4;
  var EMBED_VERSION = EMBED_MODEL + ':' + EMBED_DIMENSIONS;

  /*
   * k-NN over those vectors, as a second opinion on the model's answer.
   *
   * Deliberately one-directional: neighbours can pull a green down to grey when her
   * own past rulings contradict it, but can never manufacture a red on their own.
   * Same asymmetry as everywhere else here - the neighbours are evidence she has
   * skipped leads like this before, not proof this one is safe to skip.
   *
   * The two thresholds are the tuning knobs. NEIGHBOR_MIN_SIMILARITY is what counts
   * as "like this lead" at all; below it a neighbour is just noise.
   */
  var NEIGHBOR_COUNT = 5;
  var NEIGHBOR_MIN_SIMILARITY = 0.72;
  var NEIGHBOR_MIN_COUNT = 3;
  var NEIGHBOR_MIN_AGREEMENT = 0.8;

  // Shown the instant the row is built, before the model has answered. Reserving
  // the space up front is what keeps the row from reflowing when the verdict lands.
  var PENDING_LABEL = 'Checking…';
  var NOT_RELEVANT_LABEL = 'Not ours';
  var RELEVANT_LABEL = 'Ours';
  var UNCLEAR_LABEL = 'Unclear';

  var api = {
    CATEGORIES: CATEGORIES,
    CATEGORY_IDS: CATEGORY_IDS,
    NOT_OURS_EXAMPLES: NOT_OURS_EXAMPLES,
    STATUS: STATUS,
    VERDICT_TTL_MS: VERDICT_TTL_MS,
    VERDICT_CACHE_MAX: VERDICT_CACHE_MAX,
    VERDICT_CACHE_VERSION: VERDICT_CACHE_VERSION,
    EMBED_MODEL: EMBED_MODEL,
    EMBED_PATH: EMBED_PATH,
    EMBED_DIMENSIONS: EMBED_DIMENSIONS,
    EMBED_TASK_PREFIX: EMBED_TASK_PREFIX,
    EMBED_VERSION: EMBED_VERSION,
    EMBED_PRECISION: EMBED_PRECISION,
    NEIGHBOR_COUNT: NEIGHBOR_COUNT,
    NEIGHBOR_MIN_SIMILARITY: NEIGHBOR_MIN_SIMILARITY,
    NEIGHBOR_MIN_COUNT: NEIGHBOR_MIN_COUNT,
    NEIGHBOR_MIN_AGREEMENT: NEIGHBOR_MIN_AGREEMENT,
    FEEDBACK_LABELS: FEEDBACK_LABELS,
    FEEDBACK_MAX: FEEDBACK_MAX,
    FEEDBACK_PROMPT_MAX: FEEDBACK_PROMPT_MAX,
    FEEDBACK_TRANSCRIPT_MAX_CHARS: FEEDBACK_TRANSCRIPT_MAX_CHARS,
    PENDING_LABEL: PENDING_LABEL,
    NOT_RELEVANT_LABEL: NOT_RELEVANT_LABEL,
    RELEVANT_LABEL: RELEVANT_LABEL,
    UNCLEAR_LABEL: UNCLEAR_LABEL
  };

  root.APA = root.APA || {};
  root.APA.relevanceConfig = api;

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof globalThis !== 'undefined' ? globalThis : self);
