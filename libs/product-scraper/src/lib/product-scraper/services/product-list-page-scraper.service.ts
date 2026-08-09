import { ScraperService } from "@ebike-backend/scraper";
import { ScrapeTaskPublisherService } from "@ebike-backend/task";
import { ScrapeUrlDeduplicationService } from "./scrape-url-deduplication.service";
import { CustomLogger } from "@ebike-backend/logger";
import { ScrapeQueueName, ScrapeTask } from "@ebike-backend/database";
import * as cheerio from "cheerio";
import { compact, isEmpty } from "lodash";
import { ListPageExtractor } from "../interfaces/list-page-extractor.interface";
import { Injectable } from "@nestjs/common";
import { WebLink } from "@ebike-backend/product";
import { ProductCollectionMetricsService } from "@ebike-backend/metrics";

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
  ) {}

  public async scrapeListPage(
    task: ScrapeTask,
    listPageExtractor: ListPageExtractor,
  ): Promise<void> {
    const html = await this.scraperService.getHtml(task.url);
    const $ = cheerio.load(html);

    const categoryName = listPageExtractor.getCategoryName(task, $);
    const categoryLinks = await listPageExtractor.getCategoryLinks(task, $);
    const productLinks = await listPageExtractor.getProductLinks(task, $);

    const sourceType = task.source.type;

    this.productCollectionMetrics.recordProductsFound(
      sourceType,
      productLinks.length,
    );

    const categoryTasks = await this.createCategoryTasks(task, categoryLinks);
    const productTasks = await this.createProductTasks(
      categoryName,
      task,
      productLinks,
    );

    this.productCollectionMetrics.recordDetailTasksCreated(
      sourceType,
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
      this.logger.warn("Skipping link with empty URL or name", {
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
          parentTask.source.type,
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
      this.logger.error("Error checking dedup for product link", {
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
