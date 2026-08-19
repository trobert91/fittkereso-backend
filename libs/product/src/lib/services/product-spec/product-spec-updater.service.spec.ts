import { ProductSpecUpdaterService } from './product-spec-updater.service';
import { hashRawSpecs } from '@fittkereso-backend/utils';
import type { ProductModel, ProductSourceRecord } from '@fittkereso-backend/database';

describe('ProductSpecUpdaterService.updateSpecsOnProduct', () => {
  let service: ProductSpecUpdaterService;
  let productRepo: { save: jest.Mock };
  let specMergeService: { mergeSpecs: jest.Mock };
  let specSortService: { sortSpecs: jest.Mock };
  let validatorService: { validateSpecs: jest.Mock };
  let productMetrics: {
    productSourceSpecValidationFailed: jest.Mock;
    productSpecValidationFailed: jest.Mock;
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
    productRepo = { save: jest.fn() };
    specMergeService = { mergeSpecs: jest.fn().mockResolvedValue({ weight: 22 }) };
    specSortService = { sortSpecs: jest.fn().mockReturnValue([]) };
    validatorService = {
      validateSpecs: jest.fn().mockReturnValue({ isValid: true, errors: {} }),
    };
    productMetrics = {
      productSourceSpecValidationFailed: jest.fn(),
      productSpecValidationFailed: jest.fn(),
    };
    categoryConfigService = {
      getJsonSchema: jest.fn().mockReturnValue(undefined),
      getConfig: jest.fn().mockReturnValue(undefined),
    };

    service = new ProductSpecUpdaterService(
      productRepo as any,
      specMergeService as any,
      specSortService as any,
      validatorService as any,
      productMetrics as any,
      categoryConfigService as any,
    );
  });

  it('skips extraction/merge entirely when specs is undefined and a matching source row already exists', async () => {
    const existingSource: Partial<ProductSourceRecord> = {
      url: 'https://speedbike.hu/product-1',
      specs: { weight: 22 },
      rawSpecsHash: 'abc123',
      lastUpdated: new Date('2026-01-01'),
    };
    const model = makeModel(existingSource);

    const result = await service.updateSpecsOnProduct({
      model,
      source,
      specs: undefined,
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(result).toBe(existingSource);
    expect(specMergeService.mergeSpecs).not.toHaveBeenCalled();
    expect(existingSource.lastUpdated).toEqual(new Date('2026-01-01')); // untouched
  });

  it('creates/updates the source row and re-merges when specs is provided, storing rawSpecs and its hash', async () => {
    const model = makeModel();
    const rawSpecs = [{ name: 'Súly', values: ['22 kg'] }];

    const result = await service.updateSpecsOnProduct({
      model,
      source,
      specs: { weight: 22 },
      rawSpecs,
      externalId: 'sku-123',
      sourceUrl: 'https://speedbike.hu/product-1',
      sourceName: 'KTM Macina Scarp',
      normalizedSourceName: 'ktm macina scarp',
    });

    expect(result).toBeDefined();
    expect(result?.specs).toEqual({ weight: 22 });
    expect(result?.rawSpecs).toBe(rawSpecs);
    expect(result?.rawSpecsHash).toBe(hashRawSpecs(rawSpecs));
    expect(result?.externalId).toBe('sku-123');
    expect(specMergeService.mergeSpecs).toHaveBeenCalledTimes(1);
    expect(model.specs).toEqual({ weight: 22 });
  });

  it('re-runs extraction/merge when rawSpecs differs from what is stored, even if specs is present', async () => {
    const existingSource: Partial<ProductSourceRecord> = {
      url: 'https://speedbike.hu/product-1',
      specs: { weight: 22 },
      rawSpecsHash: hashRawSpecs([{ name: 'Súly', values: ['22 kg'] }]),
      lastUpdated: new Date('2026-01-01'),
    };
    const model = makeModel(existingSource);
    const newRawSpecs = [{ name: 'Súly', values: ['23 kg'] }];

    await service.updateSpecsOnProduct({
      model,
      source,
      specs: { weight: 23 },
      rawSpecs: newRawSpecs,
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(specMergeService.mergeSpecs).toHaveBeenCalledTimes(1);
    expect(existingSource.rawSpecsHash).toBe(hashRawSpecs(newRawSpecs));
  });

  it('always processes when specs is provided even without a prior source row', async () => {
    const model = makeModel();

    await service.updateSpecsOnProduct({
      model,
      source,
      specs: { weight: 22 },
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(specMergeService.mergeSpecs).toHaveBeenCalledTimes(1);
    expect(model.sources).toHaveLength(1);
  });

  it('does not skip when specs is undefined but no matching source row exists yet', async () => {
    const model = makeModel(); // no existing sources

    await service.updateSpecsOnProduct({
      model,
      source,
      specs: undefined,
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    // Falls through to normal processing with empty specs — this is the
    // manual-edit / first-scrape path, not the "unchanged" skip path.
    expect(specMergeService.mergeSpecs).toHaveBeenCalledTimes(1);
  });

  it('excludes offer-level spec keys from the merged model.specs', async () => {
    specMergeService.mergeSpecs.mockResolvedValue({
      weight: 22,
      frameSize: 48,
      color: 'Fekete',
    });
    categoryConfigService.getConfig.mockReturnValue({
      offerLevelSpecs: ['frameSize', 'color'],
    });
    const model = makeModel();

    await service.updateSpecsOnProduct({
      model,
      source,
      specs: { weight: 22, frameSize: 48, color: 'Fekete' },
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(model.specs).toEqual({ weight: 22 });
    expect(model.specs).not.toHaveProperty('frameSize');
    expect(model.specs).not.toHaveProperty('color');
  });

  it('leaves model.specs untouched when the category has no offerLevelSpecs configured', async () => {
    specMergeService.mergeSpecs.mockResolvedValue({ weight: 22, frameSize: 48 });
    categoryConfigService.getConfig.mockReturnValue(undefined);
    const model = makeModel();

    await service.updateSpecsOnProduct({
      model,
      source,
      specs: { weight: 22, frameSize: 48 },
      sourceUrl: 'https://speedbike.hu/product-1',
    });

    expect(model.specs).toEqual({ weight: 22, frameSize: 48 });
  });
});
