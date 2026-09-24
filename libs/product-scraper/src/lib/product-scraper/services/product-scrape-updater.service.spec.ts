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
  ProductKeyLookupService,
} from '@fittkereso-backend/product-identity';
import type { CategoryConfigService } from '@fittkereso-backend/config';
import type {
  BrandResolutionService,
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
import type { SpecPostProcessService } from './spec-post-process.service';

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
  let mockKeyLookup: jest.Mocked<ProductKeyLookupService>;
  let mockBrandResolution: jest.Mocked<BrandResolutionService>;
  let mockSpecPostProcess: jest.Mocked<SpecPostProcessService>;

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
      offerGtin: jest.fn(),
      identityKeyConflict: jest.fn(),
      identityKeyDisagreement: jest.fn(),
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

    // Nothing shares an identifier with the listing unless a test says so.
    mockKeyLookup = {
      lookup: jest.fn().mockResolvedValue([]),
      decide: jest
        .fn()
        .mockResolvedValue({ verdict: { kind: 'none' }, failedGates: {} }),
      disagreeingTiers: jest.fn().mockReturnValue([]),
      recordPairs: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<ProductKeyLookupService>;

    mockBrandResolution = {
      resolve: jest.fn().mockResolvedValue({ entity: makeBrand(), similarity: 1 }),
    } as unknown as jest.Mocked<BrandResolutionService>;

    // Both LLM steps pass the listing through unchanged unless a test says
    // otherwise, so the identity tests above read as before.
    mockSpecPostProcess = {
      extractIdentity: jest
        .fn()
        .mockImplementation(async ({ scrapedProduct }) => scrapedProduct),
      unify: jest.fn().mockImplementation(async ({ scrapedProduct }) => scrapedProduct),
    } as unknown as jest.Mocked<SpecPostProcessService>;

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
      mockKeyLookup,
      mockBrandResolution,
      mockSpecPostProcess,
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

  describe('identifier tiers', () => {
    const gtinMatch = {
      via: 'gtin' as const,
      key: '09008594503199',
      productId: 'model-speedbike',
    };

    const savedAs = (id: string) =>
      mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
        if (!model.id) model.id = id;
        return model;
      });

    it('looks up the normalized identifiers, the resolved brand and the declared siblings', async () => {
      savedAs('model-new');
      mockOfferRepo.upsertFromScrape.mockResolvedValue({} as never);

      await service.createOrUpdateProduct(
        contextFromTask(makeTask()),
        makeScrapedProduct({
          externalId: '1260040108',
          siblingExternalIds: ['1260040103', '1260040108', '1260040113'],
          offers: [{ price: 1, gtin: '9008594503199', mpn: '1260-040108' }],
        }),
      );

      expect(mockKeyLookup.lookup).toHaveBeenCalledWith({
        sourceId: 'source-arukereso',
        // The listing's own id is its history, never a sibling of itself.
        siblingIds: ['1260040103', '1260040113'],
        gtins: ['09008594503199'],
        mpns: ['1260040108'],
        brandId: 'brand-1',
      });
    });

    // ebikeshop's KTM listing landing on the product speedbike's feed created,
    // by barcode alone — the case names could not settle (EXONICX vs EXONIC XX).
    it('attaches to the product an identifier found, without name matching', async () => {
      const speedbikeProduct = makeExistingModel();
      speedbikeProduct.id = 'model-speedbike';
      mockKeyLookup.lookup.mockResolvedValueOnce([gtinMatch]);
      mockKeyLookup.decide.mockResolvedValueOnce({
        verdict: { kind: 'attach', via: 'gtin', productId: 'model-speedbike' },
        failedGates: { 'model-speedbike': [] },
      });
      mockProductRepo.findOneOrFail.mockResolvedValueOnce(speedbikeProduct);
      mockProductRepo.save.mockResolvedValue(speedbikeProduct);

      const result = await service.createOrUpdateProduct(
        contextFromTask(makeTask()),
        makeScrapedProduct(),
      );

      expect(result?.id).toBe('model-speedbike');
      expect(mockListingMatch.match).not.toHaveBeenCalled();
      expect(mockMetricsService.scrapeResolutionOutcome).toHaveBeenCalledWith(
        'arukereso',
        'gtin_hit',
      );
      // Resolved by an identifier, not scored: nothing for name-based
      // duplicate detection to compare.
      expect(mockDuplicateService.detect).not.toHaveBeenCalled();
    });

    it('checks the candidate against the listing\'s brand and specs', async () => {
      savedAs('model-new');
      const specs = { modelYear: 2027, batteryCapacity: 625 };
      mockKeyLookup.lookup.mockResolvedValueOnce([gtinMatch]);

      await service.createOrUpdateProduct(
        contextFromTask(makeTask()),
        makeScrapedProduct({ specs }),
      );

      expect(mockKeyLookup.decide).toHaveBeenCalledWith([gtinMatch], {
        brandId: 'brand-1',
        specs,
        categorySlug: 'keyboards',
      });
    });

    // speedbike lists one CUBE trike twice under one GTIN, once as 2025 and
    // once as 2027. The shop contradicts itself; a person decides.
    it('sends a conflicting listing on to name matching, and pairs wherever it lands with the key\'s product', async () => {
      savedAs('model-2027');
      mockKeyLookup.lookup.mockResolvedValueOnce([gtinMatch]);
      const failedGates = {
        'model-speedbike': [
          {
            gate: 'primarySpecMismatch' as const,
            spec: 'modelYear',
            severity: 30,
            queryValue: 2027,
            candidateValue: 2025,
          },
        ],
      };
      mockKeyLookup.decide.mockResolvedValueOnce({
        verdict: {
          kind: 'conflict',
          via: 'gtin',
          reason: 'spec_mismatch',
          productIds: ['model-speedbike'],
        },
        failedGates,
      });

      const result = await service.createOrUpdateProduct(
        contextFromTask(makeTask()),
        makeScrapedProduct(),
      );

      expect(mockListingMatch.match).toHaveBeenCalled();
      expect(result?.id).toBe('model-2027');
      expect(mockMetricsService.identityKeyConflict).toHaveBeenCalledWith(
        'arukereso',
        'gtin',
        'spec_mismatch',
      );
      expect(mockKeyLookup.recordPairs).toHaveBeenCalledWith(
        'model-2027',
        [gtinMatch],
        failedGates,
        'scrape',
      );
    });

    // A duplicate created before the identifier was known: the listing's own
    // history keeps it where it is, and the GTIN pointing elsewhere is what
    // brings the other product to a person's attention.
    it('never moves a listing its own history resolved, but pairs it with the product an identifier points at', async () => {
      const ownProduct = makeExistingModel();
      ownProduct.id = 'model-own';
      mockOfferRepo.findFirstBySellerAndExternalIdsWithModelRelations.mockResolvedValueOnce({
        model: ownProduct,
      } as never);
      mockKeyLookup.lookup.mockResolvedValueOnce([gtinMatch]);
      mockKeyLookup.decide.mockResolvedValueOnce({
        verdict: { kind: 'attach', via: 'gtin', productId: 'model-speedbike' },
        failedGates: {},
      });
      mockKeyLookup.disagreeingTiers.mockReturnValueOnce(['gtin']);
      mockProductRepo.save.mockResolvedValue(ownProduct);
      mockOfferRepo.upsertFromScrape.mockResolvedValue({} as never);

      const result = await service.createOrUpdateProduct(
        contextFromTask(makeTask()),
        makeScrapedProduct({ offers: [{ price: 1, externalId: 'sku-1' }] }),
      );

      expect(result?.id).toBe('model-own');
      expect(mockKeyLookup.disagreeingTiers).toHaveBeenCalledWith(
        [gtinMatch],
        'model-own',
        undefined,
      );
      expect(mockMetricsService.identityKeyDisagreement).toHaveBeenCalledWith(
        'arukereso',
        'offer_external_id',
        'gtin',
      );
      expect(mockKeyLookup.recordPairs).toHaveBeenCalledWith(
        'model-own',
        [gtinMatch],
        {},
        'scrape',
      );
    });

    it('only counts tiers after the one that resolved as disagreeing', async () => {
      const sibling = makeExistingModel();
      sibling.id = 'model-sibling';
      mockKeyLookup.decide.mockResolvedValueOnce({
        verdict: { kind: 'attach', via: 'sibling', productId: 'model-sibling' },
        failedGates: {},
      });
      mockProductRepo.findOneOrFail.mockResolvedValueOnce(sibling);
      mockProductRepo.save.mockResolvedValue(sibling);

      await service.createOrUpdateProduct(contextFromTask(makeTask()), makeScrapedProduct());

      expect(mockMetricsService.scrapeResolutionOutcome).toHaveBeenCalledWith(
        'arukereso',
        'sibling_hit',
      );
      expect(mockKeyLookup.disagreeingTiers).toHaveBeenCalledWith(
        [],
        'model-sibling',
        'sibling',
      );
    });

    it('does not fail the scrape when writing the pairs throws', async () => {
      savedAs('model-new');
      mockKeyLookup.recordPairs.mockRejectedValueOnce(new Error('db down'));

      const result = await service.createOrUpdateProduct(
        contextFromTask(makeTask()),
        makeScrapedProduct(),
      );

      expect(result?.id).toBe('model-new');
    });
  });

  describe('the LLM steps', () => {
    const cleaned = (scrapedProduct: ScrapedProduct): ScrapedProduct => ({
      ...scrapedProduct,
      model: 'Macina Scarp SX',
      displayName: 'KTM Macina Scarp SX',
      specs: { modelYear: 2026 },
      nameCleaned: true,
    });

    const savedAs = (id: string) =>
      mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
        if (!model.id) model.id = id;
        return model;
      });

    // The listing's own history decides whether the stored extraction can be
    // reused, so it has to be known before the extraction runs.
    it('hands the extraction this listing\'s own record once its history found it', async () => {
      const ownRecord = {
        url: 'https://example.com/product',
        source: { id: 'source-arukereso' },
      };
      const known = makeExistingModel();
      known.sources = [
        { url: 'https://example.com/other', source: { id: 'source-arukereso' } } as never,
        ownRecord as never,
      ];
      mockOfferRepo.findFirstBySellerAndExternalIdsWithModelRelations.mockResolvedValueOnce({
        model: known,
      } as never);
      mockProductRepo.save.mockResolvedValue(known);
      mockOfferRepo.upsertFromScrape.mockResolvedValue({} as never);

      await service.createOrUpdateProduct(
        contextFromTask(makeTask()),
        makeScrapedProduct({ offers: [{ price: 1, externalId: 'sku-1' }] }),
      );

      expect(mockSpecPostProcess.extractIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ ownRecord }),
      );
    });

    it('runs history, extraction, identifier lookups, decision and unification in that order', async () => {
      savedAs('model-new');
      mockOfferRepo.upsertFromScrape.mockResolvedValue({} as never);

      await service.createOrUpdateProduct(
        contextFromTask(makeTask()),
        makeScrapedProduct({ offers: [{ price: 1, externalId: 'sku-1' }] }),
      );

      const order = (mock: jest.Mock) => mock.mock.invocationCallOrder[0];
      expect(
        order(mockOfferRepo.findFirstBySellerAndExternalIdsWithModelRelations as jest.Mock),
      ).toBeLessThan(order(mockSpecPostProcess.extractIdentity as jest.Mock));
      expect(order(mockSpecPostProcess.extractIdentity as jest.Mock)).toBeLessThan(
        order(mockKeyLookup.lookup as jest.Mock),
      );
      expect(order(mockKeyLookup.decide as jest.Mock)).toBeLessThan(
        order(mockSpecPostProcess.unify as jest.Mock),
      );
      expect(order(mockSpecPostProcess.unify as jest.Mock)).toBeLessThan(
        order(mockSourceRecordUpdater.upsertSourceRecord as jest.Mock),
      );
    });

    it('extracts a first-seen listing without a record to reuse', async () => {
      savedAs('model-new');

      await service.createOrUpdateProduct(contextFromTask(makeTask()), makeScrapedProduct());

      expect(mockSpecPostProcess.extractIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ ownRecord: undefined }),
      );
    });

    // The sanity check compares the extracted specs, and name matching the
    // cleaned name — not the raw title the importer handed over.
    it('decides identity on what the extraction produced', async () => {
      savedAs('model-new');
      mockSpecPostProcess.extractIdentity.mockImplementationOnce(async ({ scrapedProduct }) =>
        cleaned(scrapedProduct),
      );

      await service.createOrUpdateProduct(contextFromTask(makeTask()), makeScrapedProduct());

      expect(mockKeyLookup.decide).toHaveBeenCalledWith([], expect.objectContaining({
        specs: { modelYear: 2026 },
      }));
      expect(mockListingMatch.match).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'Macina Scarp SX', nameCleaned: true }),
        expect.anything(),
      );
      expect(mockBrandResolution.resolve).toHaveBeenCalledWith(
        'Logitech',
        'KTM Macina Scarp SX',
      );
    });

    it('unifies once when the listing creates its product, and saves the result', async () => {
      savedAs('model-new');
      mockSpecPostProcess.unify.mockImplementationOnce(async ({ scrapedProduct }) => ({
        ...scrapedProduct,
        specs: { ...scrapedProduct.specs, tubeless: true },
      }));

      await service.createOrUpdateProduct(contextFromTask(makeTask()), makeScrapedProduct());

      expect(mockSpecPostProcess.unify).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: 'created' }),
      );
      expect(mockSourceRecordUpdater.upsertSourceRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          scrapedProduct: expect.objectContaining({
            specs: { layout: 'UK', tubeless: true },
          }),
        }),
      );
    });

    // A shop's first listing of a product another shop created: its spec
    // table gets read once, and extends the product's specs.
    it('unifies when the listing is its source\'s first on an existing product', async () => {
      const otherShops = makeExistingModel();
      otherShops.sources = [{ source: { id: 'source-other-shop' } } as never];
      mockListingMatch.match.mockResolvedValueOnce({
        productId: otherShops.id,
        decision: { outcome: 'identified', nameKey: 'mx keys', candidates: [] },
      } as never);
      mockProductRepo.findOneOrFail.mockResolvedValueOnce(otherShops);
      mockProductRepo.save.mockResolvedValue(otherShops);

      await service.createOrUpdateProduct(contextFromTask(makeTask()), makeScrapedProduct());

      expect(mockSpecPostProcess.unify).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: 'new_source' }),
      );
    });

    it('does not unify another size from a source that already contributed', async () => {
      const product = makeExistingModel();
      product.sources = [
        { url: 'https://example.com/48cm', source: { id: 'source-arukereso' } } as never,
      ];
      mockKeyLookup.decide.mockResolvedValueOnce({
        verdict: { kind: 'attach', via: 'sibling', productId: product.id },
        failedGates: {},
      });
      mockProductRepo.findOneOrFail.mockResolvedValueOnce(product);
      mockProductRepo.save.mockResolvedValue(product);

      await service.createOrUpdateProduct(contextFromTask(makeTask()), makeScrapedProduct());

      expect(mockSpecPostProcess.unify).not.toHaveBeenCalled();
    });

    // The admin's "force resync" on one listing is a request to read it again in full.
    it('unifies a listing its source already contributed when the resync is forced', async () => {
      const product = makeExistingModel();
      product.sources = [
        { url: 'https://example.com/product', source: { id: 'source-arukereso' } } as never,
      ];
      mockSourceRecordRepo.findBySourceAndUrl.mockResolvedValueOnce({
        model: { id: product.id },
      } as never);
      mockProductRepo.findOneOrFail.mockResolvedValueOnce(product);
      mockProductRepo.save.mockResolvedValue(product);

      await service.createOrUpdateProduct(
        contextFromTask({ ...makeTask(), force: true } as ScrapeTask),
        makeScrapedProduct(),
      );

      expect(mockSpecPostProcess.unify).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: 'forced' }),
      );
    });

    // The product cannot be created, so the listing is about to be dropped.
    it('does not unify a product whose brand is unknown', async () => {
      mockBrandResolution.resolve.mockResolvedValueOnce(undefined);
      mockModelFactory.createShell.mockRejectedValueOnce(
        new Error('Brand could not be identified'),
      );

      const result = await service.createOrUpdateProduct(
        contextFromTask(makeTask()),
        makeScrapedProduct({ brand: 'Unknown Co' }),
      );

      expect(result).toBeUndefined();
      expect(mockSpecPostProcess.unify).not.toHaveBeenCalled();
    });

    it('names a new product from the cleaned name', async () => {
      savedAs('model-new');
      mockSpecPostProcess.extractIdentity.mockImplementationOnce(async ({ scrapedProduct }) =>
        cleaned(scrapedProduct),
      );

      await service.createOrUpdateProduct(contextFromTask(makeTask()), makeScrapedProduct());

      expect(mockModelFactory.createShell).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'Macina Scarp SX', displayName: 'KTM Macina Scarp SX' }),
      );
    });
  });

  // A source without source-native ids still has a history: its own page.
  it('recognises a listing by its page URL when no id resolves it', async () => {
    const known = makeExistingModel();
    mockSourceRecordRepo.findBySourceAndUrl.mockResolvedValueOnce({ model: { id: known.id } } as never);
    mockProductRepo.findOneOrFail.mockResolvedValueOnce(known);
    mockProductRepo.save.mockResolvedValue(known);

    const result = await service.createOrUpdateProduct(
      contextFromTask(makeTask()),
      makeScrapedProduct(),
    );

    expect(result?.id).toBe(known.id);
    expect(mockSourceRecordRepo.findBySourceAndUrl).toHaveBeenCalledWith(
      'source-arukereso',
      'https://example.com/product',
    );
    expect(mockMetricsService.scrapeResolutionOutcome).toHaveBeenCalledWith(
      'arukereso',
      'source_url_hit',
    );
    expect(mockListingMatch.match).not.toHaveBeenCalled();
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

  describe('offer identifiers', () => {
    const upserted = () =>
      mockOfferRepo.upsertFromScrape.mock.calls.map((call) => ({
        gtin: (call[0] as { gtin?: string }).gtin,
        mpn: (call[0] as { mpn?: string }).mpn,
      }));

    const runWithOffers = async (offers: unknown[]) => {
      mockProductRepo.findOne.mockResolvedValueOnce(null);
      mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
        if (!model.id) model.id = 'model-offer-identifiers';
        return model;
      });
      mockOfferRepo.upsertFromScrape.mockResolvedValue({} as never);

      await service.createOrUpdateProduct(
        contextFromTask(makeTask()),
        makeScrapedProduct({ offers: offers as never }),
      );
    };

    it('stores the normalized GTIN and MPN, not the raw values', async () => {
      await runWithOffers([
        { price: 1000, url: 'https://ebikeshop.hu/a', gtin: ' 9008594503199', mpn: '1260-040108' },
      ]);

      expect(upserted()).toEqual([{ gtin: '09008594503199', mpn: '1260040108' }]);
    });

    // speedbike's GIANT rows carry 7-digit article stubs in ean_code: storing
    // one would let it match another shop's unrelated offer.
    it('drops an invalid GTIN but keeps the MPN beside it', async () => {
      await runWithOffers([
        { price: 1000, url: 'https://speedbike.hu/a', gtin: '5461000', mpn: '2300160206' },
      ]);

      expect(upserted()).toEqual([{ gtin: undefined, mpn: '2300160206' }]);
    });

    it("counts every offer's GTIN by outcome, so a source whose barcodes stop validating is visible", async () => {
      await runWithOffers([
        { price: 1000, url: 'https://shop.hu/a', gtin: '9008594503199' },
        { price: 2000, url: 'https://shop.hu/b', gtin: '5461000' },
        { price: 3000, url: 'https://shop.hu/c' },
        { price: 4000, url: 'https://shop.hu/d', gtin: '  ' },
      ]);

      expect(mockMetricsService.offerGtin.mock.calls.map((c) => c[1])).toEqual([
        'valid',
        'invalid',
        'absent',
        'absent',
      ]);
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
