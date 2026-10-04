import type { ProductModel, ProductSpecs } from '@fittkereso-backend/database';
import { ProductNormalizerService } from '@fittkereso-backend/product';
import type { RecallRow } from './candidate-recall.service';
import { FLAT_IDF } from './name-similarity';
import { ProductCandidateFinderService } from './product-candidate-finder.service';
import { ProductMatchQueryService } from './product-match-query.service';
import type { ProductMatchQuery } from './types';

describe('ProductCandidateFinderService.findCandidates', () => {
  let recall: { exact: jest.Mock; fuzzy: jest.Mock };
  let sourceRecordRepo: { findNormalizedModelsByProductIds: jest.Mock };
  let productRepo: { find: jest.Mock };
  let categoryConfigService: { getConfig: jest.Mock };
  let tokenIdf: { forScope: jest.Mock };
  let finder: ProductCandidateFinderService;

  /** A listing's query: one model key. */
  const listing: ProductMatchQuery = {
    brandId: 'brand-cube',
    brandName: 'Cube',
    categoryId: 'cat-ebikes',
    categorySlug: 'ebikes',
    keys: ['140 hybrid stereo'],
    keyed: true,
    model: 'Stereo Hybrid 140',
    specs: { modelYear: 2024 },
  };

  /** A stored product's query: its keys are loaded from its listings. */
  const stored: ProductMatchQuery = {
    productId: 'query-product',
    brandId: 'brand-cube',
    brandName: 'Cube',
    categoryId: 'cat-ebikes',
    categorySlug: 'ebikes',
    model: 'Stereo Hybrid 140',
    specs: { modelYear: 2024 },
  };

  function row(productId: string, normalizedModel: string, model: string | null = null): RecallRow {
    return { productId, normalizedModel, model };
  }

  function product(
    id: string,
    specs: ProductSpecs = {},
    createdAt = '2026-01-01',
    model = 'Stereo Hybrid 140',
  ): ProductModel {
    return { id, model, createdAt: new Date(createdAt), specs } as ProductModel;
  }

  beforeEach(() => {
    recall = {
      exact: jest.fn().mockResolvedValue([]),
      fuzzy: jest.fn().mockResolvedValue([]),
    };
    sourceRecordRepo = { findNormalizedModelsByProductIds: jest.fn().mockResolvedValue(new Map()) };
    productRepo = { find: jest.fn().mockResolvedValue([]) };
    categoryConfigService = { getConfig: jest.fn().mockReturnValue(undefined) };
    tokenIdf = { forScope: jest.fn().mockResolvedValue(FLAT_IDF) };
    finder = new ProductCandidateFinderService(
      recall as never,
      productRepo as never,
      new ProductMatchQueryService(new ProductNormalizerService(), categoryConfigService as never),
      categoryConfigService as never,
      tokenIdf as never,
      sourceRecordRepo as never,
    );
  });

  it('returns nothing, without loading products, when recall finds nothing', async () => {
    await expect(finder.findCandidates(listing)).resolves.toEqual([]);
    expect(productRepo.find).not.toHaveBeenCalled();
  });

  it('recalls by the exact key and by trigram on it', async () => {
    await finder.findCandidates(listing);

    expect(recall.exact).toHaveBeenCalledWith(listing, ['140 hybrid stereo']);
    expect(recall.fuzzy).toHaveBeenCalledWith(listing, '140 hybrid stereo');
  });

  it('never returns the query product itself', async () => {
    sourceRecordRepo.findNormalizedModelsByProductIds.mockResolvedValue(
      new Map([['query-product', ['140 hybrid stereo']]]),
    );
    recall.fuzzy.mockResolvedValue([row('query-product', '140 hybrid stereo')]);

    await expect(finder.findCandidates(stored)).resolves.toEqual([]);
    expect(productRepo.find).not.toHaveBeenCalled();
  });

  it('says which candidates have the key, and names them by brand and model', async () => {
    recall.exact.mockResolvedValue([row('p-key', '140 hybrid stereo', 'Stereo Hybrid 140')]);
    recall.fuzzy.mockResolvedValue([
      row('p-key', '140 hybrid stereo', 'Stereo Hybrid 140'),
      row('p-near', '140 hpc hybrid stereo', 'Stereo Hybrid 140 HPC'),
    ]);
    productRepo.find.mockResolvedValue([
      product('p-key'),
      product('p-near', {}, '2026-01-01', 'Stereo Hybrid 140 HPC'),
    ]);

    const candidates = await finder.findCandidates(listing);

    expect(candidates.find((c) => c.productId === 'p-key')).toMatchObject({
      displayName: 'Cube Stereo Hybrid 140',
      matchedOn: 'normalizedModel',
      matchedValue: '140 hybrid stereo',
      normalizedModelMatch: true,
      score: 100,
    });
    expect(candidates.find((c) => c.productId === 'p-near')).toMatchObject({
      matchedOn: 'trigram',
      matchedValue: '140 hpc hybrid stereo',
      normalizedModelMatch: false,
    });
  });

  it("keeps each product's best listing: one with the key first, then the closest", async () => {
    recall.fuzzy.mockResolvedValue([
      row('p1', '140 hpc hybrid stereo'),
      row('p1', '140 hybrid stereo'),
      row('p1', '140 hybrid'),
    ]);
    productRepo.find.mockResolvedValue([product('p1')]);

    const [candidate] = await finder.findCandidates(listing);

    expect(candidate).toMatchObject({ matchedValue: '140 hybrid stereo', normalizedModelMatch: true });
  });

  it('only recalls equal keys when asked not to search by trigram', async () => {
    recall.exact.mockResolvedValue([row('p1', '140 hybrid stereo')]);
    productRepo.find.mockResolvedValue([product('p1')]);

    const candidates = await finder.findCandidates(listing, { fuzzy: false });

    expect(recall.fuzzy).not.toHaveBeenCalled();
    expect(candidates.map(({ productId }) => productId)).toEqual(['p1']);
  });

  it('loads every candidate in one query', async () => {
    recall.fuzzy.mockResolvedValue([
      row('p1', '140 hybrid stereo'),
      row('p2', '140 hybrid stereo'),
      row('p1', '140 hybrid'),
    ]);
    productRepo.find.mockResolvedValue([product('p1'), product('p2')]);

    await finder.findCandidates(listing);

    expect(productRepo.find).toHaveBeenCalledTimes(1);
    expect(productRepo.find.mock.calls[0][0].where.id.value).toEqual(['p1', 'p2']);
  });

  it('applies the category gates and returns candidates best first', async () => {
    categoryConfigService.getConfig.mockReturnValue({
      primarySpecs: ['modelYear'],
      matchingConfig: { specTolerances: { modelYear: { absolute: 0 } } },
    });
    recall.fuzzy.mockResolvedValue([
      row('older-year', '140 hybrid stereo'),
      row('same-year', '140 hybrid stereo'),
    ]);
    productRepo.find.mockResolvedValue([
      product('same-year', { modelYear: 2024 }),
      product('older-year', { modelYear: 2023 }),
    ]);

    const candidates = await finder.findCandidates(listing);

    expect(categoryConfigService.getConfig).toHaveBeenCalledWith('ebikes');
    expect(candidates.map(({ productId, score }) => [productId, score])).toEqual([
      ['same-year', 100],
      ['older-year', 70],
    ]);
    expect(candidates[1].failedGates).toEqual([
      expect.objectContaining({ gate: 'primarySpecMismatch', queryValue: 2024, candidateValue: 2023 }),
    ]);
  });

  it('checks model numbers on the names as written, and leaves them out of keyScore', async () => {
    categoryConfigService.getConfig.mockReturnValue({ primarySpecs: ['modelYear'] });
    recall.fuzzy.mockResolvedValue([row('p1', '830 cx tour', 'Tour CX830')]);
    productRepo.find.mockResolvedValue([product('p1', { modelYear: 2024 })]);

    const [candidate] = await finder.findCandidates({
      ...listing,
      keys: ['820 cx tour'],
      model: 'Tour CX 820',
    });

    expect(candidate.failedGates.map((gate) => gate.gate)).toEqual(['modelNumberMismatch']);
    expect(candidate.keyScore).toBe(100);
  });

  it('breaks a score tie by the older product first', async () => {
    recall.fuzzy.mockResolvedValue([
      row('newer', '140 hybrid stereo'),
      row('older', '140 hybrid stereo'),
    ]);
    productRepo.find.mockResolvedValue([
      product('newer', {}, '2026-05-01'),
      product('older', {}, '2025-05-01'),
    ]);

    const candidates = await finder.findCandidates(listing);

    expect(candidates.map(({ productId }) => productId)).toEqual(['older', 'newer']);
  });

  it('drops a product deleted between recall and load', async () => {
    recall.fuzzy.mockResolvedValue([row('p1', '140 hybrid stereo'), row('gone', '140 hybrid stereo')]);
    productRepo.find.mockResolvedValue([product('p1')]);

    const candidates = await finder.findCandidates(listing);

    expect(candidates.map(({ productId }) => productId)).toEqual(['p1']);
  });

  describe('a query without a model key', () => {
    const titled: ProductMatchQuery = { ...listing, keyed: false };

    it('searches by trigram only, and says nothing about a key match', async () => {
      recall.fuzzy.mockResolvedValue([row('p1', '140 hybrid stereo')]);
      productRepo.find.mockResolvedValue([product('p1')]);

      const [candidate] = await finder.findCandidates(titled);

      expect(recall.exact).not.toHaveBeenCalled();
      expect(candidate.normalizedModelMatch).toBeUndefined();
      expect(candidate.matchedOn).toBe('trigram');
    });

    it('recalls nothing when asked for equal keys only', async () => {
      await expect(finder.findCandidates(titled, { fuzzy: false })).resolves.toEqual([]);
      expect(recall.exact).not.toHaveBeenCalled();
    });
  });

  describe('a stored product', () => {
    it("searches by its listings' keys", async () => {
      sourceRecordRepo.findNormalizedModelsByProductIds.mockResolvedValue(
        new Map([['query-product', ['140 hybrid stereo', '140 hybrid stereo xl']]]),
      );
      recall.fuzzy.mockResolvedValue([row('p1', '140 hybrid stereo xl')]);
      productRepo.find.mockResolvedValue([product('p1')]);

      const [candidate] = await finder.findCandidates(stored);

      expect(sourceRecordRepo.findNormalizedModelsByProductIds).toHaveBeenCalledWith(['query-product']);
      expect(recall.exact).toHaveBeenCalledWith(stored, ['140 hybrid stereo', '140 hybrid stereo xl']);
      expect(recall.fuzzy).toHaveBeenCalledTimes(2);
      expect(candidate).toMatchObject({ normalizedModelMatch: true, score: 100 });
    });

    it("falls back to its own model's words, which match no key, when no listing has one", async () => {
      recall.fuzzy.mockResolvedValue([row('p1', '140 hybrid stereo')]);
      productRepo.find.mockResolvedValue([product('p1')]);

      const [candidate] = await finder.findCandidates(stored);

      expect(recall.fuzzy).toHaveBeenCalledWith(stored, '140 hybrid stereo');
      expect(recall.exact).not.toHaveBeenCalled();
      expect(candidate.normalizedModelMatch).toBeUndefined();
    });
  });
});
