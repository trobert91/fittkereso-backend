import { Injectable } from '@nestjs/common';
import {
  TaskStatus,
  ScrapeTask,
  ScrapeTaskRepository,
  ProductSourceRecordRepository,
  ProductSource,
  ScrapeQueueName,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { normalizeUrl } from '@fittkereso-backend/utils';

export type DispatchOutcome =
  | { dispatched: true; task: ScrapeTask }
  | { dispatched: false; reason: 'pending_task' | 'recently_processed' };

export interface DispatchScrapeTaskParams {
  url: string;
  source: ProductSource;
  queue: ScrapeQueueName;
  // Skip dispatch if a ProductSourceRecord for this URL already has
  // updatedAt >= processedSince. Only consulted once the URL is confirmed to
  // have no pending/processing task — see dispatchIfNeeded.
  processedSince: Date;
}

@Injectable()
export class ScrapeTaskPublisherService {
  private readonly logger = new CustomLogger(ScrapeTaskPublisherService.name);

  constructor(
    private readonly taskRepo: ScrapeTaskRepository,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
  ) {}

  public async addTask(task: ScrapeTask) {
    task.status = TaskStatus.PENDING;

    await this.taskRepo.save(task);

    this.logger.debug('Published scrape task', {
      taskId: task.id,
      queue: task.queue,
      url: task.url,
      sourceId: task.source?.id,
    });
  }

  public async addTasks(tasks: ScrapeTask[]) {
    tasks.forEach((task) => (task.status = TaskStatus.PENDING));

    await this.taskRepo.saveAll(tasks);

    this.logger.debug(`Published ${tasks.length} scrape task(s)`, {
      count: tasks.length,
      queues: [...new Set(tasks.map((task) => task.queue))],
      sourceIds: [...new Set(tasks.map((task) => task.source?.id).filter(Boolean))],
    });
  }

  // Creates a ScrapeTask for `url` unless this source already has one
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
    params: DispatchScrapeTaskParams,
  ): Promise<DispatchOutcome> {
    const { source, queue, processedSince } = params;
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

    const task = new ScrapeTask();
    task.url = normalizedUrl;
    task.queue = queue;
    task.source = source;
    // task.product intentionally left unset — the dispatched task resolves
    // its own product identity when it runs (source+externalId), it is not
    // pinned to whatever product the discovering page resolved to.

    await this.addTask(task);
    return { dispatched: true, task };
  }
}
