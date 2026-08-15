import { Interval } from '@nestjs/schedule';
import {
  TaskStatus,
  ScrapeTaskRepository,
  ScrapeQueueName,
  ScrapeTask,
} from '@fittkereso-backend/database';
import {
  SCHEDULING_DEFAULTS,
  TaskConfigService,
} from '@fittkereso-backend/config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ScrapeTaskMetricsService } from '@fittkereso-backend/metrics';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';

export abstract class BaseScrapeTaskManagerService {
  protected readonly logger = new CustomLogger(
    BaseScrapeTaskManagerService.name,
  );

  constructor(
    protected readonly taskConfig: TaskConfigService,
    protected readonly taskRepo: ScrapeTaskRepository,
    protected readonly queues: ScrapeQueueName[],
    protected readonly taskMetricsService: ScrapeTaskMetricsService,
    protected readonly dynamicConfigService: DynamicConfigService,
  ) {}

  @Interval(5000)
  async processTasks() {
    const staleTimeoutMinutes =
      this.dynamicConfigService.scheduling?.staleScrapeTaskTimeoutMinutes ??
      SCHEDULING_DEFAULTS.staleScrapeTaskTimeoutMinutes;

    const task = await this.taskRepo.fetchNextScrapeTask(
      this.queues,
      staleTimeoutMinutes,
    );
    if (!task) {
      return;
    }

    this.logger.debug(
      `Processing scrape task ${task.id} for queue ${task.queue}`,
    );

    this.taskMetricsService.taskStarted(task.queue, task.source.name);

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
        task.status = TaskStatus.DONE;
        task.scheduledAt = null;
      }

      await this.taskRepo.save(task);

      this.logger.debug(`Finished task ${task.id} for queue ${task.queue}`);
      this.taskMetricsService.taskFinished(task.queue, task.source.name);
    } catch (error: unknown) {
      this.logger.error(`Task ${task.id} failed: ${task.url}`, error);
      this.taskMetricsService.taskFailed(task.queue, task.source.name);

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
          task.source.name,
          task.status === TaskStatus.FAILED ? 'failed' : 'finished',
          task.executionTimeInSec,
        );
      }
    }
  }

  protected abstract processTask(task: ScrapeTask): Promise<void>;
}
