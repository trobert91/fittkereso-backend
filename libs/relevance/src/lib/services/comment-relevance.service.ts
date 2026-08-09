import { Injectable } from "@nestjs/common";
import { ProductCategory } from "@ebike-backend/database";
import { CategoryConfigService } from "@ebike-backend/config";
import { isEmpty } from "lodash";
import {
  RelevanceCalculatorService,
  RelevanceResult,
} from "../relevance-calculator.service";

@Injectable()
export class CommentRelevanceService {
  constructor(
    private readonly relevanceCalculatorService: RelevanceCalculatorService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  /**
   * Overall comment relevance (1–100) using comprehensive relevance scoring.
   * Returns the full RelevanceResult with score and component breakdown.
   */
  public async calculateRelevance(
    text: string,
    category: ProductCategory | undefined,
  ): Promise<RelevanceResult> {
    if (isEmpty(text?.trim())) {
      return {
        score: 1,
        components: {
          fuzzyScore: 0,
          diversity: 0,
          reviewIntentMultiplier: 1,
          penaltyMultiplier: 1,
          deliberationMultiplier: 1,
          depthMultiplier: 1,
          disclaimerPenalty: 1,
          ownershipMultiplier: 1,
          comparisonMultiplier: 1,
          brandBoost: 0,
          productTermContribution: 0,
          topTerms: [],
        },
      };
    }

    const sentences = this.splitIntoSentences(text);

    return this.relevanceCalculatorService.calculateRelevance(sentences, {
      maxScore: 100,
      useBrands: true,
      additionalTerms: category?.slug
        ? this.categoryConfigService.getConfig(category.slug)?.relevanceTerms
        : undefined,
    });
  }

  /**
   * Split text into sentences for more precise fuzzy matching.
   * fast-fuzzy produces much better similarity scores when matching
   * keywords against focused 10-30 word sentences vs. 500+ word bodies.
   */
  private splitIntoSentences(text: string): string[] {
    return text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 10);
  }
}
