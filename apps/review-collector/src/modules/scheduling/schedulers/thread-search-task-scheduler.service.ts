import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import {
  QueueName,
  TaskStatus,
  ThreadSearchTask,
  ThreadSearchTaskRepository,
} from "@ebike-backend/database";
import { BaseScheduler } from "@ebike-backend/task";
import { SCHEDULING_DEFAULTS, TaskConfigService } from "@ebike-backend/config";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import {
  SchedulerMetricsService,
  TaskMetricsService,
} from "@ebike-backend/metrics";
import { ThreadSearchExecutor } from "@ebike-backend/thread-search";

const DEFAULT_BATCH_SIZE = 5;

@Injectable()
export class ThreadSearchTaskScheduler extends BaseScheduler {
  private isRunning = false;

  constructor(
    readonly metricsService: SchedulerMetricsService,
    private readonly taskRepo: ThreadSearchTaskRepository,
    private readonly executor: ThreadSearchExecutor,
    private readonly dynamicConfigService: DynamicConfigService,
    private readonly taskMetricsService: TaskMetricsService,
    private readonly taskConfig: TaskConfigService,
  ) {
    super(ThreadSearchTaskScheduler.name, metricsService);
  }

  @Cron("*/10 * * * *")
  async tick(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn("Previous tick still in progress, skipping");
      return;
    }
    this.isRunning = true;
    try {
      await super.schedule(this.drain.bind(this));
    } finally {
      this.isRunning = false;
    }
  }

  private async drain(): Promise<void> {
    const batchSize =
      this.dynamicConfigService.keywordResearch?.schedulerBatchSize ??
      DEFAULT_BATCH_SIZE;
    const staleTimeoutMinutes =
      this.dynamicConfigService.scheduling?.staleTaskTimeoutMinutes ??
      SCHEDULING_DEFAULTS.staleTaskTimeoutMinutes;

    let processed = 0;
    for (let i = 0; i < batchSize; i++) {
      const task =
        await this.taskRepo.fetchNextThreadSearchTask(staleTimeoutMinutes);
      if (!task) break;
      await this.processOne(task);
      processed++;
    }
    this.logger.debug(`ThreadSearch tick complete: ${processed} tasks`);
  }

  private async processOne(task: ThreadSearchTask): Promise<void> {
    const startTime = Date.now();
    this.taskMetricsService.taskStarted(QueueName.ThreadSearch);

    try {
      const result = await this.executor.execute(task);

      task.duplicates += result.duplicates;
      task.discovered += result.discovered;
      task.belowRelevance += result.belowRelevance;

      task.executionTimeInSec = (Date.now() - startTime) / 1000;
      task.lastRunAt = new Date();
      task.error = null;

      if (task.status !== TaskStatus.PENDING) {
        task.attempts++;
        task.scheduledAt = null;
        task.status = TaskStatus.DONE;
      }
      await this.taskRepo.save(task);
      this.taskMetricsService.taskFinished(QueueName.ThreadSearch);
    } catch (error: unknown) {
      this.logger.error(`Task ${task.id} failed`, error);
      this.taskMetricsService.taskFailed(QueueName.ThreadSearch);

      task.executionTimeInSec = (Date.now() - startTime) / 1000;
      task.error = JSON.stringify(
        error instanceof Error
          ? { message: error.message, stack: error.stack }
          : error,
      );
      task.lastRunAt = new Date();
      task.attempts++;
      task.status = TaskStatus.FAILED;

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
          QueueName.ThreadSearch,
          task.status === TaskStatus.FAILED ? "failed" : "finished",
          task.executionTimeInSec,
        );
      }
    }
  }
}
