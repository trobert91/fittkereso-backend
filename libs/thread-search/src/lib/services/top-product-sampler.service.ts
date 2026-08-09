import { Injectable } from "@nestjs/common";
import { ProductModelRepository } from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";

/**
 * Returns a randomized sample of top-rated product names for a category.
 *
 * Strategy: pull the top `3 * count` products that have at least one review,
 * then shuffle and slice to `count`. The over-fetch keeps the LLM from
 * always seeing the same top-N products across runs.
 *
 * Ordering falls back through `rating → averageReviewScore → totalReviewCount`
 * so the sampler still returns something useful on catalogs where the
 * Bayesian `rating` hasn't been computed yet (e.g. fresh categories before
 * `ProductRatingScheduler` has caught up).
 */
@Injectable()
export class TopProductSamplerService {
  private readonly logger = new CustomLogger(TopProductSamplerService.name);

  constructor(
    private readonly productModelRepository: ProductModelRepository,
  ) {}

  async sample(categoryId: string, count: number): Promise<string[]> {
    if (count <= 0) return [];

    const poolSize = count * 3;

    const products = await this.productModelRepository.repo
      .createQueryBuilder("product")
      .innerJoin("product.rating", "rating")
      .where('product."productCategoryId" = :categoryId', { categoryId })
      .andWhere('rating."totalReviewCount" > 0')
      .orderBy("rating.rating", "DESC", "NULLS LAST")
      .addOrderBy('rating."averageReviewScore"', "DESC", "NULLS LAST")
      .addOrderBy('rating."totalReviewCount"', "DESC")
      .limit(poolSize)
      .getMany();

    const names = products.map((product) => product.displayName);
    const shuffled = this.shuffle(names);
    const sampled = shuffled.slice(0, count);

    this.logger.debug("Sampled products", {
      categoryId,
      requested: count,
      available: names.length,
      returned: sampled.length,
    });

    return sampled;
  }

  private shuffle<T>(items: T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
}
