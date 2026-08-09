import { Interval } from "@nestjs/schedule";
import {
  TaskRepository,
  TaskStatus,
  Task,
  QueueName,
} from "@ebike-backend/database";
import { SCHEDULING_DEFAULTS, TaskConfigService } from "@ebike-backend/config";
import { CustomLogger } from "@ebike-backend/logger";
import { TaskMetricsService } from "@ebike-backend/metrics";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";

export abstract class BaseTaskManagerService {
  protected readonly logger = new CustomLogger(BaseTaskManagerService.name);

  constructor(
    protected readonly taskConfig: TaskConfigService,
    protected readonly taskRepo: TaskRepository,
    protected readonly queues: QueueName[],
    protected readonly taskMetricsService: TaskMetricsService,
    protected readonly dynamicConfigService: DynamicConfigService,
  ) {}

  @Interval(5000)
  async processTasks() {
    const staleTimeoutMinutes =
      this.dynamicConfigService.scheduling?.staleTaskTimeoutMinutes ??
      SCHEDULING_DEFAULTS.staleTaskTimeoutMinutes;

    const task = await this.taskRepo.fetchNextTask(
      this.queues,
      staleTimeoutMinutes,
    );
    if (!task) {
      return;
    }

    this.logger.debug(`Processing task ${task.id} for queue ${task.queue}`);
    this.taskMetricsService.taskStarted(task.queue);

    const startTime = Date.now();

    try {
      await this.processTask(task);

      task.executionTimeInSec = (Date.now() - startTime) / 1000;
      task.lastRunAt = new Date();
      task.error = null;

      // the task can be rescheduled in the downstream service
      // in that case the task will be dropped and picked up later
      // the task status will be TaskStatus.PENDING again
      if (task.status !== TaskStatus.PENDING) {
        task.attempts++;
        task.scheduledAt = null;

        if (task.deleteAfterSuccess) {
          await this.taskRepo.deleteById(task.id);
        } else {
          task.status = TaskStatus.DONE;
          await this.taskRepo.save(task);
        }
      } else {
        await this.taskRepo.save(task);
      }

      this.logger.debug(`Finished task ${task.id} for queue ${task.queue}`);
      this.taskMetricsService.taskFinished(task.queue);
    } catch (error: unknown) {
      this.logger.error(`Task ${task.id} failed:`, error);
      this.taskMetricsService.taskFailed(task.queue);

      task.executionTimeInSec = (Date.now() - startTime) / 1000;
      task.error = JSON.stringify(
        error instanceof Error
          ? { message: error.message, stack: error.stack }
          : error,
      );
      task.lastRunAt = new Date();

      task.attempts++;
      task.status = TaskStatus.FAILED;
      // Exponential backoff: delay = 2^attempts * 1 minute (capped at 1 hour)
      if (task.attempts < this.taskConfig.maxAttempts) {
        const delayMinutes = Math.min(Math.pow(2, task.attempts), 60);
        task.scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000);
      } else {
        task.scheduledAt = null;
      }

      await this.taskRepo.save(task);
    } finally {
      if (task.executionTimeInSec) {
        this.taskMetricsService.recordTaskDuration(
          task.queue,
          task.status === TaskStatus.FAILED ? "failed" : "finished",
          task.executionTimeInSec,
        );
      }
    }
  }

  protected abstract processTask(task: Task): Promise<void>;
}
