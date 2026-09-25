import { contextFromTask } from '../../interfaces/product-import-context.interface';
import {
  Brand,
  OfferRepository,
  ProductAliasRepository,
  ProductCategory,
  ProductModel,
  ProductModelRepository,
  ProductSourceRecordRepository,
  ProductImportTask,
  ProductImportTaskRepository,
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
  ContributorDetachService,
  OfferComposerService,
  OfferMatchingService,
  ProductImageCopyService,
  ProductMergeService,
  ProductModelFactoryService,
  ProductNormalizerService,
  ProductSourceRecordUpdaterService,
  ScrapedProduct,
} from '@fittkereso-backend/product';

jest.mock('@fittkereso-backend/product-identity', () => ({}));

// A new product's id is chosen before its insert. Tests name it through this.
const mockRandomUUID = jest.fn();
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomUUID: () => mockRandomUUID(),
}));

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

/**
 * Every product a test builds, so the reload under the product's lock finds
 * the same object the test set up — by id at call time, since tests change ids.
 */
let knownModels: ProductModel[] = [];

function makeExistingModel(): ProductModel {
  const model = new ProductModel();
  knownModels.push(model);
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

function makeTask(): ProductImportTask {
  return {
    id: 'task-1',
    url: 'https://example.com/product',
    source: {
      id: 'source-arukereso',
      name: 'arukereso',
      seller: { id: 'seller-arukereso', name: 'arukereso' },
    },
  } as ProductImportTask;
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
  let mockTaskRepo: jest.Mocked<ProductImportTaskRepository>;
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
  let mockLocks: { withLocks: jest.Mock };
  let mockOfferComposer: jest.Mocked<OfferComposerService>;
  let mockContributorDetach: jest.Mocked<ContributorDetachService>;

  beforeEach(() => {
    knownModels = [];
    mockRandomUUID.mockReturnValue('model-created');
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
      // A test's mockResolvedValueOnce answers identity resolution; the reload
      // under the product's lock falls through to the products it built.
      findOneOrFail: jest.fn().mockImplementation(async ({ where }) => {
        const model = knownModels.find((known) => known.id === where.id);
        if (!model) throw new Error(`No product ${where.id}`);
        return model;
      }),
      save: jest.fn(),
    } as unknown as jest.Mocked<ProductModelRepository>;

    mockTaskRepo = {
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ProductImportTaskRepository>;

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
      findUnattachedBySellerAndExternalIds: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation(async (record) => record),
    } as unknown as jest.Mocked<ProductSourceRecordRepository>;

    mockSourceRecordUpdater = {
      upsertSourceRecord: jest
        .fn()
        .mockResolvedValue({ id: 'source-record-1' }),
      upsertUnattached: jest
        .fn()
        .mockImplementation(({ existing }) => existing ?? { id: 'record-unattached' }),
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
      identityRecheckAttached: jest.fn(),
    } as unknown as jest.Mocked<ProductMetricsService>;

    mockProductNormalizer = {
      normalizeProduct: jest.fn().mockReturnValue('mx keys'),
    } as unknown as jest.Mocked<ProductNormalizerService>;

    mockOfferMatching = {
      findMatch: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<OfferMatchingService>;

    mockOfferRepo = {
      findAllByModelAndSource: jest.fn().mockResolvedValue([]),
      findBySellerAndExternalIds: jest.fn().mockResolvedValue([]),
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
        knownModels.push(model);
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

    mockLocks = {
      withLocks: jest.fn(async (_keys: unknown, work: () => Promise<unknown>) => work()),
    };

    // Composition itself is OfferComposerService's spec; here, what the
    // updater asks of it.
    mockOfferComposer = {
      compose: jest.fn().mockResolvedValue({ offers: [{ id: 'offer-1' }], conflicts: [] }),
      writeUnkeyed: jest.fn().mockResolvedValue({ id: 'offer-unkeyed' }),
      currentCarriers: jest.fn().mockReturnValue([]),
    } as unknown as jest.Mocked<OfferComposerService>;

    mockContributorDetach = {
      detach: jest.fn().mockResolvedValue([]),
      detachRecords: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ContributorDetachService>;

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
      mockLocks as never,
      mockOfferComposer,
      mockContributorDetach,
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
    mockRandomUUID.mockReturnValue('model-llm-declined');

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
    mockRandomUUID.mockReturnValue('model-not-found');

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
    mockRandomUUID.mockReturnValue('model-no-brand');

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
      mockRandomUUID.mockReturnValue(id);

    it('looks up the normalized identifiers, the resolved brand and the declared siblings', async () => {
      savedAs('model-new');

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
      // Every lookup, the re-check under the brand lock included, sees the GTIN.
      mockKeyLookup.lookup.mockResolvedValue([gtinMatch]);
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
      mockKeyLookup.decide.mockResolvedValue({
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
      mockRandomUUID.mockReturnValue(id);

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
        contextFromTask({ ...makeTask(), force: true } as ProductImportTask),
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
      mockRandomUUID.mockReturnValue('model-detect');

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
      mockRandomUUID.mockReturnValue('model-detect-fails');

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
    mockRandomUUID.mockReturnValue('model-new');

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
    mockRandomUUID.mockReturnValue('model-2');

    await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

    expect(mockListingMatch.match).toHaveBeenCalledWith(scrapedProduct, {
      taskId: task.id,
    });
  });

  it('does not touch Seller/Offer plumbing when ScrapedProduct.offers is absent', async () => {
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct(); // no `offers` field

    mockProductRepo.findOne.mockResolvedValueOnce(null);
    mockRandomUUID.mockReturnValue('model-no-offers');

    await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

    expect(mockOfferComposer.compose).not.toHaveBeenCalled();
    expect(mockOfferComposer.writeUnkeyed).not.toHaveBeenCalled();
    expect(mockMergeService.recomputePrice).not.toHaveBeenCalled();
  });

  it('does not touch Offer plumbing when ScrapedProduct.offers is an empty array', async () => {
    const task = makeTask();
    const scrapedProduct = makeScrapedProduct({ offers: [] });

    mockProductRepo.findOne.mockResolvedValueOnce(null);
    mockRandomUUID.mockReturnValue('model-empty-offers');

    await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

    expect(mockOfferComposer.compose).not.toHaveBeenCalled();
    expect(mockMergeService.recomputePrice).not.toHaveBeenCalled();
  });

  it('composes the listing\'s offers for the task source\'s seller, then recomputes model price', async () => {
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
    mockRandomUUID.mockReturnValue('model-with-offers');

    await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

    expect(mockOfferComposer.compose).toHaveBeenCalledWith({
      model: expect.objectContaining({ id: 'model-with-offers' }),
      seller: task.source.seller,
      externalIds: ['listing-1'],
      sighted: true,
      create: true,
    });
    expect(mockMergeService.recomputePrice).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'model-with-offers' }),
    );
  });

  // The record alone is then enough to compose the offer from, whichever
  // source's import composes it next.
  it('stores each offer on the record with the externalId its offer is stored under', async () => {
    mockProductRepo.findOne.mockResolvedValueOnce(null);
    mockCategoryConfigService.getConfig.mockReturnValue({
      offerLevelSpecs: ['layout'],
    } as never);

    await service.createOrUpdateProduct(
      contextFromTask(makeTask()),
      makeScrapedProduct({
        specs: { layout: 'UK', weight: 800 },
        offers: [
          { price: 199990, externalId: 'listing-1' },
          { price: 209990, externalId: 'listing-2', specs: { layout: 'US' } },
        ],
      }),
    );

    const stored = mockSourceRecordUpdater.upsertSourceRecord.mock.calls[0][0]
      .scrapedProduct?.offers;
    expect(stored).toEqual([
      // The page's offer-level specs where the offer has none of its own.
      { price: 199990, externalId: 'listing-1', resolvedExternalId: 'listing-1', specs: { layout: 'UK' } },
      { price: 209990, externalId: 'listing-2', resolvedExternalId: 'listing-2', specs: { layout: 'US' } },
    ]);
  });

  it('reports an offer that sits on another product, and keeps the rest of the listing', async () => {
    mockProductRepo.findOne.mockResolvedValueOnce(null);
    mockOfferComposer.compose.mockResolvedValueOnce({
      offers: [{ id: 'offer-2' }],
      conflicts: [
        {
          details: {
            externalId: 'listing-1',
            sellerId: 'seller-arukereso',
            offerId: 'offer-owned',
            existingModelId: 'other-model',
            incomingModelId: 'model-created',
          },
        },
      ],
    } as never);

    const result = await service.createOrUpdateProduct(
      contextFromTask(makeTask()),
      makeScrapedProduct({
        offers: [
          { price: 1, externalId: 'listing-1' },
          { price: 2, externalId: 'listing-2' },
        ],
      }),
    );

    expect(result).toBeDefined();
    expect(mockMetricsService.offerIdentityConflict).toHaveBeenCalledWith(
      'arukereso',
      'model_disagreement',
    );
    expect(mockMergeService.recomputePrice).toHaveBeenCalledTimes(1);
  });

  it('continues processing remaining offers and does not fail the scrape if one unkeyed offer write throws', async () => {
    const task = makeTask();
    // No ids and no urls: both fall back to the page's slug, collide, and are
    // written without an externalId.
    const scrapedProduct = makeScrapedProduct({
      offers: [{ price: 1000 }, { price: 2000 }],
    });

    mockProductRepo.findOne.mockResolvedValueOnce(null);
    mockRandomUUID.mockReturnValue('model-partial-offer-failure');
    mockOfferComposer.writeUnkeyed
      .mockRejectedValueOnce(new Error('offer upsert failed'))
      .mockResolvedValueOnce({ id: 'offer-2' } as never);
    mockOfferComposer.compose.mockResolvedValueOnce({ offers: [], conflicts: [] });

    const result = await service.createOrUpdateProduct(contextFromTask(task), scrapedProduct);

    expect(result).toBeDefined();
    expect(mockOfferComposer.writeUnkeyed).toHaveBeenCalledTimes(2);
    expect(mockMergeService.recomputePrice).toHaveBeenCalledTimes(1);
  });

  describe('offer identity', () => {
    const storedExternalIds = () =>
      (
        mockSourceRecordUpdater.upsertSourceRecord.mock.calls[0][0].scrapedProduct?.offers ?? []
      ).map((offer) => offer.resolvedExternalId);

    const runWithOffers = async (offers: unknown[]) => {
      const task = makeTask();
      mockProductRepo.findOne.mockResolvedValueOnce(null);
      mockRandomUUID.mockReturnValue('model-offer-identity');

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

      expect(storedExternalIds()).toEqual(['kerekpar/ktm-macina']);
      expect(mockOfferComposer.compose).toHaveBeenCalledWith(
        expect.objectContaining({ externalIds: ['kerekpar/ktm-macina'] }),
      );
    });

    it('prefers a source-native externalId over the slug', async () => {
      await runWithOffers([
        { price: 1000, url: 'https://alza.hu/kerekpar/ktm-macina', externalId: 'sku-1' },
      ]);

      expect(storedExternalIds()).toEqual(['sku-1']);
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

      // Null, not absent: a collided entry must never be joined by a derived id.
      expect(storedExternalIds()).toEqual([null, null, null]);
      expect(mockOfferComposer.writeUnkeyed).toHaveBeenCalledTimes(3);
      expect(mockOfferComposer.compose).toHaveBeenCalledWith(
        expect.objectContaining({ externalIds: [] }),
      );
    });

    it('drops a source-native externalId shared by several offers too', async () => {
      await runWithOffers([
        { price: 1000, url: 'https://alza.hu/a', externalId: 'group-sku' },
        { price: 2000, url: 'https://alza.hu/b', externalId: 'group-sku' },
      ]);

      expect(storedExternalIds()).toEqual([null, null]);
    });

    // A collision must not punish the offers that are fine.
    it('keeps the unique ids on a page where only some collide', async () => {
      await runWithOffers([
        { price: 1000, url: 'https://alza.hu/a', externalId: 'shared' },
        { price: 2000, url: 'https://alza.hu/b', externalId: 'shared' },
        { price: 3000, url: 'https://alza.hu/c', externalId: 'its-own' },
      ]);

      expect(storedExternalIds()).toEqual([null, null, 'its-own']);
      expect(mockOfferComposer.compose).toHaveBeenCalledWith(
        expect.objectContaining({ externalIds: ['its-own'] }),
      );
      expect(mockOfferComposer.writeUnkeyed).toHaveBeenCalledTimes(2);
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
    const runWithOffers = async (offers: unknown[]) => {
      mockProductRepo.findOne.mockResolvedValueOnce(null);
      mockRandomUUID.mockReturnValue('model-offer-identifiers');

      await service.createOrUpdateProduct(
        contextFromTask(makeTask()),
        makeScrapedProduct({ offers: offers as never }),
      );
    };

    // Normalized where they are matched and stored on the Offer
    // (OfferComposerService); the record keeps what the source published.
    it('keeps the raw values on the stored listing, for inspection', async () => {
      await runWithOffers([
        { price: 1000, url: 'https://ebikeshop.hu/a', gtin: ' 9008594503199', mpn: '1260-040108' },
      ]);

      const [stored] =
        mockSourceRecordUpdater.upsertSourceRecord.mock.calls[0][0].scrapedProduct?.offers ?? [];
      expect(stored).toMatchObject({ gtin: ' 9008594503199', mpn: '1260-040108' });
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

  describe('offers the page stopped showing', () => {
    const PAGE = 'https://ebikeshop.hu/termek/53cm-variant';
    const seller = { id: 'seller-ebikeshop', name: 'ebikeshop.hu' };

    /** A re-import of this page, pinned to model-1, whose record listed `before`. */
    const reimport = async (before: string[], now: string[]) => {
      const task = {
        ...makeTask(),
        url: PAGE,
        product: { id: 'model-1' },
        source: { ...makeTask().source, seller },
      } as ProductImportTask;
      const existingModel = makeExistingModel();
      const ownRecord = {
        id: 'record-53cm',
        url: PAGE,
        source: task.source,
        scrapedProduct: {
          offers: before.map((id) => ({ price: 1, externalId: id, resolvedExternalId: id })),
        },
      };
      // A sibling size's own page, which this import does not visit.
      const siblingRecord = {
        id: 'record-48cm',
        url: 'https://ebikeshop.hu/termek/48cm-variant',
        source: task.source,
        scrapedProduct: {
          offers: [{ price: 1, externalId: 'sku-48cm', resolvedExternalId: 'sku-48cm' }],
        },
      };
      existingModel.sources = [ownRecord, siblingRecord] as never;
      mockProductRepo.save.mockResolvedValue(existingModel);
      mockSourceRecordUpdater.upsertSourceRecord.mockResolvedValueOnce(ownRecord as never);

      await service.createOrUpdateProduct(
        contextFromTask(task),
        makeScrapedProduct({
          offers: now.map((id) => ({ price: 3359000, url: PAGE, externalId: id })),
        }),
      );
      return existingModel;
    };

    // Regression: a scrape of one variant URL (e.g. ebikeshop's 53cm frame-size
    // page) must never delete a sibling variant's offer (e.g. the 48cm page's
    // own offer) just because this pass didn't happen to re-visit it.
    it('leaves a sibling variant\'s offer alone', async () => {
      await reimport(['sku-53cm'], ['sku-53cm']);

      expect(mockOfferComposer.currentCarriers).not.toHaveBeenCalled();
      expect(mockOfferRepo.deleteByIds).not.toHaveBeenCalled();
    });

    it('deletes an offer the page no longer shows when no other source of the seller lists it', async () => {
      mockOfferRepo.findBySellerAndExternalIds.mockResolvedValueOnce([
        { id: 'offer-53cm-stale', externalId: 'sku-53cm-old', model: { id: 'model-1' } },
      ] as never);

      const model = await reimport(['sku-53cm-old'], ['sku-53cm-new']);

      expect(mockOfferComposer.currentCarriers).toHaveBeenCalledWith(
        expect.objectContaining({ sellerId: 'seller-ebikeshop', externalId: 'sku-53cm-old' }),
      );
      expect(mockOfferRepo.findBySellerAndExternalIds).toHaveBeenCalledWith(
        'seller-ebikeshop',
        ['sku-53cm-old'],
      );
      expect(mockOfferRepo.deleteByIds).toHaveBeenCalledWith(['offer-53cm-stale']);
      // What joined only that offer has nothing left to join on this product.
      expect(mockContributorDetach.detach).toHaveBeenCalledWith({
        model,
        sellerId: 'seller-ebikeshop',
        externalIds: ['sku-53cm-old'],
      });
    });

    it('never deletes an offer of that id sitting on another product', async () => {
      mockOfferRepo.findBySellerAndExternalIds.mockResolvedValueOnce([
        { id: 'offer-elsewhere', model: { id: 'other-model' } },
      ] as never);

      await reimport(['sku-53cm-old'], ['sku-53cm-new']);

      expect(mockOfferRepo.deleteByIds).not.toHaveBeenCalled();
      expect(mockContributorDetach.detach).not.toHaveBeenCalled();
    });

    // Another source of the seller (its Google feed, say) still lists it: the
    // offer stays, composed again without this page's values.
    it('composes again an offer another current source of the seller still lists', async () => {
      mockOfferComposer.currentCarriers.mockReturnValueOnce([{ id: 'record-google' }] as never);

      const model = await reimport(['sku-53cm-old'], ['sku-53cm-new']);

      expect(mockOfferComposer.compose).toHaveBeenLastCalledWith({
        model,
        seller,
        externalIds: ['sku-53cm-old'],
        sighted: false,
        create: false,
      });
      expect(mockOfferRepo.deleteByIds).not.toHaveBeenCalled();
    });

    // Every offer refused or failed is no evidence about what the page shows.
    it('judges nothing when no offer was written', async () => {
      mockOfferComposer.compose.mockResolvedValueOnce({ offers: [], conflicts: [] });

      await reimport(['sku-53cm-old'], ['sku-53cm-new']);

      expect(mockOfferComposer.currentCarriers).not.toHaveBeenCalled();
      expect(mockOfferRepo.deleteByIds).not.toHaveBeenCalled();
      expect(mockMergeService.recomputePrice).not.toHaveBeenCalled();
    });
  });

  describe('records that waited for this listing\'s offers', () => {
    it('attaches them before the product is merged, so its specs and offers include them', async () => {
      const task = makeTask();
      task.product = { id: 'model-1' } as never;
      const model = makeExistingModel();
      const waiting = {
        id: 'record-google',
        model: null,
        source: { id: 'source-google', identifiesProducts: false, seller: task.source.seller },
        scrapedProduct: { offers: [{ price: 90, resolvedExternalId: 'sku-1' }] },
      };
      mockSourceRecordRepo.findUnattachedBySellerAndExternalIds.mockResolvedValueOnce([
        waiting,
      ] as never);
      let mergedWith: unknown[] = [];
      mockMergeService.mergeSources.mockImplementationOnce(async (merged) => {
        mergedWith = [...(merged.sources ?? [])];
        return merged;
      });

      await service.createOrUpdateProduct(
        contextFromTask(task),
        makeScrapedProduct({ offers: [{ price: 100, externalId: 'sku-1' }] as never }),
      );

      expect(mockSourceRecordRepo.findUnattachedBySellerAndExternalIds).toHaveBeenCalledWith(
        'seller-arukereso',
        ['sku-1'],
      );
      expect(waiting.model).toBe(model);
      expect(mergedWith).toContain(waiting);
      // Before the listing's own record, which may be one of them.
      expect(
        mockSourceRecordRepo.findUnattachedBySellerAndExternalIds.mock.invocationCallOrder[0],
      ).toBeLessThan(mockSourceRecordUpdater.upsertSourceRecord.mock.invocationCallOrder[0]);
    });
  });

  describe('a source that does not identify products', () => {
    const PAGE = 'https://speedbike.hu/haibike';
    const googleSource = {
      id: 'source-google',
      name: 'speedbike-googleshop',
      identifiesProducts: false,
      seller: { id: 'seller-speedbike', name: 'speedbike.hu' },
    };
    const contribute = (overrides?: Partial<ScrapedProduct>) =>
      service.createOrUpdateProduct(
        { source: googleSource as never, url: PAGE, feedRowHash: 'hash-1' },
        makeScrapedProduct({
          displayName: 'HAIBIKE SDURO raw title',
          offers: [{ price: 1499990, priceWithoutDiscount: 2269000, externalId: 'HAIBIKE-1' }] as never,
          ...overrides,
        }),
      );
    const offerOn = (modelId: string) => ({ id: 'offer-1', externalId: 'HAIBIKE-1', model: { id: modelId } });

    it('joins the offer its seller has, with no identity work and no product fields', async () => {
      const model = makeExistingModel();
      mockOfferRepo.findFirstBySellerAndExternalIdsWithModelRelations.mockResolvedValue({
        ...offerOn('model-1'),
        model,
      } as never);
      mockOfferRepo.findBySellerAndExternalIds.mockResolvedValue([offerOn('model-1')] as never);

      const result = await contribute();

      expect(result).toBe(model);
      for (const identityStep of [
        mockSpecPostProcess.extractIdentity,
        mockBrandResolution.resolve,
        mockKeyLookup.lookup,
        mockListingMatch.match,
        mockModelFactory.createShell,
        mockImageCopyService.copyImagesFromSource,
        mockAliasRepo.repo.createQueryBuilder as jest.Mock,
      ]) {
        expect(identityStep).not.toHaveBeenCalled();
      }
      // The product's names are its identifying sources'.
      expect(model.displayName).toBe('Logitech MX Keys');
      expect(mockSourceRecordUpdater.upsertSourceRecord).toHaveBeenCalledWith(
        expect.objectContaining({ model, source: googleSource, feedRowHash: 'hash-1' }),
      );
      expect(mockMergeService.mergeSources).toHaveBeenCalledWith(model);
      expect(mockOfferComposer.compose).toHaveBeenCalledWith({
        model,
        seller: googleSource.seller,
        externalIds: ['HAIBIKE-1'],
        sighted: true,
        create: false,
      });
      expect(mockMergeService.recomputePrice).toHaveBeenCalledWith(model);
      expect(mockMetricsService.scrapeResolutionOutcome).toHaveBeenCalledWith(
        'speedbike-googleshop',
        'contributed',
      );
    });

    it('unifies only when it first contributes to the product', async () => {
      const model = makeExistingModel();
      mockOfferRepo.findFirstBySellerAndExternalIdsWithModelRelations.mockResolvedValue({
        ...offerOn('model-1'),
        model,
      } as never);
      mockOfferRepo.findBySellerAndExternalIds.mockResolvedValue([offerOn('model-1')] as never);

      await contribute();

      expect(mockSpecPostProcess.unify).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: 'new_source' }),
      );
    });

    it('brings its waiting record onto the product instead of writing a second one', async () => {
      const model = makeExistingModel();
      const waiting = { id: 'record-google', url: PAGE, model: null, offers: [{ id: 'x' }] };
      mockOfferRepo.findFirstBySellerAndExternalIdsWithModelRelations.mockResolvedValue({
        ...offerOn('model-1'),
        model,
      } as never);
      mockOfferRepo.findBySellerAndExternalIds.mockResolvedValue([offerOn('model-1')] as never);
      mockSourceRecordRepo.findBySourceAndUrl.mockResolvedValue(waiting as never);

      await contribute();

      expect(model.sources).toContain(waiting);
      expect(waiting).toMatchObject({ model, source: googleSource, offers: undefined });
    });

    it('stores the listing unattached, under its offer key, when the seller has no such offer', async () => {
      const held: unknown[][] = [];
      mockLocks.withLocks.mockImplementation(async (keys: unknown[], work: () => Promise<unknown>) => {
        held.push(keys);
        return work();
      });

      const result = await contribute();

      expect(result).toBeUndefined();
      expect(held).toEqual([[{ namespace: 4, id: 'seller-speedbike:HAIBIKE-1' }]]);
      expect(mockSourceRecordUpdater.upsertUnattached).toHaveBeenCalledWith(
        expect.objectContaining({
          existing: null,
          source: googleSource,
          sourceUrl: PAGE,
          feedRowHash: 'hash-1',
        }),
      );
      const [stored] = mockSourceRecordUpdater.upsertUnattached.mock.calls[0];
      expect(stored.scrapedProduct.offers?.[0]).toMatchObject({ resolvedExternalId: 'HAIBIKE-1' });
      expect(mockSourceRecordRepo.save).toHaveBeenCalledWith({ id: 'record-unattached' });
      expect(mockOfferComposer.compose).not.toHaveBeenCalled();
      expect(mockMetricsService.scrapeResolutionOutcome).toHaveBeenCalledWith(
        'speedbike-googleshop',
        'unattached',
      );
    });

    // The identifying listing wrote the offer between the lookup and the key lock.
    it('joins the offer that turned up while it was being stored', async () => {
      const model = makeExistingModel();
      mockOfferRepo.findFirstBySellerAndExternalIdsWithModelRelations
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...offerOn('model-1'), model: { id: 'model-1' } } as never)
        .mockResolvedValue({ ...offerOn('model-1'), model } as never);
      mockOfferRepo.findBySellerAndExternalIds.mockResolvedValue([offerOn('model-1')] as never);

      const result = await contribute();

      expect(result).toBe(model);
      expect(mockSourceRecordRepo.save).not.toHaveBeenCalled();
      expect(mockOfferComposer.compose).toHaveBeenCalledWith(
        expect.objectContaining({ sighted: true, create: false }),
      );
    });

    it('leaves the product its offer has left, and waits unattached', async () => {
      const oldProduct = makeExistingModel();
      oldProduct.id = 'model-old';
      const own = {
        id: 'record-google',
        url: PAGE,
        source: googleSource,
        scrapedProduct: { offers: [{ price: 1, resolvedExternalId: 'HAIBIKE-1' }] },
      };
      oldProduct.sources = [own] as never;
      mockSourceRecordRepo.findBySourceAndUrl
        .mockResolvedValueOnce({ ...own, model: { id: 'model-old' } } as never)
        .mockResolvedValue({ ...own, model: null } as never);

      const result = await contribute();

      expect(result).toBeUndefined();
      expect(mockContributorDetach.detachRecords).toHaveBeenCalledWith(oldProduct, [own]);
      expect(mockOfferComposer.compose).toHaveBeenCalledWith({
        model: oldProduct,
        seller: googleSource.seller,
        externalIds: ['HAIBIKE-1'],
        sighted: false,
        create: false,
      });
      expect(mockProductRepo.save).toHaveBeenCalledWith(oldProduct);
      expect(mockSourceRecordUpdater.upsertUnattached).toHaveBeenCalledWith(
        expect.objectContaining({ existing: expect.objectContaining({ id: 'record-google' }) }),
      );
    });

    it('never creates an offer', async () => {
      const model = makeExistingModel();
      mockOfferRepo.findFirstBySellerAndExternalIdsWithModelRelations.mockResolvedValue({
        ...offerOn('model-1'),
        model,
      } as never);
      mockOfferRepo.findBySellerAndExternalIds.mockResolvedValue([offerOn('model-1')] as never);

      await contribute();

      for (const [params] of mockOfferComposer.compose.mock.calls) {
        expect(params.create).toBe(false);
      }
      expect(mockOfferComposer.writeUnkeyed).not.toHaveBeenCalled();
    });
  });

  describe('locks and the re-check', () => {
    const concurrentGtin = {
      via: 'gtin' as const,
      key: '09008594503199',
      productId: 'model-concurrent',
    };

    /** The locks held right now, innermost last, as `kind:id`. */
    let held: string[];
    /** What each tracked call saw held when it ran. */
    let seen: Record<string, string[][]>;

    const see = (name: string) => {
      (seen[name] ??= []).push([...held]);
    };

    beforeEach(() => {
      held = [];
      seen = {};
      mockLocks.withLocks.mockImplementation(
        async (
          keys: { namespace: number; id: string }[],
          work: () => Promise<unknown>,
        ) => {
          const kinds: Record<number, string> = { 1: 'product', 2: 'brand', 4: 'offer' };
          const labels = keys.map((key) => `${kinds[key.namespace]}:${key.id}`);
          held.push(...labels);
          try {
            return await work();
          } finally {
            held.splice(held.length - labels.length, labels.length);
          }
        },
      );
      mockModelFactory.createShell.mockImplementation(async () => {
        see('createShell');
        const model = new ProductModel();
        knownModels.push(model);
        model.brand = makeBrand();
        model.enabled = true;
        return model;
      });
      mockProductRepo.save.mockImplementation(async (model: ProductModel) => {
        see(`save ${model.id}`);
        return model;
      });
      mockSourceRecordUpdater.upsertSourceRecord.mockImplementation(async () => {
        see('upsertSourceRecord');
        return { id: 'source-record-1' } as never;
      });
      mockMergeService.recomputePrice.mockImplementation(async (model) => {
        see('recomputePrice');
        return model;
      });
      mockImageCopyService.copyImagesFromSource.mockImplementation(async () => {
        see('copyImages');
        return [];
      });
      mockKeyLookup.recordPairs.mockImplementation(async () => {
        see('recordPairs');
        return 0;
      });
    });

    const withOfferAndImage = () =>
      makeScrapedProduct({
        offers: [{ price: 100, currency: 'HUF', externalId: 'sku-1' }],
        images: [{ url: 'https://example.com/a.jpg', order: 0 }],
      } as Partial<ScrapedProduct>);

    it('writes an existing product only under its lock, on a copy loaded under it', async () => {
      const task = makeTask();
      task.product = { id: 'model-1' } as never;
      const stale = makeExistingModel();
      const fresh = makeExistingModel();
      mockProductRepo.findOneOrFail
        .mockResolvedValueOnce(stale)
        .mockResolvedValueOnce(fresh);

      const result = await service.createOrUpdateProduct(
        contextFromTask(task),
        withOfferAndImage(),
      );

      expect(result).toBe(fresh);
      expect(mockSourceRecordUpdater.upsertSourceRecord).toHaveBeenCalledWith(
        expect.objectContaining({ model: fresh }),
      );
      // By identity: the two copies are deep-equal.
      expect(mockProductRepo.save.mock.calls.every(([model]) => model === fresh)).toBe(true);
      expect(stale).not.toBe(fresh);
      for (const call of [
        'upsertSourceRecord',
        'save model-1',
        'copyImages',
        'recomputePrice',
      ]) {
        expect(seen[call]?.length).toBeGreaterThan(0);
        for (const locks of seen[call]) {
          expect(locks).toEqual(['product:model-1', 'offer:seller-arukereso:sku-1']);
        }
      }
      // Pairs only add rows, with ON CONFLICT: no lock needed.
      expect(seen['recordPairs']).toEqual([[]]);
    });

    it('creates under the brand lock and its own, and copies the image after the brand lock', async () => {
      mockRandomUUID.mockReturnValue('model-new');

      const result = await service.createOrUpdateProduct(
        contextFromTask(makeTask()),
        withOfferAndImage(),
      );

      expect(result?.id).toBe('model-new');
      // The embedding call happens before anything is locked.
      expect(seen['createShell']).toEqual([[]]);
      for (const call of ['upsertSourceRecord', 'save model-new', 'recomputePrice']) {
        for (const locks of seen[call]) {
          expect(locks).toEqual([
            'brand:brand-1',
            'product:model-new',
            'offer:seller-arukereso:sku-1',
          ]);
        }
      }
      expect(seen['copyImages']).toEqual([['product:model-new']]);
      expect(mockMetricsService.newProductCreated).toHaveBeenCalledWith('arukereso');
      expect(mockMetricsService.identityRecheckAttached).not.toHaveBeenCalled();
    });

    it('re-checks without the LLM under the brand lock before creating', async () => {
      await service.createOrUpdateProduct(
        contextFromTask(makeTask()),
        makeScrapedProduct(),
      );

      expect(mockListingMatch.match).toHaveBeenCalledTimes(2);
      expect(mockListingMatch.match).toHaveBeenLastCalledWith(
        expect.anything(),
        { taskId: 'task-1' },
        { llm: false },
      );
    });

    // Two sizes of one new bike imported at once: the second waited for the
    // brand lock while the first created the product and wrote its offers.
    it('attaches to the product a concurrent import created, found by its GTIN', async () => {
      const concurrent = makeExistingModel();
      concurrent.id = 'model-concurrent';
      // The first decision ran before the other import's offers existed.
      mockKeyLookup.lookup.mockResolvedValueOnce([]).mockResolvedValue([concurrentGtin]);
      mockKeyLookup.decide
        .mockResolvedValueOnce({ verdict: { kind: 'none' }, failedGates: {} } as never)
        .mockResolvedValue({
          verdict: { kind: 'attach', via: 'gtin', productId: 'model-concurrent' },
          failedGates: { 'model-concurrent': [] },
        } as never);

      const result = await service.createOrUpdateProduct(
        contextFromTask(makeTask()),
        withOfferAndImage(),
      );

      expect(result).toBe(concurrent);
      expect(mockMetricsService.identityRecheckAttached).toHaveBeenCalledWith(
        'arukereso',
        'gtin',
      );
      expect(mockMetricsService.newProductCreated).not.toHaveBeenCalled();
      expect(mockProductRepo.save).toHaveBeenCalledWith(concurrent);
      for (const locks of seen['save model-concurrent']) {
        expect(locks).toEqual([
          'brand:brand-1',
          'product:model-concurrent',
          'offer:seller-arukereso:sku-1',
        ]);
      }
      // Its own product: no pair with itself.
      expect(mockKeyLookup.recordPairs).toHaveBeenCalledWith(
        'model-concurrent',
        [concurrentGtin],
        { 'model-concurrent': [] },
        'scrape',
      );
    });

    it('attaches to a concurrent import\'s product found by name, and stores that decision', async () => {
      const concurrent = makeExistingModel();
      concurrent.id = 'model-concurrent';
      const identified = {
        outcome: 'identified',
        nameKey: 'mx keys',
        candidates: [],
      };
      mockListingMatch.match
        .mockResolvedValueOnce(createdDecision() as never)
        .mockResolvedValueOnce({
          productId: 'model-concurrent',
          decision: identified,
        } as never);
      const task = makeTask();

      const result = await service.createOrUpdateProduct(
        contextFromTask(task),
        makeScrapedProduct(),
      );

      expect(result).toBe(concurrent);
      expect(mockMetricsService.identityRecheckAttached).toHaveBeenCalledWith(
        'arukereso',
        'name',
      );
      expect(task.identityDecision).toBe(identified);
      expect(mockDuplicateService.detect).toHaveBeenCalledWith(
        'model-concurrent',
        'scrape',
      );
    });

    it('creates nothing when the brand does not resolve', async () => {
      mockModelFactory.createShell.mockRejectedValueOnce(
        new Error('Brand could not be identified'),
      );

      const result = await service.createOrUpdateProduct(
        contextFromTask(makeTask()),
        makeScrapedProduct(),
      );

      expect(result).toBeUndefined();
      expect(mockLocks.withLocks).not.toHaveBeenCalled();
      expect(mockProductRepo.save).not.toHaveBeenCalled();
    });
  });
});
