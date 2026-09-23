import { Injectable } from '@nestjs/common';
import {
  asArukeresoConfig,
  ArukeresoSourceConfig,
  ProductSource,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductCollectionMetricsService } from '@fittkereso-backend/metrics';
import { NativeScraperService } from '@fittkereso-backend/scraper';
import {
  emptyImportRunSummary,
  ImportRunOptions,
  ImportRunSummary,
  ProductSourceImporter,
} from '../interfaces/product-source-importer.interface';
import { ProductImportContext } from '../interfaces/product-import-context.interface';
import { ProductScrapeUpdaterService } from '../product-scraper/services/product-scrape-updater.service';
import { ArukeresoFeedParserService } from './arukereso-feed-parser.service';
import { ArukeresoFeedItem } from './arukereso-feed-item';
import {
  ArukeresoProductMapperService,
  FeedSkipReason,
} from './arukereso-product-mapper.service';

/**
 * How many consecutive per-item failures end the run.
 *
 * A handful of bad rows in a 3488-product feed is normal and must not abandon
 * the other 3487. A long unbroken streak is not a data problem — it is the
 * database being down, or a config that no longer matches the feed — and
 * continuing then just writes the same failure 3000 more times.
 */
export const MAX_CONSECUTIVE_ITEM_FAILURES = 50;

/**
 * The `arukereso` importer: fetch one feed, convert it, persist every item.
 *
 * The opposite shape to ScrapingImportService, which enqueues tasks and
 * returns. A feed is one HTTP GET containing the whole catalogue, so there is
 * nothing to fan out to — the run completes inline, and its cost is the LLM
 * post-process pass rather than page fetches. That is also why the hash-based
 * skips in SpecPostProcessService matter so much here: without them a nightly
 * pass over speedbike's 3488 products would be thousands of LLM calls for a
 * catalogue that barely moved.
 *
 * Items are processed one at a time, as the parser yields them. Sequential
 * rather than batched on purpose: identity resolution reads and writes shared
 * ProductModel rows, so two items for the same product resolving concurrently
 * would race to create it.
 */
@Injectable()
export class ArukeresoImportService implements ProductSourceImporter {
  readonly type = 'arukereso' as const;

  private readonly logger = new CustomLogger(ArukeresoImportService.name);

  constructor(
    private readonly nativeScraper: NativeScraperService,
    private readonly feedParser: ArukeresoFeedParserService,
    private readonly mapper: ArukeresoProductMapperService,
    private readonly productUpdater: ProductScrapeUpdaterService,
    private readonly productCollectionMetrics: ProductCollectionMetricsService,
  ) {}

  public async import(
    source: ProductSource,
    options?: ImportRunOptions,
  ): Promise<ImportRunSummary> {
    const startTime = Date.now();
    const summary = emptyImportRunSummary();
    const config = asArukeresoConfig(source.config, source.name);
    const skips: Partial<Record<FeedSkipReason, number>> = {};

    let consecutiveFailures = 0;
    let capped = false;

    try {
      const { stream, contentType } = await this.nativeScraper.stream(
        config.feedUrl,
      );

      const parsed = await this.feedParser.parseStream(
        stream,
        async (item) => {
          // The cap counts items IMPORTED, not items seen — with a filter
          // alongside it, `maxItems: 10` means ten matching products, not ten
          // attempts. Once reached, the remaining feed rows cost one no-op call
          // each: the stream is already open and parsing the rest is cheap,
          // whereas aborting mid-parse is not, so the run reads the feed out
          // and simply stops importing.
          if (config.maxItems !== undefined && summary.offersUpdated >= config.maxItems) {
            capped = true;
            return;
          }

          const outcome = await this.handleItem({
            source,
            config,
            item,
            requestedSlugs: options?.categorySlugs,
            summary,
            skips,
          });

          consecutiveFailures = outcome === 'failed' ? consecutiveFailures + 1 : 0;
          if (consecutiveFailures >= MAX_CONSECUTIVE_ITEM_FAILURES) {
            throw new Error(
              `Abandoning feed import for "${source.name}": ${consecutiveFailures} consecutive items failed, which is a systemic problem rather than bad rows`,
            );
          }
        },
        {
          format: config.format ?? 'auto',
          delimiter: config.csv?.delimiter ?? 'auto',
          contentType,
        },
      );

      summary.itemsSeen = parsed.itemsParsed;

      this.productCollectionMetrics.fullSyncCompleted(source.name);
      this.recordDuration(source, startTime);

      this.logger.log('Árukereső feed import completed', {
        source: source.name,
        feedUrl: config.feedUrl,
        format: parsed.format,
        itemsSeen: summary.itemsSeen,
        attributesSkipped: parsed.attributesSkipped,
        maxItems: config.maxItems ?? null,
        capped,
        offersUpdated: summary.offersUpdated,
        skipped: summary.skipped,
        failed: summary.failed,
        skipReasons: skips,
      });

      return summary;
    } catch (error) {
      this.productCollectionMetrics.fullSyncFailed(source.name);
      this.recordDuration(source, startTime);
      this.logger.error('Árukereső feed import failed', error, {
        source: source.name,
        feedUrl: config.feedUrl,
        itemsSeen: summary.itemsSeen,
        offersUpdated: summary.offersUpdated,
      });
      throw error;
    }
  }

  /**
   * Map one item and persist it, tallying the outcome.
   *
   * Never throws for a single bad item — one malformed row must not abandon a
   * catalogue. The consecutive-failure ceiling in the caller is what
   * distinguishes that from a systemic failure.
   */
  private async handleItem(params: {
    source: ProductSource;
    config: ArukeresoSourceConfig;
    item: ArukeresoFeedItem;
    requestedSlugs: string[] | undefined;
    summary: ImportRunSummary;
    skips: Partial<Record<FeedSkipReason, number>>;
  }): Promise<'updated' | 'skipped' | 'failed'> {
    const { source, config, item, requestedSlugs, summary, skips } = params;

    try {
      const mapped = await this.mapper.map({
        source,
        config,
        item,
        requestedSlugs,
      });

      if (mapped.status === 'skipped') {
        summary.skipped += 1;
        skips[mapped.reason] = (skips[mapped.reason] ?? 0) + 1;
        return 'skipped';
      }

      // No `task`: a feed run has no ScrapeTask per item, and inventing one
      // would put fake work in a table the workers poll. Everything downstream
      // of here is the same code the scrape path runs.
      const context: ProductImportContext = {
        source,
        url: mapped.url,
      };

      const model = await this.productUpdater.createOrUpdateProduct(
        context,
        mapped.scrapedProduct,
      );

      if (!model) {
        // The updater already logged and metered why (no category, or brand
        // resolution failed). Counted as skipped rather than failed: nothing
        // went wrong, the product simply was not persistable.
        summary.skipped += 1;
        return 'skipped';
      }

      summary.offersUpdated += 1;
      return 'updated';
    } catch (error) {
      summary.failed += 1;
      this.logger.warn('Feed item failed, continuing', {
        source: source.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    }
  }

  private recordDuration(source: ProductSource, startTime: number): void {
    this.productCollectionMetrics.recordFullSyncDuration(
      source.name,
      (Date.now() - startTime) / 1000,
    );
  }
}
