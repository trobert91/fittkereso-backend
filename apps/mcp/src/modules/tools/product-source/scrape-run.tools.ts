import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import {
  MANUAL_IMPORT_TASK_PRIORITY,
  MAX_IMPORT_TASK_PRIORITY,
  MIN_IMPORT_TASK_PRIORITY,
  OfferRepository,
  ProductSourceRecordRepository,
  ProductImportTaskKind,
  ProductImportTask,
  ProductImportTaskRepository,
  TaskStatus,
} from '@fittkereso-backend/database';
import { ProductImportTaskCreatorService } from '@fittkereso-backend/task';
import { nameOf } from '@fittkereso-backend/utils';

// Manual scrape-run tooling: enqueue a single ProductImportTask outside the normal
// cron/scheduler flow and inspect its result. The collector (a separate
// process — ProductImportTaskManagerService, claiming a batch every tick, 30s
// by default) picks up and processes the task asynchronously; these tools don't run it inline, so
// get_product_import_task/get_product_source_import_status must be called again
// after enough time has passed for the worker to have picked it up.
@Injectable()
export class ScrapeRunTools {
  constructor(
    private readonly importTaskCreator: ProductImportTaskCreatorService,
    private readonly importTaskRepo: ProductImportTaskRepository,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly offerRepo: OfferRepository,
  ) {}

  // ─── Write Tools ───────────────────────────────────────────────────────────

