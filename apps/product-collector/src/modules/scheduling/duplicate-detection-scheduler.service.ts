import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SchedulerMetricsService } from '@fittkereso-backend/metrics';
import { BaseScheduler } from '@fittkereso-backend/task';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { SCHEDULING_DEFAULTS } from '@fittkereso-backend/config';
import {
  ProductDuplicateEvaluationService,
  ProductResolutionAutoAcceptService,
  ProductResolutionCleanupService,
  ProductResolutionPriorityRecomputeService,
  ResolutionAiReviewBatchService,
} from '@fittkereso-backend/product';

@Injectable()
export class DuplicateDetectionScheduler extends BaseScheduler {
  constructor(
    readonly metricsService: SchedulerMetricsService,
    private readonly evaluationService: ProductDuplicateEvaluationService,
    private readonly cleanupService: ProductResolutionCleanupService,
    private readonly priorityRecomputeService: ProductResolutionPriorityRecomputeService,
    private readonly autoAcceptService: ProductResolutionAutoAcceptService,
    private readonly aiReviewBatchService: ResolutionAiReviewBatchService,
    private readonly dynamicConfigService: DynamicConfigService,
  ) {
    super(DuplicateDetectionScheduler.name, metricsService);
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async runSchedule(): Promise<void> {
    await super.schedule(this.run.bind(this));
  }

  private async run(): Promise<void> {
    await this.detectDuplicates();

    // Rescore after detection has added rows and cleanup has removed the ones
    // nobody will look at, so the pass does no work it will throw away. Outside
    // the detection switch on purpose — the queue still needs ordering on a
    // night detection does not run, and this has its own
    // `resolution.priority.recomputeEnabled` toggle.
    await this.priorityRecomputeService.recompute();

    // Strictly after the rescore. This pass selects on `decisionConfidence` and
    // `reviewTriggers`, which the rescore is what computes — running it first
    // would settle rows on yesterday's numbers, and would never see a row the
    // sweep has just classified for the first time.
    await this.autoAcceptService.run();

    // Last, and after auto-accept for the same reason it runs after the sweep:
    // the cheap deterministic pass should clear everything it can before the
    // expensive one selects a batch, so no LLM call is spent on a row a
    // comparison would have settled for nothing.
    await this.aiReviewBatchService.run();
  }

  private async detectDuplicates(): Promise<void> {
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
      recorded: summary.recorded,
      skipped: summary.skipped,
      durationMs: summary.durationMs,
    });

    // Prune here rather than on its own schedule: detection is what grows the
    // queue, so trimming it in the same pass keeps the two in step.
    await this.cleanupService.prune();
  }
}
