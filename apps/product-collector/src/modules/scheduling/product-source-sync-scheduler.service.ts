import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  ProductSource,
  ProductSourceRepository,
  ProductSourceSyncMode,
} from '@fittkereso-backend/database';
import { SchedulerMetricsService } from '@fittkereso-backend/metrics';
import { BaseScheduler, QueuePublisherService } from '@fittkereso-backend/task';
import { nameOf } from '@fittkereso-backend/utils';
import { Brackets } from 'typeorm';
import ms from 'ms';

interface SourceSyncEntry {
  source: ProductSource;
  dueModes: ProductSourceSyncMode[];
}

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
    const entries = await this.findSourcesToSync();

    for (const { source, dueModes } of entries) {
      for (const syncMode of dueModes) {
        await this.publisher.addProductSourceSyncTask({
          productSourceId: source.id,
          syncMode,
        });

        if (syncMode === ProductSourceSyncMode.full) {
          source.nextFullSyncAt = this.computeNextRun(source.fullSyncInterval);
        } else {
          source.nextIncrementalSyncAt = this.computeNextRun(
            source.incrementalSyncInterval,
          );
        }
      }
    }

    await this.repo.saveAll(entries.map((entry) => entry.source));
  }

  private async findSourcesToSync(): Promise<SourceSyncEntry[]> {
    const nextFullSyncAtColumn = `source.${nameOf<ProductSource>('nextFullSyncAt')}`;
    const nextIncrementalSyncAtColumn = `source.${nameOf<ProductSource>('nextIncrementalSyncAt')}`;
    const sources = await this.repo.repo
      .createQueryBuilder('source')
      .where(`source.${nameOf<ProductSource>('schedulingEnabled')} = true`)
      .andWhere(
        new Brackets((qb) => {
          qb.where(
            new Brackets((sub) => {
              sub
                .where(
                  `source.${nameOf<ProductSource>('fullSyncInterval')} IS NOT NULL`,
                )
                .andWhere(
                  `(${nextFullSyncAtColumn} IS NULL OR ${nextFullSyncAtColumn} <= NOW())`,
                );
            }),
          ).orWhere(
            new Brackets((sub) => {
              sub
                .where(
                  `source.${nameOf<ProductSource>('incrementalSyncInterval')} IS NOT NULL`,
                )
                .andWhere(
                  `(${nextIncrementalSyncAtColumn} IS NULL OR ${nextIncrementalSyncAtColumn} <= NOW())`,
                );
            }),
          );
        }),
      )
      .getMany();

    return sources.map((source) => {
      const dueModes: ProductSourceSyncMode[] = [];

      const fullDue =
        source.fullSyncInterval &&
        (!source.nextFullSyncAt || source.nextFullSyncAt <= new Date());
      if (fullDue) dueModes.push(ProductSourceSyncMode.full);

      const incrementalDue =
        source.incrementalSyncInterval &&
        (!source.nextIncrementalSyncAt ||
          source.nextIncrementalSyncAt <= new Date());
      if (incrementalDue) dueModes.push(ProductSourceSyncMode.incremental);

      return { source, dueModes };
    });
  }

  private computeNextRun(interval?: ms.StringValue): Date {
    return new Date(Date.now() + ms(interval ?? '7 days'));
  }
}
