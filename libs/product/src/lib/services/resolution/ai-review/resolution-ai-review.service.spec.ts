import {
  ProductResolutionFlow,
  ProductResolutionStatus,
  ResolutionActionKind,
  ResolutionActor,
  ResolutionAiConfidence,
  ResolutionAiRecommendedAction,
  ResolutionAiVerdict,
  ResolutionCorrection,
  ResolutionVerdict,
  type ProductResolution,
  type ProductResolutionRepository,
  type ProductResolutionState,
} from '@fittkereso-backend/database';
import type { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import type { ProductResolutionActionService } from '../product-resolution-action.service';
import type { ProductResolutionStateService } from '../product-resolution-state.service';
import type { AiAutomationConfig } from '../resolution-trust-rule';
import type { AiReviewContextBuilderService } from './ai-review-context-builder.service';
import type { AiReviewDecisionService } from './ai-review-decision.service';
import { ResolutionAiReviewService } from './resolution-ai-review.service';

describe('ResolutionAiReviewService', () => {
  let service: ResolutionAiReviewService;
  let repo: {
    findForAction: jest.Mock;
    saveAiReview: jest.Mock;
    appendDecision: jest.Mock;
  };
  let stateService: { deriveVerified: jest.Mock };
  let actionService: { accept: jest.Mock; decline: jest.Mock };
  let contextBuilder: { build: jest.Mock };
  let decisionService: { decide: jest.Mock };

  const config = (
    overrides: Partial<AiAutomationConfig> = {},
  ): AiAutomationConfig => ({
    enabled: true,
    model: 'gpt-5.6-luna',
    effort: 'medium',
    executeActions: true,
    executeDestructive: true,
    maxPerRun: 100,
    minPriority: 10,
    maxCostUsdPerRun: 2,
    reReviewAfterDays: 30,
    ...overrides,
  });

  /** A scrape-time resolution: the seed already performed its action, so accept
   *  is a confirmation and decline offers a split. */
  const resolution = (
    overrides: Partial<ProductResolution> = {},
  ): ProductResolution =>
    ({
      id: 'resolution-1',
      flow: ProductResolutionFlow.product_resolution,
      status: ProductResolutionStatus.pending,
      fingerprint: 'fp-1',
      reviewedAt: null,
      decisions: [],
      ...overrides,
    }) as ProductResolution;

  const performedSeed = () => ({
    at: '',
    actor: ResolutionActor.system,
    verdict: ResolutionVerdict.matched_existing,
    action: { kind: ResolutionActionKind.match },
    actionPerformed: true,
  });

  const state = (
    overrides: Partial<ProductResolutionState> = {},
  ): ProductResolutionState => ({
    status: ProductResolutionStatus.pending,
    accepted: false,
    lastPerformed: performedSeed(),
    splittableSourceRecordIds: ['record-1'],
    availableActions: [
      { action: 'accept', requiresTargetProduct: false },
      {
        action: 'decline',
        correction: ResolutionCorrection.dismiss,
        requiresTargetProduct: false,
      },
      {
        action: 'decline',
        correction: ResolutionCorrection.split,
        requiresTargetProduct: false,
      },
    ],
    blockedReasons: [],
    ...overrides,
  });

  const verdict = (
    overrides: Partial<{
      verdict: ResolutionAiVerdict;
      recommendedAction: ResolutionAiRecommendedAction;
      confidence: ResolutionAiConfidence;
      targetProductId?: string;
    }> = {},
  ) => ({
    confidence: overrides.confidence ?? ResolutionAiConfidence.high,
    review: {
      verdict: overrides.verdict ?? ResolutionAiVerdict.agree,
      recommendedAction:
        overrides.recommendedAction ?? ResolutionAiRecommendedAction.accept,
      targetProductId: overrides.targetProductId,
      reasoning: 'the live specs agree on every primary field',
      evidenceCited: ['live specs: motor'],
      model: 'gpt-5.6-luna',
      costUsd: 0.002,
    },
  });

  beforeEach(() => {
    repo = {
      findForAction: jest.fn().mockResolvedValue(resolution()),
      saveAiReview: jest.fn().mockResolvedValue(undefined),
      appendDecision: jest.fn().mockResolvedValue(undefined),
    };
    stateService = { deriveVerified: jest.fn().mockResolvedValue(state()) };
    actionService = {
      accept: jest.fn().mockResolvedValue(resolution()),
      decline: jest.fn().mockResolvedValue(resolution()),
    };
    contextBuilder = {
      build: jest.fn().mockResolvedValue({
        resolution: resolution(),
        candidates: [],
        realIdByShortId: new Map(),
        state: state(),
        triggers: [],
      }),
    };
    decisionService = { decide: jest.fn().mockResolvedValue(verdict()) };

    service = new ResolutionAiReviewService(
      repo as unknown as ProductResolutionRepository,
      stateService as unknown as ProductResolutionStateService,
      actionService as unknown as ProductResolutionActionService,
      contextBuilder as unknown as AiReviewContextBuilderService,
      decisionService as unknown as AiReviewDecisionService,
      {} as DynamicConfigService,
    );
  });

  describe('what it takes to act', () => {
    it('carries out a high-confidence recommendation as the ai actor', async () => {
      const result = await service.review(resolution(), config());

      expect(actionService.accept).toHaveBeenCalledWith(
        'resolution-1',
        expect.objectContaining({ actor: ResolutionActor.ai }),
      );
      expect(result.review.executed).toBe(true);
    });

    it.each([ResolutionAiConfidence.low, ResolutionAiConfidence.medium])(
      'leaves a %s verdict as advice, with the row still pending',
      async (confidence) => {
        decisionService.decide.mockResolvedValue(verdict({ confidence }));

        const result = await service.review(resolution(), config());

        expect(actionService.accept).not.toHaveBeenCalled();
        expect(result.review.executed).toBe(false);
        expect(result.notExecutedReason).toBe('not_confident');
        // The recommendation is still recorded — that is what makes it a
        // one-click suggestion rather than a wasted call.
        expect(repo.saveAiReview).toHaveBeenCalled();
      },
    );

    it('stores the verdict even when it is not allowed to act', async () => {
      // The point of the whole feature: a call that was paid for is never
      // thrown away, whichever gate stopped it from acting.
      await service.review(
        resolution(),
        config({ executeActions: false }),
      );

      expect(actionService.accept).not.toHaveBeenCalled();
      expect(repo.saveAiReview).toHaveBeenCalled();
      expect(repo.appendDecision).toHaveBeenCalled();
    });

    it('treats an abstain as low confidence rather than as a recommendation', async () => {
      // Enforced in the decision service, checked here because the consequence
      // lives here: an abstain must never reach the action path.
      decisionService.decide.mockResolvedValue(
        verdict({
          verdict: ResolutionAiVerdict.abstain,
          confidence: ResolutionAiConfidence.low,
        }),
      );

      const result = await service.review(resolution(), config());

      expect(actionService.accept).not.toHaveBeenCalled();
      expect(result.notExecutedReason).toBe('not_confident');
    });
  });

  describe('the destructive kill switch', () => {
    const splitVerdict = () =>
      verdict({
        verdict: ResolutionAiVerdict.disagree,
        recommendedAction: ResolutionAiRecommendedAction.split,
      });

    it('blocks a split when destructive execution is off', async () => {
      decisionService.decide.mockResolvedValue(splitVerdict());

      const result = await service.review(
        resolution(),
        config({ executeDestructive: false }),
      );

      expect(actionService.decline).not.toHaveBeenCalled();
      expect(result.notExecutedReason).toBe('destructive_disabled');
    });

    it('allows a split when it is on', async () => {
      decisionService.decide.mockResolvedValue(splitVerdict());

      await service.review(resolution(), config({ executeDestructive: true }));

      expect(actionService.decline).toHaveBeenCalledWith(
        'resolution-1',
        expect.objectContaining({ correction: ResolutionCorrection.split }),
      );
    });

    it('treats accepting an unperformed proposal as destructive', async () => {
      // A duplicate pair's accept *executes a merge* despite being spelled
      // `accept`. Reading the verb rather than the effect is how a kill switch
      // ends up not covering the thing it was added for.
      stateService.deriveVerified.mockResolvedValue(
        state({
          lastPerformed: undefined,
          availableActions: [{ action: 'accept', requiresTargetProduct: false }],
        }),
      );

      const result = await service.review(
        resolution({ flow: ProductResolutionFlow.duplicate_detection }),
        config({ executeDestructive: false }),
      );

      expect(actionService.accept).not.toHaveBeenCalled();
      expect(result.notExecutedReason).toBe('destructive_disabled');
    });

    it('still confirms a non-destructive resolution with the switch off', async () => {
      // The point of the switch being separate: the AI can be trusted with
      // bookkeeping before it is trusted to delete products.
      const result = await service.review(
        resolution(),
        config({ executeDestructive: false }),
      );

      expect(actionService.accept).toHaveBeenCalled();
      expect(result.review.executed).toBe(true);
    });

    it('makes every verdict advisory when execution is off entirely', async () => {
      const result = await service.review(
        resolution(),
        config({ executeActions: false }),
      );

      expect(actionService.accept).not.toHaveBeenCalled();
      expect(result.notExecutedReason).toBe('execution_disabled');
    });
  });

  describe('refusing to act on a stale verdict', () => {
    it('discards the action when the fingerprint moved during the call', async () => {
      // The scrape sync runs every minute. A row re-recorded while the model was
      // thinking is a different question than the one it answered.
      repo.findForAction.mockResolvedValue(resolution({ fingerprint: 'fp-2' }));

      const result = await service.review(resolution(), config());

      expect(actionService.accept).not.toHaveBeenCalled();
      expect(result.notExecutedReason).toBe('stale');
    });

    it('discards the action when a human decided the row first', async () => {
      repo.findForAction.mockResolvedValue(
        resolution({
          status: ProductResolutionStatus.done,
          reviewedAt: new Date(),
        }),
      );

      const result = await service.review(resolution(), config());

      expect(actionService.accept).not.toHaveBeenCalled();
      expect(result.notExecutedReason).toBe('stale');
    });

    it('still stores the verdict when the action was discarded', async () => {
      // The reasoning is worth keeping even when the row moved — it is what a
      // human reads next.
      repo.findForAction.mockResolvedValue(resolution({ fingerprint: 'fp-2' }));

      await service.review(resolution(), config());

      expect(repo.saveAiReview).toHaveBeenCalledWith(
        'resolution-1',
        expect.objectContaining({ fingerprint: 'fp-1' }),
      );
    });
  });

  describe('recommendations the row cannot take', () => {
    it('refuses a correction that is not on offer', async () => {
      // `merge_into` is only legal after a create or a split. Recommending it on
      // a matched row is a model error, and it is reported as one rather than
      // surfacing as a 400 from inside the action path.
      decisionService.decide.mockResolvedValue(
        verdict({
          verdict: ResolutionAiVerdict.disagree,
          recommendedAction: ResolutionAiRecommendedAction.merge_into,
          targetProductId: 'product-9',
        }),
      );

      const result = await service.review(resolution(), config());

      expect(actionService.decline).not.toHaveBeenCalled();
      expect(result.notExecutedReason).toBe('action_unavailable');
    });

    it('records the error when the action itself fails', async () => {
      actionService.accept.mockRejectedValue(new Error('merge deadlock'));

      const result = await service.review(resolution(), config());

      expect(result.review.executed).toBe(false);
      expect(result.review.error).toBe('merge deadlock');
      expect(result.notExecutedReason).toBe('failed');
    });
  });

  describe('the decision log', () => {
    it('appends an advisory entry that decides nothing', async () => {
      decisionService.decide.mockResolvedValue(
        verdict({ confidence: ResolutionAiConfidence.medium }),
      );

      await service.review(resolution(), config());

      const [id, entry, patch] = repo.appendDecision.mock.calls[0];
      expect(id).toBe('resolution-1');
      expect(entry).toMatchObject({
        actor: ResolutionActor.ai,
        actionPerformed: false,
        action: { kind: ResolutionActionKind.none },
      });
      expect(entry.note).toContain('the live specs agree on every primary field');
      // The row must stay exactly as undecided as it was: no status, no
      // `accepted`, no `decidedBy`. An advisory verdict is not a decision, and a
      // patch here would silently drop the row out of the queue.
      expect(patch).toBeUndefined();
    });

    it('carries the recommendation into the entry verdict', async () => {
      decisionService.decide.mockResolvedValue(
        verdict({
          verdict: ResolutionAiVerdict.disagree,
          recommendedAction: ResolutionAiRecommendedAction.dismiss,
          confidence: ResolutionAiConfidence.low,
        }),
      );

      await service.review(resolution(), config());

      expect(repo.appendDecision.mock.calls[0][1]).toMatchObject({
        verdict: ResolutionVerdict.decline,
      });
    });

    it('leaves the entry to the action path when it actually acted', async () => {
      // The action path writes its own entry describing what it did to the
      // catalog. A second one from here would double every executed verdict.
      const result = await service.review(resolution(), config());

      expect(result.review.executed).toBe(true);
      expect(repo.appendDecision).not.toHaveBeenCalled();
    });
  });
});
