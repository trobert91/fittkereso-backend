import type { ScrapedProduct } from '@fittkereso-backend/database';
import { ListingMatchService } from './listing-match.service';
import { LISTING_DECISION_CANDIDATES } from './product-identity.constants';
import type { ProductCandidate } from './types';

const BRAND = { id: 'brand-1', name: 'KTM' };
const MATCH_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '22222222-2222-2222-2222-222222222222';

const SCRAPED = {
  brand: 'KTM',
  model: 'Macina Kapoho Master',
  displayName: 'KTM Macina Kapoho Master 2024',
  originalName: 'KTM Macina Kapoho Master 2024 M/43',
  category: { id: 'category-1', slug: 'ebikes', name: 'E-bikes' },
  specs: { modelYear: 2024 },
} as ScrapedProduct;

const QUERY = {
  brandId: BRAND.id,
  brandName: BRAND.name,
  categoryId: 'category-1',
  categorySlug: 'ebikes',
  nameKey: 'kapoho macina master',
  specs: { modelYear: 2024 },
};

function candidateOf(
  productId: string,
  score: number,
  keyed: Pick<ProductCandidate, 'matcherModelMatch'> & Partial<ProductCandidate> = {},
): ProductCandidate {
  return {
    productId,
    displayName: 'KTM Macina Kapoho Master',
    score,
    matchedOn: 'name',
    matchedValue: 'kapoho macina master',
    nameSimilarity: { trigram: 1, levenshtein: 1 },
    failedGates: [],
    keyScore: 100,
    ...keyed,
  };
}

