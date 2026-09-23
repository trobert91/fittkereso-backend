import { Injectable } from '@nestjs/common';
import {
  ProductSourceConfigInvalidError,
  ProductSourceConfigValidatorService,
  ScrapeQueueName,
  ScrapeTask,
  systemActor,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import {
  ProductDetailsPageScraperService,
  ProductListPageScraperService,
} from '@fittkereso-backend/product-scraper';
import { ProductSourceVersionService } from '@fittkereso-backend/product';

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
    private readonly configValidator: ProductSourceConfigValidatorService,
    private readonly versionService: ProductSourceVersionService,
  ) {}

  public async process(task: ScrapeTask): Promise<void> {
    this.logger.debug(`Dispatching scrape task to ${task.queue} handler`, {
      taskId: task.id,
      queue: task.queue,
      url: task.url,
      sourceId: task.source.id,
      sourceName: task.source.name,
    });

    // BEFORE the dispatch, and therefore before either scraper fetches the
    // page. A config we already know cannot be interpreted must not cost a
    // Zyte call, and failing here reports the actual problem instead of
    // whatever the pipeline happens to throw once it reaches the bad op.
    await this.assertConfigValid(task);

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

  /**
   * Refuses a task whose source config no longer matches the schema.
   *
   * Every save path validates too, so this catches the configs that were
   * written before the schema existed or before an op was renamed — ones that
   * were valid under the rules of their own day.
   *
   * The task manager turns this into a terminal failure, so a broken source
   * fails each queued task once with a readable reason rather than three times
   * behind a backoff.
   */
  private async assertConfigValid(task: ScrapeTask): Promise<void> {
    const problems = this.configValidator.problems(
      task.source.type,
      task.source.config,
    );
    if (!problems) {
      return;
    }

    try {
      await this.versionService.recordAction(
        task.source,
        'config_validation_failed',
        { problems, taskId: task.id, queue: task.queue, url: task.url },
        systemActor('scheduler'),
      );
    } catch (recordError: unknown) {
      // An audit write must never replace the failure it is describing.
      this.logger.warn('Failed to record config validation failure', {
        sourceId: task.source.id,
        error:
          recordError instanceof Error ? recordError.message : String(recordError),
      });
    }

    throw new ProductSourceConfigInvalidError(task.source, problems);
  }
}
