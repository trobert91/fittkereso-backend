import type { ProductModel } from '@fittkereso-backend/database';
import { ContributorDetachService } from './contributor-detach.service';

describe('ContributorDetachService', () => {
  let service: ContributorDetachService;
  let offerRepo: { findBySellerAndExternalIds: jest.Mock };
  let sourceRecordRepo: { detach: jest.Mock };
  let mergeService: { mergeSources: jest.Mock };

  const speedbike = { id: 'seller-speedbike' };
  const arukereso = { id: 'arukereso', identifiesProducts: true, seller: speedbike };
  const google = { id: 'google', identifiesProducts: false, seller: speedbike };
  const record = (id: string, source: object, keys: string[]) => ({
    id,
    source,
    model: { id: 'model-1' },
    scrapedProduct: { offers: keys.map((key) => ({ price: 1, resolvedExternalId: key })) },
  });

  const productWith = (...records: object[]) =>
    ({ id: 'model-1', sources: records }) as unknown as ProductModel;

  beforeEach(() => {
    offerRepo = { findBySellerAndExternalIds: jest.fn().mockResolvedValue([]) };
    sourceRecordRepo = { detach: jest.fn().mockResolvedValue(undefined) };
    mergeService = { mergeSources: jest.fn().mockResolvedValue(undefined) };
    service = new ContributorDetachService(
      offerRepo as never,
      sourceRecordRepo as never,
      mergeService as never,
    );
  });

  it('detaches a contributing listing whose only offer left, and merges the product without it', async () => {
    const own = record('record-arukereso', arukereso, ['HAIBIKE-1']);
    const contribution = record('record-google', google, ['HAIBIKE-1']);
    const model = productWith(own, contribution);

    const detached = await service.detach({
      model,
      sellerId: 'seller-speedbike',
      externalIds: ['HAIBIKE-1'],
    });

    expect(detached).toEqual([contribution]);
    expect(sourceRecordRepo.detach).toHaveBeenCalledWith(['record-google']);
    expect(contribution.model).toBeNull();
    // The identifying source's own record is the product's listing: it stays.
    expect(model.sources).toEqual([own]);
    expect(mergeService.mergeSources).toHaveBeenCalledWith(model);
  });

  // ebikeshop-style: one page, several sizes, one of them sold out.
  it('keeps a contributing listing that still joins another offer on the product', async () => {
    const contribution = record('record-google', google, ['SIZE-M', 'SIZE-L']);
    const model = productWith(contribution);
    offerRepo.findBySellerAndExternalIds.mockResolvedValue([
      { externalId: 'SIZE-L', model: { id: 'model-1' } },
    ]);

    const detached = await service.detach({
      model,
      sellerId: 'seller-speedbike',
      externalIds: ['SIZE-M'],
    });

    expect(offerRepo.findBySellerAndExternalIds).toHaveBeenCalledWith('seller-speedbike', ['SIZE-L']);
    expect(detached).toEqual([]);
    expect(sourceRecordRepo.detach).not.toHaveBeenCalled();
    expect(mergeService.mergeSources).not.toHaveBeenCalled();
  });

  it('detaches it when its other offer sits on another product', async () => {
    const contribution = record('record-google', google, ['SIZE-M', 'SIZE-L']);
    offerRepo.findBySellerAndExternalIds.mockResolvedValue([
      { externalId: 'SIZE-L', model: { id: 'model-2' } },
    ]);

    const detached = await service.detach({
      model: productWith(contribution),
      sellerId: 'seller-speedbike',
      externalIds: ['SIZE-M'],
    });

    expect(detached).toEqual([contribution]);
  });

  it('leaves another seller\'s listings and unrelated keys alone', async () => {
    const otherSeller = record('record-other', { ...google, seller: { id: 'seller-other' } }, [
      'HAIBIKE-1',
    ]);
    const unrelated = record('record-unrelated', google, ['CUBE-1']);

    const detached = await service.detach({
      model: productWith(otherSeller, unrelated),
      sellerId: 'seller-speedbike',
      externalIds: ['HAIBIKE-1'],
    });

    expect(detached).toEqual([]);
    expect(offerRepo.findBySellerAndExternalIds).not.toHaveBeenCalled();
  });
});
