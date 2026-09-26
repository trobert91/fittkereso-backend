import { CustomLogger } from '@fittkereso-backend/logger';
import { StaleOfferSweepService } from './stale-offer-sweep.service';

describe('StaleOfferSweepService', () => {
  let service: StaleOfferSweepService;
  let offerRepo: {
    findStaleForDeletion: jest.Mock;
    countStaleOfSilentSellers: jest.Mock;
    deleteByIds: jest.Mock;
  };
  let productRepo: { findOne: jest.Mock; save: jest.Mock };
  let mergeService: { recomputePrice: jest.Mock };
  let locks: { withLocks: jest.Mock };
  let freshness: {
    deleteCutoff: jest.Mock;
    visibleCutoff: jest.Mock;
    freshnessDays: number;
    deleteAfterDays: number;
    deletionEnabled: boolean;
  };
  let sourceRecordRepo: { findModelIdsWithStaleContributors: jest.Mock };
  let offerComposer: { compose: jest.Mock };
  let contributorDetach: { detach: jest.Mock };
  let reprice: { reprice: jest.Mock };
  let sourceRepo: { find: jest.Mock };
  let warn: jest.SpyInstance;

  const CUTOFF = new Date('2026-09-09T00:00:00Z');
  const VISIBLE_CUTOFF = new Date('2026-09-16T00:00:00Z');

  const seller = { id: 'seller-1' };
  const staleOffers = () => [
    { id: 'offer-1', externalId: 'sku-1', model: { id: 'model-1' }, seller },
    { id: 'offer-2', externalId: 'sku-2', model: { id: 'model-1' }, seller },
    { id: 'offer-3', externalId: 'sku-3', model: { id: 'model-2' }, seller },
  ];

  beforeEach(() => {
    offerRepo = {
      findStaleForDeletion: jest.fn().mockResolvedValue(staleOffers()),
      countStaleOfSilentSellers: jest.fn().mockResolvedValue([]),
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
      visibleCutoff: jest.fn().mockReturnValue(VISIBLE_CUTOFF),
      freshnessDays: 3,
      deleteAfterDays: 14,
      deletionEnabled: true,
    };
    sourceRecordRepo = { findModelIdsWithStaleContributors: jest.fn().mockResolvedValue([]) };
    offerComposer = { compose: jest.fn().mockResolvedValue({ offers: [], conflicts: [] }) };
    contributorDetach = { detach: jest.fn().mockResolvedValue([]) };
    reprice = { reprice: jest.fn().mockResolvedValue(0) };
    sourceRepo = { find: jest.fn().mockResolvedValue([]) };
    warn = jest.spyOn(CustomLogger.prototype, 'warn').mockImplementation(() => undefined);

    service = new StaleOfferSweepService(
      offerRepo as never,
      productRepo as never,
      freshness as never,
      mergeService as never,
      locks as never,
      sourceRecordRepo as never,
      offerComposer as never,
      contributorDetach as never,
      reprice as never,
      sourceRepo as never,
    );
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('products whose cheapest offer went stale', () => {
    it('are repriced after the contributors are composed and before anything is deleted', async () => {
      reprice.reprice.mockResolvedValue(4);

      const result = await service.sweep();

      expect(result.productsRepriced).toBe(4);
      expect(reprice.reprice.mock.invocationCallOrder[0]).toBeGreaterThan(
        sourceRecordRepo.findModelIdsWithStaleContributors.mock.invocationCallOrder[0],
      );
      expect(reprice.reprice.mock.invocationCallOrder[0]).toBeLessThan(
        offerRepo.findStaleForDeletion.mock.invocationCallOrder[0],
      );
    });

    it('are repriced even while deletion is disabled', async () => {
      freshness.deletionEnabled = false;
      reprice.reprice.mockResolvedValue(2);

      const result = await service.sweep();

      expect(result.productsRepriced).toBe(2);
    });
  });

  describe('sellers nothing has confirmed recently', () => {
    beforeEach(() => {
      offerRepo.countStaleOfSilentSellers.mockResolvedValue([
        { sellerId: 'seller-2', sellerName: 'broken.hu', count: 4 },
      ]);
    });

    it('are left out of the candidates, by the visible cutoff', async () => {
      await service.sweep();

      expect(offerRepo.findStaleForDeletion).toHaveBeenCalledWith(
        CUTOFF,
        VISIBLE_CUTOFF,
        500,
      );
      expect(offerRepo.countStaleOfSilentSellers).toHaveBeenCalledWith(
        CUTOFF,
        VISIBLE_CUTOFF,
      );
    });

    it('keep their offers, with one warning per seller', async () => {
      const result = await service.sweep();

      expect(result.keptForSilentSellers).toBe(4);
      const sellerWarnings = warn.mock.calls.filter(([, meta]) => meta?.sellerId === 'seller-2');
      expect(sellerWarnings).toHaveLength(1);
      expect(sellerWarnings[0][1]).toMatchObject({ seller: 'broken.hu', kept: 4 });
    });
  });

  describe('scheduled sources that run less often than offers go stale', () => {
    it('are warned about, each once', async () => {
      sourceRepo.find.mockResolvedValue([
        { name: 'weekly', frequency: '7 days' },
        { name: 'every-three-days', frequency: '3 days' },
        { name: 'daily', frequency: '1 day' },
        { name: 'unscheduled', frequency: null },
      ]);

      await service.sweep();

      expect(sourceRepo.find).toHaveBeenCalledWith({ where: { schedulingEnabled: true } });
      const warned = warn.mock.calls
        .filter(([, meta]) => meta?.frequency !== undefined)
        .map(([, meta]) => meta.source);
      expect(warned).toEqual(['weekly', 'every-three-days']);
    });
  });

  describe('offers a source stopped listing while another still does', () => {
    const arukereso = { id: 'seller-1' };
    const productWithTwoSources = {
      id: 'model-9',
      sources: [
        {
          url: 'https://speedbike.hu/haibike',
          source: { id: 'arukereso', seller: arukereso },
          scrapedProduct: { offers: [{ price: 1, resolvedExternalId: 'HAIBIKE-1' }] },
        },
        {
          url: 'https://speedbike.hu/haibike',
          source: { id: 'google', seller: arukereso },
          scrapedProduct: { offers: [{ price: 1, resolvedExternalId: 'HAIBIKE-1' }] },
        },
        // The admin's record: no source, no offers.
        { source: null, scrapedProduct: { specs: {} } },
      ],
    };

    beforeEach(() => {
      offerRepo.findStaleForDeletion.mockResolvedValue([]);
      sourceRecordRepo.findModelIdsWithStaleContributors.mockResolvedValue(['model-9']);
      productRepo.findOne.mockResolvedValue(productWithTwoSources);
    });

    it('asks for them between the visible and the delete cutoff', async () => {
      await service.sweep();

      expect(sourceRecordRepo.findModelIdsWithStaleContributors).toHaveBeenCalledWith({
        visibleCutoff: VISIBLE_CUTOFF,
        deleteCutoff: CUTOFF,
        limit: 500,
      });
    });

    it('composes each seller\'s offers again under the product lock, without a sighting', async () => {
      const result = await service.sweep();

      expect(locks.withLocks.mock.calls[0][0]).toEqual([{ namespace: 1, id: 'model-9' }]);
      expect(offerComposer.compose).toHaveBeenCalledTimes(1);
      expect(offerComposer.compose).toHaveBeenCalledWith({
        model: productWithTwoSources,
        seller: arukereso,
        externalIds: ['HAIBIKE-1'],
        sighted: false,
        create: false,
      });
      expect(mergeService.recomputePrice).toHaveBeenCalledWith(productWithTwoSources);
      expect(result.contributorsRecomposed).toBe(1);
    });

    it('composes them even while deletion is disabled', async () => {
      freshness.deletionEnabled = false;

      const result = await service.sweep();

      expect(result.contributorsRecomposed).toBe(1);
    });
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

  // A contributing source's listing joined the deleted offer and nothing else
  // on the product: it waits unattached again.
  it('detaches what joined the deleted offers, per product and seller, before the price', async () => {
    await service.sweep();

    expect(productRepo.findOne).toHaveBeenCalledWith({
      where: { id: 'model-1' },
      relations: expect.arrayContaining(['sources.source.seller', 'productCategory']),
    });
    expect(contributorDetach.detach.mock.calls.map(([params]) => params)).toEqual([
      { model: { id: 'model-1' }, sellerId: 'seller-1', externalIds: ['sku-1', 'sku-2'] },
      { model: { id: 'model-2' }, sellerId: 'seller-1', externalIds: ['sku-3'] },
    ]);
    expect(contributorDetach.detach.mock.invocationCallOrder[0]).toBeLessThan(
      mergeService.recomputePrice.mock.invocationCallOrder[0],
    );
  });

  it('does nothing when nothing is stale', async () => {
    offerRepo.findStaleForDeletion.mockResolvedValue([]);

    const result = await service.sweep();

    expect(result).toEqual({
      contributorsRecomposed: 0,
      productsRepriced: 0,
      deleted: 0,
      modelsRecomputed: 0,
      keptForSilentSellers: 0,
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

      expect(contributorDetach.detach).not.toHaveBeenCalled();
      expect(mergeService.recomputePrice).not.toHaveBeenCalled();
      expect(productRepo.save).not.toHaveBeenCalled();
    });

    it('still looks, so the would-delete count is observable', async () => {
      await service.sweep();

      expect(offerRepo.findStaleForDeletion).toHaveBeenCalledWith(
        CUTOFF,
        VISIBLE_CUTOFF,
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
