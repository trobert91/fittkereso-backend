import { BeforeApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import {
  TaskStatus,
  ProductImportTaskRepository,
  ProductImportTaskKind,
  ProductImportTask,
  isProductSourceConfigInvalidError,
} from '@fittkereso-backend/database';
import {
  SCHEDULING_DEFAULTS,
  TaskConfigService,
} from '@fittkereso-backend/config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductImportTaskMetricsService } from '@fittkereso-backend/metrics';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { describeTaskError } from './describe-task-error';

export const IMPORT_TASK_TICK_INTERVAL = 'product-import-task-tick';

/** A task running longer than this is logged, and again after as long again. */
const LONG_RUNNING_MS = 10 * 60 * 1000;
/** How long shutdown waits for running tasks before handing them back. */
const SHUTDOWN_GRACE_MS = 60 * 1000;
/** TypeORM's pool size when postgres.pool_size is unset. */
const DRIVER_DEFAULT_POOL_SIZE = 10;
/** Used only when the collector's config sets no task.max_attempts. */
const FALLBACK_MAX_ATTEMPTS = 3;

interface RunningTask {
  task: ProductImportTask;
  startedAt: number;
  warnedAt: number;
  done: Promise<void>;
}

/**
 * The import task scheduler: every tick claims up to a batch of tasks and
 * starts them all, however many earlier ones are still running.
 *
 * Producers only write tasks to the database; nothing notifies this. A task
 * queued by any producer starts within one tick, and a claimed task is
 * marked `processing` by the claim itself, so neither the next tick nor
 * another collector takes it again while it runs (see
 * ProductImportTaskRepository.claimBatch).
 *
 * The tick and the batch size are dynamic config (scheduling.json):
 * throughput is about batchSize × 3600000 / tickMs tasks an hour, and each
 * tick costs one claim query.
 */
export abstract class BaseProductImportTaskManagerService
  implements OnModuleInit, BeforeApplicationShutdown
{
  protected readonly logger = new CustomLogger(
    BaseProductImportTaskManagerService.name,
  );

  private readonly running = new Map<string, RunningTask>();
  private claiming = false;
  private stopped = false;

  constructor(
    protected readonly taskConfig: TaskConfigService,
    protected readonly taskRepo: ProductImportTaskRepository,
    protected readonly kinds: ProductImportTaskKind[],
    protected readonly taskMetricsService: ProductImportTaskMetricsService,
    protected readonly dynamicConfigService: DynamicConfigService,
    protected readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const { tickMs, batchSize } = this.settings();
    this.warnIfPoolTooSmall(batchSize);
    this.schedulerRegistry.addInterval(
      IMPORT_TASK_TICK_INTERVAL,
      setInterval(() => void this.tick(), tickMs),
    );
    this.logger.log('Import task scheduler started', { tickMs, batchSize });
  }

  /**
   * Stops ticking, gives running tasks a grace period to finish, then puts
   * the rest back to `pending` so the next collector takes them at once
   * instead of after the stale timeout.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.schedulerRegistry.doesExist('interval', IMPORT_TASK_TICK_INTERVAL)) {
      this.schedulerRegistry.deleteInterval(IMPORT_TASK_TICK_INTERVAL);
    }
    if (this.running.size === 0) return;

    this.logger.log('Waiting for running import tasks before shutting down', {
      running: this.running.size,
      graceMs: SHUTDOWN_GRACE_MS,
    });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.whenIdle(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
      }),
    ]);
    clearTimeout(timer);

    const unfinished = [...this.running.keys()];
    if (unfinished.length > 0) {
      const released = await this.taskRepo.releaseClaims(unfinished);
      this.logger.warn('Handed unfinished import tasks back to the queue', {
        unfinished: unfinished.length,
        released,
      });
    }
  }

  /**
   * One tick: claim up to a batch and start every task claimed. A tick that
   * finds this process's previous claim still running skips.
   */
  async tick(): Promise<void> {
    if (this.stopped || this.claiming) return;
    this.claiming = true;
    try {
      this.logLongRunning();
      const { batchSize, staleTimeoutMinutes } = this.settings();
      const tasks = await this.taskRepo.claimBatch({
        kinds: this.kinds,
        limit: batchSize,
        maxAttempts: this.maxAttempts(),
        staleTimeoutMinutes,
      });
      for (const task of tasks) {
        this.start(task);
      }
    } catch (error: unknown) {
      this.logger.error('Claiming import tasks failed', error);
    } finally {
      this.claiming = false;
    }
  }

  /** Resolves once every task started so far has finished. */
  async whenIdle(): Promise<void> {
    await Promise.allSettled([...this.running.values()].map((entry) => entry.done));
  }

  private start(task: ProductImportTask): void {
    const entry: RunningTask = {
      task,
      startedAt: Date.now(),
      warnedAt: 0,
      done: Promise.resolve(),
    };
    this.running.set(task.id, entry);
    this.taskMetricsService.setInFlight(this.running.size);

    entry.done = this.runTask(task)
      .catch((error: unknown) => {
        // runTask records every failure on the task; this only catches one
        // in the recording itself (a failed save, say).
        this.logger.error('Import task failed outside its own handling', error, {
          taskId: task.id,
        });
      })
      .finally(() => {
        this.running.delete(task.id);
        this.taskMetricsService.setInFlight(this.running.size);
      });
  }

  private async runTask(task: ProductImportTask): Promise<void> {
    this.logger.debug(`Processing import task ${task.id} (${task.kind})`, {
      taskId: task.id,
      kind: task.kind,
      priority: task.priority,
      url: task.url,
      sourceId: task.source.id,
      sourceName: task.source.name,
      attempts: task.attempts,
    });

    this.taskMetricsService.taskStarted(task.kind, task.source.name);

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

      this.logger.debug(`Finished task ${task.id} (${task.kind})`, {
        taskId: task.id,
        kind: task.kind,
        url: task.url,
        sourceId: task.source.id,
        sourceName: task.source.name,
        status: task.status,
        executionTimeInSec: task.executionTimeInSec,
        attempts: task.attempts,
      });
      this.taskMetricsService.taskFinished(task.kind, task.source.name);
    } catch (error: unknown) {
      this.logger.error(`Task ${task.id} failed: ${task.url}`, error, {
        taskId: task.id,
        kind: task.kind,
        url: task.url,
        sourceId: task.source.id,
        sourceName: task.source.name,
        attempts: task.attempts,
      });
      this.taskMetricsService.taskFailed(task.kind, task.source.name);

      task.executionTimeInSec = (Date.now() - startTime) / 1000;
      task.error = describeTaskError(error);
      task.lastRunAt = new Date();

      task.attempts++;
      task.status = TaskStatus.FAILED;

      // A failure retrying cannot change is parked immediately rather than
      // repeated on a backoff for the same answer. See ProductImportTask.terminal.
      if (isProductSourceConfigInvalidError(error)) {
        task.terminal = true;
        task.scheduledAt = null;
      } else if (task.attempts < this.maxAttempts()) {
        // Exponential backoff: delay = 2^attempts * 1 minute (capped at 1 hour)
        const delayMinutes = Math.min(Math.pow(2, task.attempts), 60);
        task.scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000);
      } else {
        task.scheduledAt = null;
      }

      await this.taskRepo.save(task);
    } finally {
      if (task.executionTimeInSec) {
        this.taskMetricsService.recordTaskDuration(
          task.kind,
          task.source.name,
          task.status === TaskStatus.FAILED ? 'failed' : 'finished',
          task.executionTimeInSec,
        );
      }
    }
  }

  /** Nothing interrupts a task that runs long; it is logged, so it can be found. */
  private logLongRunning(): void {
    const now = Date.now();
    for (const entry of this.running.values()) {
      if (
        now - entry.startedAt >= LONG_RUNNING_MS &&
        now - entry.warnedAt >= LONG_RUNNING_MS
      ) {
        entry.warnedAt = now;
        this.logger.warn('Import task still running', {
          taskId: entry.task.id,
          kind: entry.task.kind,
          url: entry.task.url,
          sourceName: entry.task.source.name,
          runningForSec: Math.round((now - entry.startedAt) / 1000),
        });
      }
    }
  }

  /**
   * Up to about two batches run at once (a tick does not wait for the last),
   * and an import holds up to three connections: its brand lock, its product
   * lock, and the one it queries with. Plus a few for the claim and the
   * collector's other pollers.
   */
  private warnIfPoolTooSmall(batchSize: number): void {
    const options = this.taskRepo.repo.manager.connection
      .options as PostgresConnectionOptions;
    const poolSize = options.poolSize ?? DRIVER_DEFAULT_POOL_SIZE;
    const needed = 6 * batchSize + 6;
    if (poolSize < needed) {
      this.logger.warn('The Postgres pool may be too small for this import batch size', {
        poolSize,
        batchSize,
        needed,
        hint: 'Raise postgres.pool_size, or lower scheduling.importTaskBatchSize',
      });
    }
  }

  private maxAttempts(): number {
    return this.taskConfig.maxAttempts ?? FALLBACK_MAX_ATTEMPTS;
  }

  private settings() {
    const scheduling = this.dynamicConfigService.scheduling;
    return {
      tickMs: scheduling?.importTaskTickMs ?? SCHEDULING_DEFAULTS.importTaskTickMs,
      batchSize:
        scheduling?.importTaskBatchSize ?? SCHEDULING_DEFAULTS.importTaskBatchSize,
      staleTimeoutMinutes:
        scheduling?.staleImportTaskTimeoutMinutes ??
        SCHEDULING_DEFAULTS.staleImportTaskTimeoutMinutes,
    };
  }

  protected abstract processTask(task: ProductImportTask): Promise<void>;
}
