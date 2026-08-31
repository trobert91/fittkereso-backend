import { BadRequestException, NotFoundException } from '@nestjs/common';
import type {
  ProductModelRepository,
  ProductSourceRecord,
  ProductSourceRecordRepository,
} from '@fittkereso-backend/database';
import { ProductSplitService } from './product-split.service';
import type { ProductMergeService } from './product-merge.service';
import type { ProductModelFactoryService } from '../product-model-factory.service';
import type { ProductEmbeddingService } from '../product-embedding.service';

function makeQueryBuilder() {
  const builder: any = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  return builder;
}

function makeRecord(
  overrides: Partial<ProductSourceRecord> = {},
): ProductSourceRecord {
  return {
    id: 'record-1',
    url: 'https://shop.hu/p/1',
    lastUpdated: new Date('2024-05-01'),
    normalizedSourceName: 'cube reaction hybrid',
    model: { id: 'product-1', productCategory: { id: 'category-1' } },
    scrapedProduct: {
      brand: 'Cube',
      model: 'Reaction Hybrid',
      displayName: 'Cube Reaction Hybrid 625',
      category: { id: 'category-1', name: 'E-bikes', slug: 'e-bikes' },
    },
    ...overrides,
  } as ProductSourceRecord;
}

describe('ProductSplitService', () => {
  let service: ProductSplitService;
  let sourceRecordRepo: { find: jest.Mock };
  let productRepo: any;
  let mergeService: { mergeSources: jest.Mock; recomputePrice: jest.Mock };
  let modelFactory: { createShell: jest.Mock };
  let queryBuilder: ReturnType<typeof makeQueryBuilder>;
  let manager: any;

  beforeEach(() => {
    queryBuilder = makeQueryBuilder();
    manager = {
      save: jest.fn().mockResolvedValue({ id: 'product-new' }),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };

    sourceRecordRepo = { find: jest.fn().mockResolvedValue([makeRecord()]) };
    productRepo = {
      repo: {
        manager: {
          connection: {
            transaction: jest.fn(async (cb: any) => cb(manager)),
          },
        },
      },
      findOne: jest.fn().mockResolvedValue(null),
      findOneOrFail: jest.fn().mockResolvedValue({ id: 'product-new' }),
      save: jest.fn(),
    };
    mergeService = {
      mergeSources: jest.fn(),
      recomputePrice: jest.fn(),
    };
    modelFactory = {
      createShell: jest.fn().mockResolvedValue({ displayName: 'Cube' }),
    };

    service = new ProductSplitService(
      productRepo as unknown as ProductModelRepository,
      sourceRecordRepo as unknown as ProductSourceRecordRepository,
      mergeService as unknown as ProductMergeService,
      modelFactory as unknown as ProductModelFactoryService,
      { createProductEmbedding: jest.fn() } as unknown as ProductEmbeddingService,
    );
  });

  it('rejects an empty set of listings', async () => {
    await expect(
      service.splitIntoNewProduct({ sourceRecordIds: [], reason: 'test' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reports listings that no longer exist rather than silently splitting fewer', async () => {
    sourceRecordRepo.find.mockResolvedValue([makeRecord({ id: 'record-1' })]);

    await expect(
      service.splitIntoNewProduct({
        sourceRecordIds: ['record-1', 'record-gone'],
        reason: 'test',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // A split produces exactly one new product, so the caller must not hand it
  // listings that currently live on different products.
  it('refuses listings that span more than one product', async () => {
    sourceRecordRepo.find.mockResolvedValue([
      makeRecord({ id: 'record-1', model: { id: 'product-1' } as any }),
      makeRecord({ id: 'record-2', model: { id: 'product-2' } as any }),
    ]);

    await expect(
      service.splitIntoNewProduct({
        sourceRecordIds: ['record-1', 'record-2'],
        reason: 'test',
      }),
    ).rejects.toThrow(/one product/);
  });

  it('builds the new product from the newest listing snapshot', async () => {
    sourceRecordRepo.find.mockResolvedValue([
      makeRecord({
        id: 'record-1',
        lastUpdated: new Date('2024-01-01'),
        scrapedProduct: {
          brand: 'Cube',
          model: 'Old Name',
          displayName: 'Old Name',
          category: { id: 'category-1', name: 'E-bikes', slug: 'e-bikes' },
        } as any,
      }),
      makeRecord({
        id: 'record-2',
        lastUpdated: new Date('2024-09-01'),
        scrapedProduct: {
          brand: 'Cube',
          model: 'New Name',
          displayName: 'New Name',
          category: { id: 'category-1', name: 'E-bikes', slug: 'e-bikes' },
        } as any,
      }),
    ]);

    await service.splitIntoNewProduct({
      sourceRecordIds: ['record-1', 'record-2'],
      reason: 'test',
    });

    expect(modelFactory.createShell).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'New Name', displayName: 'New Name' }),
    );
  });

  it('moves the listings, their offers, tasks and price history onto the new product', async () => {
    await service.splitIntoNewProduct({
      sourceRecordIds: ['record-1'],
      reason: 'test',
    });

    // source records + offers + scrape tasks + price history
    expect(manager.createQueryBuilder).toHaveBeenCalledTimes(4);
    expect(queryBuilder.set).toHaveBeenCalledWith(
      expect.objectContaining({ model: { id: 'product-new' } }),
    );
  });

  it('scopes the offer move to the given listings, not the whole product', async () => {
    await service.splitIntoNewProduct({
      sourceRecordIds: ['record-1'],
      reason: 'test',
    });

    expect(queryBuilder.where).toHaveBeenCalledWith(
      expect.stringContaining('sourceRecordId'),
      { sourceRecordIds: ['record-1'] },
    );
  });

  // Both sides changed shape, so both need their specs/price recomputed from
  // whatever sources they have left.
  it('recomputes the new product and the one it was carved out of', async () => {
    productRepo.findOne.mockResolvedValue({
      id: 'whatever',
      sources: [makeRecord()],
    });

    await service.splitIntoNewProduct({
      sourceRecordIds: ['record-1'],
      reason: 'test',
    });

    expect(mergeService.mergeSources).toHaveBeenCalledTimes(2);
    expect(mergeService.recomputePrice).toHaveBeenCalledTimes(2);
  });

  it('does not fail the split when the post-split recompute throws', async () => {
    productRepo.findOne.mockRejectedValue(new Error('db down'));

    await expect(
      service.splitIntoNewProduct({
        sourceRecordIds: ['record-1'],
        reason: 'test',
      }),
    ).resolves.toEqual({ id: 'product-new' });
  });
});
