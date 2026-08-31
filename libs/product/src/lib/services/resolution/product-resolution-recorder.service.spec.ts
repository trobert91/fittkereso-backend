import { RESOLUTION_DEFAULTS } from '@fittkereso-backend/config';
import type { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import type { ProductResolutionRepository } from '@fittkereso-backend/database';
import {
  ResolutionActionKind,
  ResolutionActor,
  ResolutionVerdict,
} from '@fittkereso-backend/database';
import { ProductResolutionRecorderService } from './product-resolution-recorder.service';
import { ProductResolutionFingerprintService } from './product-resolution-fingerprint.service';
import { ProductResolutionPriorityService } from './product-resolution-priority.service';
import { ResolutionConfidenceService } from './resolution-confidence.service';
import { ResolutionScoringService } from './resolution-scoring.service';

describe('ProductResolutionRecorderService', () => {
  let mockRepo: {
    insert: jest.Mock;
    upsertPair: jest.Mock;
    upsertByAnchor: jest.Mock;
  };
  let mockDynamicConfig: { resolution: { minScoreToRecord?: number } | undefined };
  let service: ProductResolutionRecorderService;

  beforeEach(() => {
    mockRepo = {
      insert: jest.fn().mockResolvedValue({ id: 'resolution-1' }),
      upsertPair: jest.fn().mockResolvedValue({ id: 'resolution-2' }),
      upsertByAnchor: jest
        .fn()
        .mockResolvedValue({ resolution: { id: 'resolution-3' }, outcome: 'created' }),
    };
    mockDynamicConfig = { resolution: undefined };
    // Real scoring collaborators, not mocks: the point of these tests is that a
    // recorded row carries scores derived from what was actually written, and a
    // stubbed number would assert nothing about that.
    service = new ProductResolutionRecorderService(
      mockRepo as unknown as ProductResolutionRepository,
      mockDynamicConfig as unknown as DynamicConfigService,
      new ProductResolutionFingerprintService(),
      new ResolutionScoringService(
        new ProductResolutionPriorityService(new ResolutionConfidenceService()),
        mockDynamicConfig as unknown as DynamicConfigService,
      ),
    );
  });

  describe('threshold resolution', () => {
    // The threshold only applies to resolutions that matched an existing
    // product, so these carry a `resolvedProductId` — without one the row is
    // recorded regardless (see the exemption tests below).
    it('falls back to the static default when no dynamic override is set', async () => {
      mockDynamicConfig.resolution = undefined;

      await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: RESOLUTION_DEFAULTS.minScoreToRecord - 1,
        resolvedProductId: 'product-1',
      });
      expect(mockRepo.insert).not.toHaveBeenCalled();

      await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: RESOLUTION_DEFAULTS.minScoreToRecord,
        resolvedProductId: 'product-1',
      });
      expect(mockRepo.insert).toHaveBeenCalledTimes(1);
    });

    it('uses the dynamic config override instead of the static default', async () => {
      mockDynamicConfig.resolution = { minScoreToRecord: 90 };

      await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 85,
        resolvedProductId: 'product-1',
      });
      expect(mockRepo.insert).not.toHaveBeenCalled();

      await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 90,
        resolvedProductId: 'product-1',
      });
      expect(mockRepo.insert).toHaveBeenCalledTimes(1);
    });

    it('applies the threshold to duplicate pairs with no exemption', async () => {
      // Both products already exist, so a low score really does mean the pair
      // is not worth reviewing — nothing was created as a result.
      const result = await service.recordDuplicatePair({
        flow: 'duplicate_detection' as never,
        productAId: 'a',
        productBId: 'b',
        similarityScore: RESOLUTION_DEFAULTS.minScoreToRecord - 1,
      });

      expect(result).toBeNull();
      expect(mockRepo.upsertPair).not.toHaveBeenCalled();
    });
  });

  describe('the created-product exemption', () => {
    // A listing the system could not place still gets a product of its own, and
    // that product is how duplicates enter the catalog. Suppressing the row
    // because an unresolved decision reports confidence 0 would hide exactly
    // the decisions most worth reviewing.
    it('records a resolution that matched nothing, however low it scored', async () => {
      const result = await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 0,
      });

      expect(mockRepo.insert).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ id: 'resolution-1' });
    });

    it('still routes an exempted row through the anchored upsert', async () => {
      await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 0,
        anchorKey: 'source-1:sku-9',
      });

      // Idempotency must not be bypassed by the exemption: a repeat scrape of
      // an unplaceable listing still must not queue a second row for it.
      expect(mockRepo.upsertByAnchor).toHaveBeenCalledTimes(1);
      expect(mockRepo.insert).not.toHaveBeenCalled();
    });

    it('does not exempt a low-scoring match to an existing product', async () => {
      const result = await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 0,
        resolvedProductId: 'product-1',
      });

      expect(result).toBeNull();
      expect(mockRepo.insert).not.toHaveBeenCalled();
      expect(mockRepo.upsertByAnchor).not.toHaveBeenCalled();
    });
  });

  describe('recordResolution', () => {
    it('appends-only when there is no anchor to key on', async () => {
      const result = await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 100,
      });

      expect(mockRepo.insert).toHaveBeenCalledTimes(1);
      expect(mockRepo.upsertByAnchor).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'resolution-1' });
    });

    it('routes through the anchored upsert when an anchor is given, so a repeat scrape cannot queue the same decision twice', async () => {
      const result = await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 100,
        anchorKey: 'source-1:sku-9',
      });

      expect(mockRepo.insert).not.toHaveBeenCalled();
      expect(mockRepo.upsertByAnchor).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ id: 'resolution-3' });

      const params = mockRepo.upsertByAnchor.mock.calls[0][0];
      expect(params.anchorKey).toBe('source-1:sku-9');
      expect(params.fingerprint).toEqual(expect.any(String));
    });

    it('seeds the log with an already-performed match when a product was resolved', async () => {
      await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 100,
        resolvedProductId: 'product-1',
      });

      const seed = mockRepo.insert.mock.calls[0][0].seedDecision;
      expect(seed).toMatchObject({
        actor: ResolutionActor.system,
        verdict: ResolutionVerdict.matched_existing,
        actionPerformed: true,
      });
      expect(seed.action).toMatchObject({
        kind: ResolutionActionKind.match,
        productId: 'product-1',
      });
    });

    it('seeds a create verdict when no product was matched', async () => {
      await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 100,
      });

      const seed = mockRepo.insert.mock.calls[0][0].seedDecision;
      expect(seed.verdict).toBe(ResolutionVerdict.created_new);
      expect(seed.action.kind).toBe(ResolutionActionKind.create);
    });

    // Below-threshold behaviour now depends on whether a product was matched —
    // see "the created-product exemption" above.
  });

  describe('the scores written with the row', () => {
    const record = (overrides: Record<string, unknown> = {}) =>
      service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 95,
        anchorKey: 'source-1:sku-9',
        resolvedProductId: 'product-1',
        ...overrides,
      });

    const written = () => mockRepo.upsertByAnchor.mock.calls[0][0];

    it('derives the confidence instead of copying the decider self-report', async () => {
      // The self-report is one weighted input. Adopting it wholesale is the bug
      // this replaces: it reads 0 for every rejection, because a rejection has
      // no selected candidate to take a max over.
      await record({ decisionSnapshot: { confidence: 82 } });

      expect(written().decisionConfidence).toEqual(expect.any(Number));
      expect(written().decisionConfidence).not.toBe(82);
    });

    it('writes a priority and the breakdown that accounts for it', async () => {
      await record();

      const { priority, priorityBreakdown } = written();
      expect(priority).toBeGreaterThanOrEqual(0);
      expect(priority).toBeLessThanOrEqual(100);
      expect(priorityBreakdown.priority).toBe(priority);
      expect(priorityBreakdown.confidence).toBe(written().decisionConfidence);
    });

    it('leaves blast radius unmeasured, and says so', async () => {
      // Counting the listings on the affected product would be a query per
      // scraped record. The nightly sweep measures it; the flag is how a
      // reviewer can tell the difference.
      await record();

      expect(written().priorityBreakdown.blastRadiusMeasured).toBe(false);
    });

    it('ranks a near-miss creation above an obviously-new listing', async () => {
      // Both created a product. The one that scored 95 against an existing
      // product and still got its own is how duplicates enter the catalog; the
      // one that resembled nothing is simply a new product.
      await record({ similarityScore: 95, resolvedProductId: undefined });
      await record({ similarityScore: 5, resolvedProductId: undefined });

      const [nearMiss, obviouslyNew] = mockRepo.upsertByAnchor.mock.calls;
      expect(nearMiss[0].priority).toBeGreaterThan(obviouslyNew[0].priority);
    });

    it('writes them on the anchorless path too', async () => {
      // The ad-hoc admin endpoint has no anchor and goes straight to insert —
      // it must not produce an unranked row that sorts last forever.
      await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 95,
        resolvedProductId: 'product-1',
      });

      expect(mockRepo.insert.mock.calls[0][0].priority).toEqual(
        expect.any(Number),
      );
    });

    it('scores a duplicate pair against the recording threshold it cleared', async () => {
      // Every recorded pair sits above minScoreToRecord, so raw scores bunch up
      // at the top. A pair barely over the line must not read as a near-certain
      // duplicate.
      mockDynamicConfig.resolution = { minScoreToRecord: 60 };

      await service.recordDuplicatePair({
        flow: 'duplicate_detection' as never,
        productAId: 'a',
        productBId: 'b',
        similarityScore: 62,
      });
      await service.recordDuplicatePair({
        flow: 'duplicate_detection' as never,
        productAId: 'c',
        productBId: 'd',
        similarityScore: 98,
      });

      const [marginal, nearIdentical] = mockRepo.upsertPair.mock.calls;
      expect(marginal[0].decisionConfidence).toBeLessThan(
        nearIdentical[0].decisionConfidence,
      );
      expect(marginal[0].priority).toBeGreaterThan(nearIdentical[0].priority);
    });
  });

  describe('recordDuplicatePair', () => {
    const pairParams = {
      flow: 'duplicate_detection' as never,
      productAId: 'a',
      productBId: 'b',
      similarityScore: 75,
    };

    it('calls repo.upsertPair (not insert) when the score clears the threshold, using the same shared gate', async () => {
      const result = await service.recordDuplicatePair(pairParams);

      expect(mockRepo.upsertPair).toHaveBeenCalledTimes(1);
      expect(mockRepo.insert).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'resolution-2' });
    });

    it('anchors the pair on its ordered ids so either argument order dedupes to one row', async () => {
      await service.recordDuplicatePair(pairParams);
      await service.recordDuplicatePair({
        ...pairParams,
        productAId: 'b',
        productBId: 'a',
      });

      const [first, second] = mockRepo.upsertPair.mock.calls;
      expect(first[0].anchorKey).toBe('a:b');
      expect(second[0].anchorKey).toBe('a:b');
    });

    it('seeds an UNPERFORMED merge, because detection proposes but never merges', async () => {
      await service.recordDuplicatePair(pairParams);

      const seed = mockRepo.upsertPair.mock.calls[0][0].seedDecision;
      expect(seed).toMatchObject({
        actor: ResolutionActor.system,
        verdict: ResolutionVerdict.duplicate_proposed,
        actionPerformed: false,
      });
      expect(seed.action.kind).toBe(ResolutionActionKind.merge);
    });

    it('returns null and never calls the repository when below threshold', async () => {
      const result = await service.recordDuplicatePair({
        ...pairParams,
        similarityScore: RESOLUTION_DEFAULTS.minScoreToRecord - 1,
      });

      expect(result).toBeNull();
      expect(mockRepo.upsertPair).not.toHaveBeenCalled();
    });
  });
});
