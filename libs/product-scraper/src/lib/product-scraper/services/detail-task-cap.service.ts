import { Injectable } from '@nestjs/common';
import {
  AdvisoryLockService,
  ProductImportTask,
  ProductImportTaskKind,
  ProductImportTaskRepository,
  sourceTaskCapLock,
} from '@fittkereso-backend/database';
import { ProductImportTaskPublisherService } from '@fittkereso-backend/task';
import { isEmpty } from 'lodash';
import { runStartedAtOf } from './list-page-task-payload';

export interface QueueDetailTasksParams {
  /** The list-page task the detail tasks come from. */
  listTask: ProductImportTask;
  tasks: ProductImportTask[];
  /** The source's `maxItems`: at most this many detail tasks per run. Undefined queues them all. */
  maxItems: number | undefined;
}

export interface QueuedDetailTasks {
  queued: number;
  /** Left out because the run had reached `maxItems`. */
  capped: number;
}

/**
 * Queues a list page's detail tasks within its run's `maxItems`.
 *
 * A scraping run's list pages are separate tasks, so the cap has no in-memory
 * counter to share. It counts instead the source's detail tasks created since
 * the run began (the run stamps its start on every list task), under a
 * per-source advisory lock, so two list pages finishing at once cannot both
 * see room for the same slots. The run start comes from the collector's clock
 * and `createdAt` from the database's, but detail tasks are created minutes
 * after a run starts, so skew between the two does not matter.
 *
 * Only queued tasks count. A card refreshed in place, or skipped because its
 * URL already has a task in flight, uses no slot. The cards left out are simply
 * not queued: the next run finds them again.
 */
@Injectable()
export class DetailTaskCapService {
  constructor(
    private readonly taskRepo: ProductImportTaskRepository,
    private readonly importTaskPublisher: ProductImportTaskPublisherService,
    private readonly locks: AdvisoryLockService,
  ) {}

  async queue(params: QueueDetailTasksParams): Promise<QueuedDetailTasks> {
    const { listTask, tasks, maxItems } = params;
    if (isEmpty(tasks)) return { queued: 0, capped: 0 };

    if (maxItems === undefined) {
      await this.importTaskPublisher.addTasks(tasks);
      return { queued: tasks.length, capped: 0 };
    }

    const runStartedAt = await this.runStartedAt(listTask);

    return this.locks.withLocks([sourceTaskCapLock(listTask.source.id)], async () => {
      const alreadyQueued = await this.taskRepo.countCreatedSince({
        sourceId: listTask.source.id,
        kinds: [ProductImportTaskKind.DetailPage],
        since: runStartedAt,
      });
      const admitted = tasks.slice(0, Math.max(0, maxItems - alreadyQueued));

      if (!isEmpty(admitted)) {
        await this.importTaskPublisher.addTasks(admitted);
      }

      return { queued: admitted.length, capped: tasks.length - admitted.length };
    });
  }

  /**
   * When the list task's run began. A list task queued by hand, or before runs
   * stamped their start, counts from its own creation instead: a cap for that
   * page alone.
   */
  private async runStartedAt(listTask: ProductImportTask): Promise<Date> {
    const payload = await this.taskRepo.loadPayload(listTask.id);
    return runStartedAtOf(payload) ?? listTask.createdAt ?? new Date();
  }
}
