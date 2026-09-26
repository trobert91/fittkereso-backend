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
  /** The best few candidates, best first — not necessarily every one scored. */
  candidates: ListingMatchCandidate[];
  llm?: ListingMatchLlmRecord;
}
