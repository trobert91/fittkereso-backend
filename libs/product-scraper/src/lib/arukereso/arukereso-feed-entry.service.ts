import { Injectable } from '@nestjs/common';
import { compact, uniqBy } from 'lodash';
import {
  ArukeresoSourceConfig,
  ListingExternalIdMismatchError,
  ListingPageRead,
  ProductImportTask,
  ProductImportTaskRepository,
  ProductSourceRecordRepository,
  ScrapedPage,
  asArukeresoConfig,
} from '@fittkereso-backend/database';
import { CategoryConfigService, TaskConfigService } from '@fittkereso-backend/config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductCollectionMetricsService } from '@fittkereso-backend/metrics';
import { listingExternalIdOf } from '@fittkereso-backend/utils';
import { contextFromTask } from '../interfaces/product-import-context.interface';
import { ProductScrapeUpdaterService } from '../product-scraper/services/product-scrape-updater.service';
import {
  PageCategory,
  ProductPageRead,
  ProductPageReaderService,
} from '../product-scraper/services/product-page-reader.service';
import { ArukeresoProductMapperService, MappedFeedItem } from './arukereso-product-mapper.service';
import { asFeedEntryPayload, feedRowHash } from './feed-row-hash';
import { mergeFeedAndPage, toScrapedPage } from './merge-feed-and-page';

/** Used only when the collector's config sets no task.max_attempts. */
const FALLBACK_MAX_ATTEMPTS = 3;

type MappedRow = Extract<MappedFeedItem, { status: 'mapped' }>;

/**
 * Imports the feed rows of one product page, as a feed task: `feed_entry`, or
 * `detail_page` when the page is to be read with them (the source has a
 * detailPage, and a row is new or its page never read or due).
 *
 * Each row is mapped again here, with the source's config as it is now rather
 * than as it was when the feed run queued it: a task queued before a config
 * fix imports under the fix. A row the config now rejects is skipped and
 * counted by reason.
 *
 * Several rows can share one page (a bike's sizes): each is still its own
 * listing, imported on its own, and one failing does not stop the others. The
 * page is read once for all of them, with the service a scraping source reads
 * its pages with (ProductPageReaderService), and merged into each row — the
 * feed primary, the page filling its gaps (mergeFeedAndPage). A row imported
 * without a read merges the page its record kept, so its identity input is
 * the same as after the read and no LLM call follows.
 */
@Injectable()
export class ArukeresoFeedEntryService {
  private readonly logger = new CustomLogger(ArukeresoFeedEntryService.name);

  constructor(
    private readonly taskRepo: ProductImportTaskRepository,
    private readonly mapper: ArukeresoProductMapperService,
    private readonly productUpdater: ProductScrapeUpdaterService,
    private readonly productCollectionMetrics: ProductCollectionMetricsService,
    private readonly pageReader: ProductPageReaderService,
    private readonly sourceRecordRepo: ProductSourceRecordRepository,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly taskConfig: TaskConfigService,
  ) {}

  public async importEntry(
    task: ProductImportTask,
    options: { fetchPage?: boolean } = {},
  ): Promise<void> {
    const payload = asFeedEntryPayload(await this.taskRepo.loadPayload(task.id));
    if (!payload) {
      throw new Error(`Feed task ${task.id} carries no feed row`);
    }
    const config = asArukeresoConfig(task.source.config, task.source.name);

    const rows: MappedRow[] = [];
    for (const { item } of payload.rows) {
      const mapped = await this.mapper.map({ config, item, requestedSlugs: payload.requestedSlugs });
      if (mapped.status === 'skipped') {
        this.productCollectionMetrics.feedEntrySkippedAt(task.source.name, mapped.reason);
        this.logger.debug('Feed row no longer imported under the current config', {
          taskId: task.id,
          url: task.url,
          source: task.source.name,
          reason: mapped.reason,
        });
        continue;
      }
      rows.push(mapped);
    }
    if (rows.length === 0) return;

    const { pages, pageRead } = await this.pagesOf(task, config, rows, options.fetchPage ?? false);

    // A task pinned to a product (a resync of one listing) keeps the pin for
    // that one row. A page's task carries several listings, which a single
    // pin — the last one written back — would all send to one product.
    const pinned = rows.length === 1 ? contextFromTask(task).product : undefined;
    const failures: unknown[] = [];
    for (const row of rows) {
      const listingId = listingExternalIdOf(row.scrapedProduct, row.url);
      const page = pages.get(listingId);
      const listing = page
        ? mergeFeedAndPage(row.scrapedProduct, page, this.offerLevelKeysOf(row.scrapedProduct.category))
        : row.scrapedProduct;
      try {
        await this.productUpdater.createOrUpdateProduct(
          {
            ...contextFromTask(task),
            product: pinned,
            url: row.url,
            // Of the feed row alone, as the run hashes it, so an unchanged row
            // still reads unchanged next run.
            feedRowHash: feedRowHash(row.url, row.scrapedProduct),
            pageRead,
            feedListing: row.scrapedProduct,
          },
          listing,
        );
      } catch (error) {
        failures.push(error);
        this.logger.error('Feed row failed to import', error, {
          taskId: task.id,
          url: row.url,
          source: task.source.name,
          listingId,
        });
      }
    }
    // One row's failure is its own; only a page none of whose rows imported
    // fails the task, for its retries to try them all again.
    if (failures.length === rows.length) throw failures[0];
  }

