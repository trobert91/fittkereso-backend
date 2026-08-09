import { Injectable } from "@nestjs/common";
import {
  EvaluatedProduct,
  MatchResult,
  ProductSpecs,
} from "@ebike-backend/database";
import {
  ProductSimilarityService,
  ProductSimilarityInput,
  SimilarityTraceContext,
} from "@ebike-backend/product";
import { isEmpty } from "lodash";

export interface CandidateScoringInput {
  model?: string;
  displayName?: string;
  brand?: string;
  releaseYear?: number;
}

/**
 * Thin adapter over `ProductSimilarityService` from `@ebike-backend/product`.
 *
 * Takes the search lib's per-candidate inputs and yields `MatchResult[]` — the
 * shape the quality gates consume. Skips zero-score, empty-name results so the
 * gate never sees obvious non-matches.
 */
@Injectable()
export class CandidateScoringService {
  constructor(private readonly productSimilarity: ProductSimilarityService) {}

  scoreAllCandidates(
    input: CandidateScoringInput,
    candidates: EvaluatedProduct[],
    inputSpecs: ProductSpecs,
    categorySlug?: string,
    traceContext?: SimilarityTraceContext,
  ): MatchResult[] {
    const matches: MatchResult[] = [];

    for (const candidate of candidates) {
      if (!candidate.model && !candidate.displayName) continue;

      const similarityInput: ProductSimilarityInput = {
        query: {
          model: input.model ?? "",
          displayName: input.displayName,
          specs: isEmpty(inputSpecs) ? undefined : inputSpecs,
          year: input.releaseYear,
        },
        candidate: {
          model: candidate.model ?? "",
          displayName: candidate.displayName,
          aliases: candidate.aliases,
          specs: candidate.specs,
          releaseYear: candidate.releaseYear,
        },
        brandName: input.brand,
        categorySlug,
        traceContext: traceContext
          ? { ...traceContext, productId: candidate.id }
          : undefined,
      };

      const result = this.productSimilarity.score(similarityInput);

      if (result.score === 0 && result.bestMatchName === "") continue;

      matches.push({
        candidateId: candidate.id,
        alias: result.bestMatchName,
        score: result.score,
        components: {
          stringSimilarity: result.components.stringSimilarity,
          tokenOverlap: result.components.tokenOverlap,
          alphaMatch: result.components.alphaMatch,
          aliasMatch: result.components.aliasMatch,
          specSimilarity: result.components.specSimilarity,
        },
        specMatchDetails: result.specMatchDetails,
      });
    }

    return matches;
  }
}
