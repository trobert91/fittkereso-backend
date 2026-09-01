import { Injectable } from '@nestjs/common';
import {
  ProductResolution,
  ProductResolutionFlow,
  ProductResolutionRepository,
  ResolutionActor,
} from '@fittkereso-backend/database';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductResolutionActionService } from './product-resolution-action.service';
import {
  deterministicAutomationConfig,
  trustRuleRejection,
  type TrustRuleRejection,
} from './resolution-trust-rule';

export interface AutoAcceptRunSummary {
  /** Rows the pre-filter returned. */
  scanned: number;
  accepted: number;
  /** Passed the SQL pre-filter but failed the authoritative re-check. Should be
   *  ~0; anything else means the two have drifted apart. */
  skipped: number;
  failed: number;
  dryRun: boolean;
  /** The batch filled the cap, so more rows are waiting for tomorrow. */
  capped: boolean;
  durationMs: number;
}

/**
 * The nightly catch-up half of the deterministic rule.
 *
 * The record-time path is the primary one and settles rows before they are ever
 * queued; this exists for the rows it could not have caught — those recorded
 * before the feature existed, and those that only became trustworthy afterwards
 * because a threshold moved, weights were retuned, or the sweep classified them
 * for the first time.
 *
 * Runs *after* the sweep in the nightly sequence, and that order is load-bearing:
 * the sweep is what computes the confidence and the triggers this pass selects
 * on, so running first would decide on yesterday's numbers.
 *
 * Every accept goes through `ProductResolutionActionService`, which re-derives
 * from live database state before acting. That is what keeps this pass from
 * needing to know anything about what the action does — including the structural
 * guarantee that, for this flow, it does nothing to the catalog at all.
 */
@Injectable()
export class ProductResolutionAutoAcceptService {
  private readonly logger = new CustomLogger(
    ProductResolutionAutoAcceptService.name,
  );

  constructor(
    private readonly resolutionRepo: ProductResolutionRepository,
    private readonly actionService: ProductResolutionActionService,
    private readonly dynamicConfigService: DynamicConfigService,
  ) {}

  public async run(): Promise<AutoAcceptRunSummary> {
    const startedAt = Date.now();
    const config = deterministicAutomationConfig(this.dynamicConfigService);

    const summary: AutoAcceptRunSummary = {
      scanned: 0,
      accepted: 0,
      skipped: 0,
      failed: 0,
      dryRun: config.dryRun,
      capped: false,
      durationMs: 0,
    };

    if (!config.enabled) {
      this.logger.debug('Deterministic auto-accept is disabled');
      return { ...summary, durationMs: Date.now() - startedAt };
    }

    const batch = await this.resolutionRepo.findTrustedPendingBatch(
      // The flow restriction is the non-destructive guarantee, so it is applied
      // at the query as well as re-asserted per row — a duplicate pair must never
      // even be loaded by this pass.
      ProductResolutionFlow.product_resolution,
      config.minConfidence,
      config.maxPerRunNightly,
    );

    summary.scanned = batch.length;
    summary.capped = batch.length >= config.maxPerRunNightly;

    for (const resolution of batch) {
      const rejection = this.recheck(resolution, config.minConfidence);
      if (rejection) {
        summary.skipped += 1;
        continue;
      }

      if (config.dryRun) {
        summary.accepted += 1;
        continue;
      }

      try {
        await this.actionService.accept(resolution.id, {
          actor: ResolutionActor.system,
          note: `auto-accepted by the nightly catch-up: confidence ${resolution.decisionConfidence} ≥ ${config.minConfidence}, no review trigger fired`,
        });
        summary.accepted += 1;
      } catch (error: unknown) {
        // One row failing is not a reason to abandon the rest — the usual cause
        // is a race with a human deciding the same row, which the action service
        // is right to refuse.
        summary.failed += 1;
        this.logger.warn('Auto-accept failed for a row, continuing', {
          resolutionId: resolution.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    summary.durationMs = Date.now() - startedAt;

    this.logger.log(
      config.dryRun
        ? 'Deterministic auto-accept completed (dryRun — nothing was written)'
        : 'Deterministic auto-accept completed',
      summary,
    );

    return summary;
  }

  /**
   * The authoritative check, run per row against the same predicate the record-
   * time path uses.
   *
   * The SQL pre-filter already narrowed to what looks trusted, so this should
   * never reject anything — which is exactly why it is here. A non-zero `skipped`
   * count in the summary is the alarm that the query and the rule have drifted
   * apart, and it fails safe: the row stays in the queue.
   */
  private recheck(
    resolution: ProductResolution,
    minConfidence: number,
  ): TrustRuleRejection | undefined {
    const rejection = trustRuleRejection(
      {
        flow: resolution.flow,
        status: resolution.status,
        reviewedAt: resolution.reviewedAt,
        decisionConfidence: resolution.decisionConfidence,
        reviewTriggers: resolution.reviewTriggers,
        candidates: resolution.candidates,
      },
      { minConfidence },
    );

    if (rejection) {
      this.logger.warn(
        'Row passed the auto-accept pre-filter but failed the rule — skipping',
        { resolutionId: resolution.id, rejection },
      );
    }

    return rejection;
  }
}
