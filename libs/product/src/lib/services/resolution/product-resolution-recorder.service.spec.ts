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
    service = new ProductResolutionRecorderService(
      mockRepo as unknown as ProductResolutionRepository,
      mockDynamicConfig as unknown as DynamicConfigService,
      new ProductResolutionFingerprintService(),
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

    it('denormalizes the decision confidence so the queue can sort on it', async () => {
      await service.recordResolution({
        flow: 'product_resolution' as never,
        similarityScore: 100,
        anchorKey: 'source-1:sku-9',
        decisionSnapshot: { confidence: 82 } as never,
      });

      expect(mockRepo.upsertByAnchor.mock.calls[0][0].decisionConfidence).toBe(82);
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
