import type { ScrapedProduct } from '@fittkereso-backend/database';
import { ListingMatchService } from './listing-match.service';
import { LISTING_DECISION_CANDIDATES } from './product-identity.constants';
import type { ProductCandidate, ProductMatchQuery } from './types';

const BRAND = { id: 'brand-1', name: 'KTM' };
const MATCH_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '22222222-2222-2222-2222-222222222222';
const KEY = 'kapoho macina master';

const SCRAPED = {
  brand: 'KTM',
  model: 'Macina Kapoho Master',
  originalName: 'KTM Macina Kapoho Master 2024 M/43',
  category: { id: 'category-1', slug: 'ebikes', name: 'E-bikes' },
  specs: { modelYear: 2024 },
} as ScrapedProduct;

const QUERY: ProductMatchQuery = {
  brandId: BRAND.id,
  brandName: BRAND.name,
  categoryId: 'category-1',
  categorySlug: 'ebikes',
  keys: [KEY],
  keyed: true,
  model: 'Macina Kapoho Master',
  specs: { modelYear: 2024 },
};

/** A candidate with the listing's key unless told otherwise. */
function candidateOf(
  productId: string,
  score: number,
  overrides: Partial<ProductCandidate> = {},
): ProductCandidate {
  return {
    productId,
    displayName: 'KTM Macina Kapoho Master',
    score,
    matchedOn: 'normalizedModel',
    matchedValue: KEY,
    nameSimilarity: { trigram: 1, levenshtein: 1, alignment: 1 },
    failedGates: [],
    normalizedModelMatch: true,
    keyScore: 100,
    ...overrides,
  };
}

/** A candidate a trigram search found: another key. */
function nearOf(productId: string, score: number): ProductCandidate {
  return candidateOf(productId, score, {
    matchedOn: 'trigram',
    matchedValue: 'kapoho macina prestige',
    normalizedModelMatch: false,
  });
}

