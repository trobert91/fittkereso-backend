import type { ProductSpecs } from '../../models/product-spec';
import type {
  ProductResolutionInput,
  ResolutionOptions,
  SlimReference,
} from '../../models/resolution-context';

/** Snapshot of a `product_resolution`-flow row's input/context — everything
 *  needed to understand what the resolution pipeline was asked to resolve and
 *  what it inferred before scoring candidates. */
export interface ProductResolutionInputSnapshot {
  kind: 'product_resolution';
  input: ProductResolutionInput;
  options: ResolutionOptions;
  referenceProduct?: SlimReference;
  effectiveMatchSpecs?: ProductSpecs;
  brand?: { id: string; name: string; similarity: number };
  category?: { id: string; name: string; similarity: number };
  /** Where the call came from (e.g. 'product-scrape-updater', 'resolution-test-controller') — for trace clarity. */
  callerSource?: string;
}

/** Snapshot of a `duplicate_detection`-flow row's input — the two products'
 *  identifying fields as they were compared, plus the pg_trgm pre-filter score
 *  that surfaced the pair in the first place. */
export interface ProductDuplicateDetectionInputSnapshot {
  kind: 'duplicate_detection';
  query: {
    model: string;
    displayName?: string;
    aliases: string[];
    specs?: ProductSpecs;
  };
  candidate: {
    model: string;
    displayName?: string;
    aliases: string[];
    specs?: ProductSpecs;
  };
  brandName?: string;
  categorySlug?: string;
  /** The pg_trgm pre-filter score, distinct from the persisted `similarityScore`
   *  (the in-process score computed by `ProductSimilarityService`). */
  trigramScore: number;
}
