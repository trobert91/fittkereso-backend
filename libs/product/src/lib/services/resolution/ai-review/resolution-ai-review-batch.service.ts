import { Injectable } from '@nestjs/common';
import {
  ProductResolutionRepository,
  ResolutionAiConfidence,
  ResolutionAiVerdict,
} from '@fittkereso-backend/database';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { aiAutomationConfig, type AiAutomationConfig } from '../resolution-trust-rule';
import { ResolutionAiReviewService } from './resolution-ai-review.service';

/** Per-run overrides for the on-demand endpoint. Anything omitted falls back to
 *  the configured value, so the button and the scheduler share one code path and
 *  one set of defaults. */
export interface AiReviewBatchOverrides {
  maxPerRun?: number;
  minPriority?: number;
  executeDestructive?: boolean;
}

export interface AiReviewBatchSummary {
  rowsReviewed: number;
  /** A recommendation was carried out. */
  executed: number;
  /** Judged, but left for a human — low/medium confidence, a kill switch, or an
   *  action the row could not take. */
  advisory: number;
  abstained: number;
  /** The row moved between intake and the verdict, so the action was discarded. */
  skippedStale: number;
  /** The call itself threw. */
  failed: number;
  costUsd: number;
  /** Stopped early on the cost cap or the row cap — more work is waiting. */
  capped: boolean;
  durationMs: number;
}

/**
 * Works the top of the review queue with the LLM.
 *
 * Intake is `priority DESC` — the same order the admin queue shows — so this and
 * a human are working one list from the same end. Rows you cleared today are
 * gone from tonight's batch because they are no longer `pending`; rows the model
 * could not settle stay put with their reasoning attached, which is what turns
 * the queue into "things the machine couldn't decide" by morning.
 */
@Injectable()
export class ResolutionAiReviewBatchService {
  private readonly logger = new CustomLogger(
    ResolutionAiReviewBatchService.name,
  );

  constructor(
    private readonly resolutionRepo: ProductResolutionRepository,
    private readonly reviewService: ResolutionAiReviewService,
    private readonly dynamicConfigService: DynamicConfigService,
  ) {}

  public async run(
    overrides: AiReviewBatchOverrides = {},
  ): Promise<AiReviewBatchSummary> {
    const startedAt = Date.now();
    const config = this.resolveConfig(overrides);

    const summary: AiReviewBatchSummary = {
      rowsReviewed: 0,
      executed: 0,
      advisory: 0,
      abstained: 0,
      skippedStale: 0,
      failed: 0,
      costUsd: 0,
      capped: false,
      durationMs: 0,
    };

    if (!config.enabled) {
      this.logger.debug('AI review is disabled');
      return { ...summary, durationMs: Date.now() - startedAt };
    }

    const batch = await this.resolutionRepo.findAiReviewBatch({
      minPriority: config.minPriority,
      reReviewAfterDays: config.reReviewAfterDays,
      limit: config.maxPerRun,
    });

    summary.capped = batch.length >= config.maxPerRun;

    for (const resolution of batch) {
      // Checked before the call, not after: the cap is a spend limit, and a
      // limit you only notice having exceeded is not one.
      if (summary.costUsd >= config.maxCostUsdPerRun) {
        summary.capped = true;
        this.logger.warn('AI review stopped on the cost cap', {
          costUsd: summary.costUsd,
          maxCostUsdPerRun: config.maxCostUsdPerRun,
          rowsReviewed: summary.rowsReviewed,
          rowsRemaining: batch.length - summary.rowsReviewed,
        });
        break;
      }

      try {
        const result = await this.reviewService.review(resolution, config);

        summary.rowsReviewed += 1;
        summary.costUsd += result.review.costUsd ?? 0;

        if (result.review.verdict === ResolutionAiVerdict.abstain) {
          summary.abstained += 1;
        }
        if (result.review.executed) {
          summary.executed += 1;
        } else if (result.notExecutedReason === 'stale') {
          summary.skippedStale += 1;
        } else {
          summary.advisory += 1;
        }
      } catch (error: unknown) {
        // One row failing must not abandon the rest — a provider hiccup on row 3
        // should not cost the other 97 their review.
        summary.failed += 1;
        this.logger.warn('AI review failed for a row, continuing', {
          resolutionId: resolution.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    summary.durationMs = Date.now() - startedAt;

    this.logger.log('AI review batch completed', summary);

    return summary;
  }

  /**
   * Resolved once per run, not per row.
   *
   * Deliberate: the dynamic config can be edited while a batch is in flight, and
   * half a run judged under one `executeDestructive` setting and half under
   * another would be very hard to reason about afterwards.
   */
  private resolveConfig(
    overrides: AiReviewBatchOverrides,
  ): AiAutomationConfig {
    const config = aiAutomationConfig(this.dynamicConfigService);

    return {
      ...config,
      maxPerRun: overrides.maxPerRun ?? config.maxPerRun,
      minPriority: overrides.minPriority ?? config.minPriority,
      // An override can only ever tighten this one. Letting a request switch on
      // destructive execution would make the config's "off" meaningless, and
      // this is the switch that deletes products.
      executeDestructive:
        config.executeDestructive && (overrides.executeDestructive ?? true),
    };
  }
}