describe('ListingMatchService', () => {
  let brandResolution: { resolve: jest.Mock };
  let queryService: { ofListing: jest.Mock };
  let finder: { findCandidates: jest.Mock };
  let llmService: { pick: jest.Mock };
  let service: ListingMatchService;

  /** What the exact-key pass returns, then the full search. */
  function found(exact: ProductCandidate[], full: ProductCandidate[] = exact) {
    finder.findCandidates.mockImplementation(async (_query, options) =>
      options?.fuzzy === false ? exact : full,
    );
  }

  beforeEach(() => {
    brandResolution = {
      resolve: jest.fn().mockResolvedValue({ entity: BRAND, similarity: 1 }),
    };
    queryService = { ofListing: jest.fn().mockReturnValue(QUERY) };
    finder = { findCandidates: jest.fn().mockResolvedValue([]) };
    llmService = { pick: jest.fn() };
    service = new ListingMatchService(
      brandResolution as never,
      queryService as never,
      finder as never,
      llmService as never,
    );
  });

  it('creates with no candidates when the brand does not resolve', async () => {
    brandResolution.resolve.mockResolvedValue(undefined);

    await expect(service.match(SCRAPED)).resolves.toEqual({
      productId: undefined,
      decision: { outcome: 'created', candidates: [] },
    });
    expect(finder.findCandidates).not.toHaveBeenCalled();
  });

  // The identity extraction was off or failed: the listing goes by its title.
  it('resolves the brand of a listing with no model from its title', async () => {
    const titleOnly = {
      brand: SCRAPED.brand,
      originalName: SCRAPED.originalName,
      category: SCRAPED.category,
    } as ScrapedProduct;

    await service.match(titleOnly);

    expect(brandResolution.resolve).toHaveBeenCalledWith('KTM', SCRAPED.originalName);
    expect(queryService.ofListing).toHaveBeenCalledWith(titleOnly, BRAND);
  });

  it('attaches on an equal key from the exact pass alone, without the trigram search', async () => {
    found([candidateOf(MATCH_ID, 100)]);

    await expect(service.match(SCRAPED)).resolves.toEqual({
      productId: MATCH_ID,
      decision: {
        outcome: 'identified',
        candidates: [expect.objectContaining({ productId: MATCH_ID, normalizedModelMatch: true })],
        normalizedModel: KEY,
        shortCircuit: true,
      },
    });
    expect(finder.findCandidates).toHaveBeenCalledTimes(1);
    expect(finder.findCandidates).toHaveBeenCalledWith(QUERY, { fuzzy: false });
    expect(llmService.pick).not.toHaveBeenCalled();
  });

  // Same key, another year: the gates make it another product.
  it('runs the full search when no equal-key candidate passes its gates', async () => {
    const otherYear = candidateOf(MATCH_ID, 50, { keyScore: 50 });
    found([otherYear], [otherYear, nearOf(OTHER_ID, 75)]);

    const result = await service.match(SCRAPED);

    expect(finder.findCandidates).toHaveBeenCalledTimes(2);
    expect(finder.findCandidates).toHaveBeenLastCalledWith(QUERY);
    expect(result.productId).toBeUndefined();
    expect(result.decision.outcome).toBe('created');
    expect(result.decision.shortCircuit).toBeUndefined();
  });

  // However close the name, another key never attaches.
  it('creates a near-miss with another key, the LLM check being off', async () => {
    found([], [nearOf(MATCH_ID, 95)]);

    const result = await service.match(SCRAPED);

    expect(result.productId).toBeUndefined();
    expect(result.decision.outcome).toBe('created');
    expect(result.decision.candidates).toEqual([
      expect.objectContaining({ productId: MATCH_ID, normalizedModelMatch: false }),
    ]);
    expect(llmService.pick).not.toHaveBeenCalled();
  });

  it('skips the exact pass, and attaches nothing, for a listing without a model key', async () => {
    queryService.ofListing.mockReturnValue({ ...QUERY, keyed: false });
    found([], [candidateOf(MATCH_ID, 100, { normalizedModelMatch: undefined, matchedOn: 'trigram' })]);

    const result = await service.match(SCRAPED);

    expect(finder.findCandidates).toHaveBeenCalledTimes(1);
    expect(finder.findCandidates).toHaveBeenCalledWith({ ...QUERY, keyed: false });
    expect(result.productId).toBeUndefined();
    expect(result.decision.normalizedModel).toBeUndefined();
  });

  it('keeps only the best few candidates on the decision, the chosen one first', async () => {
    const full = Array.from({ length: LISTING_DECISION_CANDIDATES + 2 }, (_, index) =>
      nearOf(`product-${index}`, 60 - index),
    );
    found([], full);

    const result = await service.match(SCRAPED);

    expect(result.decision.candidates).toHaveLength(LISTING_DECISION_CANDIDATES);
    expect(result.decision.candidates[0].productId).toBe('product-0');
  });

  // Off since 2026-09-23 (near misses go to a person); the path is kept, so
  // these run against the service with the check switched back on.
  describe('with the LLM check on', () => {
    const withLlm = async () => {
      jest.resetModules();
      jest.doMock('./product-identity.constants', () => ({
        ...jest.requireActual('./product-identity.constants'),
        LLM_ENABLED: true,
      }));
      const { ListingMatchService: WithLlm } = await import('./listing-match.service');
      return new WithLlm(
        brandResolution as never,
        queryService as never,
        finder as never,
        llmService as never,
      );
    };

    it('attaches to the LLM pick and records what it answered', async () => {
      found([], [nearOf(MATCH_ID, 78), nearOf(OTHER_ID, 71)]);
      llmService.pick.mockResolvedValue({
        productId: OTHER_ID,
        confidence: 88,
        reason: 'same battery',
      });

      const result = await (await withLlm()).match(SCRAPED, { taskId: 'task-1' });

      expect(result.productId).toBe(OTHER_ID);
      expect(result.decision.outcome).toBe('llm_identified');
      expect(result.decision.llm).toEqual({
        productId: OTHER_ID,
        confidence: 88,
        reason: 'same battery',
      });
      // Only the near-misses are adjudicated, best first, with the listing's own
      // model and title beside its key.
      expect(llmService.pick).toHaveBeenCalledWith(
        {
          brandName: BRAND.name,
          model: SCRAPED.model,
          title: SCRAPED.originalName,
          normalizedModel: KEY,
          specs: QUERY.specs,
        },
        [
          expect.objectContaining({ productId: MATCH_ID }),
          expect.objectContaining({ productId: OTHER_ID }),
        ],
        { taskId: 'task-1' },
      );
    });

    it('creates when the LLM declines, keeping its answer on the decision', async () => {
      found([], [nearOf(MATCH_ID, 70)]);
      llmService.pick.mockResolvedValue({ confidence: 40, reason: 'different year' });

      const result = await (await withLlm()).match(SCRAPED);

      expect(result.productId).toBeUndefined();
      expect(result.decision.outcome).toBe('created');
      expect(result.decision.llm).toEqual({ confidence: 40, reason: 'different year' });
    });

    it('never asks when the caller turns the LLM off', async () => {
      found([], [nearOf(MATCH_ID, 75)]);

      const result = await (await withLlm()).match(SCRAPED, {}, { llm: false });

      expect(result.productId).toBeUndefined();
      expect(result.decision.outcome).toBe('created');
      expect(llmService.pick).not.toHaveBeenCalled();
    });
  });
});
