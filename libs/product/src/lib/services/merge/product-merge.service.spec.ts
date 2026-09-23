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
    externalId: overrides.externalId,
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
      {} as any, // nameMergeService
      {} as any, // categoryConfigService
      {} as any, // embeddingService
      {} as any, // detailService
      {} as any, // offerRepo
      {} as any, // duplicatePairRepo
      {} as any, // offerFreshness
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
        makeOffer({ id: 'offer-1', externalId: 'listing-a' }),
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
        makeOffer({ id: 'offer-src', seller, externalId: 'listing-a' }),
      ]) // source offers
      .mockResolvedValueOnce([
        makeOffer({
          id: 'offer-target',
          seller,
          externalId: 'listing-a',
        }),
      ]); // target offers — same seller + externalId

    await callMoveOffers('source-1', 'target-1');

    expect(queryBuilder.delete).toHaveBeenCalled();
    expect(queryBuilder.where).toHaveBeenCalledWith('id IN (:...ids)', {
      ids: ['offer-src'],
    });
    expect(queryBuilder.update).not.toHaveBeenCalled();
  });

  it('always moves (never deletes) offers with no externalId, since the unique constraint does not cover them', async () => {
    const seller = { id: 'seller-1' } as any;
    manager.find
      .mockResolvedValueOnce([
        makeOffer({ id: 'offer-src', seller, externalId: undefined }),
      ])
      .mockResolvedValueOnce([
        makeOffer({ id: 'offer-target', seller, externalId: undefined }),
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
        makeOffer({ id: 'offer-move', seller, externalId: 'listing-b' }),
        makeOffer({ id: 'offer-dupe', seller, externalId: 'listing-a' }),
      ])
      .mockResolvedValueOnce([
        makeOffer({
          id: 'offer-target',
          seller,
          externalId: 'listing-a',
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

describe('ProductMergeService.moveProductSourceRecords', () => {
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
      {} as any, // nameMergeService
      {} as any, // categoryConfigService
      {} as any, // embeddingService
      {} as any, // detailService
      {} as any, // offerRepo
      {} as any, // duplicatePairRepo
      {} as any, // offerFreshness
    );
  });

  function callMove(source: any, target: any) {
    return (service as any).moveProductSourceRecords(manager, source, target);
  }

  it('returns nothing when the source product has no listings', async () => {
    const moved = await callMove({ id: 'source-1', sources: [] }, { id: 'target-1' });

    expect(moved).toEqual([]);
    expect(manager.createQueryBuilder).not.toHaveBeenCalled();
  });

  // There is no unique constraint on (model, source) — only url — and the
  // scraper deliberately creates one record per variant URL. So two records
  // from the same source are two real listings, and dropping either would
  // destroy a listing plus its scrapedProduct provenance.
  it('moves every listing, including one from a source the target already has', async () => {
    const moved = await callMove(
      {
        id: 'source-1',
        sources: [
          { id: 'record-1', source: { id: 'shop-a' } },
          { id: 'record-2', source: { id: 'shop-b' } },
        ],
      },
      {
        id: 'target-1',
        sources: [{ id: 'record-existing', source: { id: 'shop-a' } }],
      },
    );

    expect(moved).toEqual(['record-1', 'record-2']);
    expect(queryBuilder.where).toHaveBeenCalledWith('id IN (:...ids)', {
      ids: ['record-1', 'record-2'],
    });
    expect(queryBuilder.delete).not.toHaveBeenCalled();
  });

  // The returned ids are the whole reversal mechanism: splitting them back out
  // re-creates the merged-away product from live source data.
  it('reports the moved ids so the merge can be reversed later', async () => {
    const moved = await callMove(
      { id: 'source-1', sources: [{ id: 'record-9', source: null }] },
      { id: 'target-1', sources: [] },
    );

    expect(moved).toEqual(['record-9']);
  });
});

describe('ProductMergeService.movePriceHistory', () => {
  let service: ProductMergeService;
  let manager: jest.Mocked<EntityManager>;
  let queryBuilder: ReturnType<typeof makeQueryBuilder>;

  beforeEach(() => {
    queryBuilder = makeQueryBuilder();
    manager = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    } as unknown as jest.Mocked<EntityManager>;

    service = new ProductMergeService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any, // offerFreshness
    );
  });

  // PriceHistory.model is onDelete: CASCADE, so anything still pointing at the
  // source product when it is deleted is destroyed with no error and no log.
  it('reassigns price history to the target instead of letting the cascade eat it', async () => {
    await (service as any).movePriceHistory(manager, 'source-1', 'target-1');

    expect(queryBuilder.set).toHaveBeenCalledWith({
      model: { id: 'target-1' },
    });
    expect(queryBuilder.where).toHaveBeenCalledWith('"modelId" = :sourceId', {
      sourceId: 'source-1',
    });
  });
});

describe('ProductMergeService.mergeProducts', () => {
  const TRANSACTION_STEPS = [
    'moveProductSourceRecords',
    'moveProductImages',
    'moveOffers',
    'createAliasesFromSource',
    'moveProductAliases',
    'moveScrapeTasks',
    'movePriceHistory',
    'deleteSourceProduct',
  ];

  // The delete cascades the source's own pairs away, so the dismissals have to
  // be copied onto the target first — and in the same transaction, so a failed
  // merge carries nothing.
  it('carries dismissed duplicate pairs inside the transaction, just before the source is deleted', async () => {
    const manager = {
      findOne: jest.fn(async (_entity: unknown, { where }: { where: { id: string } }) => ({
        id: where.id,
        displayName: where.id,
      })),
    };
    const productRepo = {
      repo: {
        manager: {
          connection: {
            transaction: jest.fn(async (work: (m: unknown) => Promise<void>) => work(manager)),
          },
        },
      },
    };
    const duplicatePairRepo = { carryDismissalsForMerge: jest.fn().mockResolvedValue(0) };
    const detailService = { getProductById: jest.fn().mockResolvedValue({ id: 'target-1' }) };

    const service = new ProductMergeService(
      productRepo as any, // productRepo
      {} as any, // specMergeService
      {} as any, // specSortService
      {} as any, // validatorService
      {} as any, // nameMergeService
      {} as any, // categoryConfigService
      {} as any, // embeddingService
      detailService as any, // detailService
      {} as any, // offerRepo
      duplicatePairRepo as any, // duplicatePairRepo
      {} as any, // offerFreshness
    );
    const steps = Object.fromEntries(
      TRANSACTION_STEPS.map((step) => [
        step,
        jest
          .spyOn(service as any, step)
          .mockResolvedValue(step === 'moveProductSourceRecords' ? [] : undefined),
      ]),
    );
    jest.spyOn(service as any, 'postMergeUpdates').mockResolvedValue(undefined);

    await service.mergeProducts({ sourceId: 'source-1', targetId: 'target-1' });

    const carryOrder = duplicatePairRepo.carryDismissalsForMerge.mock.invocationCallOrder[0];
    expect(duplicatePairRepo.carryDismissalsForMerge).toHaveBeenCalledWith(
      manager,
      'source-1',
      'target-1',
    );
    expect(carryOrder).toBeGreaterThan(steps['movePriceHistory'].mock.invocationCallOrder[0]);
    expect(carryOrder).toBeLessThan(steps['deleteSourceProduct'].mock.invocationCallOrder[0]);
    expect(steps['deleteSourceProduct']).toHaveBeenCalledWith(manager, 'source-1');
  });
});

describe('ProductMergeService.mergeSources', () => {
  let service: ProductMergeService;
  let specMergeService: { mergeSpecs: jest.Mock };
  let specSortService: { sortSpecs: jest.Mock };
  let validatorService: { validateSpecs: jest.Mock };
  let nameMergeService: { mergeNames: jest.Mock };
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
    nameMergeService = { mergeNames: jest.fn().mockResolvedValue(undefined) };
    categoryConfigService = {
      getJsonSchema: jest.fn().mockReturnValue(undefined),
      getConfig: jest.fn().mockReturnValue(undefined),
    };

    service = new ProductMergeService(
      {} as any,
      specMergeService as any,
      specSortService as any,
      validatorService as any,
      nameMergeService as any,
      categoryConfigService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any, // offerFreshness
    );
  });

  it('is a no-op when the model has no sources', async () => {
    const model = { sources: [], productCategory: category } as any;

    await service.mergeSources(model);

    expect(specMergeService.mergeSpecs).not.toHaveBeenCalled();
    expect(nameMergeService.mergeNames).not.toHaveBeenCalled();
  });

  it('merges specs, strips offer-level keys, and calls the name merge with the same latest-per-source set and category slug', async () => {
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
    expect(nameMergeService.mergeNames).toHaveBeenCalledWith(
      model,
      [sourceA],
      'ebikes',
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

describe('ProductMergeService.recomputePrice', () => {
  const build = (cheapest: unknown) =>
    new ProductMergeService(
      {} as any, // productRepo
      {} as any, // specMergeService
      {} as any, // specSortService
      {} as any, // validatorService
      {} as any, // nameMergeService
      {} as any, // categoryConfigService
      {} as any, // embeddingService
      {} as any, // detailService
      { findCheapestFreshOffer: jest.fn().mockResolvedValue(cheapest) } as any,
      {} as any, // duplicatePairRepo
      { visibleCutoff: () => new Date('2026-09-16') } as any,
    );

  it('denormalizes the cheapest fresh offer onto the model', async () => {
    const service = build({ price: 199990, priceWithoutDiscount: 249990 });
    const model = { id: 'model-1', price: 10, priceWithoutDiscount: 20 } as any;

    await service.recomputePrice(model);

    expect(model.price).toBe(199990);
    expect(model.priceWithoutDiscount).toBe(249990);
  });

  // The failure this guards is silent and was live for months: TypeORM's save()
  // OMITS undefined-valued properties from the UPDATE, so assigning `undefined`
  // left the previous price in the column. This method could raise a price and
  // could never clear one — so a model whose offers all aged out (or whose
  // source was deleted) went on advertising a price for offers that no longer
  // existed, in the column the public listing sorts and filters on.
  it('clears the price with NULL, not undefined, when no fresh offer remains', async () => {
    const service = build(null);
    const model = { id: 'model-1', price: 199990, priceWithoutDiscount: 249990 } as any;

    await service.recomputePrice(model);

    expect(model.price).toBeNull();
    expect(model.priceWithoutDiscount).toBeNull();
    // Belt and braces: `undefined` is exactly the value that does not survive a
    // save, so assert the distinction rather than just falsiness.
    expect(model.price).not.toBeUndefined();
  });
});
