import { Injectable } from '@nestjs/common';
import { ProductResolutionRepository } from '@fittkereso-backend/database';
import { RESOLUTION_DEFAULTS } from '@fittkereso-backend/config';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { CustomLogger } from '@fittkereso-backend/logger';

export interface ResolutionCleanupSummary {
  supersededDeleted: number;
  doneDeleted: number;
}

/**
 * Prunes the review queue's dead weight on a schedule.
 *
 * Two categories age differently on purpose:
 *
 * - `superseded` rows are pure noise the moment a newer row exists for the same
 *   situation, so they age on their own timestamp.
 * - `done` rows age on **`lastSeenAt`**, not on when they were decided. A
 *   decided row is what stops the scraper queueing the same question again, so
 *   deleting one whose listing is still being scraped would resurrect exactly
 *   the repetition this pipeline removes. Every repeat sighting touches
 *   `lastSeenAt`, so an active listing keeps its row indefinitely and only
 *   genuinely quiet ones are pruned.
 *
 * Nothing else is touched — `ProductSourceRecord`s in particular, since they are
 * what any future correction acts on.
 */
@Injectable()
export class ProductResolutionCleanupService {
  private readonly logger = new CustomLogger(
    ProductResolutionCleanupService.name,
  );

  constructor(
    private readonly resolutionRepo: ProductResolutionRepository,
    private readonly dynamicConfigService: DynamicConfigService,
  ) {}

  public async prune(): Promise<ResolutionCleanupSummary> {
    const config = this.dynamicConfigService.resolution?.review;
    const defaults = RESOLUTION_DEFAULTS.review;

    if (!(config?.cleanupEnabled ?? defaults.cleanupEnabled)) {
      this.logger.debug('Resolution cleanup is disabled');
      return { supersededDeleted: 0, doneDeleted: 0 };
    }

    const supersededDeleted = await this.resolutionRepo.pruneSuperseded(
      this.cutoff(
        config?.supersededRetentionDays ?? defaults.supersededRetentionDays,
      ),
    );
    const doneDeleted = await this.resolutionRepo.pruneDoneNotSeenSince(
      this.cutoff(config?.doneRetentionDays ?? defaults.doneRetentionDays),
    );

    this.logger.log('Resolution cleanup completed', {
      supersededDeleted,
      doneDeleted,
    });

    return { supersededDeleted, doneDeleted };
  }

  private cutoff(days: number): Date {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return cutoff;
  }
}
