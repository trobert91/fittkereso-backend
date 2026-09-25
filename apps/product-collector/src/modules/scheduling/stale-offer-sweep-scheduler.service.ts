import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SchedulerMetricsService } from '@fittkereso-backend/metrics';
import { BaseScheduler } from '@fittkereso-backend/task';
import { StaleOfferSweepService } from '@fittkereso-backend/product';
import { CustomLogger } from '@fittkereso-backend/logger';

/**
 * Deletes offers no import run has confirmed for `offers.deleteAfterDays`.
 *
 * Runs at 06:30 Budapest — just after the nightly import window closes (see
 * ProductSourceSyncScheduler), so a source that ran successfully overnight has
 * already re-stamped its offers and nothing it still sells is ever a candidate.
 * Sweeping before or during the window would race the very runs that prove an
 * offer is alive.
 */
@Injectable()
export class StaleOfferSweepScheduler extends BaseScheduler {
  private readonly log = new CustomLogger(StaleOfferSweepScheduler.name);

  constructor(
    private readonly sweepService: StaleOfferSweepService,
    readonly metricsService: SchedulerMetricsService,
  ) {
    super(StaleOfferSweepScheduler.name, metricsService);
  }

  @Cron('30 6 * * *', {
    timeZone: 'Europe/Budapest',
    waitForCompletion: true,
  })
  async schedule() {
    await super.schedule(this.sweepStaleOffers.bind(this));
  }

  async sweepStaleOffers(): Promise<void> {
    const result = await this.sweepService.sweep();

    if (result.deleted === 0 && result.contributorsRecomposed === 0) return;

    this.log.log('Stale offer sweep finished', {
      contributorsRecomposed: result.contributorsRecomposed,
      deleted: result.deleted,
      modelsRecomputed: result.modelsRecomputed,
      cutoff: result.cutoff.toISOString(),
      capped: result.capped,
    });
  }
}
