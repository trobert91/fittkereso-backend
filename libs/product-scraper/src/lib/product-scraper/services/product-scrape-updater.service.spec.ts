import {
  Brand,
  OfferRepository,
  ProductAliasRepository,
  ProductCategory,
  ProductModel,
  ProductModelRepository,
  ProductModelSourceRepository,
  ScrapeTask,
  ScrapeTaskRepository,
} from '@fittkereso-backend/database';
import type { ProductMetricsService } from '@fittkereso-backend/metrics';
import type { ResolutionService } from '@fittkereso-backend/resolution';
import type {
  BrandResolutionService,
  ProductEmbeddingService,
  ProductImageCopyService,
  ProductNormalizerService,
  ProductSpecUpdaterService,
  ScrapedProduct,
  SellerResolutionService,
} from '@fittkereso-backend/product';

jest.mock('@fittkereso-backend/resolution', () => ({
  productSpecsToStructuredSpecs: jest.fn((specs) => specs),
}));

jest.mock('@fittkereso-backend/product', () => ({}));

import { ProductScrapeUpdaterService } from './product-scrape-updater.service';

function makeBrand(name = 'Logitech'): Brand {
  const brand = new Brand();
  brand.id = 'brand-1';
  brand.name = name;
  return brand;
}

function makeCategory(overrides?: Partial<ProductCategory>): ProductCategory {
  const category = new ProductCategory();
  category.id = 'category-1';
  category.name = 'Keyboards';
  category.slug = 'keyboards';
  Object.assign(category, overrides);
  return category;
}

function makeExistingModel(): ProductModel {
  const model = new ProductModel();
  model.id = 'model-1';
  model.brand = makeBrand();
  model.productCategory = makeCategory();
  model.displayName = 'Logitech MX Keys';
  model.model = 'MX Keys';
  model.normalizedName = 'mx keys';
  model.slug = 'logitech-mx-keys';
  model.images = [];
  model.sources = [];
  return model;
}

function makeTask(): ScrapeTask {
  return {
    id: 'task-1',
    url: 'https://example.com/product',
    source: {
      id: 'source-arukereso',
      name: 'arukereso',
    },
  } as ScrapeTask;
}

function makeScrapedProduct(
  overrides?: Partial<ScrapedProduct>,
): ScrapedProduct {
  return {
    brand: 'Logitech',
    displayName: 'Logitech MX Keys',
    model: 'MX Keys',
    category: makeCategory(),
    specs: { layout: 'UK' },
    imageUrls: [],
    ...overrides,
  } as ScrapedProduct;
}

function makeAliasInsertBuilder() {
  return {
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({
      generatedMaps: [],
      identifiers: [],
      raw: [],
    }),
  };
}

