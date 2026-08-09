import { Injectable } from "@nestjs/common";
import { ExtractedProduct, ProductCategory } from "@ebike-backend/database";
import { CategoryConfigService } from "@ebike-backend/config";
import { compact, isEmpty } from "lodash";
import { RelevanceCalculatorService } from "../relevance-calculator.service";

@Injectable()
export class ProductMentionRelevanceService {
  constructor(
    private readonly relevanceCalculatorService: RelevanceCalculatorService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  /**
   * Score a product reference (1–100) using comprehensive relevance scoring.
   * Considers quotes, review intent, brand mentions, and content quality.
   */
  public async calculateRelevance(
    extracted: ExtractedProduct,
    category: ProductCategory | undefined,
  ): Promise<number> {
    if (isEmpty(extracted?.quotes)) return 1;

    // Extract content from quotes for relevance calculation
    const contents = compact((extracted.quotes ?? []).map((q) => q.text));

    // Use the new RelevanceCalculatorService with full buyer-focused scoring
    const result = await this.relevanceCalculatorService.calculateRelevance(
      contents,
      {
        maxScore: 100,
        useBrands: true,
        // add category-specific relevance terms if available
        additionalTerms: category?.slug
          ? this.categoryConfigService.getConfig(category.slug)?.relevanceTerms
          : undefined,
      },
    );

    return result.score;
  }
}
