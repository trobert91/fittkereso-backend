import { Injectable } from '@nestjs/common';
import { uniq } from 'lodash';
import {
  AdvisoryLockService,
  ArukeresoSourceConfig,
  asArukeresoConfig,
  DEFAULT_IMPORT_TASK_PRIORITY,
  OfferRepository,
  ProductImportTask,
  ProductImportTaskKind,
  ProductImportTaskRepository,
  ProductModelRepository,
  ProductSource,
  productLock,
  TaskStatus,
} from '@fittkereso-backend/database';
import { TaskConfigService } from '@fittkereso-backend/config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductCollectionMetricsService } from '@fittkereso-backend/metrics';
import {
  OfferFreshnessService,
  ProductMergeService,
} from '@fittkereso-backend/product';
import { NativeScraperService } from '@fittkereso-backend/scraper';
import {
  emptyImportRunSummary,
  ImportRunOptions,
  ImportRunSummary,
  ProductSourceImporter,
} from '../interfaces/product-source-importer.interface';
import { offerExternalIdOf } from '../product-scraper/services/offer-external-id';
import { ArukeresoFeedParserService } from './arukereso-feed-parser.service';
import { ArukeresoFeedItem } from './arukereso-feed-item';
import {
  ArukeresoProductMapperService,
  FeedSkipReason,
  MappedFeedItem,
} from './arukereso-product-mapper.service';
import {
  ArukeresoFeedTriageService,
  FeedRow,
  UnchangedFeedRow,
} from './arukereso-feed-triage.service';
import { FeedEntryPayload, feedRowHash } from './feed-row-hash';

/**
 * How many consecutive per-item failures end the run.
 *
 * A handful of bad rows in a 3488-product feed is normal and must not abandon
 * the other 3487. A long unbroken streak is not a data problem — it is a
 * config that no longer matches the feed — and continuing then just records
 * the same failure 3000 more times.
 */
export const MAX_CONSECUTIVE_ITEM_FAILURES = 50;

/** Rows mapped per flush: each flush is a few lookups for the whole batch. */
export const FEED_FLUSH_SIZE = 200;

/** Used only when the collector's config sets no task.max_attempts. */
const FALLBACK_MAX_ATTEMPTS = 3;

/**
 * The `arukereso` importer: fetch one feed, and queue a task for every row
 * that is new or changed.
 *
 * A run takes seconds. It maps every row — deterministic, no LLM — and
 * compares it with what the row's listing last imported (see
 * ArukeresoFeedTriageService):
 * - an unchanged row only has its offer confirmed in place (lastSynced), in
 *   one statement per batch;
 * - a new or changed row becomes a feed_entry task, which the collector's
 *   scheduler imports in parallel with everything else. A row whose task is
 *   still pending replaces that task's row instead.
 *
 * So a nightly run over a catalogue that barely moved queues almost nothing,
 * and the expensive part — identity extraction, unification, the writes — runs
 * in tasks: retried one by one, spread over the scheduler's batches, and
 * resumed after a restart.
 */
@Injectable()
export class ArukeresoImportService implements ProductSourceImporter {
  readonly type = 'arukereso' as const;

  private readonly logger = new CustomLogger(ArukeresoImportService.name);

  constructor(
    private readonly nativeScraper: NativeScraperService,
    private readonly feedParser: ArukeresoFeedParserService,
    private readonly mapper: ArukeresoProductMapperService,
    private readonly triage: ArukeresoFeedTriageService,
    private readonly taskRepo: ProductImportTaskRepository,
    private readonly offerRepo: OfferRepository,
    private readonly productRepo: ProductModelRepository,
    private readonly mergeService: ProductMergeService,
    private readonly offerFreshness: OfferFreshnessService,
    private readonly locks: AdvisoryLockService,
    private readonly taskConfig: TaskConfigService,
    private readonly productCollectionMetrics: ProductCollectionMetricsService,
  ) {}

