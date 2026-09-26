import { Injectable } from '@nestjs/common';
import {
  asScrapingConfig,
  DEFAULT_IMPORT_TASK_PRIORITY,
  ProductSource,
  ProductImportTaskKind,
  ProductImportTask,
  ScrapingSourceConfig,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductCollectionMetricsService } from '@fittkereso-backend/metrics';
import { ProductImportTaskPublisherService } from '@fittkereso-backend/task';
import { ScrapeInterpreterService } from '@fittkereso-backend/scrape-interpreter';
import { ScraperService } from '@fittkereso-backend/scraper';
import { WebLink } from '@fittkereso-backend/product';
import * as cheerio from 'cheerio';
import { compact, isEmpty, uniq } from 'lodash';
import {
  emptyImportRunSummary,
  ImportRunOptions,
  ImportRunSummary,
  ProductSourceImporter,
} from '../../interfaces/product-source-importer.interface';
import { listPageTaskPayload } from './list-page-task-payload';

/**
 * Sanity ceiling on pages enumerated from one listing.
 *
 * A `pageCount` pipeline reads a number off the page, so a selector that rots
 * and picks up some unrelated figure would otherwise enqueue that many fetches
 * — all of them billed. Hitting this is a config problem, and it is logged as
 * one rather than silently truncating.
 */
export const MAX_PAGES_PER_LISTING = 500;

/**
 * The `scraping` importer: resolve start URLs into list-page tasks, then stop.
 *
 * Everything after that happens on the ordinary task poller. Crucially, BOTH
 * category expansion and pagination are resolved here, once per run — a
 * list-page task has no power to enqueue more list pages. That is what makes
 * the re-emission bug structurally impossible: previously a self-paginating
 * listing re-emitted its whole page range from every page it landed on, which
 * is why both live configs had to leave `categoryLinks` empty.
 */
@Injectable()
export class ScrapingImportService implements ProductSourceImporter {
  readonly types = ['scraping'] as const;

  private readonly logger = new CustomLogger(ScrapingImportService.name);

  constructor(
    private readonly scraperService: ScraperService,
    private readonly interpreter: ScrapeInterpreterService,
    private readonly importTaskPublisher: ProductImportTaskPublisherService,
    private readonly productCollectionMetrics: ProductCollectionMetricsService,
  ) {}

  public async import(
    source: ProductSource,
    _options?: ImportRunOptions,
  ): Promise<ImportRunSummary> {
    const startTime = Date.now();
    const runStartedAt = new Date(startTime);
    const summary = emptyImportRunSummary();
    const config = asScrapingConfig(source.config, source.name);

    try {
      const { categoryUrls, pageUrls } = await this.planRun(source, config);

      summary.listTasksEnqueued = await this.createListTasks(source, pageUrls, runStartedAt);

      this.productCollectionMetrics.recordCategoriesDiscovered(
        source.name,
        categoryUrls.length,
      );
      this.productCollectionMetrics.fullSyncCompleted(source.name);
      this.recordDuration(source, startTime);

      this.logger.log('Scraping import enqueued', {
        source: source.name,
        categoryUrls: categoryUrls.length,
        pageUrls: pageUrls.length,
        listTasks: summary.listTasksEnqueued,
      });

      return summary;
    } catch (error) {
      this.productCollectionMetrics.fullSyncFailed(source.name);
      this.recordDuration(source, startTime);
      throw error;
    }
  }

  /**
   * Every URL this run would visit, without enqueueing anything.
   *
   * Public so the import simulator can answer "what would tonight's run
   * actually do" by running this code rather than a reimplementation of it —
   * the page walk is precisely the part worth checking before it is trusted
   * with a shop's whole catalogue, and a second copy would be checked instead
   * of the real one. Costs one fetch per start URL and per category listing.
   */
  public async planRun(
    source: ProductSource,
    config: ScrapingSourceConfig,
  ): Promise<{ categoryUrls: string[]; pageUrls: string[] }> {
    const categoryUrls = await this.resolveCategoryUrls(source, config);
    const pageUrls = await this.expandPages(source, config, categoryUrls);

    return { categoryUrls, pageUrls };
  }