describe('ProductScrapeUpdaterService', () => {
  let service: ProductScrapeUpdaterService;
  let mockProductSearch: jest.Mocked<ResolutionService>;
  let mockBrandResolution: jest.Mocked<BrandResolutionService>;
  let mockEmbeddingService: jest.Mocked<ProductEmbeddingService>;
  let mockProductRepo: jest.Mocked<ProductModelRepository>;
  let mockTaskRepo: jest.Mocked<ScrapeTaskRepository>;
  let mockAliasRepo: jest.Mocked<ProductAliasRepository>;
  let mockProductModelSourceRepo: jest.Mocked<ProductModelSourceRepository>;
  let mockSpecUpdaterService: jest.Mocked<ProductSpecUpdaterService>;
  let mockImageCopyService: jest.Mocked<ProductImageCopyService>;
  let mockMetricsService: jest.Mocked<ProductMetricsService>;
  let mockProductNormalizer: jest.Mocked<ProductNormalizerService>;
  let mockSellerResolution: jest.Mocked<SellerResolutionService>;
  let mockOfferRepo: jest.Mocked<OfferRepository>;

  beforeEach(() => {
    const aliasInsertBuilder = makeAliasInsertBuilder();

    mockProductSearch = {
      search: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<ResolutionService>;

    mockBrandResolution = {
      resolve: jest.fn().mockResolvedValue({ entity: makeBrand() }),
    } as unknown as jest.Mocked<BrandResolutionService>;

    mockEmbeddingService = {
      createProductEmbedding: jest.fn().mockResolvedValue([0.1, 0.2]),
    } as unknown as jest.Mocked<ProductEmbeddingService>;

    mockProductRepo = {
      findOne: jest.fn(),
      findOneOrFail: jest.fn(),
      save: jest.fn(),
    } as unknown as jest.Mocked<ProductModelRepository>;

    mockTaskRepo = {
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ScrapeTaskRepository>;

    mockAliasRepo = {
      repo: {
        createQueryBuilder: jest.fn().mockReturnValue(aliasInsertBuilder),
      },
    } as unknown as jest.Mocked<ProductAliasRepository>;

    mockProductModelSourceRepo = {
      findAllByNormalizedName: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<ProductModelSourceRepository>;

    mockSpecUpdaterService = {
      updateSpecsOnProduct: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ProductSpecUpdaterService>;

    mockImageCopyService = {
      copyImagesFromSource: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<ProductImageCopyService>;

    mockMetricsService = {
      productMatched: jest.fn(),
      productUpdated: jest.fn(),
      newProductCreated: jest.fn(),
      productAliasCreated: jest.fn(),
      productImagesCreated: jest.fn(),
      productBrandResolutionFailed: jest.fn(),
      scrapeResolutionOutcome: jest.fn(),
    } as unknown as jest.Mocked<ProductMetricsService>;

    mockProductNormalizer = {
      normalizeProduct: jest.fn().mockReturnValue('mx keys'),
    } as unknown as jest.Mocked<ProductNormalizerService>;

    mockSellerResolution = {
      resolveOrCreate: jest.fn(),
    } as unknown as jest.Mocked<SellerResolutionService>;

    mockOfferRepo = {
      upsertFromScrape: jest.fn(),
    } as unknown as jest.Mocked<OfferRepository>;

    service = new ProductScrapeUpdaterService(
      mockProductSearch,
      mockBrandResolution,
      mockEmbeddingService,
      mockProductRepo,
      mockTaskRepo,
      mockAliasRepo,
      mockProductModelSourceRepo,
      mockSpecUpdaterService,
      mockImageCopyService,
      mockMetricsService,
      mockProductNormalizer,
      mockSellerResolution,
      mockOfferRepo,
    );
  });

  it('reuses an exact normalizedName match before creating a new product', async () => {
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct();
    const existingModel = makeExistingModel();

    mockProductModelSourceRepo.findAllByNormalizedName.mockResolvedValueOnce([
      {
        model: existingModel,
        source: { id: 'source-arukereso' },
        sourceName: scrapedProduct.displayName,
      } as never,
    ]);
    mockProductRepo.save.mockResolvedValue(existingModel);

    const result = await service.createOrUpdateProduct(task, scrapedProduct);

    expect(result).toBe(existingModel);
    expect(mockProductSearch.search).not.toHaveBeenCalled();
    expect(mockBrandResolution.resolve).not.toHaveBeenCalled();
    expect(mockMetricsService.scrapeResolutionOutcome).toHaveBeenCalledWith(
      'arukereso',
      'path1_hit',
    );
    expect(mockMetricsService.productUpdated).toHaveBeenCalledWith('arukereso');
    expect(mockMetricsService.newProductCreated).not.toHaveBeenCalled();
    expect(mockTaskRepo.save).toHaveBeenCalledWith(task);
    expect(task.product).toBe(existingModel);
  });

  it('takes a cross-source row when no same-source exact match exists', async () => {
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct();
    const existingModel = makeExistingModel();

    mockProductModelSourceRepo.findAllByNormalizedName.mockResolvedValueOnce([
      {
        model: existingModel,
        source: { id: 'source-displayspecs' },
        sourceName: 'Logitech MX Keys (different display name)',
      } as never,
    ]);
    mockProductRepo.save.mockResolvedValue(existingModel);

    const result = await service.createOrUpdateProduct(task, scrapedProduct);

    expect(result).toBe(existingModel);
    expect(mockProductSearch.search).not.toHaveBeenCalled();
    expect(mockMetricsService.scrapeResolutionOutcome).toHaveBeenCalledWith(
      'arukereso',
      'path1_hit',
    );
  });

  it('skips Path 1 when only same-source-different-name rows exist (variant siblings)', async () => {
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct({
      displayName: 'LG 39GS95QE-W',
      model: '39GS95QE-W',
      brand: 'LG',
    });
    const otherVariant = makeExistingModel();
    otherVariant.id = 'model-variant-b';
    otherVariant.sources = [{ source: { id: 'source-arukereso' } } as never];

    mockProductModelSourceRepo.findAllByNormalizedName.mockResolvedValueOnce([
      {
        model: otherVariant,
        source: { id: 'source-arukereso' },
        sourceName: 'LG UltraGear 39GS95QE-B',
      } as never,
    ]);
    mockProductSearch.search.mockResolvedValueOnce({
      resolvedModel: { id: otherVariant.id } as never,
      context: undefined,
    } as never);
    mockProductRepo.findOneOrFail.mockResolvedValueOnce(otherVariant);
    mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
      if (!model.id) model.id = 'model-variant-w';
      return model;
    });

    const result = await service.createOrUpdateProduct(task, scrapedProduct);

    expect(result?.id).toBe('model-variant-w');
    expect(mockProductSearch.search).toHaveBeenCalled();
    expect(mockMetricsService.scrapeResolutionOutcome).toHaveBeenCalledWith(
      'arukereso',
      'cross_source_rejected_same_source',
    );
    expect(mockMetricsService.scrapeResolutionOutcome).toHaveBeenCalledWith(
      'arukereso',
      'new_product',
    );
  });

  it('recovers from a normalizedName insert race by loading the existing product', async () => {
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct();
    const existingModel = makeExistingModel();

    mockProductRepo.findOne.mockResolvedValue(existingModel);
    mockProductRepo.save
      .mockRejectedValueOnce(
        new Error(
          'duplicate key value violates unique constraint "UQ_product_brand_normalized_name"',
        ),
      )
      .mockResolvedValue(existingModel);

    const result = await service.createOrUpdateProduct(task, scrapedProduct);

    expect(result).toBe(existingModel);
    expect(mockBrandResolution.resolve).toHaveBeenCalledTimes(1);
    expect(mockSpecUpdaterService.updateSpecsOnProduct).toHaveBeenCalledTimes(
      2,
    );
    expect(mockMetricsService.newProductCreated).not.toHaveBeenCalled();
    expect(mockMetricsService.productUpdated).toHaveBeenCalledWith('arukereso');
    expect(mockTaskRepo.save).toHaveBeenCalledWith(task);
    expect(task.product).toBe(existingModel);
  });

  it('uses strict matching for scrape-time resolution', async () => {
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct({
      brand: 'MSI',
      displayName: 'MSI MPG 341CQPX',
      model: 'MPG 341CQPX',
      category: makeCategory({
        id: 'category-monitors',
        name: 'Monitors',
        slug: 'monitors',
      }),
    });

    mockProductRepo.findOne.mockResolvedValueOnce(null);
    mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
      if (!model.id) {
        model.id = 'model-2';
      }
      return model;
    });

    await service.createOrUpdateProduct(task, scrapedProduct);

    expect(mockProductSearch.search).toHaveBeenCalledWith(
      expect.objectContaining({
        brand: scrapedProduct.brand,
        model: scrapedProduct.model,
        displayName: scrapedProduct.displayName,
      }),
      expect.objectContaining({ mode: 'strict' }),
      undefined,
      { taskId: task.id },
    );
  });

  it('uses strict matching for non-monitor scrapes too', async () => {
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct();

    mockProductRepo.findOne.mockResolvedValueOnce(null);
    mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
      if (!model.id) {
        model.id = 'model-3';
      }
      return model;
    });

    await service.createOrUpdateProduct(task, scrapedProduct);

    expect(mockProductSearch.search).toHaveBeenCalledWith(
      expect.objectContaining({
        brand: scrapedProduct.brand,
        model: scrapedProduct.model,
        displayName: scrapedProduct.displayName,
      }),
      expect.objectContaining({ mode: 'strict' }),
      undefined,
      { taskId: task.id },
    );
  });

  it('does not touch Seller/Offer plumbing when ScrapedProduct.offers is absent', async () => {
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct(); // no `offers` field

    mockProductRepo.findOne.mockResolvedValueOnce(null);
    mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
      if (!model.id) model.id = 'model-no-offers';
      return model;
    });

    await service.createOrUpdateProduct(task, scrapedProduct);

    expect(mockSellerResolution.resolveOrCreate).not.toHaveBeenCalled();
    expect(mockOfferRepo.upsertFromScrape).not.toHaveBeenCalled();
  });

  it('does not touch Seller/Offer plumbing when ScrapedProduct.offers is an empty array', async () => {
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct({ offers: [] });

    mockProductRepo.findOne.mockResolvedValueOnce(null);
    mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
      if (!model.id) model.id = 'model-empty-offers';
      return model;
    });

    await service.createOrUpdateProduct(task, scrapedProduct);

    expect(mockSellerResolution.resolveOrCreate).not.toHaveBeenCalled();
    expect(mockOfferRepo.upsertFromScrape).not.toHaveBeenCalled();
  });

  it('resolves a seller and upserts an offer per entry when ScrapedProduct.offers is populated', async () => {
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct({
      offers: [
        {
          sellerName: 'Alza.hu',
          price: 199990,
          currency: 'HUF',
          url: 'https://alza.hu/product/1',
          sourceListingId: 'listing-1',
        },
      ],
    });

    mockProductRepo.findOne.mockResolvedValueOnce(null);
    mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
      if (!model.id) model.id = 'model-with-offers';
      return model;
    });
    const mockSeller = { id: 'seller-1', name: 'Alza.hu' };
    mockSellerResolution.resolveOrCreate.mockResolvedValueOnce(
      mockSeller as never,
    );
    mockOfferRepo.upsertFromScrape.mockResolvedValueOnce({} as never);

    await service.createOrUpdateProduct(task, scrapedProduct);

    expect(mockSellerResolution.resolveOrCreate).toHaveBeenCalledWith(
      'Alza.hu',
    );
    expect(mockOfferRepo.upsertFromScrape).toHaveBeenCalledWith(
      expect.objectContaining({
        seller: mockSeller,
        source: task.source,
        price: 199990,
        currency: 'HUF',
        url: 'https://alza.hu/product/1',
        sourceListingId: 'listing-1',
      }),
    );
  });

  it('continues processing remaining offers and does not fail the scrape if one offer upsert throws', async () => {
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct({
      offers: [
        { sellerName: 'BadSeller', price: 1000 },
        { sellerName: 'GoodSeller', price: 2000 },
      ],
    });

    mockProductRepo.findOne.mockResolvedValueOnce(null);
    mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
      if (!model.id) model.id = 'model-partial-offer-failure';
      return model;
    });
    mockSellerResolution.resolveOrCreate
      .mockRejectedValueOnce(new Error('seller resolution failed'))
      .mockResolvedValueOnce({ id: 'seller-2', name: 'GoodSeller' } as never);
    mockOfferRepo.upsertFromScrape.mockResolvedValueOnce({} as never);

    const result = await service.createOrUpdateProduct(task, scrapedProduct);

    expect(result).toBeDefined();
    expect(mockSellerResolution.resolveOrCreate).toHaveBeenCalledTimes(2);
    expect(mockOfferRepo.upsertFromScrape).toHaveBeenCalledTimes(1);
  });
});
