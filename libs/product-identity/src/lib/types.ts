import type {
  CandidateMatchedOn,
  ListingMatchFailedGate,
  NameSimilarity,
  OwnOffers,
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
  /** Stripped from keys built here; also names candidates (productDisplayName). */
  brandName: string;
  categoryId: string;
  categorySlug: string;
  /**
   * The normalizedModels the query is searched and scored by: a listing's own
   * (one), or a stored product's listings' (any number). Left unset for a
   * stored product: the finder loads them.
   */
  keys?: string[];
  /**
   * Whether `keys` are model keys, which an equal candidate key may attach
   * on. False when they were built from a title — a listing the extraction
   * did not name, a product none of whose listings was named: they still find
   * and score candidates, and never attach one. Unset with `keys`.
   */
  keyed?: boolean;
  /** The model as written (else the title): what the model-number check reads. */
  model: string;
  specs?: ProductSpecs;
  /** Set for a listing identified again where it sits: its own traces left out. */
  exclusion?: ListingExclusion;
}

/**
 * A listing identified again while it sits on a product: what of it must not
 * vouch for itself. Its own record is no candidate's listing, its product is
 * compared by what its other listings say, and its own offers' identifiers
 * find nothing.
 */
export interface ListingExclusion {
  recordId: string;
  /** The product it sits on, and that product's specs merged without it. */
  productId: string;
  productSpecs: ProductSpecs;
  ownOffers: OwnOffers;
}

/**
 * A contradiction between the query and a candidate, with both values. Same
 * shape a decision stores, so a candidate's gates go straight into one.
 */
export type FailedGate = ListingMatchFailedGate;

/** A stored product the query could be, scored. */
export interface ProductCandidate {
  productId: string;
  /** The product's shown name: its brand, then its model. */
  displayName: string;
  createdAt?: Date;
  /** 1–100: the name score minus every failed gate's severity. */
  score: number;
  /** `normalizedModel` when the candidate's key equals one of the query's model keys, else `trigram`. */
  matchedOn: CandidateMatchedOn;
  /** The candidate listing's normalizedModel recall matched on. */
  matchedValue: string;
  nameSimilarity: NameSimilarity;
  failedGates: FailedGate[];
  specs?: ProductSpecs;
  /**
   * Whether one of the product's listings has one of the query's model keys.
   * Undefined when the query has none (it was keyed on a title).
   */
  normalizedModelMatch?: boolean;
  /** 100 minus the spec gates alone (keyScoreOf): what an equal key attaches on. */
  keyScore: number;
}
