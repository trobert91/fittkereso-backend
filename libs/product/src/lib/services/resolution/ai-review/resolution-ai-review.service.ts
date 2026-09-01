import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ProductResolution,
  ProductResolutionRepository,
  ResolutionActionKind,
  ResolutionActor,
  ResolutionAiConfidence,
  ResolutionAiRecommendedAction,
  ResolutionCorrection,
  ResolutionVerdict,
  type ProductResolutionAiReview,
} from '@fittkereso-backend/database';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { CustomLogger } from '@fittkereso-backend/logger';
import { ProductResolutionActionService } from '../product-resolution-action.service';
import { ProductResolutionStateService } from '../product-resolution-state.service';
import { aiAutomationConfig, type AiAutomationConfig } from '../resolution-trust-rule';
import { AiReviewContextBuilderService } from './ai-review-context-builder.service';
import {
  AiReviewDecisionService,
  correctionFor,
} from './ai-review-decision.service';

export interface AiReviewResult {
  resolutionId: string;
  review: ProductResolutionAiReview;
  confidence: ResolutionAiConfidence;
  /** Why the recommendation was not carried out, when it was not. */
  notExecutedReason?:
    | 'not_confident'
    | 'execution_disabled'
    | 'destructive_disabled'
    | 'action_unavailable'
    | 'stale'
    | 'failed';
}

/**
 * Reviews one row with an LLM, and acts on the verdict when it is confident
 * enough to be worth acting on.
 *
 * The shape is deliberately the same as every other decision path in this
 * system: load, re-derive what is legal from live state, decide, then act
 * **through `ProductResolutionActionService`**. The AI gets no privileged route
 * to the catalog — it proposes an action from the same vocabulary a human has,
 * and that action is validated against the same live-state derivation before
 * anything happens. An AI recommendation the world has moved past is refused for
 * exactly the reasons a human's would be.
 */
@Injectable()
export class ResolutionAiReviewService {
  private readonly logger = new CustomLogger(ResolutionAiReviewService.name);

  constructor(
    private readonly resolutionRepo: ProductResolutionRepository,
    private readonly stateService: ProductResolutionStateService,
    private readonly actionService: ProductResolutionActionService,
    private readonly contextBuilder: AiReviewContextBuilderService,
    private readonly decisionService: AiReviewDecisionService,
    private readonly dynamicConfigService: DynamicConfigService,
  ) {}

  public async reviewById(id: string): Promise<AiReviewResult> {
    const resolution = await this.resolutionRepo.findForAction(id);
    if (!resolution) {
      throw new NotFoundException(`Resolution ${id} not found`);
    }
    return this.review(resolution, aiAutomationConfig(this.dynamicConfigService));
  }

  /**
   * The whole pass for one row. Takes the config rather than reading it so a
   * batch resolves it once — and, more importantly, so every row in a run is
   * judged under identical settings even if someone edits the dynamic config
   * mid-run.
   */
  public async review(
    resolution: ProductResolution,
    config: AiAutomationConfig,
  ): Promise<AiReviewResult> {
    const fingerprintAtIntake = resolution.fingerprint;
    const statusAtIntake = resolution.status;

    const state = await this.stateService.deriveVerified(resolution);
    const context = await this.contextBuilder.build(resolution, state);
    const outcome = await this.decisionService.decide(context, config);

    const execution = await this.execute({
      resolution,
      config,
      confidence: outcome.confidence,
      recommendedAction: outcome.review.recommendedAction,
      targetProductId: outcome.review.targetProductId,
      state,
      fingerprintAtIntake,
      statusAtIntake,
    });

    const review: ProductResolutionAiReview = {
      ...outcome.review,
      executed: execution.executed,
      error: execution.error,
    };

    await this.resolutionRepo.saveAiReview(resolution.id, {
      review,
      confidence: outcome.confidence,
      fingerprint: fingerprintAtIntake,
    });

    // Every verdict goes in the log, not just the ones that changed something.
    //
    // A judgement that recommended nothing be done is still a judgement, and the
    // log is what answers "what has been decided about this row" — a question an
    // advisory verdict is part of the answer to. Skipping it would also make the
    // log disagree with `aiReview`, which is stored either way.
    //
    // The entry when the AI acted is written by the action path, which knows
    // what it actually did to the catalog; writing one here too would double it.
    if (!execution.executed) {
      await this.appendAdvisoryEntry(resolution.id, review, outcome.confidence);
    }

    this.logger.log('AI review completed', {
      resolutionId: resolution.id,
      verdict: review.verdict,
      recommendedAction: review.recommendedAction,
      confidence: outcome.confidence,
      executed: review.executed,
      notExecutedReason: execution.reason,
      costUsd: review.costUsd,
    });

    return {
      resolutionId: resolution.id,
      review,
      confidence: outcome.confidence,
      notExecutedReason: execution.reason,
    };
  }

