import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
  ProductModel,
  ProductModelRepository,
  QueueName,
  Review,
  Task,
  TaskStatus,
} from "@ebike-backend/database";
import { SchedulerMetricsService } from "@ebike-backend/metrics";
import { BaseScheduler, QueuePublisherService } from "@ebike-backend/task";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { SCHEDULING_DEFAULTS } from "@ebike-backend/config";
import { isEmpty } from "lodash";

interface ResolvedConfig {
  batchLimit: number;
  minimumTotalReviews: number;
  minimumNewReviewsToTrigger: number;
}

@Injectable()
export class ProductReviewAnalysisScheduler extends BaseScheduler {
  constructor(
    readonly metricsService: SchedulerMetricsService,
    private readonly productRepo: ProductModelRepository,
    private readonly queuePublisher: QueuePublisherService,
    private readonly dynamicConfigService: DynamicConfigService,
  ) {
    super(ProductReviewAnalysisScheduler.name, metricsService);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async schedule(): Promise<void> {
    await super.schedule(this.scheduleProductReviewAnalysis.bind(this));
  }

  async scheduleProductReviewAnalysis(): Promise<void> {
    const config = this.getConfig();
    const eligible = await this.findEligibleProducts(config);
    if (isEmpty(eligible)) {
      return;
    }

    this.logger.debug(
      `Enqueuing ${eligible.length} products for review analysis ` +
        `(minTotal=${config.minimumTotalReviews}, minNew=${config.minimumNewReviewsToTrigger}).`,
    );

    for (const product of eligible) {
      try {
        await this.queuePublisher.addProductReviewAnalysisTask({
          productId: product.id,
        });
      } catch (error) {
        this.logger.error(
          `Error enqueuing product review analysis task for ${product.id}`,
          error,
        );
      }
    }
  }

  private async findEligibleProducts(
    config: ResolvedConfig,
  ): Promise<ProductModel[]> {
    return this.productRepo.repo
      .createQueryBuilder("p")
      .innerJoin("p.rating", "r")
      .where('r."totalReviewCount" >= :minTotal', {
        minTotal: config.minimumTotalReviews,
      })
      .andWhere(
        (qb) => {
          const sub = qb
            .subQuery()
            .select("COUNT(*)")
            .from(Review, "rv")
            .where('rv."modelId" = p.id')
            .andWhere("rv.enabled = true")
            .andWhere(
              '(r."lastSummaryGeneratedAt" IS NULL OR rv."updatedAt" > r."lastSummaryGeneratedAt")',
            )
            .getQuery();
          return `(${sub}) >= :minNew`;
        },
        { minNew: config.minimumNewReviewsToTrigger },
      )
      .andWhere((qb) => {
        const sub = qb
          .subQuery()
          .select("1")
          .from(Task, "t")
          .where("t.queue = :queue", {
            queue: QueueName.ProductReviewAnalysis,
          })
          .andWhere("t.status IN (:...activeStatuses)", {
            activeStatuses: [TaskStatus.PENDING, TaskStatus.PROCESSING],
          })
          .andWhere(`t.payload->>'productId' = p.id::text`)
          .getQuery();
        return `NOT EXISTS (${sub})`;
      })
      .orderBy('r."lastSummaryGeneratedAt"', "ASC", "NULLS FIRST")
      .limit(config.batchLimit)
      .getMany();
  }

  private getConfig(): ResolvedConfig {
    const dynamic = this.dynamicConfigService.scheduling?.productReviewAnalysis;
    const defaults = (
      SCHEDULING_DEFAULTS as typeof SCHEDULING_DEFAULTS & {
        productReviewAnalysis: {
          batchLimit: number;
          minimumTotalReviews: number;
          minimumNewReviewsToTrigger: number;
        };
      }
    ).productReviewAnalysis;
    return {
      batchLimit: dynamic?.batchLimit ?? defaults.batchLimit,
      minimumTotalReviews:
        dynamic?.minimumTotalReviews ?? defaults.minimumTotalReviews,
      minimumNewReviewsToTrigger:
        dynamic?.minimumNewReviewsToTrigger ??
        defaults.minimumNewReviewsToTrigger,
    };
  }
}
