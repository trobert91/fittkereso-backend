import type {
  ProductCategory,
  ProductResolutionInput,
  StructuredSpec,
} from "@ebike-backend/database";
import type { ResolutionResult } from "@ebike-backend/resolution";
import type { LLMDiscoveredProduct } from "../schemas/product-discovery.schema";

/**
 * One distinct product surfaced by the `product_discovery` LLM step, after the
 * raw schema output has been normalised (specs whitelisted, brand/model
 * trimmed). Product-centric — not yet mapped to comments. The discovery sweep
 * pools evidence across every mention of the same product, so each entry stands
 * for "the N mentions of this exact product in this subtree".
 */
export type DiscoveredProduct = LLMDiscoveredProduct;

/**
 * A {@link DiscoveredProduct} after enrichment: assigned a stable in-batch key,
 * a `productLinkId` (minted per distinct product, inherited from the registry
 * when the product was already seen in an earlier subtree), the matched product
 * category, and a ready-to-resolve {@link ProductResolutionInput} built from the
 * pooled evidence. This is what the distinct-product resolver consumes.
 */
export interface EnrichedDiscoveredProduct {
  /** The normalised discovery output this was built from. */
  discovered: DiscoveredProduct;
  /**
   * Stable key for this distinct product within the batch — used as the map key
   * the comment-identification step references when attaching comments. Derived
   * from the discovery `linkLabel` (every mention shares the label → shares the
   * key).
   */
  distinctKey: string;
  /** Same-product group UUID. Minted per distinct product; inherited from the
   *  registry entry when this product was already resolved in an earlier
   *  subtree, carrying the group across batches. */
  productLinkId: string;
  /** Fuzzy registry key (`${brand}::${model}` family) for registry-hit lookup. */
  registryKey: string;
  /** Category matched from `categoryHint` — enabled match preferred, else any
   *  catalog category (deferred). Undefined when no category could be matched. */
  productCategory?: ProductCategory;
  /** Specs after the valid-spec-name whitelist filter. */
  filteredSpecs: StructuredSpec[];
  /** Resolution input assembled from the pooled discovery evidence. */
  resolutionInput: ProductResolutionInput;
}

/**
 * The full resolution outcome for one distinct product, held in memory between
 * the `product_resolution` step and per-comment reference creation. Carries the
 * complete {@link ResolutionResult} (`resolvedModel`, `context`, `confidence`)
 * — never flattened to the primary candidate — so seeding a reference can route
 * it through the same `ResolutionResultApplierService.apply()` the normal path
 * uses and reproduce the full multi-candidate set + ambiguity.
 *
 * `resolved` is `false` (and `result` is `null`) for deferred products whose
 * category is disabled — the reference is still created and registered, and the
 * scheduled Resolution Backfill resolves it later.
 */
export interface HeldResolution {
  result: ResolutionResult | null;
  resolved: boolean;
}
