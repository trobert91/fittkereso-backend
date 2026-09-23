import { contextFromTask } from '../../interfaces/product-import-context.interface';
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
import type {
  ListingMatchService,
  ProductDuplicateService,
} from '@fittkereso-backend/product-identity';
import type { CategoryConfigService } from '@fittkereso-backend/config';
import type {
  OfferMatchingService,
  ProductImageCopyService,
  ProductMergeService,
  ProductModelFactoryService,
  ProductNormalizerService,
  ProductSourceRecordUpdaterService,
  ScrapedProduct,
} from '@fittkereso-backend/product';

jest.mock('@fittkereso-backend/product-identity', () => ({}));

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

/** What ListingMatchService returns when nothing was close enough to attach. */
function createdDecision() {
  return {
    decision: { outcome: 'created', nameKey: 'mx keys', candidates: [] },
  };
}

describe('ProductScrapeUpdaterService', () => {
  let service: ProductScrapeUpdaterService;
  let mockListingMatch: jest.Mocked<ListingMatchService>;
  let mockDuplicateService: jest.Mocked<ProductDuplicateService>;
  let mockModelFactory: jest.Mocked<ProductModelFactoryService>;
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

  beforeEach(() => {
    const aliasInsertBuilder = makeAliasInsertBuilder();

    // The common case for every test that isn't about matching: nothing close
    // enough, so a new product. The six offer tests all fall through to this.
    mockListingMatch = {
      match: jest.fn().mockResolvedValue(createdDecision()),
    } as unknown as jest.Mocked<ListingMatchService>;

    mockDuplicateService = {
      detect: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<ProductDuplicateService>;

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
      findBySourceAndExternalId: jest.fn().mockResolvedValue(null),
      findBySourceAndUrl: jest.fn().mockResolvedValue(null),
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
      offerIdentityConflict: jest.fn(),
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

    mockModelFactory = {
      // Mirrors the real factory: an unsaved shell with no id, which is what
      // marks the model as newly created downstream.
      createShell: jest.fn().mockImplementation(async () => {
        const model = new ProductModel();
        model.brand = makeBrand();
        model.enabled = true;
        return model;
      }),
    } as unknown as jest.Mocked<ProductModelFactoryService>;

    service = new ProductScrapeUpdaterService(
      mockListingMatch,
      mockDuplicateService,
      mockModelFactory,
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

    await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

    expect(existingModel.productCategory).toBe(originalCategory);
    expect(existingModel.productCategory?.slug).toBe('keyboards');
  });

  // Regression: a source's own catalog legitimately accumulates several
  // ProductSourceRecords on one ProductModel (one per variant URL — see
  // §2.1a's offerLinks dispatch), so a same-source match is not inherently a
  // false positive. Rejecting it (the old hasSourceRow gate) forced a new
  // ProductModel per variant for sources with no group-level externalId
  // configured, which raced two variant scrapes into a ProductModel.slug
  // uniqueness violation in production.
  it('attaches to the product listing matching picked by score', async () => {
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct({
      displayName: 'LG 39GS95QE-W',
      model: '39GS95QE-W',
      brand: 'LG',
    });
    const otherVariant = makeExistingModel();
    otherVariant.id = 'model-variant-b';
    otherVariant.sources = [{ source: { id: 'source-arukereso' } } as never];

    mockListingMatch.match.mockResolvedValueOnce({
      productId: otherVariant.id,
      decision: {
        outcome: 'identified',
        nameKey: '39gs95qe-w lg',
        candidates: [
          {
            productId: otherVariant.id,
            displayName: 'LG 39GS95QE-W',
            score: 100,
            matchedOn: 'name',
            failedGates: [],
          },
        ],
      },
    } as never);
    mockProductRepo.findOneOrFail.mockResolvedValueOnce(otherVariant);
    mockProductRepo.save.mockResolvedValue(otherVariant);

    const result = await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

    expect(result?.id).toBe('model-variant-b');
    expect(mockListingMatch.match).toHaveBeenCalledWith(scrapedProduct, {
      taskId: task.id,
    });
    expect(mockMetricsService.scrapeResolutionOutcome).toHaveBeenCalledWith(
      'arukereso',
      'identified',
    );
    expect(mockMetricsService.productMatched).toHaveBeenCalledWith('arukereso');
    expect(mockMetricsService.scrapeResolutionOutcome).not.toHaveBeenCalledWith(
      'arukereso',
      'created',
    );
    expect(task.identityDecision).toEqual(
      expect.objectContaining({ outcome: 'identified' }),
    );
  });

  it('attaches on the LLM’s pick and labels it separately', async () => {
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct();
    const chosen = makeExistingModel();

    mockListingMatch.match.mockResolvedValueOnce({
      productId: chosen.id,
      decision: {
        outcome: 'llm_identified',
        nameKey: 'mx keys',
        candidates: [],
        llm: { productId: chosen.id, confidence: 92, reason: 'same board' },
      },
    } as never);
    mockProductRepo.findOneOrFail.mockResolvedValueOnce(chosen);
    mockProductRepo.save.mockResolvedValue(chosen);

    const result = await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

    expect(result?.id).toBe('model-1');
    expect(mockMetricsService.scrapeResolutionOutcome).toHaveBeenCalledWith(
      'arukereso',
      'llm_identified',
    );
    expect(mockMetricsService.productMatched).toHaveBeenCalledWith('arukereso');
  });

  it('creates a product when the LLM was asked and declined', async () => {
    // Two labels, and both matter: `llm_declined` says a call was spent and
    // came back undecided, `created` says what happened to the listing.
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct();

    mockListingMatch.match.mockResolvedValueOnce({
      decision: {
        outcome: 'created',
        nameKey: 'mx keys',
        candidates: [],
        llm: { confidence: 40, reason: 'different layout' },
      },
    } as never);
    mockProductRepo.findOne.mockResolvedValue(null);
    mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
      if (!model.id) model.id = 'model-llm-declined';
      return model;
    });

    await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

    expect(mockMetricsService.scrapeResolutionOutcome).toHaveBeenCalledWith(
      'arukereso',
      'llm_declined',
    );
    expect(mockMetricsService.scrapeResolutionOutcome).toHaveBeenCalledWith(
      'arukereso',
      'created',
    );
    expect(mockMetricsService.productMatched).not.toHaveBeenCalled();
  });

  it('creates a product without an LLM label when nothing was close enough', async () => {
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct();

    mockProductRepo.findOne.mockResolvedValue(null);
    mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
      if (!model.id) model.id = 'model-not-found';
      return model;
    });

    await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

    expect(mockMetricsService.scrapeResolutionOutcome).toHaveBeenCalledWith(
      'arukereso',
      'created',
    );
    expect(mockMetricsService.scrapeResolutionOutcome).not.toHaveBeenCalledWith(
      'arukereso',
      'llm_declined',
    );
  });

  it('creates a product when the brand did not resolve, with no name key to store', async () => {
    // Recall is scoped by brand, so an unresolved one has nothing to search.
    // The listing takes the create path it has always taken, and the stored
    // decision records that there was no key to match on.
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct({ brand: 'Unknown Co' });

    mockListingMatch.match.mockResolvedValueOnce({
      decision: { outcome: 'created', candidates: [] },
    } as never);
    mockProductRepo.findOne.mockResolvedValue(null);
    mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
      if (!model.id) model.id = 'model-no-brand';
      return model;
    });

    await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

    expect(task.identityDecision).toEqual({
      outcome: 'created',
      candidates: [],
    });
    expect(mockMetricsService.scrapeResolutionOutcome).toHaveBeenCalledWith(
      'arukereso',
      'created',
    );
  });

  describe('duplicate detection after the scrape', () => {
    it('runs for a listing whose identity Path 4 decided', async () => {
      const task = makeTask();
      const scrapedProduct = makeScrapedProduct();

      mockProductRepo.findOne.mockResolvedValue(null);
      mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
        if (!model.id) model.id = 'model-detect';
        return model;
      });

      await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

      expect(mockDuplicateService.detect).toHaveBeenCalledWith(
        'model-detect',
        'scrape',
      );
    });

    it('does not run when a stored id resolved the listing', async () => {
      // Path 1: the task is pinned to a product, so nothing was scored and
      // there is no new neighbourhood to look at.
      const task = makeTask();
      task.product = { id: 'existing-model-1' } as never;
      const existingModel = makeExistingModel();

      mockProductRepo.findOneOrFail.mockResolvedValueOnce(existingModel);
      mockProductRepo.save.mockResolvedValue(existingModel);

      await service.createOrUpdateProduct(contextFromTask(task), makeScrapedProduct());

      expect(mockListingMatch.match).not.toHaveBeenCalled();
      expect(mockDuplicateService.detect).not.toHaveBeenCalled();
    });

    it('does not fail the scrape when detection throws', async () => {
      // The product and its offers are already saved by this point; a missing
      // suggestion is worth far less than a lost scrape.
      const task = makeTask();
      const scrapedProduct = makeScrapedProduct();

      mockDuplicateService.detect.mockRejectedValueOnce(
        new Error('recall exploded'),
      );
      mockProductRepo.findOne.mockResolvedValue(null);
      mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
        if (!model.id) model.id = 'model-detect-fails';
        return model;
      });

      const result = await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

      expect(result?.id).toBe('model-detect-fails');
    });
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
    mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
      if (!model.id) model.id = 'model-new';
      return model;
    });

    await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

    expect(mockMergeService.mergeSources).toHaveBeenCalledWith(
      expect.anything(),
      scrapedProduct.category.slug,
    );
  });

  it('hands the whole scraped listing to matching, with the task for log context', async () => {
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

    await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

    expect(mockListingMatch.match).toHaveBeenCalledWith(scrapedProduct, {
      taskId: task.id,
    });
  });

  it('does not touch Seller/Offer plumbing when ScrapedProduct.offers is absent', async () => {
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct(); // no `offers` field

    mockProductRepo.findOne.mockResolvedValueOnce(null);
    mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
      if (!model.id) model.id = 'model-no-offers';
      return model;
    });

    await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

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

    await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

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

    await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

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

    const result = await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

    expect(result).toBeDefined();
    expect(mockOfferRepo.upsertFromScrape).toHaveBeenCalledTimes(2);
    expect(mockMergeService.recomputePrice).toHaveBeenCalledTimes(1);
  });

  describe('offer identity', () => {
    const upsertedExternalIds = () =>
      mockOfferRepo.upsertFromScrape.mock.calls.map(
        (call) => (call[0] as { externalId?: string }).externalId,
      );

    const runWithOffers = async (offers: unknown[]) => {
      const task = makeTask();
      mockProductRepo.findOne.mockResolvedValueOnce(null);
      mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
        if (!model.id) model.id = 'model-offer-identity';
        return model;
      });
      mockOfferRepo.upsertFromScrape.mockResolvedValue({} as never);

      await service.createOrUpdateProduct(
        contextFromTask(task),
        makeScrapedProduct({ offers: offers as never }),
      );
    };

    // The fallback is what makes a scraping source and an Árukereső source for
    // one shop land on the same identity — it is derived here, in shared code,
    // rather than per config, precisely so the two cannot drift apart.
    it('falls back to the URL slug when a source emits no externalId', async () => {
      await runWithOffers([
        { price: 1000, url: 'https://alza.hu/kerekpar/ktm-macina' },
      ]);

      expect(upsertedExternalIds()).toEqual(['kerekpar/ktm-macina']);
    });

    it('prefers a source-native externalId over the slug', async () => {
      await runWithOffers([
        { price: 1000, url: 'https://alza.hu/kerekpar/ktm-macina', externalId: 'sku-1' },
      ]);

      expect(upsertedExternalIds()).toEqual(['sku-1']);
    });

    // The failure this guard exists for, and it is completely silent without
    // it: Offer is @Unique([seller, externalId]), so three variants sharing one
    // URL would each conflict onto the same row and the page would end up with
    // ONE offer instead of three — no error, no log, just missing variants.
    it('drops a slug fallback shared by several offers rather than collapsing them', async () => {
      await runWithOffers([
        { price: 1000, url: 'https://alza.hu/ktm-macina' },
        { price: 2000, url: 'https://alza.hu/ktm-macina' },
        { price: 3000, url: 'https://alza.hu/ktm-macina' },
      ]);

      expect(upsertedExternalIds()).toEqual([undefined, undefined, undefined]);
      expect(mockOfferRepo.upsertFromScrape).toHaveBeenCalledTimes(3);
    });

    it('drops a source-native externalId shared by several offers too', async () => {
      await runWithOffers([
        { price: 1000, url: 'https://alza.hu/a', externalId: 'group-sku' },
        { price: 2000, url: 'https://alza.hu/b', externalId: 'group-sku' },
      ]);

      expect(upsertedExternalIds()).toEqual([undefined, undefined]);
    });

    // A collision must not punish the offers that are fine.
    it('keeps the unique ids on a page where only some collide', async () => {
      await runWithOffers([
        { price: 1000, url: 'https://alza.hu/a', externalId: 'shared' },
        { price: 2000, url: 'https://alza.hu/b', externalId: 'shared' },
        { price: 3000, url: 'https://alza.hu/c', externalId: 'its-own' },
      ]);

      expect(upsertedExternalIds()).toEqual([undefined, undefined, 'its-own']);
    });

    it('counts a collision once per colliding value, by kind', async () => {
      await runWithOffers([
        { price: 1000, url: 'https://alza.hu/a', externalId: 'group-sku' },
        { price: 2000, url: 'https://alza.hu/b', externalId: 'group-sku' },
      ]);

      expect(mockMetricsService.offerIdentityConflict).toHaveBeenCalledTimes(1);
      expect(mockMetricsService.offerIdentityConflict).toHaveBeenCalledWith(
        expect.any(String),
        'duplicate_external_id',
      );
    });

    it('distinguishes a slug collision from a native-id collision', async () => {
      await runWithOffers([
        { price: 1000, url: 'https://alza.hu/ktm-macina' },
        { price: 2000, url: 'https://alza.hu/ktm-macina' },
      ]);

      expect(mockMetricsService.offerIdentityConflict).toHaveBeenCalledWith(
        expect.any(String),
        'duplicate_slug_fallback',
      );
    });
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

    await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

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

    await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

    expect(mockOfferRepo.deleteByIds).toHaveBeenCalledWith([
      'offer-53cm-stale',
    ]);
  });
});