  /**
   * Record a verdict that changed nothing.
   *
   * The `verdict` is what the AI *recommended*, so the log says what it
   * concluded rather than flattening every advisory entry into one word.
   * `actionPerformed: false` and `action.kind: none` carry the other half — that
   * the recommendation was not carried out — which is the shape the timeline
   * already renders as "judged, no catalog change".
   *
   * No workflow patch is passed: an advisory entry must not move `status`,
   * `accepted` or `decidedBy`. The row is exactly as undecided afterwards as it
   * was before, and the queue must keep showing it.
   */
  private async appendAdvisoryEntry(
    resolutionId: string,
    review: ProductResolutionAiReview,
    confidence: ResolutionAiConfidence,
  ): Promise<void> {
    const note = `AI review (${confidence} confidence) — ${
      review.verdict
    }, recommends ${review.recommendedAction}: ${review.reasoning}`;

    await this.resolutionRepo.appendDecision(resolutionId, {
      at: new Date().toISOString(),
      actor: ResolutionActor.ai,
      verdict:
        review.recommendedAction === ResolutionAiRecommendedAction.accept
          ? ResolutionVerdict.accept
          : ResolutionVerdict.decline,
      action: { kind: ResolutionActionKind.none },
      actionPerformed: false,
      error: review.error,
      note,
    });
  }

  /**
   * Carry out the recommendation, or say why not.
   *
   * Three gates before anything is written, in order of how cheaply they can be
   * decided: the confidence bar, the two kill switches, and finally whether the
   * action is still legal at all. Only `high` acts — `medium` reads as
   * "probably, but check", and a system that acts on "probably" is one whose
   * mistakes nobody sees coming.
   *
   * Note this gates *acting*, never *recording*: the verdict is stored either
   * way, so a row that was judged always shows what the judgement was.
   */
  private async execute(params: {
    resolution: ProductResolution;
    config: AiAutomationConfig;
    confidence: ResolutionAiConfidence;
    recommendedAction: ResolutionAiRecommendedAction;
    targetProductId?: string;
    state: Awaited<ReturnType<ProductResolutionStateService['deriveVerified']>>;
    fingerprintAtIntake?: string | null;
    statusAtIntake: ProductResolution['status'];
  }): Promise<{
    executed: boolean;
    error?: string;
    reason?: AiReviewResult['notExecutedReason'];
  }> {
    const { resolution, config, confidence, recommendedAction } = params;

    if (confidence !== ResolutionAiConfidence.high) {
      return { executed: false, reason: 'not_confident' };
    }
    if (!config.executeActions) {
      return { executed: false, reason: 'execution_disabled' };
    }

    const correction = correctionFor(recommendedAction);
    const destructive =
      correction === ResolutionCorrection.split ||
      correction === ResolutionCorrection.merge_into ||
      // Accepting a duplicate proposal performs the merge — destructive despite
      // being spelled `accept`. Reading the verb rather than the effect is how a
      // kill switch ends up not covering the thing it was added for.
      (recommendedAction === ResolutionAiRecommendedAction.accept &&
        !params.state.lastPerformed);

    if (destructive && !config.executeDestructive) {
      return { executed: false, reason: 'destructive_disabled' };
    }

    if (!this.isAvailable(params.state, recommendedAction, correction)) {
      return { executed: false, reason: 'action_unavailable' };
    }

    // The world may have moved while the model was thinking: the scrape sync
    // runs every minute, and a human may have decided this row. Re-read rather
    // than trusting the copy loaded before the call.
    const current = await this.resolutionRepo.findForAction(resolution.id);
    if (
      !current ||
      current.status !== params.statusAtIntake ||
      current.fingerprint !== params.fingerprintAtIntake ||
      current.reviewedAt
    ) {
      this.logger.warn('Discarding AI action — the row moved during review', {
        resolutionId: resolution.id,
      });
      return { executed: false, reason: 'stale' };
    }

    try {
      const note = `AI review (${confidence} confidence)`;
      if (recommendedAction === ResolutionAiRecommendedAction.accept) {
        await this.actionService.accept(resolution.id, {
          actor: ResolutionActor.ai,
          note,
        });
      } else {
        await this.actionService.decline(resolution.id, {
          actor: ResolutionActor.ai,
          correction: correction as ResolutionCorrection,
          targetProductId: params.targetProductId,
          note,
        });
      }
      return { executed: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('AI review action failed', {
        resolutionId: resolution.id,
        recommendedAction,
        error: message,
      });
      return { executed: false, error: message, reason: 'failed' };
    }
  }

  /** The same check `ActionService` will make. Applied here too so an illegal
   *  recommendation is reported as such rather than surfacing as a 400 from
   *  deep inside the action path. */
  private isAvailable(
    state: Awaited<ReturnType<ProductResolutionStateService['deriveVerified']>>,
    recommendedAction: ResolutionAiRecommendedAction,
    correction?: ResolutionCorrection,
  ): boolean {
    const action =
      recommendedAction === ResolutionAiRecommendedAction.accept
        ? 'accept'
        : 'decline';

    return state.availableActions.some(
      (available) =>
        available.action === action &&
        (correction === undefined || available.correction === correction),
    );
  }
}
