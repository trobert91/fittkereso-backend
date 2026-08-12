import type { ProductEmbeddingMatchService } from '@fittkereso-backend/product';
import type { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import type { EvaluatedProduct } from '@fittkereso-backend/database';
import { EmbeddingRecallStrategy } from './embedding.recall';
import { makeTestContext } from '../../testing/make-context';

function makeHit(id: string, confidence: number): EvaluatedProduct {
  return {
    id,
    confidence,
    aliases: [],
  } as EvaluatedProduct;
}

function makeDynamicConfig(): DynamicConfigService {
  return {
    search: { maxModelVariants: 20, maxCandidates: 50 },
  } as unknown as DynamicConfigService;
}

describe('EmbeddingRecallStrategy', () => {
  it('shouldRun=true when useEmbedding && no candidates yet', () => {
    const strategy = new EmbeddingRecallStrategy(
      {} as ProductEmbeddingMatchService,
      makeDynamicConfig(),
    );
    const context = makeTestContext({
      options: { useEmbedding: true, webSearchEnabled: false, mode: 'loose' },
    });
    expect(strategy.shouldRun(context)).toBe(true);
  });

  it('shouldRun=false when options.useEmbedding is false', () => {
    const strategy = new EmbeddingRecallStrategy(
      {} as ProductEmbeddingMatchService,
      makeDynamicConfig(),
    );
    const context = makeTestContext({
      options: { useEmbedding: false, webSearchEnabled: false, mode: 'loose' },
    });
    expect(strategy.shouldRun(context)).toBe(false);
  });

  it('shouldRun=false when fuzzy already returned candidates (first iteration)', () => {
    const strategy = new EmbeddingRecallStrategy(
      {} as ProductEmbeddingMatchService,
      makeDynamicConfig(),
    );
    const context = makeTestContext({
      candidates: [
        {
          productId: 'p1',
          source: 'fuzzy',
        },
      ],
    });
    expect(strategy.shouldRun(context)).toBe(false);
  });

  it('shouldRun=false when embedding is already in strategiesRun (single-shot)', () => {
    const strategy = new EmbeddingRecallStrategy(
      {} as ProductEmbeddingMatchService,
      makeDynamicConfig(),
    );
    const context = makeTestContext({ strategiesRun: ['embedding'] });
    expect(strategy.shouldRun(context)).toBe(false);
  });

  it('shouldRun=true on rescue iteration when scoring has failed gates', () => {
    const strategy = new EmbeddingRecallStrategy(
      {} as ProductEmbeddingMatchService,
      makeDynamicConfig(),
    );
    const context = makeTestContext({
      candidates: [{ productId: 'p1', source: 'fuzzy' }],
      strategiesRun: ['fuzzy'],
      scoring: {
        bestCandidate: { candidateId: 'p1', alias: 'p1', score: 30 },
        failedGates: ['low_confidence_anchored'],
      },
    });
    expect(strategy.shouldRun(context)).toBe(true);
  });

  it('shouldRun=true on rescue iteration when filter dropped every candidate', () => {
    const strategy = new EmbeddingRecallStrategy(
      {} as ProductEmbeddingMatchService,
      makeDynamicConfig(),
    );
    const context = makeTestContext({
      candidates: [],
      strategiesRun: ['fuzzy'],
      scoring: { failedGates: [] },
    });
    expect(strategy.shouldRun(context)).toBe(true);
  });

  it('shouldRun=false on rescue iteration when scoring accepted (no failed gates)', () => {
    const strategy = new EmbeddingRecallStrategy(
      {} as ProductEmbeddingMatchService,
      makeDynamicConfig(),
    );
    const context = makeTestContext({
      candidates: [{ productId: 'p1', source: 'fuzzy' }],
      strategiesRun: ['fuzzy'],
      scoring: {
        bestCandidate: { candidateId: 'p1', alias: 'p1', score: 95 },
        failedGates: [],
      },
    });
    expect(strategy.shouldRun(context)).toBe(false);
  });

  it('returns SlimCandidates from embedding hits with source=embedding', async () => {
    const embeddingMatch = {
      findMatches: jest.fn().mockResolvedValue([makeHit('p1', 0.92)]),
    } as unknown as ProductEmbeddingMatchService;
    const strategy = new EmbeddingRecallStrategy(
      embeddingMatch,
      makeDynamicConfig(),
    );

    const context = makeTestContext({ input: { model: 'MPG341CQPX' } });
    const result = await strategy.recall(context);

    expect(result).toHaveLength(1);
    expect(result[0].productId).toBe('p1');
    expect(result[0].source).toBe('embedding');
  });

  it('dedupes embedding hits by productId, keeping highest confidence', async () => {
    const embeddingMatch = {
      findMatches: jest
        .fn()
        .mockResolvedValueOnce([makeHit('p1', 0.7)])
        .mockResolvedValueOnce([makeHit('p1', 0.95)]),
    } as unknown as ProductEmbeddingMatchService;
    const strategy = new EmbeddingRecallStrategy(
      embeddingMatch,
      makeDynamicConfig(),
    );

    const context = makeTestContext({ input: { model: 'MPG 341CQPX' } });
    const result = await strategy.recall(context);

    expect(result).toHaveLength(1);
  });

  it('passes [ctx.brand.id] as brandIds to findMatches when context.brand is set', async () => {
    const findMatches = jest.fn().mockResolvedValue([]);
    const embeddingMatch = {
      findMatches,
    } as unknown as ProductEmbeddingMatchService;
    const strategy = new EmbeddingRecallStrategy(
      embeddingMatch,
      makeDynamicConfig(),
    );

    const context = makeTestContext({
      input: { model: 'MPG341CQPX' },
      brand: { id: 'brand-samsung', name: 'Samsung', similarity: 1.0 },
    });
    await strategy.recall(context);

    expect(findMatches).toHaveBeenCalled();
    const [, categoryArg, brandArg] = findMatches.mock.calls[0];
    expect(brandArg).toEqual(['brand-samsung']);
    expect(categoryArg).toBeUndefined();
  });

  it('passes undefined as brandIds to findMatches when context.brand is not set', async () => {
    const findMatches = jest.fn().mockResolvedValue([]);
    const embeddingMatch = {
      findMatches,
    } as unknown as ProductEmbeddingMatchService;
    const strategy = new EmbeddingRecallStrategy(
      embeddingMatch,
      makeDynamicConfig(),
    );

    const context = makeTestContext({ input: { model: 'MPG341CQPX' } });
    await strategy.recall(context);

    const [, , brandArg] = findMatches.mock.calls[0];
    expect(brandArg).toBeUndefined();
  });

  it('populates brandId on emitted SlimCandidates from EvaluatedProduct.brandId', async () => {
    const hit = {
      id: 'p1',
      confidence: 0.9,
      brand: 'Samsung',
      brandId: 'brand-samsung',
      aliases: [],
    } as EvaluatedProduct;
    const embeddingMatch = {
      findMatches: jest.fn().mockResolvedValue([hit]),
    } as unknown as ProductEmbeddingMatchService;
    const strategy = new EmbeddingRecallStrategy(
      embeddingMatch,
      makeDynamicConfig(),
    );

    const context = makeTestContext({ input: { model: 'MPG341CQPX' } });
    const result = await strategy.recall(context);

    expect(result[0].brandId).toBe('brand-samsung');
    expect(result[0].brand).toBe('Samsung');
  });

  it('records phase error when embedding match throws', async () => {
    const embeddingMatch = {
      findMatches: jest.fn().mockRejectedValue(new Error('embedding down')),
    } as unknown as ProductEmbeddingMatchService;
    const strategy = new EmbeddingRecallStrategy(
      embeddingMatch,
      makeDynamicConfig(),
    );

    const context = makeTestContext({ input: { model: 'MPG341CQPX' } });
    const result = await strategy.recall(context);

    expect(result).toEqual([]);
    expect(context.errors[0].phase).toBe('recall');
    expect(context.errors[0].detail).toBe('embedding');
  });
});
