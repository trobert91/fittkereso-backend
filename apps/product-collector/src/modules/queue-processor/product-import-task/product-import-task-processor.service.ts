import { Injectable } from '@nestjs/common';
import {
  ProductSourceConfigInvalidError,
  ProductSourceConfigValidatorService,
  ProductImportTaskKind,
  ProductImportTask,
  systemActor,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import {
  ArukeresoFeedEntryService,
  ProductDetailsPageScraperService,
  ProductListPageScraperService,
} from '@fittkereso-backend/product-scraper';
import { ProductSourceVersionService } from '@fittkereso-backend/product';

// Routes a task by kind: the two page scrapers and the feed row importer all
// derive everything from task.source.config (and a feed row from its payload),
// so there is no per-source branching.
@Injectable()
export class ProductImportTaskProcessorService {
  private readonly logger = new CustomLogger(ProductImportTaskProcessorService.name);

  constructor(
    private readonly listScraper: ProductListPageScraperService,
    private readonly detailsScraper: ProductDetailsPageScraperService,
    private readonly feedEntries: ArukeresoFeedEntryService,
    private readonly configValidator: ProductSourceConfigValidatorService,
    private readonly versionService: ProductSourceVersionService,
  ) {}

  public async process(task: ProductImportTask): Promise<void> {
    this.logger.debug(`Dispatching ${task.kind} import task`, {
      taskId: task.id,
      kind: task.kind,
      url: task.url,
      sourceId: task.source.id,
      sourceName: task.source.name,
    });

    // BEFORE the dispatch, and therefore before either scraper fetches the
    // page. A config we already know cannot be interpreted must not cost a
    // Zyte call, and failing here reports the actual problem instead of
    // whatever the pipeline happens to throw once it reaches the bad op.
    await this.assertConfigValid(task);

    switch (task.kind) {
      case ProductImportTaskKind.ListPage:
        await this.listScraper.scrapeListPage(task);
        break;
      case ProductImportTaskKind.DetailPage:
        await this.detailsScraper.scrapeProductDetailsPage(task);
        break;
      case ProductImportTaskKind.FeedEntry:
        await this.feedEntries.importEntry(task);
        break;
      default:
        this.logger.error(`Unknown import task kind: ${task.kind}`, undefined, {
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
  private async assertConfigValid(task: ProductImportTask): Promise<void> {
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
        { problems, taskId: task.id, kind: task.kind, url: task.url },
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