  public async import(
    source: ProductSource,
    options?: ImportRunOptions,
  ): Promise<ImportRunSummary> {
    // Before the feed is fetched: triage keys offers by (seller, externalId),
    // and without the seller every flush would fail.
    if (!source.seller) {
      throw new Error(`Source ${source.name} was loaded without its seller`);
    }

    const startTime = Date.now();
    const summary = emptyImportRunSummary();
    const config = asArukeresoConfig(source.config, source.name);
    const requestedSlugs = options?.categorySlugs;
    const skips: Partial<Record<FeedSkipReason, number>> = {};
    const seenUrls = new Set<string>();

    let consecutiveFailures = 0;
    let eligible = 0;
    let capped = false;
    let batch: FeedRow[] = [];

    try {
      const { stream, contentType } = await this.nativeScraper.stream(
        config.feedUrl,
      );

      const parsed = await this.feedParser.parseStream(
        stream,
        async (item) => {
          // The cap counts ELIGIBLE rows — queued, confirmed in place, or
          // already waiting in a task — not rows queued. Counting only queued
          // rows would make every run of a capped source reach for the next
          // `maxItems` rows. Once reached, the rest of the feed is read out
          // (cheaper than aborting mid-parse) and ignored.
          if (config.maxItems !== undefined && eligible >= config.maxItems) {
            capped = true;
            return;
          }

          const mapped = await this.mapItem(source, config, item, requestedSlugs, summary);
          if (!mapped) {
            consecutiveFailures += 1;
            if (consecutiveFailures >= MAX_CONSECUTIVE_ITEM_FAILURES) {
              throw new Error(
                `Abandoning feed import for "${source.name}": ${consecutiveFailures} consecutive items failed, which is a systemic problem rather than bad rows`,
              );
            }
            return;
          }
          consecutiveFailures = 0;

          if (mapped.status === 'skipped') {
            summary.skipped += 1;
            skips[mapped.reason] = (skips[mapped.reason] ?? 0) + 1;
            return;
          }

          eligible += 1;
          if (seenUrls.has(mapped.url)) {
            summary.duplicateUrls += 1;
          } else {
            seenUrls.add(mapped.url);
          }
          batch.push(this.toRow(mapped, item));

          if (batch.length >= FEED_FLUSH_SIZE) {
            const rows = batch;
            batch = [];
            await this.flush(source, rows, requestedSlugs, summary);
          }
        },
        {
          format: config.format ?? 'auto',
          delimiter: config.csv?.delimiter ?? 'auto',
          contentType,
        },
      );
      await this.flush(source, batch, requestedSlugs, summary);

      summary.itemsSeen = parsed.itemsParsed;

      this.productCollectionMetrics.fullSyncCompleted(source.name);
      this.recordDuration(source, startTime);

      this.logger.log('Árukereső feed run completed', {
        source: source.name,
        feedUrl: config.feedUrl,
        format: parsed.format,
        itemsSeen: summary.itemsSeen,
        attributesSkipped: parsed.attributesSkipped,
        maxItems: config.maxItems ?? null,
        capped,
        eligible,
        feedTasksEnqueued: summary.feedTasksEnqueued,
        tasksReplaced: summary.tasksReplaced,
        offersUpdated: summary.offersUpdated,
        duplicateUrls: summary.duplicateUrls,
        skipped: summary.skipped,
        failed: summary.failed,
        skipReasons: skips,
        durationMs: Date.now() - startTime,
      });
      if (summary.duplicateUrls > 0) {
        this.logger.warn(
          'Feed rows share a URL — only the last row of each is imported. Is the URL mapping per variant?',
          { source: source.name, duplicateUrls: summary.duplicateUrls },
        );
      }

      return summary;
    } catch (error) {
      this.productCollectionMetrics.fullSyncFailed(source.name);
      this.recordDuration(source, startTime);
      this.logger.error('Árukereső feed run failed', error, {
        source: source.name,
        feedUrl: config.feedUrl,
        eligible,
        feedTasksEnqueued: summary.feedTasksEnqueued,
      });
      throw error;
    }
  }

