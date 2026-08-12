import type {
  ProductFuzzySearchService,
  CandidateSearchInput,
} from '@fittkereso-backend/product';
import type { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import type {
  ProductModel,
  WithSimilarity,
} from '@fittkereso-backend/database';
import { FuzzyRecallStrategy } from './fuzzy.recall';
import { makeTestContext } from '../../testing/make-context';

function makeFuzzyHit(
  id: string,
  similarity: number,
  brandName?: string,
  categoryName?: string,
): WithSimilarity<ProductModel> {
  return {
    entity: {
      id,
      brand: brandName ? { name: brandName } : undefined,
      productCategory: categoryName
        ? { id: 'cat', name: categoryName, slug: categoryName.toLowerCase() }
        : undefined,
      specs: undefined,
      aliases: [],
    } as unknown as ProductModel,
    similarity,
  };
}

function makeDynamicConfig(maxModelVariants = 20): DynamicConfigService {
  return {
    search: { maxModelVariants, maxCandidates: 50 },
  } as unknown as DynamicConfigService;
}

describe('FuzzyRecallStrategy', () => {
  it('returns empty array when no variants can be built', async () => {
    const fuzzySearch = {
      search: jest.fn().mockResolvedValue([]),
    } as unknown as ProductFuzzySearchService;
    const strategy = new FuzzyRecallStrategy(fuzzySearch, makeDynamicConfig());

    const context = makeTestContext({ input: {} });
    const result = await strategy.recall(context);

    expect(result).toEqual([]);
    expect(fuzzySearch.search).not.toHaveBeenCalled();
  });

  it('records the variant seeds on ctx.modelVariants', async () => {
    const fuzzySearch = {
      search: jest.fn().mockResolvedValue([]),
    } as unknown as ProductFuzzySearchService;
    const strategy = new FuzzyRecallStrategy(fuzzySearch, makeDynamicConfig());

    const context = makeTestContext({ input: { model: 'MPG341CQPX' } });
    await strategy.recall(context);

    expect(context.modelVariants.length).toBeGreaterThanOrEqual(1);
    expect(context.modelVariants[0]).toEqual({
      model: 'MPG341CQPX',
      source: 'original',
    });
  });

  it('passes ctx.category.id as categoryIds when set', async () => {
    const fuzzySearch = {
      search: jest.fn().mockResolvedValue([]),
    } as unknown as ProductFuzzySearchService;
    const strategy = new FuzzyRecallStrategy(fuzzySearch, makeDynamicConfig());

    const context = makeTestContext({
      input: { model: 'MPG341CQPX' },
      category: { id: 'cat-monitors', name: 'Monitor', similarity: 1.0 },
    });
    await strategy.recall(context);

    expect(fuzzySearch.search).toHaveBeenCalled();
    const callArgs = (fuzzySearch.search as jest.Mock).mock.calls[0];
    const [, categoryIds] = callArgs as [
      CandidateSearchInput,
      string[] | undefined,
    ];
    expect(categoryIds).toEqual(['cat-monitors']);
  });

  it('dedupes candidates by productId', async () => {
    const fuzzySearch = {
      search: jest
        .fn()
        .mockResolvedValueOnce([makeFuzzyHit('p1', 0.8)])
        .mockResolvedValueOnce([makeFuzzyHit('p1', 0.9)]),
    } as unknown as ProductFuzzySearchService;
    const strategy = new FuzzyRecallStrategy(fuzzySearch, makeDynamicConfig());

    const context = makeTestContext({ input: { model: 'MPG 341CQPX' } });
    const result = await strategy.recall(context);

    const ids = result.map((candidate) => candidate.productId);
    expect(ids).toEqual(['p1']);
  });

  it('captures source=fuzzy on emitted SlimCandidates', async () => {
    const fuzzySearch = {
      search: jest
        .fn()
        .mockResolvedValue([makeFuzzyHit('p1', 0.9, 'MSI', 'Monitor')]),
    } as unknown as ProductFuzzySearchService;
    const strategy = new FuzzyRecallStrategy(fuzzySearch, makeDynamicConfig());

    const context = makeTestContext({ input: { model: 'MPG341CQPX' } });
    const result = await strategy.recall(context);

    expect(result[0].source).toBe('fuzzy');
    expect(result[0].brand).toBe('MSI');
    expect(result[0].productCategory?.slug).toBe('monitor');
  });

  it('records phase error when fuzzy search throws (continues with empty)', async () => {
    const fuzzySearch = {
      search: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as ProductFuzzySearchService;
    const strategy = new FuzzyRecallStrategy(fuzzySearch, makeDynamicConfig());

    const context = makeTestContext({ input: { model: 'MPG341CQPX' } });
    const result = await strategy.recall(context);

    expect(result).toEqual([]);
    expect(context.errors.length).toBeGreaterThanOrEqual(1);
    expect(context.errors[0].phase).toBe('recall');
  });

  describe('shouldRun', () => {
    it('returns true when fuzzy has not run yet', () => {
      const strategy = new FuzzyRecallStrategy(
        {} as ProductFuzzySearchService,
        makeDynamicConfig(),
      );
      expect(strategy.shouldRun(makeTestContext())).toBe(true);
    });

    it('returns false when fuzzy is already in strategiesRun (single-shot)', () => {
      const strategy = new FuzzyRecallStrategy(
        {} as ProductFuzzySearchService,
        makeDynamicConfig(),
      );
      expect(
        strategy.shouldRun(makeTestContext({ strategiesRun: ['fuzzy'] })),
      ).toBe(false);
    });
  });
});
