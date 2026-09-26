import { ScraperService } from '@fittkereso-backend/scraper';
import { ScrapeUrlDeduplicationService } from './scrape-url-deduplication.service';
import {
  emptyOutcomeCounts,
  ListProductRefreshService,
} from './list-product-refresh.service';
import { DetailTaskCapService } from './detail-task-cap.service';
import { CustomLogger } from '@fittkereso-backend/logger';
import {
  asScrapingConfig,
  ScrapedListProduct,
  ProductImportTaskKind,
  ProductImportTask,
} from '@fittkereso-backend/database';
import * as cheerio from 'cheerio';
import { compact, isEmpty } from 'lodash';
import { Injectable } from '@nestjs/common';
import { ProductCollectionMetricsService } from '@fittkereso-backend/metrics';
import { ScrapeInterpreterService } from '@fittkereso-backend/scrape-interpreter';
import { matchesFilter } from './source-item-filter';

@Injectable()
export class ProductListPageScraperService {
  private readonly logger = new CustomLogger(
    ProductListPageScraperService.name,
  );

  constructor(
    private readonly scraperService: ScraperService,
    private readonly scrapeUrlDedup: ScrapeUrlDeduplicationService,
    private readonly listProductRefresh: ListProductRefreshService,
    private readonly productCollectionMetrics: ProductCollectionMetricsService,
    private readonly interpreter: ScrapeInterpreterService,
    private readonly detailTaskCap: DetailTaskCapService,
  ) {}

  /**
   * Parse one list page and act on each card.
   *
   * Enqueues detail tasks only, never further list pages: category expansion
   * and pagination are resolved once per run by ScrapingImportService, which is
   * what makes a self-paginating listing unable to re-emit its own page range.
   */
  public async scrapeListPage(task: ProductImportTask): Promise<void> {
    const sourceName = task.source.name;

    this.logger.debug('Scraping list page', {
      taskId: task.id,
      url: task.url,
      sourceName,
    });

    const config = asScrapingConfig(task.source.config, sourceName);
    const html = await this.scraperService.getHtml(task.url, task.source.fetchMode);
    const $ = cheerio.load(html);

    const { categoryName, products } = await this.interpreter.runListPage(
      task,
      $,
      config,
    );

    this.productCollectionMetrics.recordProductsFound(
      sourceName,
      products.length,
    );

    // Applied to the CARDS, before any decision is made about them: a card
    // rejected here is a paid detail fetch not spent, which is the whole point
    // of filtering at this layer rather than after extraction.
    const selected = config.filter
      ? products.filter((item) =>
          matchesFilter(config.filter, (field) => this.cardValue(item, field)),
        )
      : products;

    // Every card is looked at, whatever `maxItems` says: a card refreshed in
    // place costs no task. The cap applies only to the detail tasks queued
    // below, counted across the whole run (DetailTaskCapService).
    const outcomes = emptyOutcomeCounts();
    const needingDetail: ScrapedListProduct[] = [];

    for (const item of selected) {
      if (isEmpty(item?.url)) continue;

      try {
        const outcome = await this.listProductRefresh.tryRefresh(
          task.source,
          item,
        );
        outcomes[outcome] += 1;

        // Only 'refreshed' avoids the detail fetch. Everything else — a card
        // too thin for the minimum set, a listing due its periodic detail
        // scrape, an unseen or ambiguously moved listing, an ambiguous
        // multi-offer record — falls back to the authoritative path.
        if (outcome !== 'refreshed') needingDetail.push(item);
      } catch (error) {
        // A refresh failure must not lose the item; fall back to the detail
        // scrape, which would have been the old behaviour anyway.
        this.logger.error('Failed to refresh list item, falling back', error, {
          taskId: task.id,
          url: item.url,
        });
        needingDetail.push(item);
      }
    }

    const detailTasks = await this.createDetailTasks(task, needingDetail);
    const { queued, capped } = await this.detailTaskCap.queue({
      listTask: task,
      tasks: detailTasks,
      maxItems: config.maxItems,
    });

    this.productCollectionMetrics.recordDetailTasksCreated(sourceName, queued);

    this.logger.debug('List page scrape complete', {
      taskId: task.id,
      url: task.url,
      sourceName,
      categoryName,
      productsFound: products.length,
      afterFilter: selected.length,
      maxItems: config.maxItems ?? null,
      ...outcomes,
      detailTasksCreated: queued,
      detailTasksCapped: capped,
    });
  }

  /**
   * Resolve a filter condition's `field` against a list card.
   *
   * A card is a fixed interface rather than an arbitrary column set, so this is
   * a plain property read — the feed's equivalent has to do normalized-name
   * matching instead. Both feed the same matcher.
   */
  private cardValue(item: ScrapedListProduct, field: string): unknown {
    return (item as unknown as Record<string, unknown>)[field];
  }

  private async createDetailTasks(
    parentTask: ProductImportTask,
    items: ScrapedListProduct[],
  ): Promise<ProductImportTask[]> {
    return compact(
      await Promise.all(
        items.map((item) => this.createDetailTaskForItem(parentTask, item)),
      ),
    );
  }

  private async createDetailTaskForItem(
    parentTask: ProductImportTask,
    item: ScrapedListProduct,
  ): Promise<ProductImportTask | undefined> {
    try {
      // Only the in-flight layer applies here. The "already has a record" layer
      // is now the refresh decision above — permanently skipping known URLs is
      // exactly what made every previous run discovery-only.
      const dedup = await this.scrapeUrlDedup.isDuplicate(
        parentTask.source.id,
        item.url,
        { taskId: parentTask.id, linkTitle: item.name ?? '' },
      );

      if (dedup.isDuplicate) {
        this.productCollectionMetrics.productSkipped(
          parentTask.source.name,
          dedup.reason!,
        );
        return;
      }

      const task = new ProductImportTask();
      task.source = parentTask.source;
      task.kind = ProductImportTaskKind.DetailPage;
      task.url = item.url;
      // What the page must still show when the task runs (see
      // ProductDetailsPageScraperService.assertCardsProduct).
      task.externalId = item.externalId ?? null;
      // The list page's own: its detail pages are the same piece of work.
      task.priority = parentTask.priority;

      return task;
    } catch (error) {
      this.logger.error('Error checking dedup for list item', error, {
        taskId: parentTask.id,
        parentUrl: parentTask.url,
        itemUrl: item.url,
      });
      return;
    }
  }
}
