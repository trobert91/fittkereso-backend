import { StaleOfferSweepService } from './stale-offer-sweep.service';

describe('StaleOfferSweepService', () => {
  let service: StaleOfferSweepService;
  let offerRepo: { findStaleForDeletion: jest.Mock; deleteByIds: jest.Mock };
  let productRepo: { findOne: jest.Mock; save: jest.Mock };
  let mergeService: { recomputePrice: jest.Mock };
  let locks: { withLocks: jest.Mock };
  let freshness: {
    deleteCutoff: jest.Mock;
    deleteAfterDays: number;
    deletionEnabled: boolean;
  };

  const CUTOFF = new Date('2026-09-09T00:00:00Z');

  const staleOffers = () => [
    { id: 'offer-1', model: { id: 'model-1' } },
    { id: 'offer-2', model: { id: 'model-1' } },
    { id: 'offer-3', model: { id: 'model-2' } },
  ];

  beforeEach(() => {
    offerRepo = {
      findStaleForDeletion: jest.fn().mockResolvedValue(staleOffers()),
      deleteByIds: jest.fn().mockResolvedValue(undefined),
    };
    productRepo = {
      findOne: jest.fn().mockImplementation(({ where }) =>
        Promise.resolve({ id: where.id }),
      ),
      save: jest.fn().mockResolvedValue(undefined),
    };
    mergeService = { recomputePrice: jest.fn().mockResolvedValue(undefined) };
    locks = {
      withLocks: jest.fn(async (_keys: unknown, work: () => Promise<unknown>) => work()),
    };
    freshness = {
      deleteCutoff: jest.fn().mockReturnValue(CUTOFF),
      deleteAfterDays: 14,
      deletionEnabled: true,
    };

    service = new StaleOfferSweepService(
      offerRepo as never,
      productRepo as never,
      freshness as never,
      mergeService as never,
      locks as never,
    );
  });

  it('recomputes each product under its own lock', async () => {
    await service.sweep();

    expect(locks.withLocks.mock.calls.map(([keys]) => keys)).toEqual([
      [{ namespace: 1, id: 'model-1' }],
      [{ namespace: 1, id: 'model-2' }],
    ]);
  });

  it('deletes stale offers and recomputes each affected product once', async () => {
    const result = await service.sweep();

    expect(offerRepo.deleteByIds).toHaveBeenCalledWith([
      'offer-1',
      'offer-2',
      'offer-3',
    ]);
    expect(result.deleted).toBe(3);

    // Two products, three offers — the model ids are deduped, so a product
    // with several deleted offers is recomputed once.
    expect(result.modelsRecomputed).toBe(2);
    expect(mergeService.recomputePrice).toHaveBeenCalledTimes(2);
  });

  it('does nothing when nothing is stale', async () => {
    offerRepo.findStaleForDeletion.mockResolvedValue([]);

    const result = await service.sweep();

    expect(result).toEqual({
      deleted: 0,
      modelsRecomputed: 0,
      cutoff: CUTOFF,
      capped: false,
    });
    expect(offerRepo.deleteByIds).not.toHaveBeenCalled();
  });

  describe('when deletion is disabled', () => {
    beforeEach(() => {
      freshness.deletionEnabled = false;
    });

    // The sweep reads "not stamped recently" as "gone", which is only sound
    // while imports are running. On an estate where nothing imports — no
    // frequency set, a paused source, a fresh environment — that reasoning
    // destroys the catalog on a schedule.
    it('deletes nothing', async () => {
      const result = await service.sweep();

      expect(offerRepo.deleteByIds).not.toHaveBeenCalled();
      expect(result.deleted).toBe(0);
    });

    it('does not recompute prices either', async () => {
      await service.sweep();

      expect(mergeService.recomputePrice).not.toHaveBeenCalled();
      expect(productRepo.save).not.toHaveBeenCalled();
    });

    it('still looks, so the would-delete count is observable', async () => {
      await service.sweep();

      expect(offerRepo.findStaleForDeletion).toHaveBeenCalledWith(
        CUTOFF,
        expect.any(Number),
      );
    });
  });

  it('keeps going when one product fails to recompute', async () => {
    mergeService.recomputePrice
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);

    const result = await service.sweep();

    // The offers are already gone; abandoning the remaining products would
    // leave them advertising prices from listings that no longer exist.
    expect(result.deleted).toBe(3);
    expect(result.modelsRecomputed).toBe(1);
  });
});
