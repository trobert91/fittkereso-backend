import { Injectable } from '@nestjs/common';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { ProductEmbeddingMatchService } from '@fittkereso-backend/product';
import type { EvaluatedProduct } from '@fittkereso-backend/database';
import type { RecallStrategy } from '../../models/strategy-types';
import type { ResolutionContext } from '../../models/resolution-context';
import type { SlimCandidate } from '../../models/slim-types';
import {
  MAX_MODEL_VARIANTS_DEFAULT,
  dedupeBySimilarity,
  embeddingHitToSlim,
  getBaseModelVariants,
  recordVariants,
} from './recall-shared';

/**
 * Recall via pgvector embedding similarity.
 *
 * Single-shot, with two firing conditions covered by one predicate:
 *  - First recall iteration (no `ctx.scoring` yet): act as a fallback when
 *    fuzzy returned nothing — fire iff `ctx.candidates` is empty.
 *  - Later iteration (`ctx.scoring` populated by a prior pass): act as a
 *    rescue when the matcher couldn't accept — fire iff the candidate pool is
 *    empty OR scoring's quality gates rejected the pick.
 *
 * Generates the same variant seeds as `FuzzyRecallStrategy`, fans out one
 * embedding query per variant, dedupes by productId.
 */
@Injectable()
export class EmbeddingRecallStrategy implements RecallStrategy {
  readonly name = 'embedding' as const;

  constructor(
    private readonly embeddingMatch: ProductEmbeddingMatchService,
    private readonly dynamicConfig: DynamicConfigService,
  ) {}

  shouldRun(context: ResolutionContext): boolean {
    if (!context.options.useEmbedding) return false;
    if (context.strategiesRun.includes('embedding')) return false;
    if (!context.scoring) return context.candidates.length === 0;
    if (context.candidates.length === 0) return true;
    return (context.scoring.failedGates?.length ?? 0) > 0;
  }

  async recall(context: ResolutionContext): Promise<SlimCandidate[]> {
    const maxModelVariants =
      this.dynamicConfig.search?.maxModelVariants ?? MAX_MODEL_VARIANTS_DEFAULT;
    const variants = getBaseModelVariants(context, maxModelVariants);
    if (variants.length === 0) return [];

    recordVariants(context, variants);

    const categoryIds = context.category ? [context.category.id] : undefined;
    const brandIds = context.brand ? [context.brand.id] : undefined;

    const variantResults = await Promise.allSettled(
      variants.map((variant) =>
        this.embeddingMatch.findMatches(
          { ...context.input, model: variant.model },
          categoryIds,
          brandIds,
        ),
      ),
    );

    const hits: EvaluatedProduct[] = [];
    for (const result of variantResults) {
      if (result.status === 'rejected') {
        const message =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        context.errors.push({
          phase: 'recall',
          message,
          detail: 'embedding',
          timestamp: new Date().toISOString(),
        });
        continue;
      }
      hits.push(...result.value);
    }

    return dedupeBySimilarity(
      hits,
      (hit) => hit.id,
      (hit) => hit.confidence ?? 0,
      embeddingHitToSlim,
    );
  }
}
