import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SchedulerMetricsService } from '@fittkereso-backend/metrics';
import { BaseScheduler } from '@fittkereso-backend/task';
import { OfferClickRetentionService } from '@fittkereso-backend/product';
import { CustomLogger } from '@fittkereso-backend/logger';

/**
 * Erases the visitor key of the website's clicks once it is older than
 * `offers.clicks.visitorKeyRetentionHours` (OfferClickRetentionService).
 *
 * Hourly and around the clock, not tied to the import window: the privacy
 * notice promises the key is gone about a day after the click, so a key lives
 * at most an hour past the retention.
 */
@Injectable()
export class OfferClickRetentionScheduler extends BaseScheduler {
  private readonly log = new CustomLogger(OfferClickRetentionScheduler.name);

  constructor(
    private readonly retentionService: OfferClickRetentionService,
    readonly metricsService: SchedulerMetricsService,
  ) {
    super(OfferClickRetentionScheduler.name, metricsService);
  }

  @Cron('0 * * * *', {
    timeZone: 'Europe/Budapest',
    waitForCompletion: true,
  })
  async schedule() {
    await super.schedule(this.eraseVisitorKeys.bind(this));
  }

  async eraseVisitorKeys(): Promise<void> {
    const result = await this.retentionService.eraseExpiredVisitorKeys();
    if (result.erased === 0) return;

    this.log.log('Offer click visitor keys erased', {
      erased: result.erased,
      cutoff: result.cutoff.toISOString(),
    });
  }
}
