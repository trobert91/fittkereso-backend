import { Injectable } from "@nestjs/common";
import { ThreadProcessingListener } from "./thread-processing-listener.service";
import { ProductReviewAnalysisListener } from "./product-review-analysis-listener.service";
import { TaskRepository, Task, QueueName } from "@ebike-backend/database";
import { TaskConfigService } from "@ebike-backend/config";
import {
  BaseTaskManagerService,
  ProductReviewAnalysisMessage,
  ThreadMessage,
} from "@ebike-backend/task";
import { TaskMetricsService } from "@ebike-backend/metrics";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";

@Injectable()
export class TaskManagerService extends BaseTaskManagerService {
  constructor(
    readonly taskConfig: TaskConfigService,
    readonly taskRepo: TaskRepository,
    private readonly threadProcessingListener: ThreadProcessingListener,
    private readonly productReviewAnalysisListener: ProductReviewAnalysisListener,
    readonly taskMetricsService: TaskMetricsService,
    readonly dynamicConfigService: DynamicConfigService,
  ) {
    super(
      taskConfig,
      taskRepo,
      [QueueName.ThreadProcess, QueueName.ProductReviewAnalysis],
      taskMetricsService,
      dynamicConfigService,
    );
  }

  protected async processTask(task: Task): Promise<void> {
    switch (task.queue) {
      case QueueName.ThreadProcess:
        await this.threadProcessingListener.process(
          task.payload as ThreadMessage,
        );
        break;
      case QueueName.ProductReviewAnalysis:
        await this.productReviewAnalysisListener.process(
          task.payload as ProductReviewAnalysisMessage,
        );
        break;
      default:
        this.logger.error(`Unknown task queue: ${String(task.queue)}`);
    }
  }
}
