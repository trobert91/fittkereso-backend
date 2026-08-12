import { Injectable } from '@nestjs/common';
import type {
  EvaluatedProduct,
  ProductCategory,
} from '@fittkereso-backend/database';
import { CandidateScoringService } from '../matching/candidate-scoring.service';
import { InputNormalizationService } from '../matching/input-normalization.service';
import { QualityGatesService } from '../matching/quality-gates.service';
import { getInputSpecsMap } from '../matching/spec-utils';
import type { ResolutionContext } from '../models/resolution-context';
import type { SlimCandidate } from '../models/slim-types';

/**
 * Scoring stage. For each filtered candidate, runs the matcher
 * (`CandidateScoringService`), picks the best/runner-up by score, and applies
 * the quality-gate ladder (`QualityGatesService.evaluate` or `evaluateAnchored`
 * when a reference product is set).
 *
 * Writes onto the context:
 *  - per-candidate `matchScore` + `matchComponents` (mutates `SlimCandidate[]`)
 *  - aggregate `scoring` snapshot (best, runner-up, failed gates, normalized input)
 *
 * The decision stage reads `ctx.scoring.failedGates` to decide whether the
 * matcher's pick can short-circuit the LLM (`failedGates.length === 0` → accept).
 */
@Injectable()
export class ScoringService {
  constructor(
    private readonly candidateScoring: CandidateScoringService,
    private readonly qualityGates: QualityGatesService,
    private readonly inputNormalization: InputNormalizationService,
  ) {}

  score(context: ResolutionContext): void {
    if (context.candidates.length === 0) {
      context.scoring = { failedGates: [] };
      return;
    }

    const slimById = new Map<string, SlimCandidate>(
      context.candidates.map((candidate) => [candidate.productId, candidate]),
    );

    const evaluatedCandidates = context.candidates.map((candidate) =>
      slimToEvaluated(candidate),
    );
    const inputSpecsMap = getInputSpecsMap(context);

    const categorySlug = this.resolveCategorySlug(context);
    const matches = this.candidateScoring.scoreAllCandidates(
      {
        model: this.resolveMatcherQueryModel(context),
        displayName: context.input.displayName,
        brand: context.brand?.name ?? context.input.brand,
        releaseYear: context.input.releaseYear,
      },
      evaluatedCandidates,
      inputSpecsMap,
      categorySlug,
    );

    // Annotate slim candidates with matcher score + components.
    for (const match of matches) {
      const slim = slimById.get(match.candidateId);
      if (!slim) continue;
      slim.matchScore = match.score;
      slim.matchComponents = {
        stringSimilarity: match.components.stringSimilarity,
        tokenOverlap: match.components.tokenOverlap,
        alphaMatch: match.components.alphaMatch,
        aliasMatch: match.components.aliasMatch,
        specSimilarity: match.components.specSimilarity,
      };
    }

    // Re-sort the persisted candidate list by matcher score (descending) so
    // downstream consumers (decision LLM, traces) see the best first.
    context.candidates = [...context.candidates].sort(
      (a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0),
    );

    const sortedMatches = [...matches].sort((a, b) => b.score - a.score);
    // Stash full match list for the decision stage's multi-candidate filter.
    // Transient — not persisted on searchContext.
    context.scoringMatches = sortedMatches;
    const best = sortedMatches[0];
    const second = sortedMatches[1];
    if (!best) {
      context.scoring = { failedGates: [] };
      return;
    }

    const matchConfig = this.inputNormalization.getCategoryConfig(
      this.resolveCategoryForConfig(context),
    );
    const inputParsed = this.inputNormalization.parseModelCode(
      this.inputNormalization.normalizeForMatching(context.input, matchConfig),
      matchConfig,
    );
    // Carry forward so the decision stage can call filterAcceptable without
    // re-deriving these. Transient.
    context.scoringInputParsed = inputParsed;
    context.scoringMatchConfig = matchConfig;

    const gateResult = context.referenceProduct
      ? this.qualityGates.evaluateAnchored(
          best,
          second,
          inputParsed,
          context.options,
          matchConfig,
        )
      : this.qualityGates.evaluate(
          best,
          second,
          inputParsed,
          context.options,
          matchConfig,
        );

    context.scoring = {
      bestCandidate: {
        candidateId: best.candidateId,
        alias: best.alias,
        score: best.score,
      },
      secondCandidate: second
        ? {
            candidateId: second.candidateId,
            alias: second.alias,
            score: second.score,
          }
        : undefined,
      secondScore: second?.score,
      failedGates: gateResult.failedGates,
      normalizedInput: inputParsed.raw,
    };
  }

  /**
   * Resolve the model string the matcher uses as its query. Prefers the
   * comment's own `input.model`. When the comment named no model of its own
   * (e.g. "I have the 39\""), falls back to reference-product clues so the
   * matcher has something to score candidates against:
   *
   *   1. `input.model`           — what the comment said
   *   2. `input.referenceModel`  — the cheat-sheet token
   *   3. `referenceProduct.model` — the resolved reference entity
   *   4. `input.displayName`     — last-resort label
   *
   * Without this fallback, sibling-SKU searches return one filtered candidate
   * but `ProductSimilarityService.score` produces score=0, no `bestCandidate`
   * lands on `ctx.scoring`, `matcher_accept` can't fire, and we waste an LLM
   * call on what should be a deterministic resolution.
   */
  private resolveMatcherQueryModel(
    context: ResolutionContext,
  ): string | undefined {
    const direct = context.input.model?.trim();
    if (direct) return direct;
    const reference = context.input.referenceModel?.trim();
    if (reference) return reference;
    const referenceEntityModel = context.referenceProduct?.model?.trim();
    if (referenceEntityModel) return referenceEntityModel;
    return context.input.displayName?.trim() || undefined;
  }

  private resolveCategorySlug(context: ResolutionContext): string | undefined {
    const referenceSlug = context.referenceProduct?.productCategory?.slug;
    if (referenceSlug) return referenceSlug;
    for (const candidate of context.candidates) {
      const slug = candidate.productCategory?.slug;
      if (slug) return slug;
    }
    return undefined;
  }

  private resolveCategoryForConfig(
    context: ResolutionContext,
  ): { id: string; slug?: string } | undefined {
    const reference = context.referenceProduct?.productCategory;
    if (reference) {
      return { id: reference.id, slug: reference.slug };
    }
    const ctxCategory = context.category;
    if (ctxCategory) {
      // We don't have the slug on ctx.category — fall back to any candidate's
      // category that matches by id.
      const slug = context.candidates.find(
        (candidate) => candidate.productCategory?.id === ctxCategory.id,
      )?.productCategory?.slug;
      return { id: ctxCategory.id, slug };
    }
    return undefined;
  }
}

function slimToEvaluated(candidate: SlimCandidate): EvaluatedProduct {
  return {
    id: candidate.productId,
    model: candidate.model,
    displayName: candidate.displayName,
    brand: candidate.brand,
    specs: candidate.specs,
    category: candidate.productCategory
      ? ({
          id: candidate.productCategory.id,
          name: candidate.productCategory.name,
          slug: candidate.productCategory.slug,
        } as ProductCategory)
      : undefined,
    aliases: candidate.aliases ?? [],
    source: candidate.source,
  };
}
