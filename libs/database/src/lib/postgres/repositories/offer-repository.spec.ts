import { Offer } from '../models/offer.entity';
import { OfferCondition } from '../types/offer-condition';
import { OfferAvailability } from '../types/offer-availability';
import { OfferRepository } from './offer-repository';
import { OfferIdentityConflictError } from './offer-identity-conflict.error';

function makeParams(overrides: Partial<Parameters<OfferRepository['upsertFromScrape']>[0]> = {}) {
  return {
    model: { id: 'model-1' } as never,
    seller: { id: 'seller-1' } as never,
    sourceRecord: { id: 'source-record-1' } as never,
    price: 199990,
    currency: 'HUF',
    availability: OfferAvailability.in_stock,
    url: 'https://seller.example/product/1',
    externalId: 'listing-1',
    ...overrides,
  };
}

describe('OfferRepository.upsertFromScrape', () => {
  let mockRepo: { findOne: jest.Mock; find: jest.Mock; save: jest.Mock };
  let repository: OfferRepository;

  beforeEach(() => {
    mockRepo = { findOne: jest.fn(), find: jest.fn(), save: jest.fn() };
    repository = Object.create(OfferRepository.prototype);
    (repository as unknown as { repo: unknown }).repo = mockRepo;
  });

  it('creates a new offer defaulting condition to "new" when no existing offer is passed in', async () => {
    mockRepo.save.mockImplementation(async (offer: Offer) => offer);

    const result = await repository.upsertFromScrape(makeParams());

    expect(mockRepo.findOne).not.toHaveBeenCalled(); // caller pre-resolves `existing`, no internal lookup
    expect(result.condition).toBe(OfferCondition.new);
    expect(result.price).toBe(199990);
    expect(result.active).toBe(true);
    expect(result.lastSynced).toBeInstanceOf(Date);
  });

  it('persists priceWithoutDiscount when the scrape reports a discount, and leaves it undefined otherwise', async () => {
    mockRepo.save.mockImplementation(async (offer: Offer) => offer);

    const discounted = await repository.upsertFromScrape(
      makeParams({ priceWithoutDiscount: 249990 }),
    );
    expect(discounted.priceWithoutDiscount).toBe(249990);

    const notDiscounted = await repository.upsertFromScrape(makeParams());
    expect(notDiscounted.priceWithoutDiscount).toBeUndefined();
  });

  it('persists locations when the scrape reports store names, and leaves it undefined otherwise', async () => {
    mockRepo.save.mockImplementation(async (offer: Offer) => offer);

    const withLocations = await repository.upsertFromScrape(
      makeParams({ locations: ['Törökbálinti raktár', 'Törökbálint'] }),
    );
    expect(withLocations.locations).toEqual(['Törökbálinti raktár', 'Törökbálint']);

    const withoutLocations = await repository.upsertFromScrape(makeParams());
    expect(withoutLocations.locations).toBeUndefined();
  });

  it('updates the passed-in existing offer in place without clobbering a non-default condition', async () => {
    const existing = new Offer();
    existing.id = 'offer-1';
    existing.condition = OfferCondition.refurbished;
    existing.price = 150000;
    existing.active = false;
    mockRepo.save.mockImplementation(async (offer: Offer) => offer);

    const result = await repository.upsertFromScrape(
      makeParams({ existing, price: 175000 }),
    );

    expect(result).toBe(existing);
    expect(result.condition).toBe(OfferCondition.refurbished); // not overwritten
    expect(result.price).toBe(175000); // updated
    expect(result.active).toBe(true); // bumped on every sighting
  });

  it('defaults currency, and leaves availability empty when the source reports none', async () => {
    mockRepo.save.mockImplementation(async (offer: Offer) => offer);

    const result = await repository.upsertFromScrape(
      makeParams({ currency: undefined, availability: undefined, externalId: undefined }),
    );

    expect(result.currency).toBe('HUF');
    // Null, NOT `unknown`. A source that publishes no stock data at all — an
    // Árukereső feed, where delivery_time is empty on every product — must not
    // be made to look like one whose stock data we failed to parse. `unknown`
    // is reserved for a value the source did report and we could not map.
    expect(result.availability).toBeNull();
  });

  it('keeps a reported availability that the source did supply', async () => {
    mockRepo.save.mockImplementation(async (offer: Offer) => offer);

    const result = await repository.upsertFromScrape(
      makeParams({ availability: OfferAvailability.out_of_stock }),
    );

    expect(result.availability).toBe(OfferAvailability.out_of_stock);
  });

  // The cross-source adoption path, and the reason it stopped being rare:
  // offers are preloaded per SOURCE, so a second source importing a listing the
  // first already owns cannot see that row, conflicts on insert, and lands
  // here. This runs every night, not once in a blue moon.
  it('adopts an existing offer when the insert conflicts and no existing offer was passed in', async () => {
    mockRepo.save.mockRejectedValueOnce(
      new Error(
        'duplicate key value violates unique constraint "UQ_offer_seller_externalId"',
      ),
    );
    const owner = new Offer();
    owner.id = 'offer-owned';
    owner.condition = OfferCondition.new;
    // Same product — no disagreement, so the update proceeds.
    owner.model = { id: 'model-1' } as never;
    mockRepo.findOne.mockResolvedValueOnce(owner);
    mockRepo.save.mockImplementationOnce(async (offer: Offer) => offer);

    const result = await repository.upsertFromScrape(
      makeParams({ locations: ['Törökbálint'] }),
    );

    expect(mockRepo.findOne).toHaveBeenCalledWith({
      where: { seller: { id: 'seller-1' }, externalId: 'listing-1' },
      // `model` is loaded purely so the disagreement below can be detected.
      relations: ['model'],
    });
    expect(result).toBe(owner);
    expect(result.price).toBe(199990);
    expect(result.locations).toEqual(['Törökbálint']);
  });

  // Both silent options are wrong: assigning `model` relocates a listing
  // between products, and leaving it (the original behaviour) strands the
  // incoming model with no offer, hence no price and no place in price-sorted
  // search. Neither is acceptable as a default, so this refuses instead.
  it('refuses to rebind an offer when two sources disagree about its product', async () => {
    mockRepo.save.mockRejectedValueOnce(
      new Error(
        'duplicate key value violates unique constraint "UQ_offer_seller_externalId"',
      ),
    );
    const owner = new Offer();
    owner.id = 'offer-owned';
    owner.price = 111;
    owner.condition = OfferCondition.new;
    owner.model = { id: 'someone-elses-model' } as never;
    mockRepo.findOne.mockResolvedValueOnce(owner);

    await expect(repository.upsertFromScrape(makeParams({}))).rejects.toThrow(
      OfferIdentityConflictError,
    );

    // The existing row is left exactly as it was — one save attempt (the failed
    // insert), and no second one.
    expect(mockRepo.save).toHaveBeenCalledTimes(1);
    expect(owner.price).toBe(111);
  });

  it('carries the identifying ids on the conflict error, so it can be investigated', async () => {
    mockRepo.save.mockRejectedValueOnce(
      new Error(
        'duplicate key value violates unique constraint "UQ_offer_seller_externalId"',
      ),
    );
    const owner = new Offer();
    owner.id = 'offer-owned';
    owner.condition = OfferCondition.new;
    owner.model = { id: 'someone-elses-model' } as never;
    mockRepo.findOne.mockResolvedValueOnce(owner);

    await expect(
      repository.upsertFromScrape(makeParams({})),
    ).rejects.toMatchObject({
      details: {
        externalId: 'listing-1',
        sellerId: 'seller-1',
        offerId: 'offer-owned',
        existingModelId: 'someone-elses-model',
        incomingModelId: 'model-1',
      },
    });
  });

  it('does not attempt a race re-fetch when an existing offer was already passed in', async () => {
    const existing = new Offer();
    existing.id = 'offer-1';
    mockRepo.save.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "UQ_offer_seller_externalId"'),
    );

    await expect(
      repository.upsertFromScrape(makeParams({ existing })),
    ).rejects.toThrow();
    expect(mockRepo.findOne).not.toHaveBeenCalled();
  });
});

