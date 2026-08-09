import type { ProductSpecs } from "@ebike-backend/database";

/** Slim snapshot of the reference product (the catalog row identified by
 *  `input.referenceProductId`). Source of inherited primary specs for
 *  `effectiveMatchSpecs`. Persisted alongside the rest of the context. */
export interface SlimReference {
  productId: string;
  brand?: string;
  model?: string;
  productCategory?: { id: string; name: string; slug?: string };
  /** Reference's specs restricted to the category's primarySpecs. */
  specs: ProductSpecs;
}

/** Slim resolved-model snapshot for the persisted outcome. */
export interface SlimResolvedModel {
  id: string;
  brand?: string;
  model?: string;
  displayName?: string;
  categoryId?: string;
  categoryName?: string;
  /** Primary-spec-ordered list of human-readable spec strings. */
  specs: string[];
}

/** Matcher score breakdown attached to a candidate after scoring. */
export interface MatchResultComponents {
  stringSimilarity: number;
  tokenOverlap: number;
  alphaMatch: number;
  aliasMatch: boolean;
  specSimilarity: number;
}

/** A candidate snapshot — productId + the primary specs the gates care about,
 *  plus source/match metadata. Used both during recall and on the persisted
 *  context. */
export interface SlimCandidate {
  productId: string;
  brand?: string;
  brandId?: string;
  model?: string;
  displayName?: string;
  productCategory?: { id: string; name: string; slug?: string };
  /** Primary specs only — same set the filter and decision prompt compare against. */
  specs?: ProductSpecs;
  /** Alias strings on the catalog row. The matcher scores against these too —
   *  an exact alias hit beats a partial model-string match (e.g. input
   *  "34GS95QE-B" matches alias "34gs95qe-b" exactly while the bare model
   *  "UltraGear 34GS95QE" loses the `-B` suffix). */
  aliases?: string[];
  source: "fuzzy" | "embedding" | "web";
  /** Matcher score on the unified 0–100 scale. Populated after the Scoring stage. */
  matchScore?: number;
  matchComponents?: MatchResultComponents;
}

/** Funnel counts for candidate recall. */
export interface CandidateFunnel {
  fuzzyHits: number;
  embeddingHits: number;
  webHits: number;
  afterDedupe: number;
  /** Candidates left after dropping `input.referenceProductId` (when set). */
  afterReferenceExclusion: number;
}
