import { Injectable } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import {
  ProductSource,
  ScrapeQueueName,
  ScrapeTask,
  ScrapeTaskRepository,
  TaskStatus,
} from "@ebike-backend/database";
import { ProductCollectionMetricsService } from "@ebike-backend/metrics";
import { CustomLogger } from "@ebike-backend/logger";
import { nameOf } from "@ebike-backend/utils";

@Injectable()
export class ScrapeTaskQueueDepthService {
  private readonly logger = new CustomLogger(ScrapeTaskQueueDepthService.name);

  constructor(
    private readonly scrapeTaskRepository: ScrapeTaskRepository,
    private readonly productCollectionMetrics: ProductCollectionMetricsService,
  ) {}

  @Interval(30000)
  async recordQueueDepth(): Promise<void> {
    try {
      const queueColumn = `task.${nameOf<ScrapeTask>("queue")}`;
      const statusColumn = `task.${nameOf<ScrapeTask>("status")}`;
      const sourceTypeColumn = `source.${nameOf<ProductSource>("type")}`;
      const counts = await this.scrapeTaskRepository.repo
        .createQueryBuilder("task")
        .select(queueColumn, "queue")
        .addSelect(sourceTypeColumn, "source_type")
        .addSelect(statusColumn, "status")
        .addSelect("COUNT(*)::int", "count")
        .innerJoin(`task.${nameOf<ScrapeTask>("source")}`, "source")
        .where(`${statusColumn} IN (:...statuses)`, {
          statuses: [
            TaskStatus.PENDING,
            TaskStatus.PROCESSING,
            TaskStatus.FAILED,
          ],
        })
        .groupBy(queueColumn)
        .addGroupBy(sourceTypeColumn)
        .addGroupBy(statusColumn)
        .getRawMany<{
          queue: ScrapeQueueName;
          source_type: string;
          status: string;
          count: number;
        }>();

      this.productCollectionMetrics.resetQueueDepth();

      for (const row of counts) {
        this.productCollectionMetrics.setQueueDepth(
          row.queue,
          row.source_type,
          row.status,
          row.count,
        );
      }
    } catch (error: unknown) {
      this.logger.warn("Failed to record queue depth metrics", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