describe('ListingMatchService', () => {
  let brandResolution: { resolve: jest.Mock };
  let queryService: { ofListing: jest.Mock; requiresMatcherModel: jest.Mock };
  let finder: { findCandidates: jest.Mock };
  let llmService: { pick: jest.Mock };
  let service: ListingMatchService;

  beforeEach(() => {
    brandResolution = {
      resolve: jest.fn().mockResolvedValue({ entity: BRAND, similarity: 1 }),
    };
    queryService = {
      ofListing: jest.fn().mockReturnValue(QUERY),
      requiresMatcherModel: jest.fn().mockReturnValue(false),
    };
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

  it('attaches to a single candidate above the accept score without asking the LLM', async () => {
    finder.findCandidates.mockResolvedValue([
      candidateOf(MATCH_ID, 92),
      candidateOf(OTHER_ID, 64),
    ]);

    await expect(service.match(SCRAPED)).resolves.toEqual({
      productId: MATCH_ID,
      decision: {
        outcome: 'identified',
        nameKey: QUERY.nameKey,
        candidates: [
          expect.objectContaining({ productId: MATCH_ID, score: 92 }),
          expect.objectContaining({ productId: OTHER_ID, score: 64 }),
        ],
        mode: 'score',
      },
    });
    expect(llmService.pick).not.toHaveBeenCalled();
  });

  it('creates without asking the LLM when nothing is a near-miss', async () => {
    finder.findCandidates.mockResolvedValue([candidateOf(MATCH_ID, 69)]);

    const result = await service.match(SCRAPED);

    expect(result.productId).toBeUndefined();
    expect(result.decision.outcome).toBe('created');
    expect(result.decision.llm).toBeUndefined();
    expect(llmService.pick).not.toHaveBeenCalled();
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
      const { ListingMatchService: WithLlm } =
        await import('./listing-match.service');
      return new WithLlm(
        brandResolution as never,
        queryService as never,
        finder as never,
        llmService as never,
      );
    };

    it('attaches to the LLM pick and records what it answered', async () => {
      finder.findCandidates.mockResolvedValue([
        candidateOf(MATCH_ID, 78),
        candidateOf(OTHER_ID, 71),
      ]);
      llmService.pick.mockResolvedValue({
        productId: OTHER_ID,
        confidence: 88,
        reason: 'same battery',
      });

      const result = await (
        await withLlm()
      ).match(SCRAPED, { taskId: 'task-1' });

      expect(result.productId).toBe(OTHER_ID);
      expect(result.decision.outcome).toBe('llm_identified');
      expect(result.decision.llm).toEqual({
        productId: OTHER_ID,
        confidence: 88,
        reason: 'same battery',
      });
      // Only the near-misses are adjudicated, best first, with the listing's own
      // names — which the query key alone doesn't carry.
      expect(llmService.pick).toHaveBeenCalledWith(
        expect.objectContaining({
          brandName: BRAND.name,
          model: SCRAPED.model,
          displayName: SCRAPED.displayName,
          nameKey: QUERY.nameKey,
        }),
        [
          expect.objectContaining({ productId: MATCH_ID }),
          expect.objectContaining({ productId: OTHER_ID }),
        ],
        { taskId: 'task-1' },
      );
    });

    it('creates when the LLM declines, keeping its answer on the decision', async () => {
      finder.findCandidates.mockResolvedValue([candidateOf(MATCH_ID, 70)]);
      llmService.pick.mockResolvedValue({
        confidence: 40,
        reason: 'different year',
      });

      const result = await (await withLlm()).match(SCRAPED);

      expect(result.productId).toBeUndefined();
      expect(result.decision.outcome).toBe('created');
      expect(result.decision.llm).toEqual({
        confidence: 40,
        reason: 'different year',
      });
    });

    it('never asks when the caller turns the LLM off', async () => {
      finder.findCandidates.mockResolvedValue([candidateOf(MATCH_ID, 75)]);

      const result = await (
        await withLlm()
      ).match(SCRAPED, {}, { llm: false });

      expect(result.productId).toBeUndefined();
      expect(result.decision.outcome).toBe('created');
      expect(llmService.pick).not.toHaveBeenCalled();
    });
  });

  it('keeps only the best few candidates on the decision', async () => {
    finder.findCandidates.mockResolvedValue(
      Array.from({ length: LISTING_DECISION_CANDIDATES + 2 }, (_, index) =>
        candidateOf(`product-${index}`, 60 - index),
      ),
    );

    const result = await service.match(SCRAPED);

    expect(result.decision.candidates).toHaveLength(
      LISTING_DECISION_CANDIDATES,
    );
    expect(result.decision.candidates[0].productId).toBe('product-0');
  });

  // The default: a near miss becomes a new product, and duplicate detection
  // pairs it with the candidate for a person to decide.
  it('creates near-misses without a call, as the LLM check is off', async () => {
    finder.findCandidates.mockResolvedValue([candidateOf(MATCH_ID, 75)]);

    const result = await service.match(SCRAPED);

    expect(result.productId).toBeUndefined();
    expect(result.decision.outcome).toBe('created');
    expect(llmService.pick).not.toHaveBeenCalled();
  });

  describe('matcherModel keys', () => {
    const KEY = 'kapoho macina master';
    beforeEach(() => {
      queryService.ofListing.mockReturnValue({ ...QUERY, matcherModelKeys: [KEY] });
    });

    it('acts on the score and records what the key rule would have done', async () => {
      finder.findCandidates.mockResolvedValue([
        candidateOf(MATCH_ID, 92, { matcherModelMatch: false }),
        candidateOf(OTHER_ID, 64, { matcherModelMatch: true }),
      ]);

      const { productId, decision } = await service.match(SCRAPED);

      expect(productId).toBe(MATCH_ID);
      expect(decision).toMatchObject({
        mode: 'score',
        matcherModelKey: KEY,
        alternative: { mode: 'key', kind: 'attach', productId: OTHER_ID, comparison: 'switch' },
      });
      expect(decision.candidates[1]).toMatchObject({ matcherModelMatch: true, keyScore: 100 });
    });

    it('records a split when the key rule would keep the listing off the product the score chose', async () => {
      // "Style 810" against "Style 810 Di2": a perfect name, another key.
      finder.findCandidates.mockResolvedValue([candidateOf(MATCH_ID, 100, { matcherModelMatch: false })]);

      const { productId, decision } = await service.match(SCRAPED);

      expect(productId).toBe(MATCH_ID);
      expect(decision.alternative).toMatchObject({ kind: 'ask_llm', llmCandidates: 1, comparison: 'split' });
    });

    it('acts on equal keys where the category requires them, the chosen product first', async () => {
      queryService.requiresMatcherModel.mockReturnValue(true);
      finder.findCandidates.mockResolvedValue([
        candidateOf(MATCH_ID, 92, { matcherModelMatch: false }),
        candidateOf(OTHER_ID, 64, { matcherModelMatch: true }),
      ]);

      const { productId, decision } = await service.match(SCRAPED);

      expect(queryService.requiresMatcherModel).toHaveBeenCalledWith('ebikes');
      expect(productId).toBe(OTHER_ID);
      expect(decision.mode).toBe('key');
      expect(decision.candidates.map((candidate) => candidate.productId)).toEqual([OTHER_ID, MATCH_ID]);
      expect(decision.alternative).toMatchObject({ mode: 'score', productId: MATCH_ID, comparison: 'switch' });
    });

    it('goes by the score, with nothing to compare, for a listing without a key', async () => {
      queryService.requiresMatcherModel.mockReturnValue(true);
      queryService.ofListing.mockReturnValue({ ...QUERY, matcherModelKeys: [] });
      finder.findCandidates.mockResolvedValue([candidateOf(MATCH_ID, 92)]);

      const { productId, decision } = await service.match(SCRAPED);

      expect(productId).toBe(MATCH_ID);
      expect(decision.mode).toBe('score');
      expect(decision.alternative).toBeUndefined();
      expect(decision.matcherModelKey).toBeUndefined();
    });
  });
});
