import { OfferRepository } from './offer-repository';

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

describe('OfferRepository identifier lookups', () => {
  let mockRepo: { find: jest.Mock };
  let repository: OfferRepository;

  beforeEach(() => {
    mockRepo = { find: jest.fn().mockResolvedValue([]) };
    repository = Object.create(OfferRepository.prototype);
    (repository as unknown as { repo: unknown }).repo = mockRepo;
  });

  it('finds the products behind a GTIN at any seller', async () => {
    mockRepo.find.mockResolvedValue([
      { id: 'o1', gtin: '09008594503199', model: { id: 'model-1' } },
    ]);

    expect(await repository.findModelIdsByGtins(['09008594503199'])).toEqual([
      { modelId: 'model-1', gtin: '09008594503199' },
    ]);
    // No seller in the filter: a GTIN is the same at every shop.
    expect(mockRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { gtin: expect.anything() } }),
    );
  });

  it('only finds MPNs within one brand', async () => {
    await repository.findModelIdsByMpns('brand-ktm', ['1260040108']);

    expect(mockRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { mpn: expect.anything(), model: { brand: { id: 'brand-ktm' } } },
      }),
    );
  });

  it('does not query for an empty list', async () => {
    expect(await repository.findModelIdsByGtins([])).toEqual([]);
    expect(await repository.findModelIdsByMpns('brand-ktm', [])).toEqual([]);
    expect(mockRepo.find).not.toHaveBeenCalled();
  });
});

describe('OfferRepository.findSellerOffersInCategories', () => {
  // What a complete run weighs against its rows: another category's offers
  // are no part of it.
  it("scopes the seller's offers to the products of these categories", async () => {
    const mockRepo = {
      find: jest.fn().mockResolvedValue([
        { id: 'offer-1', externalId: 'sku-1', model: { id: 'model-1' } },
        { id: 'offer-2', externalId: undefined, model: { id: 'model-2' } },
      ]),
    };
    const repository = Object.create(OfferRepository.prototype);
    (repository as unknown as { repo: unknown }).repo = mockRepo;

    const offers = await repository.findSellerOffersInCategories('seller-1', ['ebikes']);

    expect(mockRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seller: { id: 'seller-1' },
          model: { productCategory: { slug: expect.objectContaining({ _value: ['ebikes'] }) } },
        },
      }),
    );
    expect(offers).toEqual([
      { id: 'offer-1', externalId: 'sku-1', modelId: 'model-1' },
      { id: 'offer-2', externalId: null, modelId: 'model-2' },
    ]);
  });

  it('queries nothing without categories', async () => {
    const mockRepo = { find: jest.fn() };
    const repository = Object.create(OfferRepository.prototype);
    (repository as unknown as { repo: unknown }).repo = mockRepo;

    expect(await repository.findSellerOffersInCategories('seller-1', [])).toEqual([]);
    expect(mockRepo.find).not.toHaveBeenCalled();
  });
});
