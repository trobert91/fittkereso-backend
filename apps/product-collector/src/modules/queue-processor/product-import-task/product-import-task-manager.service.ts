import { Injectable } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  ProductImportTask,
  ProductImportTaskRepository,
  ProductImportTaskKind,
} from '@fittkereso-backend/database';
import { TaskConfigService } from '@fittkereso-backend/config';
import { BaseProductImportTaskManagerService } from '@fittkereso-backend/task';
import { ProductImportTaskProcessorService } from './product-import-task-processor.service';
import { ProductImportTaskMetricsService } from '@fittkereso-backend/metrics';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';

@Injectable()
export class ProductImportTaskManagerService extends BaseProductImportTaskManagerService {
  constructor(
    readonly taskConfig: TaskConfigService,
    readonly taskRepo: ProductImportTaskRepository,
    private readonly processor: ProductImportTaskProcessorService,
    readonly taskMetricsService: ProductImportTaskMetricsService,
    readonly dynamicConfigService: DynamicConfigService,
    readonly schedulerRegistry: SchedulerRegistry,
  ) {
    super(
      taskConfig,
      taskRepo,
      [
        ProductImportTaskKind.ListPage,
        ProductImportTaskKind.DetailPage,
        ProductImportTaskKind.FeedEntry,
      ],
      taskMetricsService,
      dynamicConfigService,
      schedulerRegistry,
    );
  }

  protected async processTask(task: ProductImportTask): Promise<void> {
    await this.processor.process(task);
  }
}
