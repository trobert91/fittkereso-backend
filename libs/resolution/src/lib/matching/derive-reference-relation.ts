import type { ProductModel } from '@fittkereso-backend/database';
import type { SpecComparisonService } from '@fittkereso-backend/product';
import type { ProductResolutionInput } from '../models/resolution-input';
import type { CategoryMatchConfig } from './input-normalization.service';
import { structuredSpecsToProductSpecs } from './spec-utils';

/**
 * Same vs variant vs none classification for a reference-product-driven search.
 *
 * - `'same'`: input names the same product as the reference. The orchestrator
 *   short-circuits with `confidence=100` and returns the reference entity
 *   directly — no search needed.
 * - `'variant'`: input names a sibling of the reference (different SKU within
 *   the same product family). The search continues with reference-seeded
 *   variants.
 * - `'none'`: `input.referenceProductId` was unset; the lib runs a normal
 *   unanchored search.
 *
 * Classifies `'same'` when:
 *   - referenceProductId is set
 *   - modelClues and variantClues are both empty
 *   - every input spec is consistent with the reference's catalog specs (no
 *     primary or matcher-spec mismatches under the category's hierarchies)
 *
 * Returns `'variant'` when the referenceProductId is set but any of the above
 * fails. Returns `'none'` when the referenceProductId is unset.
 *
 * Byte-identical port of `deriveAnchorRelation` from
 * `libs/thread-processor/.../resolution-input-enricher.service.ts`.
 */
export type ReferenceRelation = 'same' | 'variant' | 'none';

export function deriveReferenceRelation(
  input: ProductResolutionInput,
  referenceProduct: ProductModel,
  matchConfig: CategoryMatchConfig,
  specComparison: SpecComparisonService,
): ReferenceRelation {
  if (!input.referenceProductId) return 'none';

  const noModelClues = (input.modelClues ?? []).length === 0;
  const noVariantClues = (input.variantClues ?? []).length === 0;

  const result = specComparison.compareSpecs({
    specsA: structuredSpecsToProductSpecs(input.specs ?? []),
    specsB: referenceProduct.specs ?? undefined,
    primarySpecs: matchConfig.primarySpecs,
    matcherSpecs: matchConfig.matcherSpecs,
    matcherSpecHierarchies: matchConfig.matcherSpecHierarchies,
  });

  const specsConsistent =
    result.primaryMismatches === 0 && result.matcherSpecMismatches === 0;

  return noModelClues && noVariantClues && specsConsistent ? 'same' : 'variant';
}
