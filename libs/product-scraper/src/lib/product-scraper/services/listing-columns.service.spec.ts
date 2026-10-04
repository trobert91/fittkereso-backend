import type { ProductSourceRecord, ScrapedProduct } from '@fittkereso-backend/database';
import { ListingColumnsService } from './listing-columns.service';

describe('ListingColumnsService', () => {
  const cube = { id: 'brand-cube', name: 'Cube' };
  let sourceRecordRepo: { findForModelRefresh: jest.Mock; setListingColumns: jest.Mock };
  let brandResolution: { resolve: jest.Mock };
  let matchQuery: { normalizedModelOf: jest.Mock };
  let service: ListingColumnsService;

  const identifying = { id: 'source-1', identifiesProducts: true };
  const contributing = { id: 'source-2', identifiesProducts: false };
  const recordOf = (
    id: string,
    listing: Partial<ScrapedProduct>,
    columns: Partial<ProductSourceRecord> = {},
    source: object = identifying,
  ): ProductSourceRecord =>
    ({
      id,
      source,
      scrapedProduct: {
        brand: 'CUBE',
        originalName: 'Cube Kathmandu Hybrid ONE 800 54',
        category: { id: 'cat-1', slug: 'ebikes', name: 'E-bikes' },
        ...listing,
      },
      ...columns,
    }) as unknown as ProductSourceRecord;

  beforeEach(() => {
    sourceRecordRepo = {
      findForModelRefresh: jest.fn().mockResolvedValue([]),
      setListingColumns: jest.fn().mockResolvedValue(undefined),
    };
    brandResolution = { resolve: jest.fn().mockResolvedValue({ entity: cube, similarity: 1 }) };
    matchQuery = {
      normalizedModelOf: jest.fn(
        (listing: ScrapedProduct, brandName?: string) => `key:${listing.model}:${brandName}`,
      ),
    };
    service = new ListingColumnsService(
      sourceRecordRepo as never,
      brandResolution as never,
      matchQuery as never,
    );
  });

  it('fills a listing\x27s brand, model, title and key from its stored listing', async () => {
    sourceRecordRepo.findForModelRefresh.mockResolvedValueOnce([
      recordOf('r1', { model: 'Kathmandu Hybrid ONE 800' }),
    ]);

    const summary = await service.fill({ dryRun: false });

    expect(sourceRecordRepo.findForModelRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ named: false }),
    );
    expect(brandResolution.resolve).toHaveBeenCalledWith('CUBE', 'Cube Kathmandu Hybrid ONE 800 54');
    expect(sourceRecordRepo.setListingColumns).toHaveBeenCalledWith('r1', {
      brandId: 'brand-cube',
      model: 'Kathmandu Hybrid ONE 800',
      originalTitle: 'Cube Kathmandu Hybrid ONE 800 54',
      normalizedModel: 'key:Kathmandu Hybrid ONE 800:Cube',
    });
    expect(summary).toEqual({ read: 1, changed: 1 });
  });

  it('keeps no key for a contributing source, nor for a listing without a model', async () => {
    sourceRecordRepo.findForModelRefresh.mockResolvedValueOnce([
      recordOf('google', { model: 'Kathmandu Hybrid ONE 800' }, {}, contributing),
      recordOf('unnamed', { model: undefined }),
    ]);
    matchQuery.normalizedModelOf.mockImplementation((listing: ScrapedProduct) =>
      listing.model ? 'key' : undefined,
    );

    await service.fill({ dryRun: false });

    expect(sourceRecordRepo.setListingColumns).toHaveBeenCalledWith(
      'google',
      expect.objectContaining({ normalizedModel: null, model: 'Kathmandu Hybrid ONE 800' }),
    );
    expect(sourceRecordRepo.setListingColumns).toHaveBeenCalledWith(
      'unnamed',
      expect.objectContaining({ normalizedModel: null, model: null }),
    );
  });

  it('writes nothing for a record whose columns already match', async () => {
    sourceRecordRepo.findForModelRefresh.mockResolvedValueOnce([
      recordOf(
        'r1',
        { model: 'Kathmandu Hybrid ONE 800' },
        {
          brand: cube as never,
          model: 'Kathmandu Hybrid ONE 800',
          originalTitle: 'Cube Kathmandu Hybrid ONE 800 54',
          normalizedModel: 'key:Kathmandu Hybrid ONE 800:Cube',
        },
      ),
    ]);

    const summary = await service.fill({ dryRun: false });

    expect(summary).toEqual({ read: 1, changed: 0 });
    expect(sourceRecordRepo.setListingColumns).not.toHaveBeenCalled();
  });

  it('only counts in a dry run', async () => {
    sourceRecordRepo.findForModelRefresh.mockResolvedValueOnce([recordOf('r1', { model: 'X' })]);

    const summary = await service.fill({ dryRun: true });

    expect(summary).toEqual({ read: 1, changed: 1 });
    expect(sourceRecordRepo.setListingColumns).not.toHaveBeenCalled();
  });

  it('resolves each brand string and title once', async () => {
    sourceRecordRepo.findForModelRefresh.mockResolvedValueOnce([
      recordOf('r1', { model: 'X' }),
      recordOf('r2', { model: 'Y' }),
    ]);

    await service.fill({ dryRun: false });

    expect(brandResolution.resolve).toHaveBeenCalledTimes(1);
  });
});