  @Tool({
    name: 'enqueue_product_import_task',
    description:
      'Manually enqueue a single ProductImportTask for a ProductSource, bypassing the normal cron scheduler — the fastest way to test a new or edited ProductSourceConfig against one real URL without waiting for/enabling scheduling. Kind "list_page" for a list/category page (produces more list + detail tasks once processed) or "detail_page" for a single product detail page. The task runs asynchronously, started by the collector within one scheduler tick (30s by default) — call get_product_import_task afterward to see the result. It runs at priority 90 unless you pass one: higher runs first, so it goes ahead of the tasks an import run queued (50).',
    parameters: z.object({
      productSourceId: z
        .string()
        .describe(
          "ProductSource UUID the task belongs to. A webshop may have several sources (a page scraper and a feed, say), so this decides which one — it is no longer inferred from the URL. Must be a \"scraping\" source: a feed source has no page pipelines.",
        ),
      kind: z
        // Page kinds only: a feed row's task is queued by its feed run.
        .enum([ProductImportTaskKind.ListPage, ProductImportTaskKind.DetailPage])
        .describe('"list_page" or "detail_page"'),
      url: z.string().url().describe('The exact URL to scrape'),
      priority: z
        .number()
        .int()
        .min(MIN_IMPORT_TASK_PRIORITY)
        .max(MAX_IMPORT_TASK_PRIORITY)
        .optional()
        .describe('0–100, higher runs first. Default 90; an import run queues its own tasks at 50.'),
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
  })
  async enqueueImportTask(args: {
    productSourceId: string;
    kind: ProductImportTaskKind;
    url: string;
    priority?: number;
  }): Promise<string> {
    try {
      const task = await this.importTaskCreator.create({
        kind: args.kind,
        url: args.url,
        priority: args.priority ?? MANUAL_IMPORT_TASK_PRIORITY,
        // Honoured rather than ignored: the source used to be inferred from the
        // URL's domain, which silently picked one arbitrary row once a webshop
        // had more than one source.
        productSourceId: args.productSourceId,
      });

      return `Enqueued ${task.kind} task ${task.id} at priority ${task.priority} for "${task.url}" (status: ${task.status}). Call get_product_import_task with taskId "${task.id}" in a few seconds to see the result.`;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to enqueue import task: ${message}`;
    }
  }

  // ─── Read Tools ────────────────────────────────────────────────────────────

  @Tool({
    name: 'get_product_import_task',
    description:
      'Get the current status and result of a ProductImportTask by id — status (pending/processing/done/failed), attempts, timing, any error, and (for a done detail-page task) the ProductSourceRecord/Offer rows it produced. Use after enqueue_product_import_task to check whether the run succeeded.',
    parameters: z.object({
      taskId: z.string().describe('ProductImportTask UUID'),
    }),
    annotations: { readOnlyHint: true },
  })
  async getImportTask(args: { taskId: string }): Promise<string> {
    const task = await this.importTaskRepo.findOneOrFail({
      where: { id: args.taskId },
      relations: [nameOf<ProductImportTask>('source'), nameOf<ProductImportTask>('product')],
    });

    const L: string[] = [];
    L.push(`# Import Task ${task.id}`);
    L.push(`- **Kind**: ${task.kind}`);
    L.push(`- **Priority**: ${task.priority}`);
    L.push(`- **Source**: ${task.source?.name ?? '_unknown_'} (${task.source?.id ?? ''})`);
    L.push(`- **URL**: ${task.url}`);
    L.push(`- **Status**: ${task.status}`);
    L.push(`- **Attempts**: ${task.attempts}`);
    L.push(`- **Last run**: ${task.lastRunAt?.toISOString() ?? '_not run yet_'}`);
    L.push(
      `- **Execution time**: ${task.executionTimeInSec != null ? `${task.executionTimeInSec}s` : '_n/a_'}`,
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
            `- ${offer.price} ${offer.currency}${discountSuffix} · availability: ${offer.availability ?? '_not reported_'} · condition: ${offer.condition} · externalId: ${offer.externalId ?? '_none_'} · gtin: ${offer.gtin ?? '_none_'} · mpn: ${offer.mpn ?? '_none_'} · lastSynced: ${offer.lastSynced?.toISOString?.() ?? ''}`,
          );
        }
      } else if (task.kind === ProductImportTaskKind.DetailPage) {
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
    name: 'get_product_source_import_status',
    description:
      "Get an aggregate status breakdown (pending/processing/done/failed counts per kind) of all ProductImportTasks belonging to a ProductSource. Use this to see overall progress of a source's scraping — e.g. after enabling scheduling, or after enqueuing a list-page task that fans out into many more tasks. Also shows how many of the source's listings wait unattached (a source that does not identify products, whose offers the seller's identifying source has not written yet).",
    parameters: z.object({
      productSourceId: z.string().describe('ProductSource UUID'),
    }),
    annotations: { readOnlyHint: true },
  })
  async getProductSourceImportStatus(args: {
    productSourceId: string;
  }): Promise<string> {
    const kindColumn = `t.${nameOf<ProductImportTask>('kind')}`;
    const statusColumn = `t.${nameOf<ProductImportTask>('status')}`;
    const rows: { kind: string; status: string; count: string }[] =
      await this.importTaskRepo.repo
        .createQueryBuilder('t')
        .select(kindColumn, 'kind')
        .addSelect(statusColumn, 'status')
        .addSelect('COUNT(*)::int', 'count')
        .where(`t.${nameOf<ProductImportTask>('source')} = :sourceId`, {
          sourceId: args.productSourceId,
        })
        .groupBy(kindColumn)
        .addGroupBy(statusColumn)
        .getRawMany();

    const L: string[] = [];
    L.push(`# Import Status for Product Source ${args.productSourceId}`);
    L.push('');
    const unattached = await this.sourceRecordRepo.countUnattached(args.productSourceId);
    L.push(
      `**Unattached listings:** ${unattached}${unattached > 0 ? ' — waiting for the seller\'s identifying source to write their offers (list_product_source_records with attached: false)' : ''}`,
    );
    L.push('');

    if (rows.length === 0) {
      L.push('_No import tasks found for this source yet._');
      return L.join('\n');
    }

    const kinds = new Map<string, Map<string, number>>();
    for (const row of rows) {
      const statuses = kinds.get(row.kind) ?? new Map<string, number>();
      statuses.set(row.status, Number(row.count));
      kinds.set(row.kind, statuses);
    }

    L.push('| Kind | Pending | Processing | Done | Failed |');
    L.push('|-------|---------|------------|------|--------|');
    for (const [kind, statuses] of kinds) {
      L.push(
        `| ${kind} | ${statuses.get('pending') ?? 0} | ${statuses.get('processing') ?? 0} | ${statuses.get('done') ?? 0} | ${statuses.get('failed') ?? 0} |`,
      );
    }

    const failedRows = await this.importTaskRepo.find({
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
