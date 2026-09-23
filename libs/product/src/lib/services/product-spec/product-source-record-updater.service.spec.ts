import { ProductSourceRecordUpdaterService } from './product-source-record-updater.service';
import { hashSpecs } from '@fittkereso-backend/utils';
import type { ProductModel, ProductSourceRecord } from '@fittkereso-backend/database';

describe('ProductSourceRecordUpdaterService.upsertSourceRecord', () => {
  let service: ProductSourceRecordUpdaterService;
  let validatorService: { validateSpecs: jest.Mock };
  let productMetrics: {
    productSourceSpecValidationFailed: jest.Mock;
  };
  let categoryConfigService: { getJsonSchema: jest.Mock; getConfig: jest.Mock };

  const category = { slug: 'ebikes' } as any;
  const source = { id: 'source-1', name: 'speedbike', config: {} } as any;

  function makeModel(existingSource?: Partial<ProductSourceRecord>): ProductModel {
    return {
      productCategory: category,
      sources: existingSource ? [existingSource as ProductSourceRecord] : [],
    } as ProductModel;
  }

  beforeEach(() => {
    validatorService = {
      validateSpecs: jest.fn().mockReturnValue({ isValid: true, errors: {} }),
    };
    productMetrics = {
      productSourceSpecValidationFailed: jest.fn(),
    };
    categoryConfigService = {
      getJsonSchema: jest.fn().mockReturnValue(undefined),
      getConfig: jest.fn().mockReturnValue(undefined),
    };

    service = new ProductSourceRecordUpdaterService(
      validatorService as any,
      productMetrics as any,
      categoryConfigService as any,
    );
  });

  it('skips extraction entirely when scrapedProduct is undefined and a matching source row already exists', async () => {
    const existingSource: Partial<ProductSourceRecord> = {
      source,
      url: 'https://speedbike.hu/product-1',
      scrapedProduct: { specs: { weight: 22 } },
      offerSpecsHash: 'abc123',
      productSpecsHash: 'def456',
      lastUpdated: new Date('2026-01-01'),
    };
    const model = makeModel(existingSource);

    const result = await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: undefined,
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(result).toBe(existingSource);
    expect(existingSource.lastUpdated).toEqual(new Date('2026-01-01')); // untouched
  });

  it('creates/updates the source row when scrapedProduct is provided, persisting the hashes supplied by the caller as given', async () => {
    const model = makeModel();

    const result = await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: {
        model: 'Macina Scarp',
        specs: { weight: 22 },
        offerLevelDeterministicSpecs: { frameSize: 43 },
        productLevelDeterministicSpecs: { weight: 22 },
        offerSpecsHash: hashSpecs({ frameSize: 43 }),
        productSpecsHash: hashSpecs({ weight: 22 }),
      } as any,
      externalId: 'sku-123',
      sourceUrl: 'https://speedbike.hu/product-1',
      normalizedSourceName: 'ktm macina scarp',
    });

    expect(result).toBeDefined();
    expect(result?.scrapedProduct?.specs).toEqual({ weight: 22 });
    expect(result?.offerSpecsHash).toBe(hashSpecs({ frameSize: 43 }));
    expect(result?.productSpecsHash).toBe(hashSpecs({ weight: 22 }));
    expect(result?.externalId).toBe('sku-123');
    expect(model.sources).toHaveLength(1);
  });

  it('re-writes the row when the caller supplies a new productSpecsHash, even if scrapedProduct is present', async () => {
    const existingSource: Partial<ProductSourceRecord> = {
      source,
      url: 'https://speedbike.hu/product-1',
      scrapedProduct: { specs: { weight: 22 } },
      productSpecsHash: hashSpecs({ weight: 22 }),
      lastUpdated: new Date('2026-01-01'),
    };
    const model = makeModel(existingSource);

    await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: {
        model: 'Macina Scarp',
        specs: { weight: 23 },
        productLevelDeterministicSpecs: { weight: 23 },
        productSpecsHash: hashSpecs({ weight: 23 }),
      } as any,
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(existingSource.productSpecsHash).toBe(hashSpecs({ weight: 23 }));
  });

  it('trusts the caller-supplied hash even if it does not match what processSpecs would derive from productLevelDeterministicSpecs, since the hash and the LLM-call decision must agree on the same pre-computed value', async () => {
    const model = makeModel();

    const result = await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: {
        model: 'Macina Scarp',
        specs: { weight: 22 },
        productLevelDeterministicSpecs: { weight: 22 },
        productSpecsHash: 'caller-computed-hash',
      } as any,
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(result?.productSpecsHash).toBe('caller-computed-hash');
  });

  it('always processes when scrapedProduct is provided even without a prior source row', async () => {
    const model = makeModel();

    await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: { specs: { weight: 22 } } as any,
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(model.sources).toHaveLength(1);
  });

  it('does not skip when scrapedProduct is undefined but no matching source row exists yet', async () => {
    const model = makeModel(); // no existing sources

    const result = await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: undefined,
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    // Falls through to normal processing with an empty specs object — this
    // is the manual-edit / first-scrape path, not the "unchanged" skip path.
    expect(result).toBeDefined();
    expect(model.sources).toHaveLength(1);
  });

  it('skips extraction when scrapedProduct is defined but specs is undefined (both hashes unchanged rescrape) and a matching source row already exists', async () => {
    // Mirrors ProductDetailsPageScraperService.extractProduct's
    // both-hashes-unchanged branch: it returns a full ScrapedProduct
    // (brand/model/displayName/offers/...) but omits specs/rawSpecs — it must
    // not be treated as "new data to write", or it wipes the existing row's
    // specs with {}.
    const existingSource: Partial<ProductSourceRecord> = {
      source,
      url: 'https://speedbike.hu/product-1',
      scrapedProduct: { specs: { weight: 22 } },
      offerSpecsHash: 'abc123',
      productSpecsHash: 'def456',
      lastUpdated: new Date('2026-01-01'),
    };
    const model = makeModel(existingSource);

    const result = await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: {
        brand: 'KTM',
        model: 'Macina Scarp',
        displayName: 'KTM Macina Scarp',
      } as any,
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(result).toBe(existingSource);
    expect(existingSource.scrapedProduct?.specs).toEqual({ weight: 22 });
    expect(existingSource.lastUpdated).toEqual(new Date('2026-01-01')); // untouched
  });

  it('never writes through another source\'s record for the same URL', async () => {
    // One webshop can be covered by several ProductSources (a page scraper and
    // an Árukereső feed), and ProductSourceRecord.url is unique only per
    // source — so `model.sources`, which is loaded across ALL sources, can hold
    // two rows with this same URL.
    //
    // Matching on url alone picked whichever came first. Source B then
    // overwrote source A's scrapedProduct, hashes and externalId, while the row
    // stayed attributed to A (source.source is assigned on create only). A's
    // data was silently replaced by B's under A's merge priority, and B never
    // got a record of its own. This is the regression guard for that.
    const otherSourcesRecord: Partial<ProductSourceRecord> = {
      source: { id: 'source-2', name: 'speedbike-arukereso' } as any,
      url: 'https://speedbike.hu/product-1',
      scrapedProduct: { specs: { weight: 99 } },
      offerSpecsHash: 'other-offer-hash',
      productSpecsHash: 'other-product-hash',
      externalId: 'other-external-id',
      lastUpdated: new Date('2026-01-01'),
    };
    const model = makeModel(otherSourcesRecord);

    const result = await service.upsertSourceRecord({
      model,
      source, // source-1
      scrapedProduct: {
        model: 'Macina Scarp',
        specs: { weight: 23 },
      } as any,
      externalId: 'my-external-id',
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    // A second, independent record — not a write through the other source's.
    expect(result).not.toBe(otherSourcesRecord);
    expect(model.sources).toHaveLength(2);
    expect(result?.source).toBe(source);

    // The other source's row is untouched in every field this call would have
    // overwritten.
    expect(otherSourcesRecord.scrapedProduct?.specs).toEqual({ weight: 99 });
    expect(otherSourcesRecord.offerSpecsHash).toBe('other-offer-hash');
    expect(otherSourcesRecord.productSpecsHash).toBe('other-product-hash');
    expect(otherSourcesRecord.externalId).toBe('other-external-id');
    expect(otherSourcesRecord.lastUpdated).toEqual(new Date('2026-01-01'));
  });

  it('sets both hashes to undefined when scrapedProduct has no offerLevelDeterministicSpecs/productLevelDeterministicSpecs', async () => {
    const model = makeModel();

    const result = await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: { model: 'Macina Scarp', specs: { weight: 22 } } as any,
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(result?.offerSpecsHash).toBeUndefined();
    expect(result?.productSpecsHash).toBeUndefined();
  });

  it('persists offerLevelDeterministicSpecs/productLevelDeterministicSpecs on the row, sorted/filtered like other spec fields', async () => {
    const model = makeModel();

    const result = await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: {
        model: 'Macina Scarp',
        specs: { weight: 22 },
        offerLevelDeterministicSpecs: { frameSize: 43, color: undefined },
        productLevelDeterministicSpecs: { weight: 22, torque: '' },
      } as any,
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(result?.scrapedProduct?.offerLevelDeterministicSpecs).toEqual({ frameSize: 43 });
    expect(result?.scrapedProduct?.productLevelDeterministicSpecs).toEqual({ weight: 22 });
  });
});
