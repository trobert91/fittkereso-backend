import type {
  CandidateMatchedOn,
  ListingMatchFailedGate,
  NameSimilarity,
  ProductSpecs,
} from '@fittkereso-backend/database';

/**
 * The product we're looking for matches of, reduced to what matching uses —
 * built from a listing or a stored product by ProductMatchQueryService.
 */
export interface ProductMatchQuery {
  /** Set for a stored product, so it never matches itself. */
  productId?: string;
  brandId: string;
  /** Re-keys aliases the way `nameKey` was built. */
  brandName: string;
  categoryId: string;
  categorySlug: string;
  /** Drives trigram recall and Levenshtein. */
  nameKey: string;
  specs?: ProductSpecs;
  /**
   * The matcherModel keys to compare: a listing's own (none or one), or a
   * stored product's listings' (any number). Left unset for a stored product,
   * the finder loads them.
   */
  matcherModelKeys?: string[];
}

/**
 * A contradiction between the query and a candidate, with both values. Same
 * shape a decision stores, so a candidate's gates go straight into one.
 */
export type FailedGate = ListingMatchFailedGate;

/** A stored product the query could be, scored. */
export interface ProductCandidate {
  productId: string;
  displayName: string;
  createdAt?: Date;
  /** 1–100: the name score minus every failed gate's severity. */
  score: number;
  matchedOn: CandidateMatchedOn;
  /** The stored name key or the raw alias recall matched on. */
  matchedValue: string;
  nameSimilarity: NameSimilarity;
  failedGates: FailedGate[];
  specs?: ProductSpecs;
  /**
   * Whether one of the product's listings has one of the query's matcherModel
   * keys. Undefined when either side has none.
   */
  matcherModelMatch?: boolean;
  /** 100 minus the spec gates alone (keyScoreOf): what the key rule attaches on. */
  keyScore: number;
}
