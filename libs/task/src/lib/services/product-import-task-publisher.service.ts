import { Injectable } from '@nestjs/common';
import {
  DEFAULT_IMPORT_TASK_PRIORITY,
  TaskStatus,
  ProductImportTask,
  ProductImportTaskRepository,
  ProductSourceRecordRepository,
  ProductSource,
  ProductImportTaskKind,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { normalizeUrl } from '@fittkereso-backend/utils';

export type DispatchOutcome =
  | { dispatched: true; task: ProductImportTask }
  | { dispatched: false; reason: 'pending_task' | 'recently_processed' };

export interface DispatchProductImportTaskParams {
  url: string;
  source: ProductSource;
  kind: ProductImportTaskKind;
  /** The dispatching task's own, so a person's resync fans out at its priority. */
  priority?: number;
  // Skip dispatch if a ProductSourceRecord for this URL already has
  // updatedAt >= processedSince. Only consulted once the URL is confirmed to
  // have no pending/processing task — see dispatchIfNeeded.
  processedSince: Date;
}

@Injectable()
export class ProductImportTaskPublisherService {
  private readonly logger = new CustomLogger(ProductImportTaskPublisherService.name);

  constructor(
    private readonly taskRepo: ProductImportTaskRepository,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
  ) {}

  public async addTask(task: ProductImportTask) {
    task.status = TaskStatus.PENDING;

    await this.taskRepo.save(task);

    this.logger.debug('Published import task', {
      taskId: task.id,
      kind: task.kind,
      priority: task.priority,
      url: task.url,
      sourceId: task.source?.id,
    });
  }

  public async addTasks(tasks: ProductImportTask[]) {
    tasks.forEach((task) => (task.status = TaskStatus.PENDING));

    await this.taskRepo.saveAll(tasks);

    this.logger.debug(`Published ${tasks.length} import task(s)`, {
      count: tasks.length,
      kinds: [...new Set(tasks.map((task) => task.kind))],
      sourceIds: [...new Set(tasks.map((task) => task.source?.id).filter(Boolean))],
    });
  }

  // Creates a ProductImportTask for `url` unless this source already has one
  // pending/processing for it (checked first, independent of `processedSince` —
  // we never want two in-flight tasks for one URL on one source, regardless of
  // age) or a ProductSourceRecord for it was already updated at/after
  // `processedSince`.
  //
  // Both checks are source-scoped, for the same reason: another source's
  // in-flight task, or another source's recently-updated record, says nothing
  // about whether THIS source needs to visit the URL. Each source keeps its own
  // ProductSourceRecord per URL.
  public async dispatchIfNeeded(
    params: DispatchProductImportTaskParams,
  ): Promise<DispatchOutcome> {
    const { source, kind, priority, processedSince } = params;
    const normalizedUrl = normalizeUrl(params.url);

    const pending = await this.taskRepo.findExistingUrl(source.id, normalizedUrl, [
      TaskStatus.PENDING,
      TaskStatus.PROCESSING,
    ]);
    if (pending) {
      this.logger.debug('Dispatch skipped — task already pending/processing', {
        url: normalizedUrl,
        existingTaskId: pending.id,
      });
      return { dispatched: false, reason: 'pending_task' };
    }

    // Source-scoped: another source having recently processed this URL says
    // nothing about whether THIS source needs to. Unscoped, one source
    // scraping a URL inside its interval would block every other source of
    // the same shop from ever dispatching it.
    const existingRecord = await this.sourceRecordRepo.findBySourceAndUrl(
      source.id,
      normalizedUrl,
    );
    if (existingRecord?.updatedAt && existingRecord.updatedAt >= processedSince) {
      this.logger.debug('Dispatch skipped — record already processed since cutoff', {
        url: normalizedUrl,
        updatedAt: existingRecord.updatedAt,
        processedSince,
      });
      return { dispatched: false, reason: 'recently_processed' };
    }

    const task = new ProductImportTask();
    task.url = normalizedUrl;
    task.kind = kind;
    task.priority = priority ?? DEFAULT_IMPORT_TASK_PRIORITY;
    task.source = source;
    // task.product intentionally left unset — the dispatched task resolves
    // its own product identity when it runs (source+externalId), it is not
    // pinned to whatever product the discovering page resolved to.

    await this.addTask(task);
    return { dispatched: true, task };
  }
}
