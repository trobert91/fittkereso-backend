import { Injectable } from '@nestjs/common';
import { ScrapeQueueName, ScrapeTask } from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import {
  ProductDetailsPageScraperService,
  ProductListPageScraperService,
} from '@fittkereso-backend/product-scraper';

// Replaces the per-source ArukeresoQueueProcessorService/
// DisplayspecsQueueProcessorService — no source-type branching needed
// anymore, since both scraper services derive everything from
// task.source.config.
@Injectable()
export class ScrapeTaskProcessorService {
  private readonly logger = new CustomLogger(ScrapeTaskProcessorService.name);

  constructor(
    private readonly listScraper: ProductListPageScraperService,
    private readonly detailsScraper: ProductDetailsPageScraperService,
  ) {}

  public async process(task: ScrapeTask): Promise<void> {
    this.logger.debug(`Dispatching scrape task to ${task.queue} handler`, {
      taskId: task.id,
      queue: task.queue,
      url: task.url,
      sourceId: task.source.id,
      sourceName: task.source.name,
    });

    switch (task.queue) {
      case ScrapeQueueName.ScrapeProductList:
        await this.listScraper.scrapeListPage(task);
        break;
      case ScrapeQueueName.ScrapeProductDetails:
        await this.detailsScraper.scrapeProductDetailsPage(task);
        break;
      default:
        this.logger.error(`Unknown queue name: ${task.queue}`, undefined, {
          taskId: task.id,
          url: task.url,
        });
    }
  }
}
