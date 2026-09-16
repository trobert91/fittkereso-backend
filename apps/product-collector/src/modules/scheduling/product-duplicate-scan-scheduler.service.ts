import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SchedulerMetricsService } from '@fittkereso-backend/metrics';
import { BaseScheduler } from '@fittkereso-backend/task';
import { ProductDuplicateScanService } from '@fittkereso-backend/product-identity';

/**
 * Looks for duplicate products across the whole catalog once a night, so pairs
 * appear for products nothing rescraped and disappear once they no longer look
 * alike. Overlapping with a scan an admin triggered in the api process is
 * harmless: the pair writes are idempotent and ordered.
 */
@Injectable()
export class ProductDuplicateScanScheduler extends BaseScheduler {
  constructor(
    private readonly scanService: ProductDuplicateScanService,
    readonly metricsService: SchedulerMetricsService,
  ) {
    super(ProductDuplicateScanScheduler.name, metricsService);
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async schedule() {
    await super.schedule(this.scanForDuplicates.bind(this));
  }

  async scanForDuplicates(): Promise<void> {
    await this.scanService.run();
  }
}
