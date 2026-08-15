import { ScraperService } from '@fittkereso-backend/scraper';
import { ScrapeTaskPublisherService } from '@fittkereso-backend/task';
import { ScrapeUrlDeduplicationService } from './scrape-url-deduplication.service';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ScrapeQueueName, ScrapeTask } from '@fittkereso-backend/database';
import * as cheerio from 'cheerio';
import { compact, isEmpty } from 'lodash';
import { Injectable } from '@nestjs/common';
import { WebLink } from '@fittkereso-backend/product';
import { ProductCollectionMetricsService } from '@fittkereso-backend/metrics';
import { ScrapeInterpreterService } from '@fittkereso-backend/scrape-interpreter';

@Injectable()
export class ProductListPageScraperService {
  private readonly logger = new CustomLogger(
    ProductListPageScraperService.name,
  );

  constructor(
    private readonly scraperService: ScraperService,
    private readonly scrapeTaskPublisher: ScrapeTaskPublisherService,
    private readonly scrapeUrlDedup: ScrapeUrlDeduplicationService,
    private readonly productCollectionMetrics: ProductCollectionMetricsService,
    private readonly interpreter: ScrapeInterpreterService,
  ) {}

  public async scrapeListPage(task: ScrapeTask): Promise<void> {
    const html = await this.scraperService.getHtml(task.url);
    const $ = cheerio.load(html);

    const { categoryName, categoryLinks, productLinks } =
      await this.interpreter.runListPage(task, $, task.source.config);

    const sourceName = task.source.name;

    this.productCollectionMetrics.recordProductsFound(
      sourceName,
      productLinks.length,
    );

    const categoryTasks = await this.createCategoryTasks(task, categoryLinks);
    const productTasks = await this.createProductTasks(
      categoryName,
      task,
      productLinks,
    );

    this.productCollectionMetrics.recordDetailTasksCreated(
      sourceName,
      productTasks.length,
    );

    await this.scrapeTaskPublisher.addTasks([
      ...categoryTasks,
      ...productTasks,
    ]);
  }

  private async createCategoryTasks(
    parentTask: ScrapeTask,
    links: WebLink[],
  ): Promise<ScrapeTask[]> {
    return links.map((link) => {
      const task = new ScrapeTask();
      task.source = parentTask.source;
      task.queue = ScrapeQueueName.ScrapeProductList;
      task.url = link.url;

      return task;
    });
  }

  private async createProductTasks(
    categoryName: string | undefined,
    task: ScrapeTask,
    links: WebLink[],
  ): Promise<ScrapeTask[]> {
    return compact(
      await Promise.all(
        links.map((link) =>
          this.createProductTaskForLink(categoryName, task, link),
        ),
      ),
    );
  }

  private async createProductTaskForLink(
    categoryName: string | undefined,
    parentTask: ScrapeTask,
    link: WebLink,
  ): Promise<ScrapeTask | undefined> {
    if (isEmpty(link.url) || isEmpty(link.title)) {
      this.logger.warn('Skipping link with empty URL or name', {
        taskId: parentTask.id,
        parentUrl: parentTask.url,
        link,
      });
      return;
    }

    try {
      const dedup = await this.scrapeUrlDedup.isDuplicate(link.url, {
        taskId: parentTask.id,
        linkTitle: link.title,
      });

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
      task.url = link.url;

      return task;
    } catch (error) {
      this.logger.error('Error checking dedup for product link', {
        taskId: parentTask.id,
        parentUrl: parentTask.url,
        linkUrl: link.url,
        linkTitle: link.title,
        error,
      });
      return;
    }
  }
}
