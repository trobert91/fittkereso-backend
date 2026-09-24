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

/**
 * What connects a pair. `name` and `alias` are the recall arms that found a
 * candidate by its name key or one of its aliases. The rest are identifiers
 * the two products share, found when a listing was imported: a size its shop
 * declared as a sibling, a GTIN, or an MPN within one brand.
 */
export type CandidateMatchedOn = 'name' | 'alias' | 'sibling' | 'gtin' | 'mpn';

/** How a pair was first found; set on insert and never changed. */
export type DuplicateDetectedBy = 'scrape' | 'scan' | 'merge';

/**
 * Every name similarity of one pair, in [0, 1]: pg_trgm `similarity()`,
 * 1 − edits / longer key length, and the token alignment that tells a
 * substitution from an omission. `baseScore` blends all three.
 *
 * `alignment` is optional only because rows written before the blend existed
 * do not carry it; every fresh score sets it.
 */
export interface NameSimilarity {
  trigram: number;
  levenshtein: number;
  alignment?: number;
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
