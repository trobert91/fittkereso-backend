import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import {
  OfferRepository,
  ProductSourceRecordRepository,
  ScrapeQueueName,
  ScrapeTask,
  ScrapeTaskRepository,
  TaskStatus,
} from '@fittkereso-backend/database';
import { ScrapeTaskCreatorService } from '@fittkereso-backend/task';
import { nameOf } from '@fittkereso-backend/utils';

// Manual scrape-run tooling: enqueue a single ScrapeTask outside the normal
// cron/scheduler flow and inspect its result. The queue worker (a separate
// process — ScrapeTaskManagerService, polling every 5s) picks up and
// processes the task asynchronously; these tools don't run it inline, so
// get_scrape_task/get_product_source_scrape_status must be called again
// after enough time has passed for the worker to have picked it up.
@Injectable()
export class ScrapeRunTools {
  constructor(
    private readonly scrapeTaskCreator: ScrapeTaskCreatorService,
    private readonly scrapeTaskRepo: ScrapeTaskRepository,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly offerRepo: OfferRepository,
  ) {}

  // ─── Write Tools ───────────────────────────────────────────────────────────

  @Tool({
    name: 'enqueue_scrape_task',
    description:
      'Manually enqueue a single ScrapeTask for a ProductSource, bypassing the normal cron scheduler — the fastest way to test a new or edited ProductSourceConfig against one real URL without waiting for/enabling scheduling. Queue "scrape-product-list" for a list/category page (produces more list + detail tasks once processed) or "scrape-product-details" for a single product detail page. The task runs asynchronously on the next queue-worker poll (~5s) — call get_scrape_task afterward to see the result.',
    parameters: z.object({
      productSourceId: z.string().describe('ProductSource UUID'),
      queue: z
        .nativeEnum(ScrapeQueueName)
        .describe('"scrape-product-list" or "scrape-product-details"'),
      url: z.string().url().describe('The exact URL to scrape'),
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
  })
  async enqueueScrapeTask(args: {
    productSourceId: string;
    queue: ScrapeQueueName;
    url: string;
  }): Promise<string> {
    try {
      const task = await this.scrapeTaskCreator.create({
        queue: args.queue,
        sourceId: args.productSourceId,
        url: args.url,
      });

      return `Enqueued ${task.queue} task ${task.id} for "${task.url}" (status: ${task.status}). Call get_scrape_task with taskId "${task.id}" in a few seconds to see the result.`;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to enqueue scrape task: ${message}`;
    }
  }

  // ─── Read Tools ────────────────────────────────────────────────────────────

  @Tool({
    name: 'get_scrape_task',
    description:
      'Get the current status and result of a ScrapeTask by id — status (pending/processing/done/failed), attempts, timing, any error, and (for a done detail-page task) the ProductSourceRecord/Offer rows it produced. Use after enqueue_scrape_task to check whether the run succeeded.',
    parameters: z.object({
      taskId: z.string().describe('ScrapeTask UUID'),
    }),
    annotations: { readOnlyHint: true },
  })
  async getScrapeTask(args: { taskId: string }): Promise<string> {
    const task = await this.scrapeTaskRepo.findOneOrFail({
      where: { id: args.taskId },
      relations: [nameOf<ScrapeTask>('source'), nameOf<ScrapeTask>('product')],
    });

    const L: string[] = [];
    L.push(`# Scrape Task ${task.id}`);
    L.push(`- **Queue**: ${task.queue}`);
    L.push(`- **Source**: ${task.source?.name ?? '_unknown_'} (${task.source?.id ?? ''})`);
    L.push(`- **URL**: ${task.url}`);
    L.push(`- **Status**: ${task.status}`);
    L.push(`- **Attempts**: ${task.attempts}`);
    L.push(`- **Last run**: ${task.lastRunAt?.toISOString() ?? '_not run yet_'}`);
    L.push(
      `- **Execution time**: ${task.executionTimeInSec !== undefined ? `${task.executionTimeInSec}s` : '_n/a_'}`,
    );

    if (task.error) {
      L.push('');
      L.push('## Error');
      L.push('```json');
      L.push(JSON.stringify(task.error, null, 2));
      L.push('```');
    }

    if (task.status === TaskStatus.DONE && task.product) {
      L.push('');
      L.push('## Resulting Product');
      L.push(`- ${task.product.displayName ?? task.product.id} (${task.product.id})`);

      const sourceRow = await this.sourceRecordRepo.findOne({
        where: { model: { id: task.product.id }, source: { id: task.source.id } },
      });
      if (sourceRow) {
        L.push(`- ProductSourceRecord: ${sourceRow.id} (created ${sourceRow.createdAt?.toISOString?.() ?? ''})`);
      }

      const offers = await this.offerRepo.find({
        where: {
          model: { id: task.product.id },
          sourceRecord: { source: { id: task.source.id } },
        },
      });
      if (offers.length) {
        L.push('');
        L.push('## Offers');
        for (const offer of offers) {
          const discountSuffix = offer.priceWithoutDiscount
            ? ` (was ${offer.priceWithoutDiscount} ${offer.currency})`
            : '';
          L.push(
            `- ${offer.price} ${offer.currency}${discountSuffix} · availability: ${offer.availability} · condition: ${offer.condition} · sourceListingId: ${offer.sourceListingId ?? '_none_'} · lastSeenAt: ${offer.lastSeenAt?.toISOString?.() ?? ''}`,
          );
        }
      } else if (task.queue === ScrapeQueueName.ScrapeProductDetails) {
        L.push('');
        L.push('_No Offer rows found for this product from this source — either the config has no `detailPage.offers` set up, or the offer pipeline did not resolve a price._');
      }
    }

    if (task.status === TaskStatus.PENDING || task.status === TaskStatus.PROCESSING) {
      L.push('');
      L.push('_Task has not finished yet — call this tool again in a few seconds._');
    }

    return L.join('\n');
  }

  @Tool({
    name: 'get_product_source_scrape_status',
    description:
      'Get an aggregate status breakdown (pending/processing/done/failed counts per queue) of all ScrapeTasks belonging to a ProductSource. Use this to see overall progress of a source\'s scraping — e.g. after enabling scheduling, or after enqueuing a list-page task that fans out into many more tasks.',
    parameters: z.object({
      productSourceId: z.string().describe('ProductSource UUID'),
    }),
    annotations: { readOnlyHint: true },
  })
  async getProductSourceScrapeStatus(args: {
    productSourceId: string;
  }): Promise<string> {
    const queueColumn = `t.${nameOf<ScrapeTask>('queue')}`;
    const statusColumn = `t.${nameOf<ScrapeTask>('status')}`;
    const rows: { queue: string; status: string; count: string }[] =
      await this.scrapeTaskRepo.repo
        .createQueryBuilder('t')
        .select(queueColumn, 'queue')
        .addSelect(statusColumn, 'status')
        .addSelect('COUNT(*)::int', 'count')
        .where(`t.${nameOf<ScrapeTask>('source')} = :sourceId`, {
          sourceId: args.productSourceId,
        })
        .groupBy(queueColumn)
        .addGroupBy(statusColumn)
        .getRawMany();

    const L: string[] = [];
    L.push(`# Scrape Status for Product Source ${args.productSourceId}`);
    L.push('');

    if (rows.length === 0) {
      L.push('_No scrape tasks found for this source yet._');
      return L.join('\n');
    }

    const queues = new Map<string, Map<string, number>>();
    for (const row of rows) {
      const statuses = queues.get(row.queue) ?? new Map<string, number>();
      statuses.set(row.status, Number(row.count));
      queues.set(row.queue, statuses);
    }

    L.push('| Queue | Pending | Processing | Done | Failed |');
    L.push('|-------|---------|------------|------|--------|');
    for (const [queue, statuses] of queues) {
      L.push(
        `| ${queue} | ${statuses.get('pending') ?? 0} | ${statuses.get('processing') ?? 0} | ${statuses.get('done') ?? 0} | ${statuses.get('failed') ?? 0} |`,
      );
    }

    const failedRows = await this.scrapeTaskRepo.find({
      where: { source: { id: args.productSourceId }, status: TaskStatus.FAILED },
      take: 5,
      order: { lastRunAt: 'DESC' },
    });
    if (failedRows.length) {
      L.push('');
      L.push('## Recent Failures (up to 5)');
      for (const failed of failedRows) {
        const errorSummary =
          typeof failed.error === 'object'
            ? JSON.stringify(failed.error)
            : String(failed.error ?? '');
        L.push(`- ${failed.url} — ${errorSummary.slice(0, 200)}`);
      }
    }

    return L.join('\n');
  }
}
