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
    sourceListingId: 'listing-1',
    ...overrides,
  };
}

describe('OfferRepository.upsertFromScrape', () => {
  let mockRepo: { findOne: jest.Mock; save: jest.Mock };
  let repository: OfferRepository;

  beforeEach(() => {
    mockRepo = { findOne: jest.fn(), save: jest.fn() };
    repository = Object.create(OfferRepository.prototype);
    (repository as unknown as { repo: unknown }).repo = mockRepo;
  });

  it('creates a new offer defaulting condition to "new" when none exists for the sourceListingId', async () => {
    mockRepo.findOne.mockResolvedValueOnce(null);
    mockRepo.save.mockImplementation(async (offer: Offer) => offer);

    const result = await repository.upsertFromScrape(makeParams());

    expect(mockRepo.findOne).toHaveBeenCalledWith({
      where: { seller: { id: 'seller-1' }, sourceListingId: 'listing-1' },
    });
    expect(result.condition).toBe(OfferCondition.new);
    expect(result.price).toBe(199990);
    expect(result.active).toBe(true);
    expect(result.lastSeenAt).toBeInstanceOf(Date);
  });

  it('updates an existing offer in place without clobbering a non-default condition', async () => {
    const existing = new Offer();
    existing.id = 'offer-1';
    existing.condition = OfferCondition.refurbished;
    existing.price = 150000;
    existing.active = false;
    mockRepo.findOne.mockResolvedValueOnce(existing);
    mockRepo.save.mockImplementation(async (offer: Offer) => offer);

    const result = await repository.upsertFromScrape(
      makeParams({ price: 175000 }),
    );

    expect(result).toBe(existing);
    expect(result.condition).toBe(OfferCondition.refurbished); // not overwritten
    expect(result.price).toBe(175000); // updated
    expect(result.active).toBe(true); // bumped on every sighting
  });

  it('defaults currency and availability when not provided by the scrape', async () => {
    mockRepo.findOne.mockResolvedValueOnce(null);
    mockRepo.save.mockImplementation(async (offer: Offer) => offer);

    const result = await repository.upsertFromScrape(
      makeParams({ currency: undefined, availability: undefined, sourceListingId: undefined }),
    );

    expect(mockRepo.findOne).not.toHaveBeenCalled(); // no sourceListingId -> always insert
    expect(result.currency).toBe('HUF');
    expect(result.availability).toBe(OfferAvailability.unknown);
  });

  it('re-fetches and updates on a concurrent-insert unique-constraint race', async () => {
    mockRepo.findOne.mockResolvedValueOnce(null); // initial check: none found
    mockRepo.save.mockRejectedValueOnce(
      new Error(
        'duplicate key value violates unique constraint "UQ_offer_seller_sourceListingId"',
      ),
    );
    const raceWinner = new Offer();
    raceWinner.id = 'offer-race';
    raceWinner.condition = OfferCondition.new;
    mockRepo.findOne.mockResolvedValueOnce(raceWinner); // re-fetch after conflict
    mockRepo.save.mockImplementationOnce(async (offer: Offer) => offer);

    const result = await repository.upsertFromScrape(makeParams());

    expect(result).toBe(raceWinner);
    expect(result.price).toBe(199990);
  });
});
