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
      originalName?: string;
      aliases?: string[];
    },
    opts: { lastUpdated?: string; createdAt?: string | null; priority?: number } = {},
  ): ProductSourceRecord {
    return {
      id,
      source: { id, priority: opts.priority ?? 0 } as any,
      // A listing the identity extraction named carries a model; only the
      // title is left when it did not.
      scrapedProduct: { ...fields },
      lastUpdated: new Date(opts.lastUpdated ?? '2026-01-01T00:00:00Z'),
      // null: a listing of this import, not saved yet.
      createdAt:
        opts.createdAt === null ? undefined : new Date(opts.createdAt ?? '2026-01-01T00:00:00Z'),
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

  describe('the model', () => {
    const trek = { id: 'brand-trek', name: 'Trek' } as any;
    beforeEach(() => brandResolution.resolve.mockResolvedValue({ entity: trek, similarity: 1 }));

    it("is the highest-priority source's, however many lower ones agree on another", async () => {
      const model = makeModel();
      const sources = [
        makeSource('a', { brand: 'Trek', model: 'Marlin Seven' }, { priority: 1 }),
        makeSource('b', { brand: 'Trek', model: 'Marlin Seven' }, { priority: 1 }),
        makeSource('c', { brand: 'Trek', model: 'Marlin 7' }, { priority: 10 }),
      ];

      await service.mergeNames(model, sources, categorySlug);

      expect(model.model).toBe('Marlin 7');
      expect(model.displayName).toBe('Trek Marlin 7');
    });

    // #9 issue 6: a joining shop renamed the product.
    it('stays when a lower-priority source joins later', async () => {
      const model = makeModel();
      const sources = [
        makeSource(
          'speedbike',
          { brand: 'Trek', model: 'Marlin 7 XL' },
          { createdAt: '2025-01-01T00:00:00Z', lastUpdated: '2025-01-01T00:00:00Z', priority: 100 },
        ),
        makeSource(
          'joiner',
          { brand: 'Trek', model: 'Marlin 7' },
          { createdAt: '2026-01-01T00:00:00Z', lastUpdated: '2026-01-01T00:00:00Z', priority: 60 },
        ),
      ];

      await service.mergeNames(model, sources, categorySlug);

      expect(model.model).toBe('Marlin 7 XL');
    });

    // Recency would hand the name back and forth on every import.
    it('breaks a priority tie by the oldest listing, however recently the other was updated', async () => {
      const model = makeModel();
      const sources = [
        makeSource(
          'newer',
          { brand: 'Trek', model: 'Marlin Seven' },
          { createdAt: '2026-01-01T00:00:00Z', lastUpdated: '2026-01-01T00:00:00Z', priority: 60 },
        ),
        makeSource(
          'older',
          { brand: 'Trek', model: 'Marlin 7' },
          { createdAt: '2025-01-01T00:00:00Z', lastUpdated: '2025-01-01T00:00:00Z', priority: 60 },
        ),
      ];

      await service.mergeNames(model, sources, categorySlug);

      expect(model.model).toBe('Marlin 7');
    });

    it("counts this import's listing, not saved yet, as the newest", async () => {
      const model = makeModel();
      const sources = [
        makeSource('new', { brand: 'Trek', model: 'Marlin Seven' }, { createdAt: null, priority: 60 }),
        makeSource('saved', { brand: 'Trek', model: 'Marlin 7' }, { priority: 60 }),
      ];

      await service.mergeNames(model, sources, categorySlug);

      expect(model.model).toBe('Marlin 7');
    });

    // A listing whose identity extraction failed keeps only its raw title,
    // sizes and colours included.
    it('skips a listing the extraction did not name, whatever its priority', async () => {
      const model = makeModel();
      const sources = [
        makeSource('named', { brand: 'Trek', model: 'Marlin 7' }, { priority: 0 }),
        makeSource('title', { brand: 'Trek', originalName: 'TREK MARLIN 7 48cm narancs' }, { priority: 100 }),
      ];

      await service.mergeNames(model, sources, categorySlug);

      expect(model.model).toBe('Marlin 7');
    });

    it('is the top title, without its brand, when no listing was named', async () => {
      const model = makeModel();
      const sources = [makeSource('title', { brand: 'Trek', originalName: 'TREK MARLIN 7 48cm' })];

      await service.mergeNames(model, sources, categorySlug);

      expect(model.model).toBe('MARLIN 7 48cm');
      expect(model.displayName).toBe('Trek MARLIN 7 48cm');
    });
  });

  it('resolves the winning brand string through BrandResolutionService, with the naming listing\x27s title, and assigns the resolved entity', async () => {
    const trekEntity = { id: 'brand-trek', name: 'Trek' } as any;
    brandResolution.resolve.mockResolvedValue({ entity: trekEntity, similarity: 1 });
    const model = makeModel();
    const sources = [
      makeSource('a', { brand: 'Trek', model: 'Marlin 7', originalName: 'Trek Marlin 7 M' }),
    ];

    await service.mergeNames(model, sources, categorySlug);

    expect(brandResolution.resolve).toHaveBeenCalledWith('Trek', 'Trek Marlin 7 M');
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
