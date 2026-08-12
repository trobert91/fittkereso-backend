import type { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { RecallService } from './recall.service';
import { makeTestContext } from '../testing/make-context';
import type { RecallStrategy } from '../models/strategy-types';
import type { SlimCandidate } from '../models/slim-types';

function makeStrategy(
  name: RecallStrategy['name'],
  options: {
    candidates?: SlimCandidate[];
    shouldRun?: boolean;
    throws?: boolean;
  } = {},
): RecallStrategy {
  return {
    name,
    shouldRun: jest.fn(() => options.shouldRun ?? true),
    recall: jest.fn().mockImplementation(async () => {
      if (options.throws) throw new Error('strategy boom');
      return options.candidates ?? [];
    }),
  };
}

function makeDynamicConfig(maxCandidates = 50): DynamicConfigService {
  return {
    search: { maxModelVariants: 20, maxCandidates },
  } as unknown as DynamicConfigService;
}

function slim(
  id: string,
  source: SlimCandidate['source'] = 'fuzzy',
): SlimCandidate {
  return { productId: id, source };
}

describe('RecallService', () => {
  it('iterates strategies and merges candidates', async () => {
    const fuzzy = makeStrategy('fuzzy', {
      candidates: [slim('p1'), slim('p2')],
    });
    const embedding = makeStrategy('embedding', {
      candidates: [slim('p3', 'embedding')],
    });
    const service = new RecallService([fuzzy, embedding], makeDynamicConfig());

    const context = makeTestContext();
    await service.recall(context);

    expect(context.candidates.map((c) => c.productId).sort()).toEqual([
      'p1',
      'p2',
      'p3',
    ]);
    expect(context.strategiesRun).toEqual(['fuzzy', 'embedding']);
  });

  it('skips strategies whose shouldRun returns false', async () => {
    const fuzzy = makeStrategy('fuzzy', { candidates: [slim('p1')] });
    const embedding = makeStrategy('embedding', {
      candidates: [slim('p3', 'embedding')],
      shouldRun: false,
    });
    const service = new RecallService([fuzzy, embedding], makeDynamicConfig());

    const context = makeTestContext();
    await service.recall(context);

    expect(embedding.recall).not.toHaveBeenCalled();
    expect(context.candidates.map((c) => c.productId)).toEqual(['p1']);
    expect(context.strategiesRun).toEqual(['fuzzy']);
  });

  it('dedupes candidates emitted by multiple strategies', async () => {
    const fuzzy = makeStrategy('fuzzy', { candidates: [slim('p1')] });
    const embedding = makeStrategy('embedding', {
      candidates: [slim('p1', 'embedding')],
    });
    const service = new RecallService([fuzzy, embedding], makeDynamicConfig());

    const context = makeTestContext();
    await service.recall(context);

    expect(context.candidates).toHaveLength(1);
  });

  it('excludes input.referenceProductId from the final pool', async () => {
    const fuzzy = makeStrategy('fuzzy', {
      candidates: [slim('ref-id'), slim('p2')],
    });
    const service = new RecallService([fuzzy], makeDynamicConfig());

    const context = makeTestContext({
      input: { referenceProductId: 'ref-id' },
    });
    await service.recall(context);

    expect(context.candidates.map((c) => c.productId)).toEqual(['p2']);
    expect(context.recallFunnel?.afterDedupe).toBe(2);
    expect(context.recallFunnel?.afterReferenceExclusion).toBe(1);
  });

  it('caps pool size at search.maxCandidates by matchScore', async () => {
    const fuzzy = makeStrategy('fuzzy', {
      candidates: [
        { productId: 'low', source: 'fuzzy', matchScore: 10 },
        { productId: 'high', source: 'fuzzy', matchScore: 90 },
        { productId: 'mid', source: 'fuzzy', matchScore: 50 },
      ],
    });
    const service = new RecallService([fuzzy], makeDynamicConfig(2));

    const context = makeTestContext();
    await service.recall(context);

    expect(context.candidates.map((c) => c.productId)).toEqual(['high', 'mid']);
  });

  it('records a phase error when a strategy throws and continues', async () => {
    const fuzzy = makeStrategy('fuzzy', { throws: true });
    const embedding = makeStrategy('embedding', {
      candidates: [slim('p3', 'embedding')],
    });
    const service = new RecallService([fuzzy, embedding], makeDynamicConfig());

    const context = makeTestContext();
    await service.recall(context);

    expect(context.errors[0].phase).toBe('recall');
    expect(context.errors[0].detail).toBe('fuzzy');
    expect(context.candidates.map((c) => c.productId)).toEqual(['p3']);
  });

  it('records recallFunnel with per-source hit counts', async () => {
    const fuzzy = makeStrategy('fuzzy', {
      candidates: [slim('p1'), slim('p2')],
    });
    const embedding = makeStrategy('embedding', {
      candidates: [slim('p3', 'embedding')],
    });
    const service = new RecallService([fuzzy, embedding], makeDynamicConfig());

    const context = makeTestContext();
    await service.recall(context);

    expect(context.recallFunnel).toEqual({
      fuzzyHits: 2,
      embeddingHits: 1,
      webHits: 0,
      afterDedupe: 3,
      afterReferenceExclusion: 3,
    });
  });

  describe('additive funnel across multiple calls', () => {
    it('preserves prior hit counts when called again', async () => {
      const fuzzy = makeStrategy('fuzzy', { candidates: [slim('p1')] });
      const embedding = makeStrategy('embedding', {
        candidates: [slim('p2', 'embedding')],
        shouldRun: false,
      });
      const service = new RecallService(
        [fuzzy, embedding],
        makeDynamicConfig(),
      );

      const context = makeTestContext();
      // First call: only fuzzy runs.
      await service.recall(context);
      expect(context.recallFunnel).toEqual({
        fuzzyHits: 1,
        embeddingHits: 0,
        webHits: 0,
        afterDedupe: 1,
        afterReferenceExclusion: 1,
      });

      // Second call: fuzzy guards itself, embedding flips to true and fires.
      (fuzzy.shouldRun as jest.Mock).mockReturnValue(false);
      (embedding.shouldRun as jest.Mock).mockReturnValue(true);
      await service.recall(context);

      expect(context.recallFunnel).toEqual({
        fuzzyHits: 1, // preserved
        embeddingHits: 1, // new
        webHits: 0,
        afterDedupe: 2,
        afterReferenceExclusion: 2,
      });
    });

    it('a strategy whose shouldRun returns true on every call fires every call (N-shot)', async () => {
      // Mimics a hypothetical N-shot strategy. Uses 'fuzzy' name purely to
      // satisfy the type — single-shot is a per-strategy policy, not a
      // framework constraint.
      const nShot = makeStrategy('fuzzy', { candidates: [slim('p1')] });
      const service = new RecallService([nShot], makeDynamicConfig());

      const context = makeTestContext();
      await service.recall(context);
      await service.recall(context);
      await service.recall(context);

      expect(nShot.recall).toHaveBeenCalledTimes(3);
      expect(context.strategiesRun).toEqual(['fuzzy', 'fuzzy', 'fuzzy']);
      expect(context.recallFunnel?.fuzzyHits).toBe(3);
    });
  });
});
