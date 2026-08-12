import { Injectable } from '@nestjs/common';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import {
  ProductFuzzySearchService,
  type CandidateSearchInput,
} from '@fittkereso-backend/product';
import type {
  ProductModel,
  WithSimilarity,
} from '@fittkereso-backend/database';
import type { RecallStrategy } from '../../models/strategy-types';
import type { ResolutionContext } from '../../models/resolution-context';
import type { SlimCandidate } from '../../models/slim-types';
import {
  MAX_MODEL_VARIANTS_DEFAULT,
  dedupeBySimilarity,
  fuzzyHitToSlim,
  getBaseModelVariants,
  recordVariants,
} from './recall-shared';

/**
 * Recall via Postgres trigram + alias fuzzy search.
 *
 * Generates model-variant seeds (original, suffix-strip, normalization,
 * brand-strip, reference-model, modelClues), fans out one fuzzy search per
 * variant, dedupes by productId keeping the highest similarity, and converts
 * to `SlimCandidate[]`.
 *
 * Scoped by `ctx.category.id` when set; otherwise unfiltered.
 *
 * Single-shot: fires on the first recall iteration only. The orchestrator's
 * fixed-point loop re-invokes `RecallService.recall()` after filter+score; the
 * `strategiesRun.includes('fuzzy')` guard prevents fuzzy from re-firing on the
 * rescue iteration.
 */
@Injectable()
export class FuzzyRecallStrategy implements RecallStrategy {
  readonly name = 'fuzzy' as const;

  constructor(
    private readonly fuzzySearch: ProductFuzzySearchService,
    private readonly dynamicConfig: DynamicConfigService,
  ) {}

  shouldRun(context: ResolutionContext): boolean {
    return !context.strategiesRun.includes('fuzzy');
  }

  async recall(context: ResolutionContext): Promise<SlimCandidate[]> {
    const maxModelVariants =
      this.dynamicConfig.search?.maxModelVariants ?? MAX_MODEL_VARIANTS_DEFAULT;
    const baseVariants = getBaseModelVariants(context, maxModelVariants);

    // Fuzzy seeds an extra reference_model variant; append to a copy so the
    // memoized base array (shared with embedding) is not mutated.
    const variants = [...baseVariants];
    const referenceEntityModel = context.referenceProduct?.model?.trim();
    if (
      referenceEntityModel &&
      variants.length < maxModelVariants &&
      !variants.some((v) => v.model === referenceEntityModel)
    ) {
      variants.push({ model: referenceEntityModel, source: 'reference_model' });
    }

    if (variants.length === 0) return [];

    recordVariants(context, variants);

    const categoryIds = context.category ? [context.category.id] : undefined;

    const variantResults = await Promise.allSettled(
      variants.map((variant) => {
        const searchInput: CandidateSearchInput = {
          input: { ...context.input, model: variant.model },
          brand: context.brand
            ? {
                id: context.brand.id,
                name: context.brand.name,
                similarity: context.brand.similarity,
              }
            : undefined,
        };
        return this.fuzzySearch.search(searchInput, categoryIds);
      }),
    );

    const hits: WithSimilarity<ProductModel>[] = [];
    for (const result of variantResults) {
      if (result.status === 'rejected') {
        const message =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        context.errors.push({
          phase: 'recall',
          message,
          detail: 'fuzzy',
          timestamp: new Date().toISOString(),
        });
        continue;
      }
      hits.push(...result.value);
    }

    return dedupeBySimilarity(
      hits,
      (hit) => hit.entity.id,
      (hit) => hit.similarity ?? 0,
      fuzzyHitToSlim,
    );
  }
}
