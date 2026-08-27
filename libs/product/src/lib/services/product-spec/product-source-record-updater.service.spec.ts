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

  it('creates/updates the source row when scrapedProduct is provided, storing specs and both spec hashes from the already-split deterministic objects', async () => {
    const model = makeModel();

    const result = await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: {
        model: 'Macina Scarp',
        specs: { weight: 22 },
        offerLevelDeterministicSpecs: { frameSize: 43 },
        productLevelDeterministicSpecs: { weight: 22 },
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

  it('re-writes the row when productLevelDeterministicSpecs differs from what is stored, even if scrapedProduct is present', async () => {
    const existingSource: Partial<ProductSourceRecord> = {
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
      } as any,
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(existingSource.productSpecsHash).toBe(hashSpecs({ weight: 23 }));
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
