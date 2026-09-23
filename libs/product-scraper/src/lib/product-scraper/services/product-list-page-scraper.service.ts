import { ScraperService } from '@fittkereso-backend/scraper';
import { ScrapeTaskPublisherService } from '@fittkereso-backend/task';
import { ScrapeUrlDeduplicationService } from './scrape-url-deduplication.service';
import { ListProductRefreshService } from './list-product-refresh.service';
import { CustomLogger } from '@fittkereso-backend/logger';
import {
  asScrapingConfig,
  ScrapedListProduct,
  ScrapeQueueName,
  ScrapeTask,
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
    private readonly scrapeTaskPublisher: ScrapeTaskPublisherService,
    private readonly scrapeUrlDedup: ScrapeUrlDeduplicationService,
    private readonly listProductRefresh: ListProductRefreshService,
    private readonly productCollectionMetrics: ProductCollectionMetricsService,
    private readonly interpreter: ScrapeInterpreterService,
  ) {}

  /**
   * Parse one list page and act on each card.
   *
   * Enqueues detail tasks only, never further list pages: category expansion
   * and pagination are resolved once per run by ScrapingImportService, which is
   * what makes a self-paginating listing unable to re-emit its own page range.
   */
  public async scrapeListPage(task: ScrapeTask): Promise<void> {
    const sourceName = task.source.name;

    this.logger.debug('Scraping list page', {
      taskId: task.id,
      url: task.url,
      sourceName,
    });

    const config = asScrapingConfig(task.source.config, sourceName);
    const html = await this.scraperService.getHtml(task.url);
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

    // `maxItems` caps PER PAGE here — each list page is its own task, so there
    // is no run-scoped counter to share. ScrapingImportService compensates by
    // enumerating only the first page of each listing when the cap is set; see
    // ScrapingSourceConfig.maxItems.
    const items =
      config.maxItems !== undefined
        ? selected.slice(0, config.maxItems)
        : selected;

    const outcomes = { refreshed: 0, incomplete: 0, unknown: 0, no_offer: 0 };
    const needingDetail: ScrapedListProduct[] = [];

    for (const item of items) {
      if (isEmpty(item?.url)) continue;

      try {
        const outcome = await this.listProductRefresh.tryRefresh(
          task.source,
          item,
        );
        outcomes[outcome] += 1;

        // Only 'refreshed' avoids the detail fetch. Everything else — a card
        // too thin for the minimum set, an unseen listing, an ambiguous
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

    this.productCollectionMetrics.recordDetailTasksCreated(
      sourceName,
      detailTasks.length,
    );

    if (!isEmpty(detailTasks)) {
      await this.scrapeTaskPublisher.addTasks(detailTasks);
    }

    this.logger.debug('List page scrape complete', {
      taskId: task.id,
      url: task.url,
      sourceName,
      categoryName,
      productsFound: products.length,
      afterFilter: selected.length,
      processed: items.length,
      maxItems: config.maxItems ?? null,
      ...outcomes,
      detailTasksCreated: detailTasks.length,
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
    parentTask: ScrapeTask,
    items: ScrapedListProduct[],
  ): Promise<ScrapeTask[]> {
    return compact(
      await Promise.all(
        items.map((item) => this.createDetailTaskForItem(parentTask, item)),
      ),
    );
  }

  private async createDetailTaskForItem(
    parentTask: ScrapeTask,
    item: ScrapedListProduct,
  ): Promise<ScrapeTask | undefined> {
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

      const task = new ScrapeTask();
      task.source = parentTask.source;
      task.queue = ScrapeQueueName.ScrapeProductDetails;
      task.url = item.url;

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