  /**
   * Start URLs, each optionally expanded into category URLs.
   *
   * A start URL that is already a listing needs no `categoryLinks`; one that
   * points at a hub page uses it to find the listings below.
   */
  private async resolveCategoryUrls(
    source: ProductSource,
    config: ScrapingSourceConfig,
  ): Promise<string[]> {
    const startUrls = compact(config.startUrls ?? []);

    if (isEmpty(startUrls)) {
      this.logger.warn('Source has no startUrls — nothing to import', {
        source: source.name,
      });
      return [];
    }

    if (!config.categoryLinks?.length) return uniq(startUrls);

    const resolved: string[] = [];
    for (const startUrl of startUrls) {
      try {
        const $ = cheerio.load(
          await this.scraperService.getHtml(startUrl, source.fetchMode),
        );
        const links =
          ((await this.interpreter.runPipeline(
            config.categoryLinks,
            this.fakeTask(source, startUrl),
            $,
            config,
          )) as WebLink[]) ?? [];

        const urls = compact(links.map((link) => link?.url));
        if (isEmpty(urls)) {
          this.logger.warn('categoryLinks resolved no URLs for a start URL', {
            source: source.name,
            startUrl,
          });
        }
        resolved.push(...urls);
      } catch (error) {
        // One bad hub page must not abandon the other start URLs.
        this.logger.error('Failed to expand start URL', error, {
          source: source.name,
          startUrl,
        });
      }
    }

    return uniq(resolved);
  }

  /**
   * Every page of every category listing, enumerated up front.
   *
   * Page 1 is fetched to read the page count, which is a pipeline rather than a
   * fixed number so the walk tracks catalog growth instead of silently
   * truncating as a shop adds products.
   */
  private async expandPages(
    source: ProductSource,
    config: ScrapingSourceConfig,
    categoryUrls: string[],
  ): Promise<string[]> {
    const pagination = config.listPage.pagination;
    if (!pagination) return categoryUrls;

    // Every page is walked even when `maxItems` is set: the cap limits the
    // detail tasks a run queues, across all its pages (DetailTaskCapService),
    // while every card can still be refreshed in place.
    const all: string[] = [];

    for (const categoryUrl of categoryUrls) {
      all.push(categoryUrl);

      try {
        const $ = cheerio.load(
          await this.scraperService.getHtml(categoryUrl, source.fetchMode),
        );
        const raw = await this.interpreter.runPipeline(
          pagination.pageCount,
          this.fakeTask(source, categoryUrl),
          $,
          config,
        );

        const pageCount = Number(raw);
        if (!Number.isFinite(pageCount) || pageCount <= 1) continue;

        const capped = Math.min(Math.floor(pageCount), MAX_PAGES_PER_LISTING);
        if (capped < pageCount) {
          this.logger.error(
            'pageCount exceeded the per-listing ceiling — check the pipeline',
            undefined,
            { source: source.name, categoryUrl, pageCount, capped },
          );
        }

        for (let page = 2; page <= capped; page += 1) {
          all.push(
            pagination.urlTemplate
              .replace(/\{\{\s*startUrl\s*\}\}/g, categoryUrl)
              .replace(/\{\{\s*baseUrl\s*\}\}/g, config.baseUrl)
              .replace(/\{\{\s*page\s*\}\}/g, String(page)),
          );
        }
      } catch (error) {
        // Page 1 is already queued above, so a failure here costs the rest of
        // that listing's pages, not the listing itself.
        this.logger.error('Failed to enumerate pages for a listing', error, {
          source: source.name,
          categoryUrl,
        });
      }
    }

    return uniq(all);
  }

  /**
   * One list task per page, each stamped with the run's start: the pages are
   * separate tasks, and that is what lets them share the run's `maxItems`.
   */
  private async createListTasks(
    source: ProductSource,
    urls: string[],
    runStartedAt: Date,
  ): Promise<number> {
    const validUrls = uniq(urls.filter((url) => !isEmpty(url)));
    if (isEmpty(validUrls)) return 0;

    await Promise.all(
      validUrls.map((url) => {
        const task = new ProductImportTask();
        task.kind = ProductImportTaskKind.ListPage;
        task.source = source;
        task.url = url;
        task.priority = DEFAULT_IMPORT_TASK_PRIORITY;
        task.payload = { ...listPageTaskPayload(runStartedAt) };
        return this.importTaskPublisher.addTask(task);
      }),
    );

    this.productCollectionMetrics.recordListTasksCreated(
      source.name,
      validUrls.length,
    );

    return validUrls.length;
  }

  /**
   * The interpreter keys its context off a ProductImportTask, but these pipelines run
   * outside any task — this run is what creates them.
   */
  private fakeTask(source: ProductSource, url: string): ProductImportTask {
    return { id: 'import', url, source } as ProductImportTask;
  }

  private recordDuration(source: ProductSource, startTime: number): void {
    this.productCollectionMetrics.recordFullSyncDuration(
      source.name,
      (Date.now() - startTime) / 1000,
    );
  }
}
