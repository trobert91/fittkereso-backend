import { BadRequestException } from '@nestjs/common';
import {
  ProductSource,
  ProductSourceRepository,
  Seller,
  SellerRepository,
} from '@fittkereso-backend/database';
import { ProductSourceSellerRulesService } from './product-source-seller-rules.service';
import { ProductSourceUpdateService } from './product-source-update.service';
import { ProductSourceVersionService } from './product-source-version.service';

const SELLER = { id: 'seller-1', name: 'speedbike.hu' } as Seller;

const makeSource = (overrides: Partial<ProductSource>): ProductSource =>
  ({
    type: 'arukereso',
    seller: SELLER,
    schedulingEnabled: false,
    processingEnabled: true,
    identifiesProducts: true,
    hasAllProducts: false,
    ...overrides,
  }) as ProductSource;

describe('ProductSourceUpdateService', () => {
  let sellerSources: ProductSource[];
  let sourceRepo: jest.Mocked<Pick<ProductSourceRepository, 'find' | 'findOne' | 'save'>>;
  let versionService: jest.Mocked<
    Pick<ProductSourceVersionService, 'addVersionIfChanged' | 'recordAction' | 'getDetail'>
  >;
  let service: ProductSourceUpdateService;

  const arukereso = () => sellerSources[0];

  beforeEach(() => {
    sellerSources = [
      makeSource({ id: 'arukereso', name: 'speedbike-arukereso', priority: 60 }),
      makeSource({ id: 'google', name: 'speedbike-googleshop', priority: 40, identifiesProducts: false }),
    ];
    sourceRepo = {
      find: jest.fn().mockImplementation(async () => sellerSources.map((source) => ({ ...source }))),
      findOne: jest.fn(async (options) => {
        const where = options.where as { id?: string; priority?: number };
        const found = where.id
          ? sellerSources.find((source) => source.id === where.id)
          : sellerSources.find((source) => source.priority === where.priority);
        return found ? { ...found } : null;
      }),
      save: jest.fn(async (source) => source as ProductSource),
    };
    versionService = {
      addVersionIfChanged: jest.fn(),
      recordAction: jest.fn(),
      getDetail: jest.fn(async (id: string) => ({ id }) as ProductSource),
    };
    const repo = sourceRepo as unknown as ProductSourceRepository;
    service = new ProductSourceUpdateService(
      repo,
      {} as SellerRepository,
      versionService as unknown as ProductSourceVersionService,
      new ProductSourceSellerRulesService(repo),
    );
  });

  it('refuses to turn off the seller\'s last identifying source', async () => {
    await expect(
      service.updateProductSource(arukereso().id, { identifiesProducts: false }),
    ).rejects.toThrow(/at least one source that identifies products/);
    expect(sourceRepo.save).not.toHaveBeenCalled();
  });

  it('turns identification on for a contributing source and records it', async () => {
    await service.updateProductSource('google', { identifiesProducts: true });

    expect(sourceRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'google', identifiesProducts: true }),
    );
    expect(versionService.recordAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'google' }),
      'identifies_products_changed',
      { from: false, to: true },
      expect.anything(),
    );
  });

  it('refuses a priority another source of the seller holds', async () => {
    await expect(
      service.updateProductSource('google', { priority: 60 }),
    ).rejects.toThrow(/already used by "speedbike-arukereso"/);
    expect(sourceRepo.save).not.toHaveBeenCalled();
  });

  it('refuses hasAllProducts on a scraping source', async () => {
    sellerSources[0] = makeSource({ id: 'crawl', name: 'crawl', type: 'scraping', priority: 60 });

    await expect(
      service.updateProductSource('crawl', { hasAllProducts: true }),
    ).rejects.toThrow(BadRequestException);
  });

  it('sets hasAllProducts on a feed source and records it', async () => {
    await service.updateProductSource(arukereso().id, { hasAllProducts: true });

    expect(sourceRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ hasAllProducts: true }),
    );
    expect(versionService.recordAction).toHaveBeenCalledWith(
      expect.anything(),
      'has_all_products_changed',
      { from: false, to: true },
      expect.anything(),
    );
  });

  it('checks nothing it did not change', async () => {
    await service.updateProductSource(arukereso().id, { name: 'renamed' });

    expect(sourceRepo.find).not.toHaveBeenCalled();
    expect(sourceRepo.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'renamed' }));
  });

  describe('detailRefreshInterval', () => {
    it('stores an ms interval', async () => {
      await service.updateProductSource(arukereso().id, { detailRefreshInterval: '8w' });

      expect(sourceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ detailRefreshInterval: '8w' }),
      );
    });

    it.each([
      ['a string ms cannot read', '60 napig', /Invalid detailRefreshInterval format/],
      ['an empty string', ' ', /cannot be cleared/],
      ['null', null, /cannot be cleared/],
      ['a negative interval', '-1d', /must be a positive interval/],
      ['zero', '0', /must be a positive interval/],
    ])('refuses %s', async (_label, value, message) => {
      await expect(
        service.updateProductSource(arukereso().id, {
          detailRefreshInterval: value as string,
        }),
      ).rejects.toThrow(message);
      expect(sourceRepo.save).not.toHaveBeenCalled();
    });
  });
});
