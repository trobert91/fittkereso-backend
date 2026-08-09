import { Injectable } from "@nestjs/common";
import { ScrapeQueueName, ScrapeTask } from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import {
  DisplayspecsDetailsPageExtractor,
  DisplayspecsListPageExtractor,
  ProductDetailsPageScraperService,
  ProductListPageScraperService,
} from "@ebike-backend/product-scraper";

@Injectable()
export class DisplayspecsQueueProcessorService {
  private readonly logger = new CustomLogger(
    DisplayspecsQueueProcessorService.name,
  );

  constructor(
    private readonly listScraper: ProductListPageScraperService,
    private readonly detailsScraper: ProductDetailsPageScraperService,
    private readonly listPageExtractor: DisplayspecsListPageExtractor,
    private readonly detailsPageExtractor: DisplayspecsDetailsPageExtractor,
  ) {}

  public async process(task: ScrapeTask): Promise<void> {
    this.logger.log(`Processing Displayspecs scrape task with ID: ${task.id}`);

    switch (task.queue) {
      case ScrapeQueueName.ScrapeProductList:
        await this.listScraper.scrapeListPage(task, this.listPageExtractor);
        break;
      case ScrapeQueueName.ScrapeProductDetails:
        await this.detailsScraper.scrapeProductDetailsPage(
          task,
          this.detailsPageExtractor,
        );
        break;
      default:
        this.logger.error(`Unknown queue name: ${task.queue}`, {
          taskId: task.id,
          url: task.url,
        });
    }
  }
}
