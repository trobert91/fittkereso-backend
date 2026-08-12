import { Injectable } from '@nestjs/common';
import {
  ProductSourceSyncService,
  ProductSourceSyncOptions,
} from '../../interfaces/product-source-sync-service.interface';
import {
  ProductSource,
  ScrapeQueueName,
  ScrapeTask,
} from '@fittkereso-backend/database';
import { ArukeresoIndexPageService } from './arukereso-index-page.service';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductCollectionMetricsService } from '@fittkereso-backend/metrics';
import { ScrapeTaskPublisherService } from '@fittkereso-backend/task';
import { isEmpty } from 'lodash';
import { WebLink } from '@fittkereso-backend/product';

@Injectable()
export class ArukeresoSyncService implements ProductSourceSyncService {
  private readonly logger = new CustomLogger(ArukeresoSyncService.name);

  constructor(
    private readonly indexService: ArukeresoIndexPageService,
    private readonly scrapeTaskPublisher: ScrapeTaskPublisherService,
    private readonly productCollectionMetrics: ProductCollectionMetricsService,
  ) {}

  public async sync(
    source: ProductSource,
    options?: ProductSourceSyncOptions,
  ): Promise<void> {
    const startTime = Date.now();
    this.logger.debug('Starting sync for arukereso.hu');

    try {
      const sourceTitles = options?.sourceTitles ?? [];
      if (isEmpty(sourceTitles)) {
        this.logger.warn(
          'Arukereso full sync: no source titles provided, skipping',
        );
        this.productCollectionMetrics.recordCategoriesDiscovered(
          source.type,
          0,
        );
        this.productCollectionMetrics.fullSyncCompleted(source.type);
        this.productCollectionMetrics.recordFullSyncDuration(
          source.type,
          (Date.now() - startTime) / 1000,
        );
        return;
      }

      const categoryLinks = await this.indexService.fetchCategoryLinks(
        source,
        sourceTitles,
      );

      this.logger.debug(
        `Category links found: ${JSON.stringify(categoryLinks)}`,
      );

      this.productCollectionMetrics.recordCategoriesDiscovered(
        source.type,
        categoryLinks.length,
      );

      await this.syncCategories(source, categoryLinks);

      this.productCollectionMetrics.fullSyncCompleted(source.type);
      this.productCollectionMetrics.recordFullSyncDuration(
        source.type,
        (Date.now() - startTime) / 1000,
      );
    } catch (error: unknown) {
      this.productCollectionMetrics.fullSyncFailed(source.type);
      this.productCollectionMetrics.recordFullSyncDuration(
        source.type,
        (Date.now() - startTime) / 1000,
      );
      throw error;
    }
  }

  private async syncCategories(
    source: ProductSource,
    categoryLinks: WebLink[],
  ): Promise<void> {
    this.logger.debug(`Creating tasks for ${categoryLinks.length} categories`);

    const validLinks = categoryLinks.filter(({ url }) => !isEmpty(url));

    const tasks = validLinks.map(({ url }) => {
      const task = new ScrapeTask();
      task.queue = ScrapeQueueName.ScrapeProductList;
      task.source = source;

      task.url = url;
      return this.scrapeTaskPublisher.addTask(task);
    });

    await Promise.all(tasks);

    this.productCollectionMetrics.recordListTasksCreated(
      source.type,
      validLinks.length,
    );

    this.logger.debug(
      `Finished creating tasks for ${categoryLinks.length} categories`,
    );
  }
}
