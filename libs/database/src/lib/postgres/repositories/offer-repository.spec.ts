import { Offer } from '../models/offer.entity';
import { OfferCondition } from '../types/offer-condition';
import { OfferAvailability } from '../types/offer-availability';
import { OfferRepository } from './offer-repository';

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
    expect(result.lastSeenAt).toBeInstanceOf(Date);
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

  it('defaults currency and availability when not provided by the scrape', async () => {
    mockRepo.save.mockImplementation(async (offer: Offer) => offer);

    const result = await repository.upsertFromScrape(
      makeParams({ currency: undefined, availability: undefined, externalId: undefined }),
    );

    expect(result.currency).toBe('HUF');
    expect(result.availability).toBe(OfferAvailability.unknown);
  });

  it('re-fetches and updates on a concurrent-insert unique-constraint race when no existing offer was passed in', async () => {
    mockRepo.save.mockRejectedValueOnce(
      new Error(
        'duplicate key value violates unique constraint "UQ_offer_seller_externalId"',
      ),
    );
    const raceWinner = new Offer();
    raceWinner.id = 'offer-race';
    raceWinner.condition = OfferCondition.new;
    mockRepo.findOne.mockResolvedValueOnce(raceWinner); // re-fetch after conflict
    mockRepo.save.mockImplementationOnce(async (offer: Offer) => offer);

    const result = await repository.upsertFromScrape(makeParams());

    expect(mockRepo.findOne).toHaveBeenCalledWith({
      where: { seller: { id: 'seller-1' }, externalId: 'listing-1' },
    });
    expect(result).toBe(raceWinner);
    expect(result.price).toBe(199990);
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
