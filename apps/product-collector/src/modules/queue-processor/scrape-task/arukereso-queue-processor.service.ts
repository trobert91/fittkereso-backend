import { Injectable } from '@nestjs/common';
import { ScrapeQueueName, ScrapeTask } from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import {
  ArukeresoDetailsPageExtractor,
  ArukeresoListPageExtractor,
  ProductDetailsPageScraperService,
  ProductListPageScraperService,
} from '@fittkereso-backend/product-scraper';

@Injectable()
export class ArukeresoQueueProcessorService {
  private readonly logger = new CustomLogger(
    ArukeresoQueueProcessorService.name,
  );

  constructor(
    private readonly listScraper: ProductListPageScraperService,
    private readonly detailsScraper: ProductDetailsPageScraperService,
    private readonly listPageExtractor: ArukeresoListPageExtractor,
    private readonly detailsPageExtractor: ArukeresoDetailsPageExtractor,
  ) {}

  public async process(task: ScrapeTask): Promise<void> {
    this.logger.log(`Processing Arukereso scrape task with ID: ${task.id}`);

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
