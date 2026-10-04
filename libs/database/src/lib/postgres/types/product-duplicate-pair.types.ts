/**
 * Shapes stored on ProductDuplicatePair rows. `libs/product-identity` computes
 * them; they live here because entities can only depend on this lib.
 */

/**
 * A check that lowers a candidate's score when two products contradict each
 * other — or, for `specMissing`, when only one of them states a spec the
 * category's `matchingConfig.missingSpecPenalty` names.
 */
export type IdentityGate =
  | 'primarySpecMismatch'
  | 'modelNumberMismatch'
  | 'matcherSpecMismatch'
  | 'specMissing';

/** A spec value, or a model name's digit-bearing words for `modelNumberMismatch`. */
export type IdentityGateValue = string | number | boolean | string[];

/**
 * What connects a pair. `normalizedModel`: a listing of each has the same key;
 * `trigram`: their keys are only alike. The rest are identifiers the two
 * products share, found when a listing was imported: a size its shop
 * declared as a sibling, a GTIN, or an MPN within one brand. `name`, `alias`
 * and `matcherModel` are what pairs found before the normalizedModel carry,
 * until a scan finds them again.
 */
export type CandidateMatchedOn =
  | 'normalizedModel'
  | 'trigram'
  | 'name'
  | 'alias'
  | 'matcherModel'
  | 'sibling'
  | 'gtin'
  | 'mpn';

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
  /** Null on the side a `specMissing` gate found without the spec. */
  productAValue: IdentityGateValue | null;
  productBValue: IdentityGateValue | null;
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
  /**
   * Whether a listing of each has the same normalizedModel; null when either
   * has none, or for an identifier pair, which compares no names.
   */
  normalizedModelMatch: boolean | null;
  detectedBy: DuplicateDetectedBy;
}
