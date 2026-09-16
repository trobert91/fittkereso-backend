/**
 * Shapes stored on ProductDuplicatePair rows. `libs/product-identity` computes
 * them; they live here because entities can only depend on this lib.
 */

/** A check that lowers a candidate's score when two products contradict each other. */
export type IdentityGate =
  | 'primarySpecMismatch'
  | 'modelNumberMismatch'
  | 'matcherSpecMismatch';

/** A spec value, or a name key's digit-bearing words for `modelNumberMismatch`. */
export type IdentityGateValue = string | number | boolean | string[];

/** Which recall arm found a candidate: its product name key or one of its aliases. */
export type CandidateMatchedOn = 'name' | 'alias';

/** How a pair was first found; set on insert and never changed. */
export type DuplicateDetectedBy = 'scrape' | 'scan' | 'merge';

/** Both name similarities, in [0, 1]: pg_trgm `similarity()` and 1 − edits / longer key length. */
export interface NameSimilarity {
  trigram: number;
  levenshtein: number;
}

/** A failed gate, with each product's value placed on the pair's A and B. */
export interface DuplicatePairFailedGate {
  gate: IdentityGate;
  /** The spec key, for spec gates. */
  spec?: string;
  severity: number;
  productAValue: IdentityGateValue;
  productBValue: IdentityGateValue;
}

/** The columns a detection writes; `productAId` must sort below `productBId`. */
export interface DuplicatePairRow {
  productAId: string;
  productBId: string;
  similarityScore: number;
  matchedOn: CandidateMatchedOn;
  matchedValue: string;
  failedGates: DuplicatePairFailedGate[];
  nameSimilarity: NameSimilarity | null;
  detectedBy: DuplicateDetectedBy;
}
