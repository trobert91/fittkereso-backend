import { Injectable } from '@nestjs/common';
import {
  ProductModel,
  ProductModelRepository,
} from '@fittkereso-backend/database';
import { productSpecsSummary } from '../matching/spec-utils';
import type { ResolutionContext } from '../models/resolution-context';
import type { ResolutionResult } from '../models/resolution-result';
import type { SlimResolvedModel } from '../models/slim-types';
import { ResolutionStatus } from '../models/resolution-status';

/**
 * Final stage. Loads the resolved `ProductModel` entity (when the decision
 * resolved), writes the terminal `status` + `resolvedProduct` snapshot, and
 * returns the `ResolutionResult` for the caller.
 *
 * NOTE: alias auto-creation from the extraction pipeline is intentionally
 * disabled. Auto-aliasing from a confidence-bounded resolution running over
 * noisy comment text can permanently corrupt the catalog — a single bad
 * resolution writes an alias that biases every subsequent search for the same
 * SKU family ("exact alias match → accept" in `QualityGatesService` then
 * short-circuits future scoring, freezing the bad answer in place).
 *
 * Aliases should only come from authoritative sources (catalog scraping,
 * manual review, duplicate-evaluation in the product-collector). The
 * `ProductAliasAutoCreateService` is still available for those use cases.
 *
 * Aliases should only come from authoritative sources (catalog scraping,
 * manual review, duplicate-evaluation in the product-collector). The
 * `shouldCreateAliases` field that previously rode along on `FinalDecision`
 * has been removed — it was never applied (regression-tested) and added prompt
 * weight without payoff.
 */
@Injectable()
export class FinalizeService {
  constructor(
    private readonly productModelRepository: ProductModelRepository,
  ) {}

  async finalize(context: ResolutionContext): Promise<ResolutionResult> {
    const decision = context.decision;
    // Primary pick is `selectedCandidates[0]` by convention (the applier
    // enforces this with an explicit sort). Empty array ⇒ unresolved.
    const primaryPickId = decision?.selectedCandidates?.[0]?.candidateId;
    if (!decision || !primaryPickId || isUnresolved(decision.kind)) {
      context.status = ResolutionStatus.UNRESOLVED;
      return {
        resolvedModel: undefined,
        context,
        confidence: decision?.confidence ?? 0,
      };
    }

    let resolvedModel: ProductModel | null = null;
    try {
      resolvedModel =
        await this.productModelRepository.findByIdForPipeline(primaryPickId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      context.errors.push({
        phase: 'finalize',
        message,
        timestamp: new Date().toISOString(),
      });
    }

    if (!resolvedModel) {
      context.status = ResolutionStatus.UNRESOLVED;
      return {
        resolvedModel: undefined,
        context,
        confidence: decision.confidence,
      };
    }

    context.resolvedProduct = toSlimResolved(resolvedModel);
    context.status = ResolutionStatus.RESOLVED;

    return {
      resolvedModel,
      context,
      confidence: decision.confidence,
    };
  }
}

function isUnresolved(kind: string): boolean {
  return kind === 'llm_unresolved' || kind === 'matcher_reject';
}

function toSlimResolved(model: ProductModel): SlimResolvedModel {
  return {
    id: model.id,
    brand: model.brand?.name,
    model: model.model,
    displayName: model.displayName,
    categoryId: model.productCategory?.id,
    categoryName: model.productCategory?.name,
    specs: productSpecsSummary(model.specs, 8),
  };
}