describe('OfferRepository.findAllByModelAndSource', () => {
  it('queries offers by model and the sourceRecord\'s source, not a single sourceRecord', async () => {
    const mockRepo = { find: jest.fn().mockResolvedValue([]) };
    const repository = Object.create(OfferRepository.prototype);
    (repository as unknown as { repo: unknown }).repo = mockRepo;

    await repository.findAllByModelAndSource('model-1', 'source-1');

    expect(mockRepo.find).toHaveBeenCalledWith({
      where: {
        model: { id: 'model-1' },
        sourceRecord: { source: { id: 'source-1' } },
      },
      relations: ['seller', 'sourceRecord'],
    });
  });
});

describe('OfferRepository.findFirstBySellerAndExternalIdsWithModelRelations', () => {
  it('returns null without querying when given no candidate ids', async () => {
    const mockRepo = { findOne: jest.fn() };
    const repository = Object.create(OfferRepository.prototype);
    (repository as unknown as { repo: unknown }).repo = mockRepo;

    const result = await repository.findFirstBySellerAndExternalIdsWithModelRelations(
      'seller-1',
      [],
      [],
    );

    expect(result).toBeNull();
    expect(mockRepo.findOne).not.toHaveBeenCalled();
  });

  // Regression test: modelRelations are ProductModel's own relation names
  // (e.g. "productCategory", as returned by
  // ProductScrapeUpdaterService.getProductRelations()) — they belong to
  // Offer.model, not to Offer itself. Passing them through unprefixed
  // caused a real production failure: TypeORM's EntityPropertyNotFoundError
  // ("productCategory" was not found in "Offer").
  it('prefixes modelRelations under the model relation instead of spreading them as Offer relations', async () => {
    const mockRepo = { findOne: jest.fn().mockResolvedValue(null) };
    const repository = Object.create(OfferRepository.prototype);
    (repository as unknown as { repo: unknown }).repo = mockRepo;

    await repository.findFirstBySellerAndExternalIdsWithModelRelations(
      'seller-1',
      ['sku-1', 'sku-2'],
      ['productCategory', 'mainImage'],
    );

    expect(mockRepo.findOne).toHaveBeenCalledWith({
      where: { seller: { id: 'seller-1' }, externalId: expect.anything() },
      relations: [
        'model',
        'sourceRecord',
        'model.productCategory',
        'model.mainImage',
      ],
    });
  });
});
