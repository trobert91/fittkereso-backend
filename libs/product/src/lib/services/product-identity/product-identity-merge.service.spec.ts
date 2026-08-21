import { ProductIdentityMergeService } from './product-identity-merge.service';
import type { ProductModel, ProductSourceRecord } from '@fittkereso-backend/database';

describe('ProductIdentityMergeService.mergeIdentity', () => {
  let service: ProductIdentityMergeService;
  let brandResolution: { resolve: jest.Mock };
  let aliasRepo: { save: jest.Mock };

  function makeSource(
    id: string,
    fields: {
      brand?: string;
      model?: string;
      displayName?: string;
      releaseYear?: number;
      aliases?: string[];
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
    service = new ProductIdentityMergeService(
      brandResolution as any,
      aliasRepo as any,
    );
  });

  it('does nothing when no source has any identity field set', async () => {
    const model = makeModel();
    const sources = [makeSource('a', {})];

    await service.mergeIdentity(model, sources);

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

    await service.mergeIdentity(model, sources);

    expect(model.displayName).toBe('Trek Marlin 7');
  });

  it('is case/whitespace-insensitive when grouping displayName candidates', async () => {
    const model = makeModel();
    const sources = [
      makeSource('a', { displayName: 'Trek Marlin 7' }),
      makeSource('b', { displayName: ' trek marlin 7 ' }),
      makeSource('c', { displayName: 'Trek Marlin Seven' }),
    ];

    await service.mergeIdentity(model, sources);

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

    await service.mergeIdentity(model, sources);

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

    await service.mergeIdentity(model, sources);

    expect(model.displayName).toBe('Trek Marlin Seven');
  });

  it('resolves the winning brand string through BrandResolutionService and assigns the resolved entity', async () => {
    const trekEntity = { id: 'brand-trek', name: 'Trek' } as any;
    brandResolution.resolve.mockResolvedValue({ entity: trekEntity, similarity: 1 });
    const model = makeModel();
    const sources = [makeSource('a', { brand: 'Trek', displayName: 'Trek Marlin 7' })];

    await service.mergeIdentity(model, sources);

    expect(brandResolution.resolve).toHaveBeenCalledWith('Trek', 'Trek Marlin 7');
    expect(model.brand).toBe(trekEntity);
  });

  it('does not overwrite model.brand when brand resolution finds no match', async () => {
    brandResolution.resolve.mockResolvedValue(undefined);
    const existingBrand = { id: 'brand-existing', name: 'Existing' } as any;
    const model = makeModel({ brand: existingBrand });
    const sources = [makeSource('a', { brand: 'Unknown Brand' })];

    await service.mergeIdentity(model, sources);

    expect(model.brand).toBe(existingBrand);
  });

  it('recomputes releaseYear via corroboration, not "first non-empty wins"', async () => {
    const model = makeModel({ releaseYear: 2020 });
    const sources = [
      makeSource('a', { releaseYear: 2024 }),
      makeSource('b', { releaseYear: 2024 }),
      makeSource('c', { releaseYear: 2023 }),
    ];

    await service.mergeIdentity(model, sources);

    expect(model.releaseYear).toBe(2024);
  });

  it('unions aliases from all sources without corroboration-gating', async () => {
    const model = makeModel({ displayName: 'Trek Marlin 7', normalizedName: 'trek marlin 7' });
    const sources = [
      makeSource('a', { aliases: ['Marlin 7'] }),
      makeSource('b', { aliases: ['MTB Marlin 7'] }),
    ];

    await service.mergeIdentity(model, sources);

    expect(aliasRepo.save).toHaveBeenCalledTimes(2);
    const savedAliases = aliasRepo.save.mock.calls.map((call) => call[0].alias);
    expect(savedAliases).toEqual(
      expect.arrayContaining(['Marlin 7', 'MTB Marlin 7']),
    );
  });

  it('skips creating an alias that duplicates the model displayName/normalizedName', async () => {
    const model = makeModel({ displayName: 'Trek Marlin 7', normalizedName: 'trek marlin 7' });
    const sources = [makeSource('a', { aliases: ['Trek Marlin 7'] })];

    await service.mergeIdentity(model, sources);

    expect(aliasRepo.save).not.toHaveBeenCalled();
  });

  it('swallows unique-constraint errors when creating an alias', async () => {
    aliasRepo.save.mockRejectedValueOnce(new Error('duplicate key value'));
    const model = makeModel();
    const sources = [makeSource('a', { aliases: ['Marlin 7'] })];

    await expect(service.mergeIdentity(model, sources)).resolves.not.toThrow();
  });
});
