import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ProductSource, ProductSourceRepository } from '@fittkereso-backend/database';
import { SchedulerMetricsService } from '@fittkereso-backend/metrics';
import { BaseScheduler, QueuePublisherService } from '@fittkereso-backend/task';
import { nameOf } from '@fittkereso-backend/utils';
import ms from 'ms';
import {
  IMPORT_WINDOW_END_HOUR,
  IMPORT_WINDOW_START_HOUR,
  IMPORT_WINDOW_TIMEZONE,
  nextWindowStart,
  windowOffsetMs,
} from './import-window';

/** Used only if a source somehow reaches scheduling with no frequency set. */
const FALLBACK_FREQUENCY = '7 days';

@Injectable()
export class ProductSourceSyncScheduler extends BaseScheduler {
  constructor(
    private readonly repo: ProductSourceRepository,
    private readonly publisher: QueuePublisherService,
    readonly metricsService: SchedulerMetricsService,
  ) {
    super(ProductSourceSyncScheduler.name, metricsService);
  }

  /**
   * Ticks every 10 minutes between 02:00 and 05:59 Budapest time.
   *
   * The window lives in the cron expression rather than in a getHours() guard
   * in the body, so there is exactly one statement of when imports run. The
   * timezone is explicit because the server may well be UTC, where the naive
   * expression would fire an hour or two off.
   *
   * `waitForCompletion` skips a tick while the previous one is still running,
   * which removes any need for a re-entrancy flag.
   *
   * This gates when runs are STARTED, not when they finish: scrape tasks keep
   * draining past 06:00 on the ordinary 5-second poller. Gating the poller too
   * would stretch a cold first import of a large shop across many nights.
   */
  @Cron(`*/10 ${IMPORT_WINDOW_START_HOUR}-${IMPORT_WINDOW_END_HOUR - 1} * * *`, {
    timeZone: IMPORT_WINDOW_TIMEZONE,
    waitForCompletion: true,
  })
  async schedule() {
    await super.schedule(this.scheduleSourceSyncs.bind(this));
  }

  async scheduleSourceSyncs(): Promise<void> {
    const sources = await this.findSourcesToSync();

    for (const source of sources) {
      await this.publisher.addProductSourceSyncTask({
        productSourceId: source.id,
      });

      source.nextRunAt = this.computeNextRun(source.frequency);
    }

    await this.repo.saveAll(sources);
  }

  private async findSourcesToSync(): Promise<ProductSource[]> {
    const nextRunAtColumn = `source.${nameOf<ProductSource>('nextRunAt')}`;

    return this.repo.repo
      .createQueryBuilder('source')
      .where(`source.${nameOf<ProductSource>('schedulingEnabled')} = true`)
      .andWhere(`source.${nameOf<ProductSource>('frequency')} IS NOT NULL`)
      .andWhere(`(${nextRunAtColumn} IS NULL OR ${nextRunAtColumn} <= NOW())`)
      .getMany();
  }

  /**
   * `now + frequency`, snapped to the next window start plus jitter.
   *
   * Advanced at ENQUEUE time rather than on completion, so an overlapping tick
   * finds nothing due — the same claim-on-enqueue property the previous
   * implementation relied on.
   */
  private computeNextRun(frequency?: ms.StringValue | null): Date {
    const due = new Date(Date.now() + ms(frequency ?? FALLBACK_FREQUENCY));
    return new Date(nextWindowStart(due).getTime() + windowOffsetMs());
  }
}
