import { ProductMergeService } from './product-merge.service';
import type { Offer } from '@fittkereso-backend/database';
import type { EntityManager } from 'typeorm';

function makeQueryBuilder() {
  const builder: any = {
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  return builder;
}

function makeOffer(overrides: Partial<Offer>): Offer {
  return {
    id: overrides.id ?? 'offer-1',
    seller: overrides.seller ?? ({ id: 'seller-1' } as any),
    sourceListingId: overrides.sourceListingId,
    ...overrides,
  } as Offer;
}

describe('ProductMergeService.moveOffers', () => {
  let service: ProductMergeService;
  let manager: jest.Mocked<EntityManager>;
  let queryBuilder: ReturnType<typeof makeQueryBuilder>;

  beforeEach(() => {
    queryBuilder = makeQueryBuilder();
    manager = {
      find: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    } as unknown as jest.Mocked<EntityManager>;

    service = new ProductMergeService(
      {} as any, // productRepo
      {} as any, // specMergeService
      {} as any, // specSortService
      {} as any, // validatorService
      {} as any, // identityMergeService
      {} as any, // categoryConfigService
      {} as any, // embeddingService
      {} as any, // detailService
      {} as any, // offerRepo
    );
  });

  // Access the private method directly — this transaction-scoped logic has
  // no public surface of its own, and mergeProducts() itself is an
  // orchestration wrapper better covered by an integration/e2e test than a
  // unit test that would need to mock the whole transaction + 6 sub-steps.
  function callMoveOffers(sourceId: string, targetId: string) {
    return (service as any).moveOffers(manager, sourceId, targetId);
  }

  it('does nothing when the source product has no offers', async () => {
    manager.find.mockResolvedValueOnce([]); // source offers

    await callMoveOffers('source-1', 'target-1');

    expect(manager.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('reassigns offers with no colliding target-side offer', async () => {
    manager.find
      .mockResolvedValueOnce([
        makeOffer({ id: 'offer-1', sourceListingId: 'listing-a' }),
      ]) // source offers
      .mockResolvedValueOnce([]); // target offers (none)

    await callMoveOffers('source-1', 'target-1');

    expect(queryBuilder.update).toHaveBeenCalled();
    expect(queryBuilder.set).toHaveBeenCalledWith({
      model: { id: 'target-1' },
    });
    expect(queryBuilder.where).toHaveBeenCalledWith('id IN (:...ids)', {
      ids: ['offer-1'],
    });
    expect(queryBuilder.delete).not.toHaveBeenCalled();
  });

  it('deletes a source offer instead of moving it when the target already has an offer from the same seller+listing', async () => {
    const seller = { id: 'seller-1' } as any;
    manager.find
      .mockResolvedValueOnce([
        makeOffer({ id: 'offer-src', seller, sourceListingId: 'listing-a' }),
      ]) // source offers
      .mockResolvedValueOnce([
        makeOffer({
          id: 'offer-target',
          seller,
          sourceListingId: 'listing-a',
        }),
      ]); // target offers — same seller + sourceListingId

    await callMoveOffers('source-1', 'target-1');

    expect(queryBuilder.delete).toHaveBeenCalled();
    expect(queryBuilder.where).toHaveBeenCalledWith('id IN (:...ids)', {
      ids: ['offer-src'],
    });
    expect(queryBuilder.update).not.toHaveBeenCalled();
  });

  it('always moves (never deletes) offers with no sourceListingId, since the unique constraint does not cover them', async () => {
    const seller = { id: 'seller-1' } as any;
    manager.find
      .mockResolvedValueOnce([
        makeOffer({ id: 'offer-src', seller, sourceListingId: undefined }),
      ])
      .mockResolvedValueOnce([
        makeOffer({ id: 'offer-target', seller, sourceListingId: undefined }),
      ]);

    await callMoveOffers('source-1', 'target-1');

    expect(queryBuilder.update).toHaveBeenCalled();
    expect(queryBuilder.where).toHaveBeenCalledWith('id IN (:...ids)', {
      ids: ['offer-src'],
    });
    expect(queryBuilder.delete).not.toHaveBeenCalled();
  });

  it('handles a mix of move and delete offers in one call', async () => {
    const seller = { id: 'seller-1' } as any;
    manager.find
      .mockResolvedValueOnce([
        makeOffer({ id: 'offer-move', seller, sourceListingId: 'listing-b' }),
        makeOffer({ id: 'offer-dupe', seller, sourceListingId: 'listing-a' }),
      ])
      .mockResolvedValueOnce([
        makeOffer({
          id: 'offer-target',
          seller,
          sourceListingId: 'listing-a',
        }),
      ]);

    await callMoveOffers('source-1', 'target-1');

    expect(queryBuilder.update).toHaveBeenCalled();
    expect(queryBuilder.delete).toHaveBeenCalled();
    const updateWhereCall = queryBuilder.where.mock.calls.find((call: any[]) =>
      call[1]?.ids?.includes('offer-move'),
    );
    const deleteWhereCall = queryBuilder.where.mock.calls.find((call: any[]) =>
      call[1]?.ids?.includes('offer-dupe'),
    );
    expect(updateWhereCall).toBeDefined();
    expect(deleteWhereCall).toBeDefined();
  });
});

describe('ProductMergeService.mergeSources', () => {
  let service: ProductMergeService;
  let specMergeService: { mergeSpecs: jest.Mock };
  let specSortService: { sortSpecs: jest.Mock };
  let validatorService: { validateSpecs: jest.Mock };
  let identityMergeService: { mergeIdentity: jest.Mock };
  let categoryConfigService: { getJsonSchema: jest.Mock; getConfig: jest.Mock };

  const category = { slug: 'ebikes' } as any;

  beforeEach(() => {
    specMergeService = {
      mergeSpecs: jest.fn().mockResolvedValue({ weight: 22, frameSize: 48 }),
    };
    specSortService = { sortSpecs: jest.fn().mockResolvedValue([]) };
    validatorService = {
      validateSpecs: jest.fn().mockReturnValue({ isValid: true, errors: {} }),
    };
    identityMergeService = { mergeIdentity: jest.fn().mockResolvedValue(undefined) };
    categoryConfigService = {
      getJsonSchema: jest.fn().mockReturnValue(undefined),
      getConfig: jest.fn().mockReturnValue(undefined),
    };

    service = new ProductMergeService(
      {} as any,
      specMergeService as any,
      specSortService as any,
      validatorService as any,
      identityMergeService as any,
      categoryConfigService as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  it('is a no-op when the model has no sources', async () => {
    const model = { sources: [], productCategory: category } as any;

    await service.mergeSources(model);

    expect(specMergeService.mergeSpecs).not.toHaveBeenCalled();
    expect(identityMergeService.mergeIdentity).not.toHaveBeenCalled();
  });

  it('merges specs, strips offer-level keys, and calls identity merge with the same latest-per-source set', async () => {
    categoryConfigService.getConfig.mockReturnValue({
      offerLevelSpecs: ['frameSize'],
    });
    const sourceA = {
      id: 'src-a',
      source: { id: 'source-1' },
      lastUpdated: new Date('2026-01-01'),
    } as any;
    const model = {
      sources: [sourceA],
      productCategory: category,
    } as any;

    await service.mergeSources(model);

    expect(specMergeService.mergeSpecs).toHaveBeenCalledWith(
      [sourceA],
      'ebikes',
    );
    // frameSize is offer-level for this category — stripped from model.specs
    expect(model.specs).toEqual({ weight: 22 });
    expect(identityMergeService.mergeIdentity).toHaveBeenCalledWith(
      model,
      [sourceA],
    );
  });

  it('dedupes to the latest row per source before merging', async () => {
    const stale = {
      id: 'src-a-stale',
      source: { id: 'source-1' },
      lastUpdated: new Date('2020-01-01'),
    } as any;
    const fresh = {
      id: 'src-a-fresh',
      source: { id: 'source-1' },
      lastUpdated: new Date('2026-01-01'),
    } as any;
    const model = {
      sources: [stale, fresh],
      productCategory: category,
    } as any;

    await service.mergeSources(model);

    expect(specMergeService.mergeSpecs).toHaveBeenCalledWith(
      [fresh],
      'ebikes',
    );
  });

  it('sets specValid/specErrors from the final validation of the merged specs', async () => {
    validatorService.validateSpecs.mockReturnValue({
      isValid: false,
      errors: { weight: 'out of range' },
    });
    const model = {
      sources: [{ id: 'src-a', source: { id: 'source-1' }, lastUpdated: new Date() }],
      productCategory: category,
    } as any;

    await service.mergeSources(model);

    expect(model.specValid).toBe(false);
    expect(model.specErrors).toEqual({ weight: 'out of range' });
  });
});
