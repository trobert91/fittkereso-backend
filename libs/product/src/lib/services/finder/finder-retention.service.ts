import { Injectable } from '@nestjs/common';
import { FinderVisitorRepository } from '@fittkereso-backend/database';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';

/** Days a visitor's saved finder results are kept after their last visit: 6 months. */
export const DEFAULT_FINDER_RETENTION_DAYS = 183;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface FinderRetentionResult {
  deleted: number;
  cutoff: Date;
}

/**
 * Deletes the website's finder visitors (FinderVisitor) not seen for
 * `finder.retentionDays`, and their saved results with them (cascade).
 *
 * The website writes these rows when a visitor saves a finder result, and
 * refreshes `lastSeenAt` while the visitor keeps using it. Its privacy notice
 * promises the data is gone after that period of disuse.
 */
@Injectable()
export class FinderRetentionService {
  constructor(
    private readonly visitorRepo: FinderVisitorRepository,
    private readonly dynamicConfig: DynamicConfigService,
  ) {}

  get retentionDays(): number {
    return this.dynamicConfig.finder?.retentionDays ?? DEFAULT_FINDER_RETENTION_DAYS;
  }

  async deleteExpired(now: Date = new Date()): Promise<FinderRetentionResult> {
    const cutoff = new Date(now.getTime() - this.retentionDays * MS_PER_DAY);
    const deleted = await this.visitorRepo.deleteNotSeenSince(cutoff);
    return { deleted, cutoff };
  }
}
