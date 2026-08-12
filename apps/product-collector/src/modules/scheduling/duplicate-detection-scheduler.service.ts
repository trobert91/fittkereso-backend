import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SchedulerMetricsService } from '@fittkereso-backend/metrics';
import { BaseScheduler } from '@fittkereso-backend/task';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { SCHEDULING_DEFAULTS } from '@fittkereso-backend/config';
import { ProductDuplicateEvaluationService } from '@fittkereso-backend/product';

@Injectable()
export class DuplicateDetectionScheduler extends BaseScheduler {
  constructor(
    readonly metricsService: SchedulerMetricsService,
    private readonly evaluationService: ProductDuplicateEvaluationService,
    private readonly dynamicConfigService: DynamicConfigService,
  ) {
    super(DuplicateDetectionScheduler.name, metricsService);
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async runSchedule(): Promise<void> {
    await super.schedule(this.run.bind(this));
  }

  private async run(): Promise<void> {
    const enabled =
      this.dynamicConfigService.scheduling?.duplicateDetection?.enabled ??
      SCHEDULING_DEFAULTS.duplicateDetection.enabled;

    if (!enabled) {
      this.logger.debug('Duplicate detection scheduler is disabled');
      return;
    }

    const summary = await this.evaluationService.processAllCategories();

    this.logger.log('Duplicate detection run completed', {
      categoriesProcessed: summary.categoriesProcessed,
      totalPairsEvaluated: summary.totalPairsEvaluated,
      autoMerged: summary.autoMerged,
      pendingReview: summary.pendingReview,
      skipped: summary.skipped,
      durationMs: summary.durationMs,
    });
  }
}
