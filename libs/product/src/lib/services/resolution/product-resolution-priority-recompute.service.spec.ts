import {
  ProductResolution,
  ProductResolutionFlow,
  ProductResolutionStatus,
  ResolutionActionKind,
  ResolutionActor,
  ResolutionVerdict,
  type OfferRepository,
  type ProductResolutionRepository,
  type ProductSourceRecordRepository,
} from '@fittkereso-backend/database';
import type { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { ProductResolutionPriorityRecomputeService } from './product-resolution-priority-recompute.service';
import { ProductResolutionPriorityService } from './product-resolution-priority.service';
import { ResolutionConfidenceService } from './resolution-confidence.service';
import { ResolutionScoringService } from './resolution-scoring.service';

describe('ProductResolutionPriorityRecomputeService', () => {
  let resolutionRepo: {
    findStalePriorityBatch: jest.Mock;
    updateScores: jest.Mock;
  };
  let sourceRecordRepo: { countByModelIds: jest.Mock };
  let offerRepo: { countByModelIds: jest.Mock };
  let config: {
    resolution?: { priority?: Record<string, unknown> };
  };
  let service: ProductResolutionPriorityRecomputeService;

  const row = (id: string, productId = `product-${id}`): ProductResolution =>
    ({
      id,
      flow: ProductResolutionFlow.product_resolution,
      status: ProductResolutionStatus.pending,
      similarityScore: 40,
      resolvedProduct: { id: productId },
      decisions: [
        {
          at: new Date().toISOString(),
          actor: ResolutionActor.system,
          verdict: ResolutionVerdict.matched_existing,
          action: { kind: ResolutionActionKind.match, productId },
          actionPerformed: true,
        },
      ],
    }) as ProductResolution;

  /** Queues up the batches the sweep will see, then an empty one to stop it. */
  const servesBatches = (...batches: ProductResolution[][]) => {
    for (const batch of batches) {
      resolutionRepo.findStalePriorityBatch.mockResolvedValueOnce(batch);
    }
    resolutionRepo.findStalePriorityBatch.mockResolvedValue([]);
  };

  beforeEach(() => {
    resolutionRepo = {
      findStalePriorityBatch: jest.fn().mockResolvedValue([]),
      updateScores: jest.fn().mockImplementation((u: unknown[]) => u.length),
    };
    sourceRecordRepo = { countByModelIds: jest.fn().mockResolvedValue(new Map()) };
    offerRepo = { countByModelIds: jest.fn().mockResolvedValue(new Map()) };
    config = { resolution: { priority: { recomputeBatchSize: 2 } } };

    service = new ProductResolutionPriorityRecomputeService(
      resolutionRepo as unknown as ProductResolutionRepository,
      sourceRecordRepo as unknown as ProductSourceRecordRepository,
      offerRepo as unknown as OfferRepository,
      new ResolutionScoringService(
        new ProductResolutionPriorityService(new ResolutionConfidenceService()),
        config as unknown as DynamicConfigService,
      ),
      config as unknown as DynamicConfigService,
    );
  });

  describe('the query shape', () => {
    it('counts a whole batch at once, not once per row', () => {
      // The property the sweep lives or dies on. Per-row counting would be four
      // queries here instead of two, and thousands instead of a handful in
      // production.
      servesBatches([row('a'), row('b')]);

      return service.recompute().then(() => {
        expect(sourceRecordRepo.countByModelIds).toHaveBeenCalledTimes(1);
        expect(offerRepo.countByModelIds).toHaveBeenCalledTimes(1);
        expect(sourceRecordRepo.countByModelIds).toHaveBeenCalledWith([
          'product-a',
          'product-b',
        ]);
      });
    });

    it('writes a batch in a single bulk update', async () => {
      servesBatches([row('a'), row('b')]);

      await service.recompute();

      expect(resolutionRepo.updateScores).toHaveBeenCalledTimes(1);
      expect(resolutionRepo.updateScores.mock.calls[0][0]).toHaveLength(2);
    });

    it('asks for each product once however many rows point at it', async () => {
      servesBatches([row('a', 'shared'), row('b', 'shared')]);

      await service.recompute();

      expect(sourceRecordRepo.countByModelIds).toHaveBeenCalledWith(['shared']);
    });

    it('keeps going until the queue is drained', async () => {
      servesBatches([row('a'), row('b')], [row('c')]);

      const summary = await service.recompute();

      expect(summary.rowsRescored).toBe(3);
      expect(summary.batches).toBe(2);
    });
  });

  describe('what it writes', () => {
    it('writes both scores, with the breakdown that explains the priority', async () => {
      servesBatches([row('a')]);

      await service.recompute();

      const [update] = resolutionRepo.updateScores.mock.calls[0][0];
      expect(update.id).toBe('a');
      expect(update.decisionConfidence).toEqual(expect.any(Number));
      expect(update.priorityBreakdown.priority).toBe(update.priority);
    });

    it('marks the blast radius measured, which is the point of running at all', async () => {
      sourceRecordRepo.countByModelIds.mockResolvedValue(
        new Map([['product-a', 30]]),
      );
      offerRepo.countByModelIds.mockResolvedValue(new Map([['product-a', 12]]));
      servesBatches([row('a')]);

      await service.recompute();

      const [update] = resolutionRepo.updateScores.mock.calls[0][0];
      expect(update.priorityBreakdown.blastRadiusMeasured).toBe(true);
      expect(
        update.priorityBreakdown.impactFactors.find(
          (factor: { key: string }) => factor.key === 'blastRadius',
        ).value,
      ).toBeGreaterThan(0.5);
    });

    it('lifts a row that turned out to carry more than it did at write time', async () => {
      const quiet = await rescoreOnce();

      sourceRecordRepo.countByModelIds.mockResolvedValue(
        new Map([['product-a', 400]]),
      );
      const busy = await rescoreOnce();

      expect(busy).toBeGreaterThan(quiet);

      async function rescoreOnce(): Promise<number> {
        resolutionRepo.findStalePriorityBatch.mockReset();
        resolutionRepo.updateScores.mockClear();
        servesBatches([row('a')]);
        await service.recompute();
        return resolutionRepo.updateScores.mock.calls[0][0][0].priority;
      }
    });

    it('produces the same scores when run twice over unchanged rows', async () => {
      servesBatches([row('a')]);
      await service.recompute();
      const first = resolutionRepo.updateScores.mock.calls[0][0];

      resolutionRepo.findStalePriorityBatch.mockReset();
      resolutionRepo.updateScores.mockClear();
      servesBatches([row('a')]);
      await service.recompute();

      expect(resolutionRepo.updateScores.mock.calls[0][0]).toEqual(first);
    });
  });

  describe('bounds', () => {
    it('stops at maxRowsPerRun rather than running until morning', async () => {
      config.resolution = { priority: { recomputeBatchSize: 2, maxRowsPerRun: 3 } };
      resolutionRepo.findStalePriorityBatch.mockImplementation(
        (_before: Date, limit: number) =>
          Promise.resolve(
            Array.from({ length: limit }, (_, i) => row(`row-${i}`)),
          ),
      );

      const summary = await service.recompute();

      expect(summary.rowsRescored).toBe(3);
      expect(summary.capped).toBe(true);
    });

    it('does nothing at all when switched off', async () => {
      config.resolution = { priority: { recomputeEnabled: false } };

      const summary = await service.recompute();

      expect(summary.rowsRescored).toBe(0);
      expect(resolutionRepo.findStalePriorityBatch).not.toHaveBeenCalled();
    });

    it('holds the cursor still for the whole run, so no row is rescored twice', async () => {
      servesBatches([row('a')], [row('b')]);

      await service.recompute();

      const [first, second] = resolutionRepo.findStalePriorityBatch.mock.calls;
      expect(first[0]).toEqual(second[0]);
    });
  });
});
