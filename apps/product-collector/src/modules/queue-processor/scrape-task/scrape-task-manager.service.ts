import { Injectable } from "@nestjs/common";
import {
  ScrapeTask,
  ScrapeTaskRepository,
  ScrapeQueueName,
  ProductSourceType,
} from "@ebike-backend/database";
import { TaskConfigService } from "@ebike-backend/config";
import { BaseScrapeTaskManagerService } from "@ebike-backend/task";
import { DisplayspecsQueueProcessorService } from "./displayspecs-queue-processor.service";
import { ArukeresoQueueProcessorService } from "./arukereso-queue-processor.service";
import { ScrapeTaskMetricsService } from "@ebike-backend/metrics";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";

@Injectable()
export class ScrapeTaskManagerService extends BaseScrapeTaskManagerService {
  constructor(
    readonly taskConfig: TaskConfigService,
    readonly taskRepo: ScrapeTaskRepository,
    private readonly displaySpecsProcessor: DisplayspecsQueueProcessorService,
    private readonly arukeresoProcessor: ArukeresoQueueProcessorService,
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
    switch (task.source.type) {
      case ProductSourceType.displaySpecs:
        await this.displaySpecsProcessor.process(task);
        break;
      case ProductSourceType.arukereso:
        await this.arukeresoProcessor.process(task);
        break;
      default:
        this.logger.error(`Unknown source type: ${String(task.source.type)}`, {
          taskId: task.id,
          url: task.url,
        });
    }
  }
}
