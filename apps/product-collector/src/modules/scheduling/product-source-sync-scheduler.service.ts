import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ProductSource, ProductSourceRepository } from '@fittkereso-backend/database';
import { SchedulerMetricsService } from '@fittkereso-backend/metrics';
import { BaseScheduler, QueuePublisherService } from '@fittkereso-backend/task';
import { nameOf } from '@fittkereso-backend/utils';
import ms from 'ms';

@Injectable()
export class ProductSourceSyncScheduler extends BaseScheduler {
  constructor(
    private readonly repo: ProductSourceRepository,
    private readonly publisher: QueuePublisherService,
    readonly metricsService: SchedulerMetricsService,
  ) {
    super(ProductSourceSyncScheduler.name, metricsService);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async schedule() {
    await super.schedule(this.scheduleSourceSyncs.bind(this));
  }

  async scheduleSourceSyncs(): Promise<void> {
    const sources = await this.findSourcesToSync();

    for (const source of sources) {
      await this.publisher.addProductSourceSyncTask({
        productSourceId: source.id,
      });

      source.nextFullSyncAt = this.computeNextRun(source.fullSyncInterval);
    }

    await this.repo.saveAll(sources);
  }

  private async findSourcesToSync(): Promise<ProductSource[]> {
    const nextFullSyncAtColumn = `source.${nameOf<ProductSource>('nextFullSyncAt')}`;

    return this.repo.repo
      .createQueryBuilder('source')
      .where(`source.${nameOf<ProductSource>('schedulingEnabled')} = true`)
      .andWhere(`source.${nameOf<ProductSource>('fullSyncInterval')} IS NOT NULL`)
      .andWhere(
        `(${nextFullSyncAtColumn} IS NULL OR ${nextFullSyncAtColumn} <= NOW())`,
      )
      .getMany();
  }

  private computeNextRun(interval?: ms.StringValue | null): Date {
    return new Date(Date.now() + ms(interval ?? '7 days'));
  }
}
