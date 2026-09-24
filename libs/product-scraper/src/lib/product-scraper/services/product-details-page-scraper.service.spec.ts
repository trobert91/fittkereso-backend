import { ProductDetailsPageScraperService } from './product-details-page-scraper.service';
import type {
  ProductCategory,
  ProductImportTask,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import { asScrapingConfig } from '@fittkereso-backend/database';

describe('ProductDetailsPageScraperService.extractProduct', () => {
  let service: ProductDetailsPageScraperService;
  let interpreter: { runDetailPage: jest.Mock };
  let runtime: { getCategoryBySlug: jest.Mock };
  let categoryConfigService: { getJsonSchema: jest.Mock; getConfig: jest.Mock };
  let specExtraction: { extractSpecs: jest.Mock };

  const category = { id: 'cat-1', slug: 'ebikes', name: 'Ebikes' } as ProductCategory;
  const jsonSchema: SpecDefinitionJsonSchema = {
    type: 'object',
    title: 'E-bike',
    properties: {},
  };

  function buildTask(): ProductImportTask {
    return {
      id: 'task-1',
      url: 'https://speedbike.hu/product/1',
      source: {
        id: 'source-1',
        name: 'speedbike',
        config: {
          categories: { ebikes: { enabled: true } },
          listPage: {
            categoryName: [],
            items: [],
            itemMode: 'cheerio',
            itemPipeline: [],
          },
          detailPage: { specMapping: { ebikes: { mappings: [] } } },
        },
      },
    } as unknown as ProductImportTask;
  }

  // "raw title" is speedbike.hu's uncleaned marketing title — the exact
  // scenario originalName exists to preserve.
  const detail = {
    categorySlug: 'ebikes',
    brand: 'KTM',
    model: 'KTM Macina Scarp SX Prestige Di2 M/43 Olive Pearl',
    rawSpecs: [{ name: 'Motor', values: ['Bosch Performance CX'] }],
    rawOffers: [],
    imageUrls: [],
    aliases: [],
    externalId: 'sku-1',
    offerLinks: [],
  };

  beforeEach(() => {
    interpreter = { runDetailPage: jest.fn().mockResolvedValue(detail) };
    runtime = { getCategoryBySlug: jest.fn().mockResolvedValue(category) };
    categoryConfigService = {
      getJsonSchema: jest.fn().mockReturnValue(jsonSchema),
      getConfig: jest.fn().mockReturnValue({ offerLevelSpecs: ['frameSize'] }),
    };
    specExtraction = { extractSpecs: jest.fn().mockReturnValue({}) };

    // No LLM service and no record repository among the dependencies: this
    // importer cannot spend a call or decide to skip one. The updater does
    // both, once identity resolution knows whether the listing is new.
    service = new ProductDetailsPageScraperService(
      {} as any, // scraperService
      {} as any, // productUpdaterService
      { recordExtractionSkipReason: jest.fn() } as any, // scrapingMetrics
      interpreter as any,
      runtime as any,
      categoryConfigService as any,
      specExtraction as any,
      {} as any, // translationSelector
      {} as any, // translationService
      {} as any, // importTaskPublisher
    );
  });

  function callExtractProduct(task: ProductImportTask) {
    return (service as any).extractProduct(task, {} as any);
  }

  it('hands over the raw title as the model, for the identity extraction to clean', async () => {
    const result = await callExtractProduct(buildTask());

    expect(result.scrapedProduct).toMatchObject({
      brand: 'KTM',
      model: detail.model,
      originalName: detail.model,
      displayName: `KTM ${detail.model}`,
      rawSpecs: detail.rawSpecs,
      externalId: 'sku-1',
    });
    expect(result.scrapedProduct.nameCleaned).toBeUndefined();
  });

  it('carries the deterministic specs, split by the category\'s offer-level keys, and both hashes', async () => {
    specExtraction.extractSpecs.mockReturnValue({ weight: 17, frameSize: 43 });

    const result = await callExtractProduct(buildTask());

    expect(result.scrapedProduct).toMatchObject({
      specs: { weight: 17 },
      extractedSpecs: { weight: 17, frameSize: 43 },
      offerLevelDeterministicSpecs: { frameSize: 43 },
      productLevelDeterministicSpecs: { weight: 17 },
      offerSpecsHash: expect.any(String),
      productSpecsHash: expect.any(String),
    });
  });

  it('folds a dedicated release-year pipeline into modelYear', async () => {
    interpreter.runDetailPage.mockResolvedValueOnce({ ...detail, releaseYear: 2026 });

    const result = await callExtractProduct(buildTask());

    expect(result.scrapedProduct.extractedSpecs).toEqual({ modelYear: 2026 });
  });

  // Regression: a normalization pass (e.g. ProductSpecNormalizationService)
  // can map a key it can't type-convert as `result[key] = undefined` rather
  // than omitting it outright. Before offerLevelDeterministicSpecs/
  // productLevelDeterministicSpecs were filtered at the point they're built
  // (and hashed), that phantom key rode along into the hash but was later
  // stripped by ProductSourceRecordUpdaterService.processSpecs before
  // persistence — so two source records with byte-identical real specs could
  // get different offerSpecsHash/productSpecsHash values purely depending on
  // whether this noise key happened to be present, permanently defeating the
  // re-import skip.
  it('filters undefined-valued keys out before hashing, so a phantom key does not change the hash', async () => {
    specExtraction.extractSpecs.mockReturnValueOnce({ weight: 17, frameSize: 43, display: undefined });
    const withPhantomKey = await callExtractProduct(buildTask());

    specExtraction.extractSpecs.mockReturnValueOnce({ weight: 17, frameSize: 43 });
    const withoutPhantomKey = await callExtractProduct(buildTask());

    expect(withPhantomKey.scrapedProduct.productLevelDeterministicSpecs).toEqual({ weight: 17 });
    expect(withPhantomKey.scrapedProduct.offerSpecsHash).toBe(
      withoutPhantomKey.scrapedProduct.offerSpecsHash,
    );
    expect(withPhantomKey.scrapedProduct.productSpecsHash).toBe(
      withoutPhantomKey.scrapedProduct.productSpecsHash,
    );
  });

  it('skips extraction without a specMapping for the category', async () => {
    const task = buildTask();
    asScrapingConfig(task.source.config).detailPage.specMapping = {};

    const result = await callExtractProduct(task);

    expect(specExtraction.extractSpecs).not.toHaveBeenCalled();
    expect(result.scrapedProduct.extractedSpecs).toEqual({});
  });

  // Listing-level values arrive once the identity extraction has read them;
  // only an offer's own values (one variant of several on a page) come from here.
  it('gives an offer only its own specs', async () => {
    interpreter.runDetailPage.mockResolvedValueOnce({
      ...detail,
      rawOffers: [{ price: 1, specs: { frameSize: 48 } }, { price: 2 }],
    });

    const result = await callExtractProduct(buildTask());

    expect(result.scrapedProduct.offers.map((offer: { specs?: unknown }) => offer.specs)).toEqual([
      { frameSize: 48 },
      undefined,
    ]);
  });

  describe('identifiers', () => {
    it('carries the declared siblings and each offer\'s GTIN and MPN through', async () => {
      interpreter.runDetailPage.mockResolvedValueOnce({
        ...detail,
        siblingIds: ['1260040103', '1260040108', '1260040113'],
        rawOffers: [{ price: 3879000, gtin: '9008594503199', mpn: '1260040108' }],
      });

      const result = await callExtractProduct(buildTask());

      expect(result.scrapedProduct.siblingExternalIds).toEqual([
        '1260040103',
        '1260040108',
        '1260040113',
      ]);
      expect(result.scrapedProduct.offers).toEqual([
        expect.objectContaining({ gtin: '9008594503199', mpn: '1260040108' }),
      ]);
    });
  });
});

describe('ProductDetailsPageScraperService.dispatchVariantTasks', () => {
  let service: ProductDetailsPageScraperService;
  let importTaskPublisher: { dispatchIfNeeded: jest.Mock };

  function buildTask(frequency?: string): ProductImportTask {
    return {
      id: 'task-1',
      url: 'https://speedbike.hu/product/1',
      source: {
        id: 'source-1',
        name: 'speedbike',
        frequency,
        config: {},
      },
    } as unknown as ProductImportTask;
  }

  function callDispatchVariantTasks(task: ProductImportTask, offerLinks: Array<{ url: string; title?: string }>) {
    return (service as any).dispatchVariantTasks(task, {
      scrapedProduct: {} as any,
      offerLinks,
    });
  }

  beforeEach(() => {
    importTaskPublisher = {
      dispatchIfNeeded: jest.fn().mockResolvedValue({ dispatched: true, task: {} }),
    };

    service = new ProductDetailsPageScraperService(
      {} as any, // scraperService
      {} as any, // productUpdaterService
      {} as any, // scrapingMetrics
      {} as any, // interpreter
      {} as any, // runtime
      {} as any, // categoryConfigService
      {} as any, // specExtraction
      {} as any, // translationSelector
      {} as any, // translationService
      importTaskPublisher as any,
    );
  });

  it('does nothing when there are no offerLinks', async () => {
    const task = buildTask();

    await callDispatchVariantTasks(task, []);

    expect(importTaskPublisher.dispatchIfNeeded).not.toHaveBeenCalled();
  });

  it('dedupes offerLinks pointing at the same normalized URL into a single dispatch', async () => {
    const task = buildTask();

    await callDispatchVariantTasks(task, [
      { url: 'https://speedbike.hu/product/1-red', title: 'Red' },
      { url: 'https://speedbike.hu/product/1-red/', title: 'Red (again)' },
      { url: 'https://speedbike.hu/product/1-blue', title: 'Blue' },
    ]);

    expect(importTaskPublisher.dispatchIfNeeded).toHaveBeenCalledTimes(2);
    const dispatchedUrls = importTaskPublisher.dispatchIfNeeded.mock.calls.map(
      ([params]) => params.url,
    );
    expect(dispatchedUrls).toEqual([
      'https://speedbike.hu/product/1-red',
      'https://speedbike.hu/product/1-blue',
    ]);
  });

  it('passes a processedSince cutoff derived from the source frequency', async () => {
    const task = buildTask('1 day');
    const before = Date.now();

    await callDispatchVariantTasks(task, [{ url: 'https://speedbike.hu/product/1-red' }]);

    const [params] = importTaskPublisher.dispatchIfNeeded.mock.calls[0];
    expect(params.source).toBe(task.source);
    expect(params.kind).toBeDefined();
    const expectedCutoff = before - 24 * 60 * 60 * 1000;
    expect(params.processedSince.getTime()).toBeGreaterThanOrEqual(expectedCutoff - 1000);
    expect(params.processedSince.getTime()).toBeLessThanOrEqual(Date.now() - 24 * 60 * 60 * 1000 + 1000);
  });

  it('dispatches variants at the priority of the task that found them', async () => {
    const task = buildTask('1 day');
    task.priority = 90;

    await callDispatchVariantTasks(task, [{ url: 'https://speedbike.hu/product/1-red' }]);

    expect(importTaskPublisher.dispatchIfNeeded.mock.calls[0][0].priority).toBe(90);
  });

  it('defaults to a 7 day cutoff when frequency is unset', async () => {
    const task = buildTask(undefined);

    await callDispatchVariantTasks(task, [{ url: 'https://speedbike.hu/product/1-red' }]);

    const [params] = importTaskPublisher.dispatchIfNeeded.mock.calls[0];
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(params.processedSince.getTime()).toBeGreaterThanOrEqual(sevenDaysAgo - 1000);
    expect(params.processedSince.getTime()).toBeLessThanOrEqual(sevenDaysAgo + 1000);
  });

  it('does not throw when dispatchIfNeeded reports the URL is pending or recently processed', async () => {
    const task = buildTask();
    importTaskPublisher.dispatchIfNeeded.mockResolvedValueOnce({
      dispatched: false,
      reason: 'pending_task',
    });

    await expect(
      callDispatchVariantTasks(task, [{ url: 'https://speedbike.hu/product/1-red' }]),
    ).resolves.toBeUndefined();
  });

  it('isolates a failing dispatch for one link, continuing to dispatch the rest', async () => {
    const task = buildTask();
    importTaskPublisher.dispatchIfNeeded
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ dispatched: true, task: {} });

    await callDispatchVariantTasks(task, [
      { url: 'https://speedbike.hu/product/1-red' },
      { url: 'https://speedbike.hu/product/1-blue' },
    ]);

    expect(importTaskPublisher.dispatchIfNeeded).toHaveBeenCalledTimes(2);
  });
});