  /**
   * Map one item. Undefined when mapping threw: one malformed row must not
   * abandon a catalogue, so it is counted and the run goes on.
   */
  private async mapItem(
    source: ProductSource,
    config: ArukeresoSourceConfig,
    item: ArukeresoFeedItem,
    requestedSlugs: string[] | undefined,
    summary: ImportRunSummary,
  ): Promise<MappedFeedItem | undefined> {
    try {
      return await this.mapper.map({
        config,
        item,
        requestedSlugs,
      });
    } catch (error) {
      summary.failed += 1;
      this.logger.warn('Feed item failed to map, continuing', {
        source: source.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private toRow(
    mapped: Extract<MappedFeedItem, { status: 'mapped' }>,
    item: ArukeresoFeedItem,
  ): FeedRow {
    const offer = mapped.scrapedProduct.offers?.[0];
    return {
      url: mapped.url,
      item,
      scrapedProduct: mapped.scrapedProduct,
      rowHash: feedRowHash(mapped.url, mapped.scrapedProduct),
      externalId: offer ? offerExternalIdOf(offer, mapped.url).value : undefined,
    };
  }

  /** One batch: confirm the unchanged rows' offers, queue the rest. */
  private async flush(
    source: ProductSource,
    rows: FeedRow[],
    requestedSlugs: string[] | undefined,
    summary: ImportRunSummary,
  ): Promise<void> {
    if (rows.length === 0) return;
    // A URL repeated in the feed: the last row wins (the repeat was counted
    // where it was read). A repeat in a later batch replaces the earlier
    // row's still-pending task the same way.
    const unique = [...new Map(rows.map((row) => [row.url, row])).values()];

    const { unchanged, toImport } = await this.triage.triage(source, unique);
    summary.offersUpdated += await this.confirmInPlace(unchanged);

    const queued = await this.queue(source, toImport, requestedSlugs);
    summary.feedTasksEnqueued += queued.enqueued;
    summary.tasksReplaced += queued.replaced;
  }

  /**
   * An unchanged row's whole import: its offer is seen again. A product whose
   * offer had aged out of visibility gets its price recomputed, since that
   * offer was left out of it.
   */
  private async confirmInPlace(unchanged: UnchangedFeedRow[]): Promise<number> {
    if (unchanged.length === 0) return 0;

    const cutoff = this.offerFreshness.visibleCutoff();
    await this.offerRepo.stampSynced(unchanged.map((entry) => entry.offerId));

    const revived = uniq(
      unchanged
        .filter((entry) => !entry.lastSynced || entry.lastSynced < cutoff)
        .map((entry) => entry.modelId),
    );
    for (const modelId of revived) {
      await this.locks.withLocks([productLock(modelId)], async () => {
        const model = await this.productRepo.findOne({ where: { id: modelId } });
        if (!model) return;
        await this.mergeService.recomputePrice(model);
        await this.productRepo.save(model);
      });
    }
    return unchanged.length;
  }

  /**
   * A task per row to import, unless one is already waiting for it:
   * - pending, or failed with retries left: it gets this row instead, and
   *   runs at once;
   * - already running this very row: nothing to add;
   * - otherwise (none, finished, or running an older row): a new task.
   */
  private async queue(
    source: ProductSource,
    rows: FeedRow[],
    requestedSlugs: string[] | undefined,
  ): Promise<{ enqueued: number; replaced: number }> {
    if (rows.length === 0) return { enqueued: 0, replaced: 0 };

    const open = await this.taskRepo.findOpenFeedEntries(
      source.id,
      rows.map((row) => row.url),
    );
    const maxAttempts = this.taskConfig.maxAttempts ?? FALLBACK_MAX_ATTEMPTS;
    const inserts: ProductImportTask[] = [];
    let replaced = 0;

    for (const row of rows) {
      const tasks = open.filter((task) => task.url === row.url);
      const payload: FeedEntryPayload = { item: row.item, requestedSlugs };

      const waiting = tasks.find(
        (task) =>
          task.status === TaskStatus.PENDING ||
          (task.status === TaskStatus.FAILED && task.attempts < maxAttempts),
      );
      if (waiting) {
        if (waiting.payloadHash !== row.rowHash) {
          await this.taskRepo.repo.update(waiting.id, {
            // Cast: TypeORM's update typing rejects a nested interface in jsonb.
            payload: payload as unknown as Record<string, never>,
            payloadHash: row.rowHash,
            scheduledAt: null,
          });
          replaced += 1;
        }
        continue;
      }
      if (
        tasks.some(
          (task) =>
            task.status === TaskStatus.PROCESSING && task.payloadHash === row.rowHash,
        )
      ) {
        continue;
      }

      const task = new ProductImportTask();
      task.kind = ProductImportTaskKind.FeedEntry;
      task.source = source;
      task.url = row.url;
      task.status = TaskStatus.PENDING;
      task.priority = DEFAULT_IMPORT_TASK_PRIORITY;
      task.payload = payload;
      task.payloadHash = row.rowHash;
      inserts.push(task);
    }

    if (inserts.length > 0) {
      await this.taskRepo.saveAll(inserts);
    }
    return { enqueued: inserts.length, replaced };
  }

  private recordDuration(source: ProductSource, startTime: number): void {
    this.productCollectionMetrics.recordFullSyncDuration(
      source.name,
      (Date.now() - startTime) / 1000,
    );
  }
}
