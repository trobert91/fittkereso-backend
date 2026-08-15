import { Injectable } from '@nestjs/common';
import {
  ScrapeTask,
  ScrapeTaskRepository,
  ScrapeQueueName,
} from '@fittkereso-backend/database';
import { TaskConfigService } from '@fittkereso-backend/config';
import { BaseScrapeTaskManagerService } from '@fittkereso-backend/task';
import { ScrapeTaskProcessorService } from './scrape-task-processor.service';
import { ScrapeTaskMetricsService } from '@fittkereso-backend/metrics';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';

@Injectable()
export class ScrapeTaskManagerService extends BaseScrapeTaskManagerService {
  constructor(
    readonly taskConfig: TaskConfigService,
    readonly taskRepo: ScrapeTaskRepository,
    private readonly processor: ScrapeTaskProcessorService,
    readonly taskMetricsService: ScrapeTaskMetricsService,
    readonly dynamicConfigService: DynamicConfigService,
  ) {
    super(
      taskConfig,
      taskRepo,
      [ScrapeQueueName.ScrapeProductList, ScrapeQueueName.ScrapeProductDetails],
      taskMetricsService,
      dynamicConfigService,
    );
  }

  protected async processTask(task: ScrapeTask): Promise<void> {
    await this.processor.process(task);
  }
}
