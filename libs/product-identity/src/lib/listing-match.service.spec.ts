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

function candidateOf(productId: string, score: number): ProductCandidate {
  return {
    productId,
    displayName: 'KTM Macina Kapoho Master',
    score,
    matchedOn: 'name',
    matchedValue: 'kapoho macina master',
    nameSimilarity: { trigram: 1, levenshtein: 1 },
    failedGates: [],
  };
}

describe('ListingMatchService', () => {
  let brandResolution: { resolve: jest.Mock };
  let queryService: { ofListing: jest.Mock };
  let finder: { findCandidates: jest.Mock };
  let llmService: { pick: jest.Mock };
  let service: ListingMatchService;

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
});
