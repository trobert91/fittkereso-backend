import { Injectable } from '@nestjs/common';
import { ProductImportTaskRepository, TaskStatus } from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { normalizeUrl } from '@fittkereso-backend/utils';

export type DeduplicationReason = 'existing_task';

export interface DeduplicationResult {
  isDuplicate: boolean;
  reason?: DeduplicationReason;
}

/**
 * Stops two in-flight import tasks existing for the same URL.
 *
 * There used to be a second layer, checked first: any URL that already had a
 * ProductSourceRecord was skipped permanently. That is precisely what made
 * every run discovery-only — a listing was scraped once and then never
 * revisited, so its price, stock and specs went stale forever.
 *
 * Refreshing is now decided per card by ListProductRefreshService, which either
 * updates the offer in place or asks for a detail scrape. Either way "we
 * already know this URL" is an argument for revisiting it, not against — so
 * that layer had to go rather than be narrowed.
 */
@Injectable()
export class ScrapeUrlDeduplicationService {
  private readonly logger = new CustomLogger(
    ScrapeUrlDeduplicationService.name,
  );

  constructor(private readonly importTaskRepo: ProductImportTaskRepository) {}

  public async isDuplicate(
    sourceId: string,
    rawUrl: string,
    logContext?: Record<string, string>,
  ): Promise<DeduplicationResult> {
    // Stored task URLs are normalized, so the probe has to be too — callers
    // pass the URL straight off a scraped card, which is not.
    const url = normalizeUrl(rawUrl);

    const existingTask = await this.importTaskRepo.findExistingUrl(sourceId, url, [
      TaskStatus.PENDING,
      TaskStatus.PROCESSING,
    ]);

    if (existingTask) {
      this.logger.debug('Skipped: in-flight task already exists for URL', {
        url,
        sourceId,
        taskId: existingTask.id,
        taskStatus: existingTask.status,
        reason: 'existing_task',
        ...logContext,
      });
      return { isDuplicate: true, reason: 'existing_task' };
    }

    return { isDuplicate: false };
  }
}
