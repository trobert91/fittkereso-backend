import { ProductNameMergeService } from './product-name-merge.service';
import { ProductNormalizerService } from '../product-normalizer.service';
import type { ProductModel, ProductSourceRecord } from '@fittkereso-backend/database';

describe('ProductNameMergeService.mergeNames', () => {
  let service: ProductNameMergeService;
  let brandResolution: { resolve: jest.Mock };
  let aliasRepo: { save: jest.Mock };
  let categoryConfigService: { getConfig: jest.Mock };

  const categorySlug = 'ebikes';
  const cube = { id: 'brand-cube', name: 'Cube' } as any;

  function makeSource(
    id: string,
    fields: {
      brand?: string;
      model?: string;
      displayName?: string;
      aliases?: string[];
      nameCleaned?: boolean;
    },
    opts: { lastUpdated?: string; priority?: number } = {},
  ): ProductSourceRecord {
    return {
      id,
      source: { id, priority: opts.priority ?? 0 } as any,
      scrapedProduct: { ...fields },
      lastUpdated: new Date(opts.lastUpdated ?? '2026-01-01T00:00:00Z'),
    } as unknown as ProductSourceRecord;
  }

  function makeModel(overrides: Partial<ProductModel> = {}): ProductModel {
    return {
      id: 'model-1',
      displayName: 'Old Name',
      aliases: [],
      ...overrides,
    } as ProductModel;
  }

  beforeEach(() => {
    brandResolution = {
      resolve: jest.fn().mockResolvedValue(undefined),
    };
    aliasRepo = { save: jest.fn().mockResolvedValue(undefined) };
    categoryConfigService = { getConfig: jest.fn().mockReturnValue(undefined) };
    service = new ProductNameMergeService(
      brandResolution as any,
      aliasRepo as any,
      new ProductNormalizerService(),
      categoryConfigService as any,
    );
  });

  it('does nothing when no source has any name field set', async () => {
    const model = makeModel();
    const sources = [makeSource('a', {})];

    await service.mergeNames(model, sources, categorySlug);

    expect(model.displayName).toBe('Old Name');
    expect(brandResolution.resolve).not.toHaveBeenCalled();
  });

  it('picks the displayName the most sources agree on over a lone dissenter', async () => {
    const model = makeModel();
    const sources = [
      makeSource('a', { displayName: 'Trek Marlin 7' }),
      makeSource('b', { displayName: 'Trek Marlin 7' }),
      makeSource('c', { displayName: 'Trek Marlin Seven' }),
    ];

    await service.mergeNames(model, sources, categorySlug);

    expect(model.displayName).toBe('Trek Marlin 7');
  });

  it('is case/whitespace-insensitive when grouping displayName candidates', async () => {
    const model = makeModel();
    const sources = [
      makeSource('a', { displayName: 'Trek Marlin 7' }),
      makeSource('b', { displayName: ' trek marlin 7 ' }),
      makeSource('c', { displayName: 'Trek Marlin Seven' }),
    ];

    await service.mergeNames(model, sources, categorySlug);

    expect(['Trek Marlin 7', ' trek marlin 7 ']).toContain(model.displayName);
  });

  it('breaks a corroboration tie by recency', async () => {
    const model = makeModel();
    const sources = [
      makeSource(
        'old',
        { displayName: 'Trek Marlin 7' },
        { lastUpdated: '2020-01-01T00:00:00Z', priority: 100 },
      ),
      makeSource(
        'fresh',
        { displayName: 'Trek Marlin Seven' },
        { lastUpdated: '2026-01-01T00:00:00Z', priority: 1 },
      ),
    ];

    await service.mergeNames(model, sources, categorySlug);

    expect(model.displayName).toBe('Trek Marlin Seven');
  });

  it('falls back to source priority once recency ties', async () => {
    const model = makeModel();
    const sources = [
      makeSource(
        'low',
        { displayName: 'Trek Marlin 7' },
        { lastUpdated: '2026-01-01T00:00:00Z', priority: 1 },
      ),
      makeSource(
        'high',
        { displayName: 'Trek Marlin Seven' },
        { lastUpdated: '2026-01-01T00:00:00Z', priority: 10 },
      ),
    ];

    await service.mergeNames(model, sources, categorySlug);

    expect(model.displayName).toBe('Trek Marlin Seven');
  });

  // A listing whose identity extraction failed keeps its raw title, sizes and
  // colours included — it must not outvote or out-date a cleaned name.
  it('ignores a raw, uncleaned name whenever a cleaned one exists', async () => {
    const model = makeModel();
    const sources = [
      makeSource(
        'cleaned',
        { model: 'Macina Scarp SX Exonic XX', displayName: 'KTM Macina Scarp SX Exonic XX' },
        { lastUpdated: '2026-01-01T00:00:00Z' },
      ),
      makeSource(
        'raw-1',
        { model: 'MACINA SCARP SX EXONICX 48cm narancs', displayName: 'KTM MACINA SCARP SX EXONICX 48cm narancs', nameCleaned: false },
        { lastUpdated: '2026-02-01T00:00:00Z' },
      ),
      makeSource(
        'raw-2',
        { model: 'MACINA SCARP SX EXONICX 48cm narancs', displayName: 'KTM MACINA SCARP SX EXONICX 48cm narancs', nameCleaned: false },
        { lastUpdated: '2026-02-01T00:00:00Z' },
      ),
    ];

    await service.mergeNames(model, sources, categorySlug);

    expect(model.model).toBe('Macina Scarp SX Exonic XX');
    expect(model.displayName).toBe('KTM Macina Scarp SX Exonic XX');
  });

  it('still names the product from a raw title when no source has a cleaned one', async () => {
    const model = makeModel();
    const sources = [
      makeSource('raw', { displayName: 'KTM MACINA SCARP 48cm', nameCleaned: false }),
    ];

    await service.mergeNames(model, sources, categorySlug);

    expect(model.displayName).toBe('KTM MACINA SCARP 48cm');
  });

  it('resolves the winning brand string through BrandResolutionService and assigns the resolved entity', async () => {
    const trekEntity = { id: 'brand-trek', name: 'Trek' } as any;
    brandResolution.resolve.mockResolvedValue({ entity: trekEntity, similarity: 1 });
    const model = makeModel();
    const sources = [makeSource('a', { brand: 'Trek', displayName: 'Trek Marlin 7' })];

    await service.mergeNames(model, sources, categorySlug);

    expect(brandResolution.resolve).toHaveBeenCalledWith('Trek', 'Trek Marlin 7');
    expect(model.brand).toBe(trekEntity);
  });

  it('does not overwrite model.brand when brand resolution finds no match', async () => {
    brandResolution.resolve.mockResolvedValue(undefined);
    const existingBrand = { id: 'brand-existing', name: 'Existing' } as any;
    const model = makeModel({ brand: existingBrand });
    const sources = [makeSource('a', { brand: 'Unknown Brand' })];

    await service.mergeNames(model, sources, categorySlug);

    expect(model.brand).toBe(existingBrand);
  });

  it('unions aliases from all sources without corroboration-gating', async () => {
    const model = makeModel({ displayName: 'Trek Marlin 7', normalizedName: 'trek marlin 7' });
    const sources = [
      makeSource('a', { aliases: ['Marlin 7'] }),
      makeSource('b', { aliases: ['MTB Marlin 7'] }),
    ];

    await service.mergeNames(model, sources, categorySlug);

    expect(aliasRepo.save).toHaveBeenCalledTimes(2);
    const savedAliases = aliasRepo.save.mock.calls.map((call) => call[0].alias);
    expect(savedAliases).toEqual(
      expect.arrayContaining(['Marlin 7', 'MTB Marlin 7']),
    );
  });

  it('skips creating an alias that duplicates the model displayName/normalizedName', async () => {
    const model = makeModel({ displayName: 'Trek Marlin 7', normalizedName: 'trek marlin 7' });
    const sources = [makeSource('a', { aliases: ['Trek Marlin 7'] })];

    await service.mergeNames(model, sources, categorySlug);

    expect(aliasRepo.save).not.toHaveBeenCalled();
  });

  it('creates no alias for a product that is not inserted yet', async () => {
    const model = makeModel({ id: undefined, displayName: 'Trek Marlin 7' });
    const sources = [makeSource('a', { aliases: ['Marlin 7'] })];

    await service.mergeNames(model, sources, categorySlug);

    expect(aliasRepo.save).not.toHaveBeenCalled();
  });

  it('swallows unique-constraint errors when creating an alias', async () => {
    aliasRepo.save.mockRejectedValueOnce(new Error('duplicate key value'));
    const model = makeModel();
    const sources = [makeSource('a', { aliases: ['Marlin 7'] })];

    await expect(service.mergeNames(model, sources, categorySlug)).resolves.not.toThrow();
  });

  describe('normalizedName', () => {
    it('rebuilds the key from the picked names with the category strategy', async () => {
      brandResolution.resolve.mockResolvedValue({ entity: cube, similarity: 1 });
      categoryConfigService.getConfig.mockReturnValue({ normalizationStrategy: 'full' });
      const model = makeModel({ normalizedName: 'stale key' });
      const sources = [makeSource('a', { brand: 'Cube', model: 'Stereo Hybrid 140 HPC' })];

      await service.mergeNames(model, sources, categorySlug);

      expect(categoryConfigService.getConfig).toHaveBeenCalledWith(categorySlug);
      expect(model.normalizedName).toBe('stereo hybrid 140 hpc');
    });

    it('strips the resolved brand name, not the scraped brand string', async () => {
      brandResolution.resolve.mockResolvedValue({ entity: cube, similarity: 0.9 });
      const model = makeModel({ normalizedName: 'stale key' });
      const sources = [makeSource('a', { brand: 'CUBE Bikes', model: 'Cube Stereo Hybrid 140' })];

      await service.mergeNames(model, sources, categorySlug);

      // No category strategy → full-sorted.
      expect(model.normalizedName).toBe('140 hybrid stereo');
    });

    it('keeps the old key when the product has no brand loaded', async () => {
      const model = makeModel({ normalizedName: 'old key' });
      const sources = [makeSource('a', { brand: 'Unknown Brand', model: 'Stereo Hybrid 140' })];

      await service.mergeNames(model, sources, categorySlug);

      expect(model.normalizedName).toBe('old key');
    });

    it('keeps the old key when there is no name to build it from', async () => {
      const model = makeModel({ brand: cube, displayName: undefined, normalizedName: 'old key' });
      const sources = [makeSource('a', {})];

      await service.mergeNames(model, sources, categorySlug);

      expect(model.normalizedName).toBe('old key');
    });

    it('does not create an alias equal to the rebuilt key', async () => {
      brandResolution.resolve.mockResolvedValue({ entity: cube, similarity: 1 });
      const model = makeModel({ normalizedName: 'stale key' });
      const sources = [
        makeSource('a', {
          brand: 'Cube',
          model: 'Stereo Hybrid 140',
          aliases: ['140 hybrid stereo', 'Stereo Hybrid 140 2024'],
        }),
      ];

      await service.mergeNames(model, sources, categorySlug);

      const savedAliases = aliasRepo.save.mock.calls.map((call) => call[0].alias);
      expect(savedAliases).toEqual(['Stereo Hybrid 140 2024']);
    });
  });
});
