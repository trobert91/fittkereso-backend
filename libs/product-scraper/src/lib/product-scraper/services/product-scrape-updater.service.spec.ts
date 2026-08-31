import {
  Brand,
  OfferRepository,
  ProductAliasRepository,
  ProductCategory,
  ProductModel,
  ProductModelRepository,
  ProductSourceRecordRepository,
  ScrapeTask,
  ScrapeTaskRepository,
} from '@fittkereso-backend/database';
import type { ProductMetricsService } from '@fittkereso-backend/metrics';
import type { ResolutionService } from '@fittkereso-backend/resolution';
import type { CategoryConfigService } from '@fittkereso-backend/config';
import type {
  BrandResolutionService,
  OfferMatchingService,
  ProductEmbeddingService,
  ProductImageCopyService,
  ProductMergeService,
  ProductNormalizerService,
  ProductResolutionRecorderService,
  ProductSourceRecordUpdaterService,
  ScrapedProduct,
  SpecComparisonService,
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
      seller: { id: 'seller-arukereso', name: 'arukereso' },
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
    images: [],
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
  let mockSourceRecordRepo: jest.Mocked<ProductSourceRecordRepository>;
  let mockSourceRecordUpdater: jest.Mocked<ProductSourceRecordUpdaterService>;
  let mockMergeService: jest.Mocked<ProductMergeService>;
  let mockImageCopyService: jest.Mocked<ProductImageCopyService>;
  let mockMetricsService: jest.Mocked<ProductMetricsService>;
  let mockProductNormalizer: jest.Mocked<ProductNormalizerService>;
  let mockOfferMatching: jest.Mocked<OfferMatchingService>;
  let mockOfferRepo: jest.Mocked<OfferRepository>;
  let mockCategoryConfigService: jest.Mocked<CategoryConfigService>;
  let mockResolutionRecorder: jest.Mocked<ProductResolutionRecorderService>;
  let mockSpecComparison: jest.Mocked<SpecComparisonService>;

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

    mockSourceRecordRepo = {
      findBySourceAndExternalIdWithModelRelations: jest
        .fn()
        .mockResolvedValue(null),
    } as unknown as jest.Mocked<ProductSourceRecordRepository>;

    mockSourceRecordUpdater = {
      upsertSourceRecord: jest
        .fn()
        .mockResolvedValue({ id: 'source-record-1' }),
    } as unknown as jest.Mocked<ProductSourceRecordUpdaterService>;

    mockMergeService = {
      mergeSources: jest.fn().mockResolvedValue(undefined),
      recomputePrice: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ProductMergeService>;

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

    mockOfferMatching = {
      findMatch: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<OfferMatchingService>;

    mockOfferRepo = {
      upsertFromScrape: jest.fn(),
      findAllByModelAndSource: jest.fn().mockResolvedValue([]),
      findFirstBySellerAndExternalIdsWithModelRelations: jest
        .fn()
        .mockResolvedValue(null),
      deleteByIds: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<OfferRepository>;

    mockCategoryConfigService = {
      getConfig: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<CategoryConfigService>;

    mockResolutionRecorder = {
      recordDuplicatePair: jest.fn().mockResolvedValue(undefined),
      recordResolution: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ProductResolutionRecorderService>;

    mockSpecComparison = {
      compareSpecs: jest.fn().mockReturnValue({
        comparableCount: 0,
        matchingCount: 0,
        primaryMismatches: 0,
        matcherSpecMismatches: 0,
        nonPrimaryMismatches: 0,
        details: [],
      }),
    } as unknown as jest.Mocked<SpecComparisonService>;

    service = new ProductScrapeUpdaterService(
      mockProductSearch,
      mockBrandResolution,
      mockEmbeddingService,
      mockProductRepo,
      mockTaskRepo,
      mockAliasRepo,
      mockSourceRecordRepo,
      mockSourceRecordUpdater,
      mockMergeService,
      mockImageCopyService,
      mockMetricsService,
      mockProductNormalizer,
      mockOfferMatching,
      mockOfferRepo,
      mockCategoryConfigService,
      mockResolutionRecorder,
      mockSpecComparison,
    );
  });

  it('preserves the existing model\'s fully-loaded productCategory (slug included) on a rescrape of the same category', async () => {
    // Regression: applyScrapedProductDetails used to unconditionally replace
    // model.productCategory with a bare { id } stub, dropping `slug` even
    // when the model already had the fully-loaded category entity. That
    // stub then reached ProductMergeService.mergeSources → sortSpecs, whose
    // `!category?.slug` guard short-circuits to an empty array — silently
    // emptying ProductModel.orderedSpecs (the "Specifications" admin tab)
    // after every single scrape.
    const task = makeTask();
    task.product = { id: 'existing-model-1' } as never; // Path 1: task pinned to a product
    const scrapedProduct = makeScrapedProduct();
    const existingModel = makeExistingModel();
    const originalCategory = existingModel.productCategory;

    mockProductRepo.findOneOrFail.mockResolvedValueOnce(existingModel);
    mockProductRepo.save.mockResolvedValue(existingModel);

    await service.createOrUpdateProduct(task, scrapedProduct);

    expect(existingModel.productCategory).toBe(originalCategory);
    expect(existingModel.productCategory?.slug).toBe('keyboards');
  });

  // Regression: a source's own catalog legitimately accumulates several
  // ProductSourceRecords on one ProductModel (one per variant URL — see
  // §2.1a's offerLinks dispatch), so a same-source match from the resolution
  // engine is not inherently a false positive. Rejecting it (the old
  // hasSourceRow gate) forced a new ProductModel per variant for sources with
  // no group-level externalId configured, which raced two variant scrapes
  // into a ProductModel.slug uniqueness violation in production.
  it('reuses a same-source match from the cross-source search (variant siblings)', async () => {
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct({
      displayName: 'LG 39GS95QE-W',
      model: '39GS95QE-W',
      brand: 'LG',
    });
    const otherVariant = makeExistingModel();
    otherVariant.id = 'model-variant-b';
    otherVariant.sources = [{ source: { id: 'source-arukereso' } } as never];

    mockProductSearch.search.mockResolvedValueOnce({
      resolvedModel: { id: otherVariant.id } as never,
      context: undefined,
    } as never);
    mockProductRepo.findOneOrFail.mockResolvedValueOnce(otherVariant);
    mockProductRepo.save.mockResolvedValue(otherVariant);

    const result = await service.createOrUpdateProduct(task, scrapedProduct);

    expect(result?.id).toBe('model-variant-b');
    expect(mockProductSearch.search).toHaveBeenCalled();
    expect(mockMetricsService.scrapeResolutionOutcome).toHaveBeenCalledWith(
      'arukereso',
      'cross_source_merge',
    );
    expect(mockMetricsService.scrapeResolutionOutcome).not.toHaveBeenCalledWith(
      'arukereso',
      'new_product',
    );
  });

  it('passes ScrapedProduct.category.slug explicitly to mergeSources for a brand-new product', async () => {
    // Regression: a brand-new ProductModel's productCategory is set to a
    // bare { id } stub (newProductModel has no fully-loaded category to
    // preserve), so mergeSources can't derive categorySlug from
    // model.productCategory?.slug the way it does for an existing model —
    // it must be passed explicitly, or orderedSpecs silently comes back [].
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct();

    mockProductRepo.findOne.mockResolvedValue(null);
    mockProductSearch.search.mockResolvedValueOnce({
      resolvedModel: undefined,
      context: undefined,
    } as never);
    mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
      if (!model.id) model.id = 'model-new';
      return model;
    });

    await service.createOrUpdateProduct(task, scrapedProduct);

    expect(mockMergeService.mergeSources).toHaveBeenCalledWith(
      expect.anything(),
      scrapedProduct.category.slug,
    );
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

    expect(mockOfferRepo.upsertFromScrape).not.toHaveBeenCalled();
    expect(mockMergeService.recomputePrice).not.toHaveBeenCalled();
  });

  it('does not touch Offer plumbing when ScrapedProduct.offers is an empty array', async () => {
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct({ offers: [] });

    mockProductRepo.findOne.mockResolvedValueOnce(null);
    mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
      if (!model.id) model.id = 'model-empty-offers';
      return model;
    });

    await service.createOrUpdateProduct(task, scrapedProduct);

    expect(mockOfferRepo.upsertFromScrape).not.toHaveBeenCalled();
    expect(mockMergeService.recomputePrice).not.toHaveBeenCalled();
  });

  it('upserts an offer per entry using the task source\'s seller when ScrapedProduct.offers is populated, then recomputes model price', async () => {
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct({
      offers: [
        {
          price: 199990,
          priceWithoutDiscount: 249990,
          currency: 'HUF',
          url: 'https://alza.hu/product/1',
          externalId: 'listing-1',
        },
      ],
    });

    mockProductRepo.findOne.mockResolvedValueOnce(null);
    mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
      if (!model.id) model.id = 'model-with-offers';
      return model;
    });
    mockOfferRepo.upsertFromScrape.mockResolvedValueOnce({} as never);

    await service.createOrUpdateProduct(task, scrapedProduct);

    expect(mockOfferRepo.upsertFromScrape).toHaveBeenCalledWith(
      expect.objectContaining({
        seller: task.source.seller,
        sourceRecord: { id: 'source-record-1' },
        price: 199990,
        priceWithoutDiscount: 249990,
        currency: 'HUF',
        url: 'https://alza.hu/product/1',
        externalId: 'listing-1',
      }),
    );
    expect(mockMergeService.recomputePrice).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'model-with-offers' }),
    );
  });

  it('continues processing remaining offers and does not fail the scrape if one offer upsert throws', async () => {
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct({
      offers: [
        { price: 1000 },
        { price: 2000 },
      ],
    });

    mockProductRepo.findOne.mockResolvedValueOnce(null);
    mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
      if (!model.id) model.id = 'model-partial-offer-failure';
      return model;
    });
    mockOfferRepo.upsertFromScrape
      .mockRejectedValueOnce(new Error('offer upsert failed'))
      .mockResolvedValueOnce({} as never);

    const result = await service.createOrUpdateProduct(task, scrapedProduct);

    expect(result).toBeDefined();
    expect(mockOfferRepo.upsertFromScrape).toHaveBeenCalledTimes(2);
    expect(mockMergeService.recomputePrice).toHaveBeenCalledTimes(1);
  });

  // Regression: a scrape of one variant URL (e.g. ebikeshop's 53cm frame-size
  // page, no offerLinks configured) must never delete a sibling variant's
  // offer (e.g. the 48cm page's own offer) just because this pass didn't
  // happen to re-visit it. Only offers belonging to a ProductSourceRecord
  // this scrape actually touched are eligible to be judged stale.
  it('does not delete a sibling variant\'s offer when this scrape only touches one ProductSourceRecord', async () => {
    const seller = { id: 'seller-ebikeshop', name: 'ebikeshop.hu' };
    const task = {
      ...makeTask(),
      source: { ...makeTask().source, seller },
    } as ScrapeTask;
    const scrapedProduct = makeScrapedProduct({
      offers: [
        {
          price: 3359000,
          url: 'https://ebikeshop.hu/termek/53cm-variant',
          externalId: 'sku-53cm',
        },
      ],
    });
    const existingModel = makeExistingModel();
    const sourceRecord48cm = {
      id: 'source-record-48cm',
      url: 'https://ebikeshop.hu/termek/48cm-variant',
    };
    const sourceRecord53cm = {
      id: 'source-record-53cm',
      url: 'https://ebikeshop.hu/termek/53cm-variant',
    };
    existingModel.sources = [sourceRecord48cm, sourceRecord53cm] as never;

    mockProductRepo.findOne.mockResolvedValueOnce(null);
    mockProductRepo.save.mockResolvedValue(existingModel);
    mockSourceRecordUpdater.upsertSourceRecord.mockResolvedValueOnce(
      sourceRecord53cm as never,
    );

    const offer48cm = {
      id: 'offer-48cm',
      seller,
      sourceRecord: sourceRecord48cm,
      externalId: 'sku-48cm',
    };
    const offer53cmExisting = {
      id: 'offer-53cm',
      seller,
      sourceRecord: sourceRecord53cm,
      externalId: 'sku-53cm',
    };
    mockOfferRepo.findAllByModelAndSource.mockResolvedValueOnce([
      offer48cm,
      offer53cmExisting,
    ] as never);
    mockOfferMatching.findMatch.mockReturnValueOnce(offer53cmExisting as never);
    mockOfferRepo.upsertFromScrape.mockResolvedValueOnce(
      offer53cmExisting as never,
    );

    await service.createOrUpdateProduct(task, scrapedProduct);

    expect(mockOfferRepo.deleteByIds).not.toHaveBeenCalled();
  });

  it('deletes an unmatched offer belonging to the ProductSourceRecord this scrape did touch', async () => {
    const seller = { id: 'seller-ebikeshop', name: 'ebikeshop.hu' };
    const task = {
      ...makeTask(),
      source: { ...makeTask().source, seller },
    } as ScrapeTask;
    const scrapedProduct = makeScrapedProduct({
      offers: [
        {
          price: 3359000,
          url: 'https://ebikeshop.hu/termek/53cm-variant',
          externalId: 'sku-53cm-new',
        },
      ],
    });
    const existingModel = makeExistingModel();
    const sourceRecord53cm = {
      id: 'source-record-53cm',
      url: 'https://ebikeshop.hu/termek/53cm-variant',
    };
    existingModel.sources = [sourceRecord53cm] as never;

    mockProductRepo.findOne.mockResolvedValueOnce(null);
    mockProductRepo.save.mockResolvedValue(existingModel);
    mockSourceRecordUpdater.upsertSourceRecord.mockResolvedValueOnce(
      sourceRecord53cm as never,
    );

    const staleOfferSameRecord = {
      id: 'offer-53cm-stale',
      seller,
      sourceRecord: sourceRecord53cm,
      externalId: 'sku-53cm-old',
    };
    mockOfferRepo.findAllByModelAndSource.mockResolvedValueOnce([
      staleOfferSameRecord,
    ] as never);
    mockOfferMatching.findMatch.mockReturnValueOnce(undefined); // no match — a new offer is created
    mockOfferRepo.upsertFromScrape.mockResolvedValueOnce({
      id: 'offer-53cm-new',
    } as never);

    await service.createOrUpdateProduct(task, scrapedProduct);

    expect(mockOfferRepo.deleteByIds).toHaveBeenCalledWith([
      'offer-53cm-stale',
    ]);
  });
});
