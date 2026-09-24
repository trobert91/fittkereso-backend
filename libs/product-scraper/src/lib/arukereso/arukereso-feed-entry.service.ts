import { Injectable } from '@nestjs/common';
import {
  asArukeresoConfig,
  ProductImportTask,
  ProductImportTaskRepository,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductCollectionMetricsService } from '@fittkereso-backend/metrics';
import { contextFromTask } from '../interfaces/product-import-context.interface';
import { ProductScrapeUpdaterService } from '../product-scraper/services/product-scrape-updater.service';
import { ArukeresoProductMapperService } from './arukereso-product-mapper.service';
import { asFeedEntryPayload, feedRowHash } from './feed-row-hash';

/**
 * Imports one feed row, as a feed_entry task.
 *
 * The row is mapped again here, with the source's config as it is now rather
 * than as it was when the feed run queued it: a task queued before a config
 * fix imports under the fix. A row the config now rejects finishes without
 * importing anything, and is counted by reason.
 */
@Injectable()
export class ArukeresoFeedEntryService {
  private readonly logger = new CustomLogger(ArukeresoFeedEntryService.name);

  constructor(
    private readonly taskRepo: ProductImportTaskRepository,
    private readonly mapper: ArukeresoProductMapperService,
    private readonly productUpdater: ProductScrapeUpdaterService,
    private readonly productCollectionMetrics: ProductCollectionMetricsService,
  ) {}

  public async importEntry(task: ProductImportTask): Promise<void> {
    const payload = asFeedEntryPayload(await this.taskRepo.loadPayload(task.id));
    if (!payload) {
      throw new Error(`Feed entry task ${task.id} carries no feed row`);
    }

    const mapped = await this.mapper.map({
      config: asArukeresoConfig(task.source.config, task.source.name),
      item: payload.item,
      requestedSlugs: payload.requestedSlugs,
    });

    if (mapped.status === 'skipped') {
      this.productCollectionMetrics.feedEntrySkippedAt(task.source.name, mapped.reason);
      this.logger.debug('Feed row no longer imported under the current config', {
        taskId: task.id,
        url: task.url,
        source: task.source.name,
        reason: mapped.reason,
      });
      return;
    }

    await this.productUpdater.createOrUpdateProduct(
      {
        ...contextFromTask(task),
        url: mapped.url,
        feedRowHash: feedRowHash(mapped.url, mapped.scrapedProduct),
      },
      mapped.scrapedProduct,
    );
  }
}
