import { RESOLUTION_DEFAULTS } from '@fittkereso-backend/config';
import type { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import type { ProductResolutionRepository } from '@fittkereso-backend/database';
import { ProductResolutionRecorderService } from './product-resolution-recorder.service';

describe('ProductResolutionRecorderService', () => {
  let mockRepo: { insert: jest.Mock; upsertPair: jest.Mock };
  let mockDynamicConfig: { resolution: { minScoreToRecord?: number } | undefined };
  let service: ProductResolutionRecorderService;

  beforeEach(() => {
    mockRepo = {
      insert: jest.fn().mockResolvedValue({ id: 'resolution-1' }),
      upsertPair: jest.fn().mockResolvedValue({ id: 'resolution-2' }),
    };
    mockDynamicConfig = { resolution: undefined };
    service = new ProductResolutionRecorderService(
      mockRepo as unknown as ProductResolutionRepository,
      mockDynamicConfig as unknown as DynamicConfigService,
    );
  });

  describe('threshold resolution', () => {
    it('falls back to the static default when no dynamic override is set', async () => {
      mockDynamicConfig.resolution = undefined;

      await service.recordResolution({
        flow: 'product_resolution' as never,
        decision: 'auto_accepted' as never,
        similarityScore: RESOLUTION_DEFAULTS.minScoreToRecord - 1,
      });
      expect(mockRepo.insert).not.toHaveBeenCalled();

      await service.recordResolution({
        flow: 'product_resolution' as never,
        decision: 'auto_accepted' as never,
        similarityScore: RESOLUTION_DEFAULTS.minScoreToRecord,
      });
      expect(mockRepo.insert).toHaveBeenCalledTimes(1);
    });

    it('uses the dynamic config override instead of the static default', async () => {
      mockDynamicConfig.resolution = { minScoreToRecord: 90 };

      await service.recordResolution({
        flow: 'product_resolution' as never,
        decision: 'auto_accepted' as never,
        similarityScore: 85,
      });
      expect(mockRepo.insert).not.toHaveBeenCalled();

      await service.recordResolution({
        flow: 'product_resolution' as never,
        decision: 'auto_accepted' as never,
        similarityScore: 90,
      });
      expect(mockRepo.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe('recordResolution', () => {
    it('calls repo.insert (not upsertPair) when the score clears the threshold', async () => {
      const params = {
        flow: 'product_resolution' as never,
        decision: 'auto_accepted' as never,
        similarityScore: 100,
      };

      const result = await service.recordResolution(params);

      expect(mockRepo.insert).toHaveBeenCalledWith(params);
      expect(mockRepo.upsertPair).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'resolution-1' });
    });

    it('returns null and never calls the repository when below threshold', async () => {
      const result = await service.recordResolution({
        flow: 'product_resolution' as never,
        decision: 'pending_review' as never,
        similarityScore: 0,
      });

      expect(result).toBeNull();
      expect(mockRepo.insert).not.toHaveBeenCalled();
    });
  });

  describe('recordDuplicatePair', () => {
    it('calls repo.upsertPair (not insert) when the score clears the threshold, using the same shared gate', async () => {
      const params = {
        flow: 'duplicate_detection' as never,
        productAId: 'a',
        productBId: 'b',
        decision: 'pending_review' as never,
        similarityScore: 75,
      };

      const result = await service.recordDuplicatePair(params);

      expect(mockRepo.upsertPair).toHaveBeenCalledWith(params);
      expect(mockRepo.insert).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'resolution-2' });
    });

    it('returns null and never calls the repository when below threshold', async () => {
      const result = await service.recordDuplicatePair({
        flow: 'duplicate_detection' as never,
        productAId: 'a',
        productBId: 'b',
        decision: 'pending_review' as never,
        similarityScore: RESOLUTION_DEFAULTS.minScoreToRecord - 1,
      });

      expect(result).toBeNull();
      expect(mockRepo.upsertPair).not.toHaveBeenCalled();
    });
  });
});
