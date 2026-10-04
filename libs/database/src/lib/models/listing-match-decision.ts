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
  /** A candidate with the listing's normalizedModel passed its spec gates. */
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
  /**
   * Whether one of the product's listings has the listing's normalizedModel;
   * absent when the listing has none. Decisions stored before it carry
   * matcherModelMatch instead.
   */
  normalizedModelMatch?: boolean;
  /** 100 minus the spec gates alone: what an equal key attaches on. Absent on decisions stored before it. */
  keyScore?: number;
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
  /** The best few candidates, the chosen one first, then best first — not necessarily every one scored. */
  candidates: ListingMatchCandidate[];
  llm?: ListingMatchLlmRecord;
  /** The listing's normalizedModel, when it has one. */
  normalizedModel?: string;
  /**
   * The exact-key pass alone decided: a candidate with the listing's key
   * attached, so no trigram search ran, and `candidates` holds only those.
   */
  shortCircuit?: boolean;
}
