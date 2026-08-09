import { Injectable } from "@nestjs/common";
import { TaskRepository, Task, QueueName } from "@ebike-backend/database";
import { TaskConfigService } from "@ebike-backend/config";
import {
  BaseTaskManagerService,
  ProductSourceSyncMessage,
} from "@ebike-backend/task";
import { ProductSourceSyncListener } from "./product-source-sync-listener.service";
import { TaskMetricsService } from "@ebike-backend/metrics";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";

@Injectable()
export class TaskManagerService extends BaseTaskManagerService {
  constructor(
    readonly taskConfig: TaskConfigService,
    readonly taskRepo: TaskRepository,
    private readonly fullSyncListener: ProductSourceSyncListener,
    readonly taskMetricsService: TaskMetricsService,
    readonly dynamicConfigService: DynamicConfigService,
  ) {
    super(
      taskConfig,
      taskRepo,
      [QueueName.ProductSourceSync],
      taskMetricsService,
      dynamicConfigService,
    );
  }

  protected async processTask(task: Task): Promise<void> {
    switch (task.queue) {
      case QueueName.ProductSourceSync:
        await this.fullSyncListener.process(
          task.payload as ProductSourceSyncMessage,
        );
        break;
      default:
        this.logger.error(`Unknown task queue: ${String(task.queue)}`);
    }
  }
}
