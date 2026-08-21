import { ProductSourceRecordUpdaterService } from './product-source-record-updater.service';
import { hashRawSpecs } from '@fittkereso-backend/utils';
import type { ProductModel, ProductSourceRecord } from '@fittkereso-backend/database';

describe('ProductSourceRecordUpdaterService.upsertSourceRecord', () => {
  let service: ProductSourceRecordUpdaterService;
  let validatorService: { validateSpecs: jest.Mock };
  let productMetrics: {
    productSourceSpecValidationFailed: jest.Mock;
  };
  let categoryConfigService: { getJsonSchema: jest.Mock; getConfig: jest.Mock };

  const source = { id: 'source-1', name: 'speedbike' } as any;
  const category = { slug: 'ebikes' } as any;

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
      rawSpecsHash: 'abc123',
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

  it('creates/updates the source row when scrapedProduct is provided, storing specs/rawSpecs and the rawSpecs hash', async () => {
    const model = makeModel();
    const rawSpecs = [{ name: 'Súly', values: ['22 kg'] }];

    const result = await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: {
        specs: { weight: 22 },
        rawSpecs,
      } as any,
      externalId: 'sku-123',
      sourceUrl: 'https://speedbike.hu/product-1',
      normalizedSourceName: 'ktm macina scarp',
    });

    expect(result).toBeDefined();
    expect(result?.scrapedProduct?.specs).toEqual({ weight: 22 });
    expect(result?.scrapedProduct?.rawSpecs).toBe(rawSpecs);
    expect(result?.rawSpecsHash).toBe(hashRawSpecs(rawSpecs));
    expect(result?.externalId).toBe('sku-123');
    expect(model.sources).toHaveLength(1);
  });

  it('re-writes the row when rawSpecs differs from what is stored, even if scrapedProduct is present', async () => {
    const existingSource: Partial<ProductSourceRecord> = {
      url: 'https://speedbike.hu/product-1',
      scrapedProduct: { specs: { weight: 22 } },
      rawSpecsHash: hashRawSpecs([{ name: 'Súly', values: ['22 kg'] }]),
      lastUpdated: new Date('2026-01-01'),
    };
    const model = makeModel(existingSource);
    const newRawSpecs = [{ name: 'Súly', values: ['23 kg'] }];

    await service.upsertSourceRecord({
      model,
      source,
      scrapedProduct: { specs: { weight: 23 }, rawSpecs: newRawSpecs } as any,
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(existingSource.rawSpecsHash).toBe(hashRawSpecs(newRawSpecs));
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

  it('skips extraction when scrapedProduct is defined but specs is undefined (rawSpecsHash-unchanged rescrape) and a matching source row already exists', async () => {
    // Mirrors ProductDetailsPageScraperService.extractProduct's
    // rawSpecsHash-unchanged branch: it returns a full ScrapedProduct
    // (brand/model/displayName/offers/...) but omits specs/rawSpecs — it must
    // not be treated as "new data to write", or it wipes the existing row's
    // specs with {}.
    const existingSource: Partial<ProductSourceRecord> = {
      url: 'https://speedbike.hu/product-1',
      scrapedProduct: { specs: { weight: 22 } },
      rawSpecsHash: 'abc123',
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
});
