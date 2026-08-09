import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
  ProductModel,
  ProductModelRepository,
  ProductReferenceCandidate,
  Review,
} from "@ebike-backend/database";
import { SchedulerMetricsService } from "@ebike-backend/metrics";
import { ProductRatingUpdaterService } from "@ebike-backend/product";
import { BaseScheduler } from "@ebike-backend/task";
import { nameOf } from "@ebike-backend/utils";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { SCHEDULING_DEFAULTS } from "@ebike-backend/config";
import { isEmpty } from "lodash";

@Injectable()
export class ProductRatingScheduler extends BaseScheduler {
  constructor(
    readonly metricsService: SchedulerMetricsService,
    private readonly productRepo: ProductModelRepository,
    private readonly ratingUpdater: ProductRatingUpdaterService,
    private readonly dynamicConfigService: DynamicConfigService,
  ) {
    super(ProductRatingScheduler.name, metricsService);
  }

  // @Cron(CronExpression.EVERY_30_MINUTES)
  @Cron(CronExpression.EVERY_MINUTE)
  async schedule() {
    await super.schedule(this.scheduleProductRating.bind(this));
  }

  async scheduleProductRating() {
    const batchLimit =
      this.dynamicConfigService.scheduling?.productRating?.batchLimit ??
      SCHEDULING_DEFAULTS.productRating.batchLimit;
    const productsToUpdate = await this.getChangedProducts(batchLimit);
    if (isEmpty(productsToUpdate)) {
      return;
    }

    this.logger.debug(
      `Found ${productsToUpdate.length} products to update ratings.`,
    );

    for (const product of productsToUpdate) {
      try {
        await this.ratingUpdater.updateProductRating(product);
      } catch (error) {
        this.logger.error(
          `Error updating product rating for product ${product.id}`,
          error,
        );
      }
    }

    this.logger.debug(`${productsToUpdate.length} product ratings updated.`);
  }

  private async getChangedProducts(limit: number): Promise<ProductModel[]> {
    return (
      this.productRepo.repo
        .createQueryBuilder("model")
        .leftJoinAndSelect(`model.${nameOf<ProductModel>("rating")}`, "rating")
        .leftJoinAndSelect(
          `model.${nameOf<ProductModel>("productCategory")}`,
          "productCategory",
        )
        .leftJoinAndSelect(`model.${nameOf<ProductModel>("reviews")}`, "review")
        .leftJoinAndSelect(`review.${nameOf<Review>("labels")}`, "reviewLabels")
        // Load each review's linked candidates so the rating updater can weight
        // contributions by the candidate's softmax weight against this product.
        .leftJoinAndSelect(
          `review.${nameOf<Review>("candidates")}`,
          "reviewCandidate",
        )
        .leftJoinAndSelect(
          `reviewCandidate.${nameOf<ProductReferenceCandidate>("model")}`,
          "reviewCandidateModel",
        )
        .where(
          `EXISTS (
          SELECT 1 FROM review r
          WHERE r."modelId" = model.id
          AND (rating.id IS NULL OR r."updatedAt" > rating."updatedAt")
        )`,
        )
        .orderBy(`model.${nameOf<ProductModel>("updatedAt")}`, "ASC")
        .take(limit)
        .getMany()
    );
  }
}
