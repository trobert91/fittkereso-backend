import type { ProductSpecs } from "@ebike-backend/database";

/** Why a particular SERP query was fired. The decision LLM uses this to reason
 *  about evidence — e.g. a `cross_market` record whose SKUs resolve to one of
 *  the candidates likely identifies a regional rename. */
export type WebQueryIntent =
  | "exact_model"
  | "model_with_specs"
  | "reference_sibling_sku"
  | "cross_market";

/**
 * Per-SERP-record evidence assembled by `WebRecall`.
 *
 * Each record carries the raw SERP text, the model-numbers the SKU-extraction
 * LLM identified in its title/description/url, and the catalog products those
 * model-numbers resolved to (primary specs only, for prompt brevity).
 */
export interface SearchEvidence {
  title: string;
  description: string;
  url: string;
  provider: "dataforseo" | "exa";
  queryIntent: WebQueryIntent;
  /** Model numbers found in this record and validated by the extraction LLM as
   *  real SKUs. Empty until the SKU-extraction stage runs. */
  modelNumbers: string[];
  /** Catalog products the per-record model-numbers resolved to. Primary specs only. */
  resolvedProducts: Array<{
    brand: string;
    model: string;
    productId: string;
    specs: ProductSpecs;
  }>;
}

/** One SERP fetch's metadata — for the persisted `webResearch.queries` array. */
export interface WebQueryRecord {
  intent: WebQueryIntent;
  keyword: string;
  provider: "dataforseo" | "exa";
  cacheHit: boolean;
  serpResultCount: number;
}
