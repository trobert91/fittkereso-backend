import { BadRequestException } from '@nestjs/common';
import {
  ProductSource,
  ProductSourceRepository,
  Seller,
  SellerRepository,
} from '@fittkereso-backend/database';
import { ProductSourceSellerRulesService } from '../product-source/product-source-seller-rules.service';
import { SellerProductSourceCreateService } from './seller-product-source-create.service';

const SELLER = { id: 'seller-1', name: 'speedbike.hu' } as Seller;

const existing = (name: string, priority: number, identifiesProducts = true): ProductSource =>
  ({ id: name, name, priority, identifiesProducts }) as ProductSource;

describe('SellerProductSourceCreateService', () => {
  let sourceRepo: jest.Mocked<Pick<ProductSourceRepository, 'find' | 'findOne' | 'save'>>;
  let sellerSources: ProductSource[];
  let service: SellerProductSourceCreateService;

  beforeEach(() => {
    sellerSources = [];
    sourceRepo = {
      find: jest.fn().mockImplementation(async () => sellerSources),
      // Two lookups go through findOne: the name check (no seller in `where`)
      // and the priority check.
      findOne: jest.fn(async (options) => {
        const where = options.where as { seller?: unknown; priority?: number };
        if (!where.seller) return null;
        return sellerSources.find((source) => source.priority === where.priority) ?? null;
      }),
      save: jest.fn(async (source) => source as ProductSource),
    };
    const sellerRepo = { findOneOrFail: jest.fn(async () => SELLER) };
    const repo = sourceRepo as unknown as ProductSourceRepository;
    service = new SellerProductSourceCreateService(
      sellerRepo as unknown as SellerRepository,
      repo,
      new ProductSourceSellerRulesService(repo),
    );
  });

  it('gives a seller\'s first source priority 10, identifying and not complete', async () => {
    const created = await service.createForSeller(SELLER.id, { name: 'first', type: 'arukereso' });

    expect(created).toMatchObject({
      priority: 10,
      identifiesProducts: true,
      hasAllProducts: false,
      schedulingEnabled: false,
      processingEnabled: false,
    });
  });

  it('puts a later source below the seller\'s lowest priority', async () => {
    sellerSources = [existing('speedbike-arukereso', 60)];

    const created = await service.createForSeller(SELLER.id, {
      name: 'speedbike-googleshop',
      type: 'arukereso',
      identifiesProducts: false,
    });

    expect(created.priority).toBe(50);
    expect(created.identifiesProducts).toBe(false);
  });

  it('uses an explicit priority as given', async () => {
    sellerSources = [existing('speedbike-arukereso', 60)];

    const created = await service.createForSeller(SELLER.id, {
      name: 'speedbike-googleshop',
      type: 'arukereso',
      priority: 40,
      identifiesProducts: false,
    });

    expect(created.priority).toBe(40);
  });

  it('refuses a priority another source of the seller holds', async () => {
    sellerSources = [existing('speedbike-arukereso', 60)];

    await expect(
      service.createForSeller(SELLER.id, { name: 'dup', type: 'arukereso', priority: 60 }),
    ).rejects.toThrow(BadRequestException);
    expect(sourceRepo.save).not.toHaveBeenCalled();
  });

  it('refuses a seller\'s first source that does not identify products', async () => {
    await expect(
      service.createForSeller(SELLER.id, { name: 'first', type: 'arukereso', identifiesProducts: false }),
    ).rejects.toThrow(/at least one source that identifies products/);
    expect(sourceRepo.save).not.toHaveBeenCalled();
  });

  it('refuses hasAllProducts on a scraping source', async () => {
    await expect(
      service.createForSeller(SELLER.id, { name: 'crawl', type: 'scraping', hasAllProducts: true }),
    ).rejects.toThrow(BadRequestException);
    expect(sourceRepo.save).not.toHaveBeenCalled();
  });
});
