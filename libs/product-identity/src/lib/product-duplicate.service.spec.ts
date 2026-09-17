import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProductDuplicateService } from './product-duplicate.service';
import type { ProductCandidate } from './types';

const PRODUCT_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '22222222-2222-2222-2222-222222222222';

function candidateOf(productId: string, score: number): ProductCandidate {
  return {
    productId,
    displayName: 'Cube Stereo Hybrid 140',
    score,
    matchedOn: 'name',
    matchedValue: '140 hybrid stereo',
    nameSimilarity: { trigram: 1, levenshtein: 1 },
    failedGates: [],
  };
}

describe('ProductDuplicateService', () => {
  let productRepo: { findOne: jest.Mock };
  let pairRepo: {
    upsertPairs: jest.Mock;
    dismiss: jest.Mock;
    reopen: jest.Mock;
    findOne: jest.Mock;
  };
  let queryService: { ofProduct: jest.Mock };
  let finder: { findCandidates: jest.Mock };
  let mergeService: { mergeProducts: jest.Mock };
  let service: ProductDuplicateService;

  beforeEach(() => {
    productRepo = { findOne: jest.fn().mockResolvedValue({ id: PRODUCT_ID }) };
    pairRepo = {
      upsertPairs: jest.fn().mockResolvedValue(1),
      dismiss: jest.fn().mockResolvedValue(true),
      reopen: jest.fn().mockResolvedValue(true),
      findOne: jest.fn(),
    };
    queryService = { ofProduct: jest.fn().mockReturnValue({ productId: PRODUCT_ID }) };
    finder = { findCandidates: jest.fn().mockResolvedValue([]) };
    mergeService = {
      mergeProducts: jest.fn().mockResolvedValue({
        product: { id: OTHER_ID },
        movedSourceRecordIds: ['record-1'],
      }),
    };
    service = new ProductDuplicateService(
      productRepo as never,
      pairRepo as never,
      queryService as never,
      finder as never,
      mergeService as never,
    );
  });

  describe('detect', () => {
    it('pairs every candidate at 70 or above, oriented on the query product', async () => {
      finder.findCandidates.mockResolvedValue([
        candidateOf(OTHER_ID, 70),
        candidateOf('33333333-3333-3333-3333-333333333333', 69),
      ]);

      await expect(service.detect(PRODUCT_ID, 'scan')).resolves.toBe(1);

      const [rows] = pairRepo.upsertPairs.mock.calls[0];
      expect(rows).toEqual([
        expect.objectContaining({
          productAId: PRODUCT_ID,
          productBId: OTHER_ID,
          similarityScore: 70,
          detectedBy: 'scan',
        }),
      ]);
    });

    it('writes nothing when no candidate reaches 70', async () => {
      finder.findCandidates.mockResolvedValue([candidateOf(OTHER_ID, 69)]);

      await expect(service.detect(PRODUCT_ID, 'scrape')).resolves.toBe(0);
      expect(pairRepo.upsertPairs).not.toHaveBeenCalled();
    });

    it('does nothing for a product that no longer exists', async () => {
      productRepo.findOne.mockResolvedValue(null);

      await expect(service.detect(PRODUCT_ID, 'scan')).resolves.toBe(0);
      expect(finder.findCandidates).not.toHaveBeenCalled();
    });
  });

  describe('dismiss', () => {
    it('closes an open pair', async () => {
      await expect(service.dismiss('pair-1')).resolves.toBeUndefined();
      expect(pairRepo.dismiss).toHaveBeenCalledWith('pair-1');
    });

    it('rejects a pair that is missing or already dismissed', async () => {
      pairRepo.dismiss.mockResolvedValue(false);

      await expect(service.dismiss('pair-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('reopen', () => {
    it('puts a dismissed pair back in the queue', async () => {
      await expect(service.reopen('pair-1')).resolves.toBeUndefined();
      expect(pairRepo.reopen).toHaveBeenCalledWith('pair-1');
    });

    it('rejects a pair that is missing or already open', async () => {
      pairRepo.reopen.mockResolvedValue(false);

      await expect(service.reopen('pair-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('mergePair', () => {
    const openPair = {
      id: 'pair-1',
      productAId: PRODUCT_ID,
      productBId: OTHER_ID,
      dismissedAt: null,
    };

    it('merges the other side into the survivor and re-detects it', async () => {
      pairRepo.findOne.mockResolvedValue(openPair);

      await expect(service.mergePair('pair-1', OTHER_ID)).resolves.toEqual({ id: OTHER_ID });

      expect(mergeService.mergeProducts).toHaveBeenCalledWith({
        sourceId: PRODUCT_ID,
        targetId: OTHER_ID,
      });
      expect(queryService.ofProduct).toHaveBeenCalled(); // re-detected the survivor
    });

    it('refuses a pair that does not exist', async () => {
      pairRepo.findOne.mockResolvedValue(null);

      await expect(service.mergePair('pair-1', OTHER_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(mergeService.mergeProducts).not.toHaveBeenCalled();
    });

    it('merges a dismissed pair, because being wrong about it is the point', async () => {
      pairRepo.findOne.mockResolvedValue({ ...openPair, dismissedAt: new Date() });

      await expect(service.mergePair('pair-1', OTHER_ID)).resolves.toEqual({
        id: OTHER_ID,
      });
      expect(mergeService.mergeProducts).toHaveBeenCalled();
    });

    it('refuses a survivor that is not one of the pair', async () => {
      pairRepo.findOne.mockResolvedValue(openPair);

      await expect(service.mergePair('pair-1', 'somebody-else')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mergeService.mergeProducts).not.toHaveBeenCalled();
    });
  });

  it('keeps a successful merge when re-detection fails', async () => {
    finder.findCandidates.mockRejectedValue(new Error('recall exploded'));

    await expect(service.mergeProducts(PRODUCT_ID, OTHER_ID)).resolves.toEqual({
      id: OTHER_ID,
    });
  });
});
