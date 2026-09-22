import type { IdentityGate } from '@fittkereso-backend/database';

/** Exactly one candidate at or above this attaches a listing without asking the LLM. */
export const ACCEPT_SCORE = 80;

/**
 * Candidates at or above this are near-misses: a listing sends them to the
 * LLM, and two stored products become a duplicate pair.
 */
export const NEAR_MISS_SCORE = 70;

/**
 * Points a failed gate takes off a candidate's score. A primary spec mismatch
 * on identical names lands exactly on NEAR_MISS_SCORE: it can reach the LLM or
 * a person, but never auto-attach.
 */
export const GATE_SEVERITY: Record<IdentityGate, number> = {
  primarySpecMismatch: 30,
  modelNumberMismatch: 30,
  matcherSpecMismatch: 10,
};

/** Rows the recall query returns, name and alias rows together. */
export const NAME_HITS = 20;

/**
 * How much a name's alignment similarity counts against trigram and
 * Levenshtein, which weigh 1 each (see `baseScore`). 3 is the lowest weight at
 * which every true match in the labelled set still auto-attaches: below it the
 * character metrics outvote alignment and the colourway cases fall back into
 * the review band.
 */
export const ALIGNMENT_WEIGHT = 3;

/**
 * What one fully identity-bearing token costs the alignment similarity, in
 * score points, when the two names *disagree* about it ("master" against
 * "prestige") versus when one name simply *omits* it ("glorious", which one
 * shop leaves in the model name and the other does not). A substitution has to
 * cost more than twice an omission — that difference is the whole point of the
 * measure — and both scale by the token's IDF, so a token the whole brand
 * shares costs nothing either way.
 */
export const SUBSTITUTION_COST = 45;
export const OMISSION_COST = 20;

/**
 * How long token frequencies for one brand and category are reused. IDF is a
 * smooth statistic over every product of a brand, so a scrape creating a few
 * products barely moves it — but the map would otherwise be rebuilt for every
 * listing of a catalog run.
 */
export const TOKEN_IDF_TTL_MS = 5 * 60 * 1000;

/**
 * Whether near-misses are put to the LLM at all. Off, a listing the score
 * can't attach on its own becomes a new product — the same safe default the
 * LLM declining gives.
 */
export const LLM_ENABLED = true;

/** The model that adjudicates near-misses. */
export const LLM_MODEL = 'deepseek-v4-flash';

/** The confidence an LLM pick needs before a listing attaches to it. */
export const LLM_ACCEPT_CONFIDENCE = 80;

/** Candidates a stored ListingMatchDecision keeps, best first. */
export const LISTING_DECISION_CANDIDATES = 5;

/** Products the nightly scan loads at a time. */
export const SCAN_PAGE_SIZE = 200;

/** How long one scan may run before it stops and leaves the rest to the next one. */
export const SCAN_BUDGET_MS = 30 * 60 * 1000;

/**
 * Subtracted from a complete scan's start time before deleting open pairs it
 * didn't re-find. `updatedAt` is written by the database and the cutoff comes
 * from the app, so this absorbs any clock difference between them; stale pairs
 * are a day old, far outside it.
 */
export const STALE_PAIR_GRACE_MS = 5 * 60 * 1000;
