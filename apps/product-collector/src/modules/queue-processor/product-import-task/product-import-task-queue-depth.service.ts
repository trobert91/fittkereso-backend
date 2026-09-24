import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  ProductSource,
  ProductImportTaskKind,
  ProductImportTask,
  ProductImportTaskRepository,
  TaskStatus,
} from '@fittkereso-backend/database';
import { ProductCollectionMetricsService } from '@fittkereso-backend/metrics';
import { CustomLogger } from '@fittkereso-backend/logger';
import { nameOf } from '@fittkereso-backend/utils';

@Injectable()
export class ProductImportTaskQueueDepthService {
  private readonly logger = new CustomLogger(ProductImportTaskQueueDepthService.name);

  constructor(
    private readonly importTaskRepository: ProductImportTaskRepository,
    private readonly productCollectionMetrics: ProductCollectionMetricsService,
  ) {}

  @Interval(30000)
  async recordQueueDepth(): Promise<void> {
    try {
      const kindColumn = `task.${nameOf<ProductImportTask>('kind')}`;
      const statusColumn = `task.${nameOf<ProductImportTask>('status')}`;
      const priorityColumn = `task.${nameOf<ProductImportTask>('priority')}`;
      const sourceNameColumn = `source.${nameOf<ProductSource>('name')}`;
      const counts = await this.importTaskRepository.repo
        .createQueryBuilder('task')
        .select(kindColumn, 'kind')
        .addSelect(sourceNameColumn, 'source_type')
        .addSelect(statusColumn, 'status')
        .addSelect(priorityColumn, 'priority')
        .addSelect('COUNT(*)::int', 'count')
        .innerJoin(`task.${nameOf<ProductImportTask>('source')}`, 'source')
        .where(`${statusColumn} IN (:...statuses)`, {
          statuses: [
            TaskStatus.PENDING,
            TaskStatus.PROCESSING,
            TaskStatus.FAILED,
          ],
        })
        .groupBy(kindColumn)
        .addGroupBy(sourceNameColumn)
        .addGroupBy(statusColumn)
        .addGroupBy(priorityColumn)
        .getRawMany<{
          kind: ProductImportTaskKind;
          source_type: string;
          status: string;
          priority: number;
          count: number;
        }>();

      this.productCollectionMetrics.resetQueueDepth();

      for (const row of counts) {
        this.productCollectionMetrics.setQueueDepth(
          row.kind,
          row.source_type,
          row.status,
          row.priority,
          row.count,
        );
      }
    } catch (error: unknown) {
      this.logger.warn('Failed to record queue depth metrics', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
