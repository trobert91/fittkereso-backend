import type { ProductModel, ProductSpecs } from '@fittkereso-backend/database';
import { ProductNormalizerService } from '@fittkereso-backend/product';
import type { RecallRow } from './candidate-recall.service';
import { FLAT_IDF } from './name-similarity';
import { ProductCandidateFinderService } from './product-candidate-finder.service';
import { ProductMatchQueryService } from './product-match-query.service';
import type { ProductMatchQuery } from './types';

describe('ProductCandidateFinderService.findCandidates', () => {
  let recall: { recall: jest.Mock };
  let productRepo: { find: jest.Mock };
  let categoryConfigService: { getConfig: jest.Mock };
  let tokenIdf: { forScope: jest.Mock };
  let finder: ProductCandidateFinderService;

  const query: ProductMatchQuery = {
    productId: 'query-product',
    brandId: 'brand-cube',
    brandName: 'Cube',
    categoryId: 'cat-ebikes',
    categorySlug: 'ebikes',
    nameKey: '140 hybrid stereo',
    specs: { modelYear: 2024 },
  };

  function row(
    productId: string,
    matchedOn: RecallRow['matchedOn'],
    matchedValue: string,
    trigram: number,
  ): RecallRow {
    return { productId, matchedOn, matchedValue, trigram };
  }

  function product(id: string, specs: ProductSpecs = {}, createdAt = '2026-01-01'): ProductModel {
    return { id, displayName: `Product ${id}`, createdAt: new Date(createdAt), specs } as ProductModel;
  }

  beforeEach(() => {
    recall = { recall: jest.fn().mockResolvedValue([]) };
    productRepo = { find: jest.fn().mockResolvedValue([]) };
    categoryConfigService = { getConfig: jest.fn().mockReturnValue(undefined) };
    tokenIdf = { forScope: jest.fn().mockResolvedValue(FLAT_IDF) };
    finder = new ProductCandidateFinderService(
      recall as never,
      productRepo as never,
      new ProductMatchQueryService(new ProductNormalizerService(), categoryConfigService as never),
      categoryConfigService as never,
      tokenIdf as never,
    );
  });

  it('returns nothing, without loading products, when recall finds nothing', async () => {
    await expect(finder.findCandidates(query)).resolves.toEqual([]);
    expect(productRepo.find).not.toHaveBeenCalled();
  });

  it('never returns the query product itself', async () => {
    recall.recall.mockResolvedValue([row('query-product', 'name', '140 hybrid stereo', 1)]);

    await expect(finder.findCandidates(query)).resolves.toEqual([]);
    expect(productRepo.find).not.toHaveBeenCalled();
  });

  it("keeps each product's best row, scoring an alias on its re-keyed form", async () => {
    recall.recall.mockResolvedValue([
      row('p1', 'name', '140 hybrid', 0.6),
      // Raw alias with the brand in front: re-keyed, it equals the query key.
      row('p1', 'alias', 'Cube Stereo Hybrid 140', 0.5),
    ]);
    productRepo.find.mockResolvedValue([product('p1')]);

    const candidates = await finder.findCandidates(query);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      productId: 'p1',
      matchedOn: 'alias',
      matchedValue: 'Cube Stereo Hybrid 140',
      // Re-keyed, the alias equals the query key, so all three agree on 1 —
      // recall's own 0.5 described the raw alias and never reaches the score.
      nameSimilarity: { trigram: 1, levenshtein: 1, alignment: 1 },
      score: 100,
      failedGates: [],
    });
  });

  it('loads every candidate in one query', async () => {
    recall.recall.mockResolvedValue([
      row('p1', 'name', '140 hybrid stereo', 1),
      row('p2', 'name', '140 hybrid stereo', 1),
      row('p1', 'alias', 'Stereo Hybrid 140', 0.9),
    ]);
    productRepo.find.mockResolvedValue([product('p1'), product('p2')]);

    await finder.findCandidates(query);

    expect(productRepo.find).toHaveBeenCalledTimes(1);
    expect(productRepo.find.mock.calls[0][0].where.id.value).toEqual(['p1', 'p2']);
  });

  it('applies the category gates and returns candidates best first', async () => {
    categoryConfigService.getConfig.mockReturnValue({
      primarySpecs: ['modelYear'],
      matchingConfig: { specTolerances: { modelYear: { absolute: 0 } } },
    });
    recall.recall.mockResolvedValue([
      row('older-year', 'name', '140 hybrid stereo', 1),
      row('same-year', 'name', '140 hybrid stereo', 1),
    ]);
    productRepo.find.mockResolvedValue([
      product('same-year', { modelYear: 2024 }),
      product('older-year', { modelYear: 2023 }),
    ]);

    const candidates = await finder.findCandidates(query);

    expect(categoryConfigService.getConfig).toHaveBeenCalledWith('ebikes');
    expect(candidates.map(({ productId, score }) => [productId, score])).toEqual([
      ['same-year', 100],
      ['older-year', 70],
    ]);
    expect(candidates[1].failedGates).toEqual([
      expect.objectContaining({ gate: 'primarySpecMismatch', queryValue: 2024, candidateValue: 2023 }),
    ]);
  });

  it('breaks a score tie by the older product first', async () => {
    recall.recall.mockResolvedValue([
      row('newer', 'name', '140 hybrid stereo', 1),
      row('older', 'name', '140 hybrid stereo', 1),
    ]);
    productRepo.find.mockResolvedValue([
      product('newer', {}, '2026-05-01'),
      product('older', {}, '2025-05-01'),
    ]);

    const candidates = await finder.findCandidates(query);

    expect(candidates.map(({ productId }) => productId)).toEqual(['older', 'newer']);
  });

  it('drops a product deleted between recall and load', async () => {
    recall.recall.mockResolvedValue([
      row('p1', 'name', '140 hybrid stereo', 1),
      row('gone', 'name', '140 hybrid stereo', 1),
    ]);
    productRepo.find.mockResolvedValue([product('p1')]);

    const candidates = await finder.findCandidates(query);

    expect(candidates.map(({ productId }) => productId)).toEqual(['p1']);
  });
});