  /**
   * The page to merge into each row, by listing id, and what to record about
   * reading it.
   * - Reading (a detail_page task): the page is read once for every row.
   *   A failure is the task's to retry, until its last attempt: then the rows
   *   are imported with the page their records kept, and the failure recorded
   *   (pageFailedAt) for the feed run to back off. A page showing another
   *   product (a delisted URL redirected elsewhere) does not fix itself on a
   *   retry, so it falls back at once.
   * - Not reading (a feed_entry task): each row's kept page, if any.
   * Neither when the source has no detailPage (any more).
   */
  private async pagesOf(
    task: ProductImportTask,
    config: ArukeresoSourceConfig,
    rows: MappedRow[],
    fetchPage: boolean,
  ): Promise<{ pages: Map<string, ScrapedPage>; pageRead?: ListingPageRead }> {
    if (!config.detailPage) return { pages: new Map() };
    const listingIds = rows.map((row) => listingExternalIdOf(row.scrapedProduct, row.url));

    if (fetchPage) {
      try {
        const reads = await this.readPage(task, config, rows);
        const pages = new Map(
          rows.map((row, index) => [listingIds[index], toScrapedPage(reads(row), rows.length)]),
        );
        return { pages, pageRead: { fetchedAt: new Date() } };
      } catch (error) {
        const mismatch = error instanceof ListingExternalIdMismatchError;
        if (!mismatch && !this.isLastAttempt(task)) throw error;
        this.productCollectionMetrics.feedPageFailed(task.source.name, mismatch ? 'mismatch' : 'error');
        this.logger.warn('Product page not read; importing the feed rows without it', {
          taskId: task.id,
          url: task.url,
          source: task.source.name,
          rows: rows.length,
          error: error instanceof Error ? error.message : String(error),
        });
        const pages = await this.sourceRecordRepo.findStoredPages(task.source.id, listingIds);
        return { pages, pageRead: { failedAt: new Date() } };
      }
    }

    return { pages: await this.sourceRecordRepo.findStoredPages(task.source.id, listingIds) };
  }

  /**
   * Reads the page once, and maps its rows for each row's category — almost
   * always one category, but rows of one page may fall in two.
   */
  private async readPage(
    task: ProductImportTask,
    config: ArukeresoSourceConfig,
    rows: MappedRow[],
  ): Promise<(row: MappedRow) => ProductPageRead> {
    const pageConfig = { baseUrl: config.baseUrl, categories: config.categories, detailPage: config.detailPage ?? {} };
    const expectedExternalIds = uniqBy(
      compact(
        rows.flatMap((row) => [
          row.scrapedProduct.externalId,
          ...(row.scrapedProduct.offers ?? []).flatMap((offer) => [offer.externalId, offer.mpn, offer.gtin]),
        ]),
      ),
      (id) => id,
    );
    const first = await this.pageReader.read({
      task,
      config: pageConfig,
      category: rows[0].scrapedProduct.category,
      expectedExternalIds,
    });

    const byCategory = new Map<string, ProductPageRead>([[rows[0].scrapedProduct.category.slug, first]]);
    for (const row of rows) {
      const category = row.scrapedProduct.category;
      if (byCategory.has(category.slug)) continue;
      byCategory.set(category.slug, await this.readFor(task, pageConfig, first, category));
    }
    return (row) => byCategory.get(row.scrapedProduct.category.slug) ?? first;
  }

  /** The same page, its rows mapped for another category. */
  private async readFor(
    task: ProductImportTask,
    config: Parameters<ProductPageReaderService['mapSpecs']>[0]['config'],
    read: ProductPageRead,
    category: PageCategory,
  ): Promise<ProductPageRead> {
    const schema = this.categoryConfigService.getJsonSchema(category.slug);
    if (!schema) return { ...read, category, schema: undefined, specs: undefined };
    const interpretation = { ...read, category, schema, categoryProblem: undefined };
    const specs = await this.pageReader.mapSpecs({ task, config, interpretation });
    return { ...interpretation, specs };
  }

  private offerLevelKeysOf(category: PageCategory): string[] {
    return this.categoryConfigService.getConfig(category.slug)?.offerLevelSpecs ?? [];
  }

  /** Whether this run of the task is its last: a failure now would be final. */
  private isLastAttempt(task: ProductImportTask): boolean {
    const maxAttempts = this.taskConfig.maxAttempts ?? FALLBACK_MAX_ATTEMPTS;
    return (task.attempts ?? 0) + 1 >= maxAttempts;
  }
}
