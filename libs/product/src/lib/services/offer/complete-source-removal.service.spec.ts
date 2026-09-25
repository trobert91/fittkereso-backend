import {
  CompleteSourceRemovalService,
  MAX_COMPLETE_RUN_REMOVAL_SHARE,
} from './complete-source-removal.service';

describe('CompleteSourceRemovalService', () => {
  let service: CompleteSourceRemovalService;
  let offerRepo: {
    findSellerOffersInCategories: jest.Mock;
    findBySellerAndExternalIds: jest.Mock;
    deleteByIds: jest.Mock;
  };
  let productRepo: { findOne: jest.Mock; save: jest.Mock };
  let freshness: { completeSourceRemovalEnabled: boolean };
  let contributorDetach: { detach: jest.Mock };
  let mergeService: { recomputePrice: jest.Mock };
  let locks: { withLocks: jest.Mock };

  const source = { id: 'source-arukereso', name: 'speedbike-arukereso', seller: { id: 'seller-1' } } as never;

  /** Twenty offers in the run's categories, on ten products, two each. */
  const catalog = () =>
    Array.from({ length: 20 }, (_, index) => ({
      id: `offer-${index}`,
      externalId: `sku-${index}`,
      modelId: `model-${Math.floor(index / 2)}`,
    }));
  const seenAllBut = (...unseen: number[]) =>
    new Set(
      catalog()
        .map((offer) => offer.externalId)
        .filter((key) => !unseen.map((index) => `sku-${index}`).includes(key)),
    );

  beforeEach(() => {
    offerRepo = {
      findSellerOffersInCategories: jest.fn().mockResolvedValue(catalog()),
      // Read again under the lock: still where they were listed.
      findBySellerAndExternalIds: jest
        .fn()
        .mockImplementation(async (_sellerId, keys: string[]) =>
          catalog()
            .filter((offer) => keys.includes(offer.externalId))
            .map((offer) => ({ ...offer, model: { id: offer.modelId } })),
        ),
      deleteByIds: jest.fn().mockResolvedValue(undefined),
    };
    productRepo = {
      findOne: jest.fn().mockImplementation(async ({ where }) => ({ id: where.id })),
      save: jest.fn().mockResolvedValue(undefined),
    };
    freshness = { completeSourceRemovalEnabled: true };
    contributorDetach = { detach: jest.fn().mockResolvedValue([]) };
    mergeService = { recomputePrice: jest.fn().mockResolvedValue(undefined) };
    locks = {
      withLocks: jest.fn(async (_keys: unknown, work: () => Promise<unknown>) => work()),
    };
    service = new CompleteSourceRemovalService(
      offerRepo as never,
      productRepo as never,
      freshness as never,
      contributorDetach as never,
      mergeService as never,
      locks as never,
    );
  });

  it('removes the unseen offers per product under its lock, and detaches what joined only them', async () => {
    const result = await service.removeUnseen({
      source,
      seenExternalIds: seenAllBut(4),
      categorySlugs: ['ebikes'],
    });

    expect(result).toEqual({ removed: 1 });
    expect(offerRepo.findSellerOffersInCategories).toHaveBeenCalledWith('seller-1', ['ebikes']);
    expect(locks.withLocks.mock.calls.map(([keys]) => keys)).toEqual([
      [{ namespace: 1, id: 'model-2' }],
    ]);
    expect(offerRepo.deleteByIds).toHaveBeenCalledWith(['offer-4']);
    expect(contributorDetach.detach).toHaveBeenCalledWith({
      model: { id: 'model-2' },
      sellerId: 'seller-1',
      externalIds: ['sku-4'],
    });
    expect(mergeService.recomputePrice).toHaveBeenCalledWith({ id: 'model-2' });
    expect(productRepo.save).toHaveBeenCalledWith({ id: 'model-2' });
  });

  it('does nothing when the run saw every offer', async () => {
    const result = await service.removeUnseen({
      source,
      seenExternalIds: seenAllBut(),
      categorySlugs: ['ebikes'],
    });

    expect(result).toEqual({ removed: 0 });
    expect(offerRepo.deleteByIds).not.toHaveBeenCalled();
  });

  // A feed that suddenly lacks this much is far likelier truncated.
  it(`removes none when more than ${MAX_COMPLETE_RUN_REMOVAL_SHARE * 100}% would go`, async () => {
    const result = await service.removeUnseen({
      source,
      seenExternalIds: seenAllBut(1, 2, 3),
      categorySlugs: ['ebikes'],
    });

    expect(result).toEqual({ removed: 0, skipped: 'share_exceeded', wouldRemove: 3 });
    expect(offerRepo.deleteByIds).not.toHaveBeenCalled();
  });

  it('removes up to the share', async () => {
    const result = await service.removeUnseen({
      source,
      seenExternalIds: seenAllBut(1, 2),
      categorySlugs: ['ebikes'],
    });

    expect(result).toEqual({ removed: 2 });
  });

  it('removes none while switched off', async () => {
    freshness.completeSourceRemovalEnabled = false;

    const result = await service.removeUnseen({
      source,
      seenExternalIds: seenAllBut(4),
      categorySlugs: ['ebikes'],
    });

    expect(result).toEqual({ removed: 0, skipped: 'disabled', wouldRemove: 1 });
    expect(offerRepo.deleteByIds).not.toHaveBeenCalled();
  });

  // Its page's ids collided: no feed row names it.
  it('never counts an offer without a key as unseen', async () => {
    offerRepo.findSellerOffersInCategories.mockResolvedValue([
      ...catalog(),
      { id: 'offer-unkeyed', externalId: null, modelId: 'model-0' },
    ]);

    const result = await service.removeUnseen({
      source,
      seenExternalIds: seenAllBut(),
      categorySlugs: ['ebikes'],
    });

    expect(result).toEqual({ removed: 0 });
  });

  it('leaves an offer an import moved to another product meanwhile', async () => {
    offerRepo.findBySellerAndExternalIds.mockResolvedValue([
      { id: 'offer-4', externalId: 'sku-4', model: { id: 'model-elsewhere' } },
    ]);

    const result = await service.removeUnseen({
      source,
      seenExternalIds: seenAllBut(4),
      categorySlugs: ['ebikes'],
    });

    expect(result).toEqual({ removed: 0 });
    expect(offerRepo.deleteByIds).not.toHaveBeenCalled();
  });

  it('keeps going when one product fails', async () => {
    productRepo.findOne
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementation(async ({ where }) => ({ id: where.id }));

    const result = await service.removeUnseen({
      source,
      seenExternalIds: seenAllBut(0, 4),
      categorySlugs: ['ebikes'],
    });

    expect(result).toEqual({ removed: 1 });
  });
});
