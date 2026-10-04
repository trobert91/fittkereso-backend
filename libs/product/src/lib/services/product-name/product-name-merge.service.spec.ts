import { ProductNameMergeService } from './product-name-merge.service';
import type { ProductModel, ProductSourceRecord } from '@fittkereso-backend/database';

describe('ProductNameMergeService.mergeNames', () => {
  let service: ProductNameMergeService;
  let brandResolution: { resolve: jest.Mock };
  let aliasRepo: { save: jest.Mock };


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
      model: 'Old Name',
      aliases: [],
      ...overrides,
    } as ProductModel;
  }

  beforeEach(() => {
    brandResolution = {
      resolve: jest.fn().mockResolvedValue(undefined),
    };
    aliasRepo = { save: jest.fn().mockResolvedValue(undefined) };
    service = new ProductNameMergeService(brandResolution as any, aliasRepo as any);
  });

  it('does nothing when no source has any name field set', async () => {
    const model = makeModel();
    const sources = [makeSource('a', {})];

    await service.mergeNames(model, sources);

    expect(model.model).toBe('Old Name');
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

      await service.mergeNames(model, sources);

      expect(model.model).toBe('Marlin 7');
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

      await service.mergeNames(model, sources);

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

      await service.mergeNames(model, sources);

      expect(model.model).toBe('Marlin 7');
    });

    it("counts this import's listing, not saved yet, as the newest", async () => {
      const model = makeModel();
      const sources = [
        makeSource('new', { brand: 'Trek', model: 'Marlin Seven' }, { createdAt: null, priority: 60 }),
        makeSource('saved', { brand: 'Trek', model: 'Marlin 7' }, { priority: 60 }),
      ];

      await service.mergeNames(model, sources);

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

      await service.mergeNames(model, sources);

      expect(model.model).toBe('Marlin 7');
    });

    it('is the top title, without its brand, when no listing was named', async () => {
      const model = makeModel();
      const sources = [makeSource('title', { brand: 'Trek', originalName: 'TREK MARLIN 7 48cm' })];

      await service.mergeNames(model, sources);

      expect(model.model).toBe('MARLIN 7 48cm');
    });
  });

  it('resolves the winning brand string through BrandResolutionService, with the naming listing\x27s title, and assigns the resolved entity', async () => {
    const trekEntity = { id: 'brand-trek', name: 'Trek' } as any;
    brandResolution.resolve.mockResolvedValue({ entity: trekEntity, similarity: 1 });
    const model = makeModel();
    const sources = [
      makeSource('a', { brand: 'Trek', model: 'Marlin 7', originalName: 'Trek Marlin 7 M' }),
    ];

    await service.mergeNames(model, sources);

    expect(brandResolution.resolve).toHaveBeenCalledWith('Trek', 'Trek Marlin 7 M');
    expect(model.brand).toBe(trekEntity);
  });

  it('does not overwrite model.brand when brand resolution finds no match', async () => {
    brandResolution.resolve.mockResolvedValue(undefined);
    const existingBrand = { id: 'brand-existing', name: 'Existing' } as any;
    const model = makeModel({ brand: existingBrand });
    const sources = [makeSource('a', { brand: 'Unknown Brand' })];

    await service.mergeNames(model, sources);

    expect(model.brand).toBe(existingBrand);
  });

  it('unions aliases from all sources without corroboration-gating', async () => {
    const model = makeModel();
    const sources = [
      makeSource('a', { aliases: ['Marlin 7'] }),
      makeSource('b', { aliases: ['MTB Marlin 7'] }),
    ];

    await service.mergeNames(model, sources);

    expect(aliasRepo.save).toHaveBeenCalledTimes(2);
    const savedAliases = aliasRepo.save.mock.calls.map((call) => call[0].alias);
    expect(savedAliases).toEqual(
      expect.arrayContaining(['Marlin 7', 'MTB Marlin 7']),
    );
  });

  it('skips creating an alias that duplicates the product name or model', async () => {
    const model = makeModel({ brand: { name: 'Trek' } as never, model: 'Marlin 7' });
    const sources = [makeSource('a', { aliases: ['Trek Marlin 7', 'Marlin 7'] })];

    await service.mergeNames(model, sources);

    expect(aliasRepo.save).not.toHaveBeenCalled();
  });

  it('creates no alias for a product that is not inserted yet', async () => {
    const model = makeModel({ id: undefined, model: 'Marlin 7' });
    const sources = [makeSource('a', { aliases: ['Marlin 7'] })];

    await service.mergeNames(model, sources);

    expect(aliasRepo.save).not.toHaveBeenCalled();
  });

  it('swallows unique-constraint errors when creating an alias', async () => {
    aliasRepo.save.mockRejectedValueOnce(new Error('duplicate key value'));
    const model = makeModel();
    const sources = [makeSource('a', { aliases: ['Marlin 7'] })];

    await expect(service.mergeNames(model, sources)).resolves.not.toThrow();
  });
});
