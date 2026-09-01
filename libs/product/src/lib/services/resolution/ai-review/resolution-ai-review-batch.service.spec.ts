import {
  ResolutionAiConfidence,
  ResolutionAiRecommendedAction,
  ResolutionAiVerdict,
  type ProductResolution,
  type ProductResolutionRepository,
} from '@fittkereso-backend/database';
import type { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import type { ResolutionAiReviewService } from './resolution-ai-review.service';
import { ResolutionAiReviewBatchService } from './resolution-ai-review-batch.service';

describe('ResolutionAiReviewBatchService', () => {
  let service: ResolutionAiReviewBatchService;
  let repo: { findAiReviewBatch: jest.Mock };
  let reviewService: { review: jest.Mock };

  /** Only the slice of the dynamic config this service reads, typed so the tests
   *  can rewrite it without casting through an index signature. */
  interface TestConfig {
    resolution: {
      automation: {
        enabled?: boolean;
        ai?: {
          executeDestructive?: boolean;
          maxCostUsdPerRun?: number;
        };
      };
    };
  }
  let config: TestConfig;

  const rows = (count: number): ProductResolution[] =>
    Array.from(
      { length: count },
      (_, index) => ({ id: `resolution-${index + 1}` }) as ProductResolution,
    );

  /** One review outcome, with the knobs the summary tallies on. */
  const outcome = (
    overrides: {
      executed?: boolean;
      verdict?: ResolutionAiVerdict;
      notExecutedReason?: string;
      costUsd?: number;
    } = {},
  ) => ({
    resolutionId: 'resolution-1',
    confidence: ResolutionAiConfidence.high,
    notExecutedReason: overrides.notExecutedReason,
    review: {
      verdict: overrides.verdict ?? ResolutionAiVerdict.agree,
      recommendedAction: ResolutionAiRecommendedAction.accept,
      reasoning: 'specs agree',
      evidenceCited: ['live specs'],
      model: 'gpt-5.6-luna',
      costUsd: overrides.costUsd ?? 0.002,
      executed: overrides.executed ?? true,
    },
  });

  beforeEach(() => {
    repo = { findAiReviewBatch: jest.fn().mockResolvedValue([]) };
    reviewService = { review: jest.fn().mockResolvedValue(outcome()) };
    config = {
      resolution: {
        automation: {
          enabled: true,
          ai: { executeDestructive: true, maxCostUsdPerRun: 2 },
        },
      },
    };

    service = new ResolutionAiReviewBatchService(
      repo as unknown as ProductResolutionRepository,
      reviewService as unknown as ResolutionAiReviewService,
      config as unknown as DynamicConfigService,
    );
  });

  describe('the summary', () => {
    it('separates executed, advisory, abstained and stale', async () => {
      repo.findAiReviewBatch.mockResolvedValue(rows(4));
      reviewService.review
        .mockResolvedValueOnce(outcome({ executed: true }))
        .mockResolvedValueOnce(
          outcome({ executed: false, notExecutedReason: 'not_confident' }),
        )
        .mockResolvedValueOnce(
          outcome({ executed: false, verdict: ResolutionAiVerdict.abstain }),
        )
        .mockResolvedValueOnce(
          outcome({ executed: false, notExecutedReason: 'stale' }),
        );

      const summary = await service.run();

      expect(summary.rowsReviewed).toBe(4);
      expect(summary.executed).toBe(1);
      // The abstain counts as advisory too — it was judged and left for a human.
      expect(summary.advisory).toBe(2);
      expect(summary.abstained).toBe(1);
      expect(summary.skippedStale).toBe(1);
    });

    it('keeps going when one row throws', async () => {
      // A provider hiccup on row 2 must not cost the other rows their review.
      repo.findAiReviewBatch.mockResolvedValue(rows(3));
      reviewService.review
        .mockResolvedValueOnce(outcome())
        .mockRejectedValueOnce(new Error('provider 503'))
        .mockResolvedValueOnce(outcome());

      const summary = await service.run();

      expect(summary.failed).toBe(1);
      expect(summary.rowsReviewed).toBe(2);
      expect(reviewService.review).toHaveBeenCalledTimes(3);
    });

    it('reports capped when the batch filled the row limit', async () => {
      repo.findAiReviewBatch.mockResolvedValue(rows(5));

      const summary = await service.run({ maxPerRun: 5 });

      expect(summary.capped).toBe(true);
    });
  });

  describe('the cost cap', () => {
    it('stops before the call that would exceed it, not after', async () => {
      // A spend limit you only notice having passed is not a limit. Six rows at
      // $1 each against a $2 cap must cost $2, not $6.
      repo.findAiReviewBatch.mockResolvedValue(rows(6));
      reviewService.review.mockResolvedValue(outcome({ costUsd: 1 }));

      const summary = await service.run();

      expect(summary.rowsReviewed).toBe(2);
      expect(summary.costUsd).toBe(2);
      expect(summary.capped).toBe(true);
      expect(reviewService.review).toHaveBeenCalledTimes(2);
    });

    it('accumulates cost across the run', async () => {
      repo.findAiReviewBatch.mockResolvedValue(rows(3));
      reviewService.review.mockResolvedValue(outcome({ costUsd: 0.002 }));

      const summary = await service.run();

      expect(summary.costUsd).toBeCloseTo(0.006, 6);
    });
  });

  describe('per-run overrides', () => {
    it('passes the row limit and priority floor to intake', async () => {
      await service.run({ maxPerRun: 7, minPriority: 40 });

      expect(repo.findAiReviewBatch).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 7, minPriority: 40 }),
      );
    });

    it('lets a request turn destructive execution OFF', async () => {
      repo.findAiReviewBatch.mockResolvedValue(rows(1));

      await service.run({ executeDestructive: false });

      expect(reviewService.review).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ executeDestructive: false }),
      );
    });

    it('never lets a request turn destructive execution ON', async () => {
      // The switch that deletes products. A request being able to flip it would
      // make the config's "off" meaningless — an override may only tighten.
      config.resolution.automation.ai = {
        executeDestructive: false,
      };
      repo.findAiReviewBatch.mockResolvedValue(rows(1));

      await service.run({ executeDestructive: true });

      expect(reviewService.review).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ executeDestructive: false }),
      );
    });

    it('resolves the config once, not per row', async () => {
      // Half a run judged under one setting and half under another, because
      // someone edited the dynamic config mid-run, would be very hard to reason
      // about afterwards.
      repo.findAiReviewBatch.mockResolvedValue(rows(3));

      await service.run();

      const configs = reviewService.review.mock.calls.map((call) => call[1]);
      expect(configs[0]).toBe(configs[1]);
      expect(configs[1]).toBe(configs[2]);
    });
  });

  it('does nothing at all when AI review is disabled', async () => {
    config.resolution.automation = { enabled: false };

    const summary = await service.run();

    expect(repo.findAiReviewBatch).not.toHaveBeenCalled();
    expect(summary.rowsReviewed).toBe(0);
  });
});
