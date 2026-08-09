import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { SchedulerMetricsService } from "@ebike-backend/metrics";
import { BaseScheduler } from "@ebike-backend/task";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import {
  ProcessorConfigService,
  SCHEDULING_DEFAULTS,
} from "@ebike-backend/config";
import { ResolutionBackfillService } from "./resolution-backfill.service";

@Injectable()
export class ResolutionBackfillScheduler extends BaseScheduler {
  constructor(
    readonly metricsService: SchedulerMetricsService,
    private readonly resolutionBackfill: ResolutionBackfillService,
    private readonly dynamicConfigService: DynamicConfigService,
    private readonly processorConfig: ProcessorConfigService,
  ) {
    super(ResolutionBackfillScheduler.name, metricsService);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async schedule(): Promise<void> {
    await super.schedule(this.run.bind(this));
  }

  private async run(): Promise<void> {
    const defaults = SCHEDULING_DEFAULTS.resolutionBackfill;
    const config = this.dynamicConfigService.scheduling?.resolutionBackfill;

    if (!(config?.enabled ?? defaults.enabled)) return;

    // Product resolution. Candidates are selected longest-waiting-first by an
    // index-backed query; unresolved refs without a category are matched to an
    // enabled category lazily inside the resolve step (no separate reconciliation
    // pass) — see ResolutionBackfillService.identifyCategoryIfMissing.
    const scoredDefaults = defaults.scoredResolution;
    const scored = config?.scoredResolution;
    {
      await this.resolutionBackfill.runBackfill({
        topN: scored?.topN ?? scoredDefaults.topN,
        retryMaxAgeDays:
          scored?.retryMaxAgeDays ?? scoredDefaults.retryMaxAgeDays,
        // Single source of truth — same threshold moderation/review use.
        minApprovalScore: this.processorConfig.relevance.minApprovalScore,
        cooldown: {
          baseCooldownHours:
            scored?.cooldown?.baseCooldownHours ??
            scoredDefaults.cooldown.baseCooldownHours,
          backoffBase:
            scored?.cooldown?.backoffBase ??
            scoredDefaults.cooldown.backoffBase,
          maxCooldownHours:
            scored?.cooldown?.maxCooldownHours ??
            scoredDefaults.cooldown.maxCooldownHours,
        },
      });
    }
  }
}
