import { Injectable } from '@nestjs/common';
import {
  ProductModelSourceRepository,
  ScrapeTaskRepository,
  TaskStatus,
} from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { isEmpty } from 'lodash';

export type DeduplicationReason = 'existing_product_source' | 'existing_task';

export interface DeduplicationResult {
  isDuplicate: boolean;
  reason?: DeduplicationReason;
}

@Injectable()
export class ScrapeUrlDeduplicationService {
  private readonly logger = new CustomLogger(
    ScrapeUrlDeduplicationService.name,
  );

  constructor(
    private readonly productModelSourceRepo: ProductModelSourceRepository,
    private readonly scrapeTaskRepo: ScrapeTaskRepository,
  ) {}

  public async isDuplicate(
    url: string,
    logContext?: Record<string, string>,
  ): Promise<DeduplicationResult> {
    // Layer 1: permanent — URL already scraped into a product
    const existingSource = await this.productModelSourceRepo.findByUrl(url);
    if (existingSource) {
      this.logger.debug(
        `Skipped: URL already exists as product source on "${existingSource.model?.displayName}"`,
        {
          url,
          productId: existingSource.model?.id,
          reason: 'existing_product_source',
          ...logContext,
        },
      );
      return { isDuplicate: true, reason: 'existing_product_source' };
    }

    // Layer 2: in-flight — task already queued/processing for this URL
    const existingTask = await this.scrapeTaskRepo.findExistingUrl(url, [
      TaskStatus.PENDING,
      TaskStatus.PROCESSING,
    ]);
    if (existingTask) {
      this.logger.debug(`Skipped: in-flight task already exists for URL`, {
        url,
        taskId: existingTask.id,
        taskStatus: existingTask.status,
        reason: 'existing_task',
        ...logContext,
      });
      return { isDuplicate: true, reason: 'existing_task' };
    }

    return { isDuplicate: false };
  }

  public async findDuplicateUrls(urls: string[]): Promise<Set<string>> {
    if (isEmpty(urls)) return new Set();

    // Layer 1: permanent — already scraped into products
    const existingProductUrls =
      await this.productModelSourceRepo.findExistingUrls(urls);

    // Layer 2: in-flight — already queued/processing
    const remainingUrls = urls.filter((url) => !existingProductUrls.has(url));
    const existingTasks = await this.scrapeTaskRepo.findExistingUrls(
      remainingUrls,
      [TaskStatus.PENDING, TaskStatus.PROCESSING],
    );
    const existingTaskUrls = new Set(
      existingTasks.map((task) => task.url.toLowerCase().replace(/\/+$/, '')),
    );

    if (existingProductUrls.size > 0) {
      this.logger.debug(
        `Batch dedup: ${existingProductUrls.size} URLs already exist as product sources`,
        { urls: [...existingProductUrls] },
      );
    }

    if (existingTaskUrls.size > 0) {
      this.logger.debug(
        `Batch dedup: ${existingTaskUrls.size} URLs have in-flight tasks`,
        { urls: [...existingTaskUrls] },
      );
    }

    return new Set([...existingProductUrls, ...existingTaskUrls]);
  }
}
