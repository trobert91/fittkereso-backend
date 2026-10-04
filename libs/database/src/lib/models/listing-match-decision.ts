import type {
  CandidateMatchedOn,
  IdentityGate,
  IdentityGateValue,
} from '../postgres/types/product-duplicate-pair.types';

/**
 * What scrape-time listing matching decided, stored on `ProductImportTask` so the
 * decision can be read back without replaying the scrape. `libs/product-identity`
 * produces it; the shape lives here because entities can only depend on this lib.
 */

/** How a listing ended up on its product. */
export type ListingMatchOutcome =
  /** Exactly one candidate scored high enough on its own. */
  | 'identified'
  /** Several candidates were close and the LLM picked one. */
  | 'llm_identified'
  /** Nothing was close enough, or the LLM declined: a new product. */
  | 'created';

/** A contradiction between the listing and a candidate, with both values. */
export interface ListingMatchFailedGate {
  gate: IdentityGate;
  /** The spec key, for spec gates. */
  spec?: string;
  severity: number;
  /** Null on the side a `specMissing` gate found without the spec. */
  queryValue: IdentityGateValue | null;
  candidateValue: IdentityGateValue | null;
}

/** One scored candidate, as the decision records it. */
export interface ListingMatchCandidate {
  productId: string;
  displayName: string;
  /** 1–100: the name score minus every failed gate's severity. */
  score: number;
  matchedOn: CandidateMatchedOn;
  failedGates: ListingMatchFailedGate[];
  /** Whether one of the product's listings has the listing's matcherModel key; absent when either has none. */
  matcherModelMatch?: boolean;
  /** 100 minus the spec gates alone: what the key rule attaches on. Absent on decisions stored before it. */
  keyScore?: number;
}

/**
 * Which rule decides a name match. `score`: the best name score minus every
 * failed gate (the clear-winner rule). `key`: equal matcherModel keys and spec
 * gates at ACCEPT_SCORE, the name score only ranking — on for a category with
 * `matchingConfig.model.required`, for a listing with a key.
 */
export type ListingMatchMode = 'score' | 'key';

/**
 * How the rule that didn't act compares with the one that did: the same
 * product (or both no product), another product, a separate product where the
 * acting rule attached, or a product where it created one.
 */
export type ListingMatchComparison = 'agree' | 'switch' | 'split' | 'join';

/** What the other rule would have done (shadow mode). */
export interface ListingMatchAlternative {
  mode: ListingMatchMode;
  kind: 'attach' | 'ask_llm' | 'not_found';
  /** The product it would have attached to. */
  productId?: string;
  /** How many candidates it would have put to the LLM. */
  llmCandidates?: number;
  comparison: ListingMatchComparison;
}

/** What the LLM answered; absent when it was never asked. */
export interface ListingMatchLlmRecord {
  /** The product it picked, when one cleared the confidence bar. */
  productId?: string;
  /** 0–100, as returned for the best pick. */
  confidence?: number;
  reason?: string;
  /** Set instead of a pick when the call itself failed. */
  error?: string;
}

export interface ListingMatchDecision {
  outcome: ListingMatchOutcome;
  /** The name key recall and scoring ran on; absent when the brand didn't resolve. */
  nameKey?: string;
  /** The best few candidates, the chosen one first, then best first — not necessarily every one scored. */
  candidates: ListingMatchCandidate[];
  llm?: ListingMatchLlmRecord;
  /** The rule that acted; absent on decisions stored before there were two. */
  mode?: ListingMatchMode;
  /** The listing's matcherModel key, when it has one. */
  matcherModelKey?: string;
  /** What the other rule would have done. */
  alternative?: ListingMatchAlternative;
}
