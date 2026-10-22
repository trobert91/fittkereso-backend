import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SchedulerMetricsService } from '@fittkereso-backend/metrics';
import { BaseScheduler } from '@fittkereso-backend/task';
import { FinderRetentionService } from '@fittkereso-backend/product';
import { CustomLogger } from '@fittkereso-backend/logger';

/**
 * Deletes the website's finder visitors not seen for `finder.retentionDays`,
 * with their saved results (FinderRetentionService). Nightly: the retention is
 * counted in months, so a day's slack is nothing.
 */
@Injectable()
export class FinderRetentionScheduler extends BaseScheduler {
  private readonly log = new CustomLogger(FinderRetentionScheduler.name);

  constructor(
    private readonly retentionService: FinderRetentionService,
    readonly metricsService: SchedulerMetricsService,
  ) {
    super(FinderRetentionScheduler.name, metricsService);
  }

  @Cron('30 3 * * *', {
    timeZone: 'Europe/Budapest',
    waitForCompletion: true,
  })
  async schedule() {
    await super.schedule(this.deleteExpired.bind(this));
  }

  async deleteExpired(): Promise<void> {
    const result = await this.retentionService.deleteExpired();
    if (result.deleted === 0) return;

    this.log.log('Finder visitors deleted', {
      deleted: result.deleted,
      cutoff: result.cutoff.toISOString(),
    });
  }
}
