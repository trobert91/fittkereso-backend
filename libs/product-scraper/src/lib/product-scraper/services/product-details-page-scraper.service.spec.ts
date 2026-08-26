import { ProductDetailsPageScraperService } from './product-details-page-scraper.service';
import type { DeterministicProductData } from '@fittkereso-backend/product';
import type {
  ProductCategory,
  ScrapeTask,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import { hashRawSpecs } from '@fittkereso-backend/utils';

describe('ProductDetailsPageScraperService', () => {
  let service: ProductDetailsPageScraperService;
  let categoryConfigService: { getGoldenSample: jest.Mock; getConfig: jest.Mock };
  let postProcess: { process: jest.Mock };
  let postProcessMerge: { merge: jest.Mock };

  const jsonSchema: SpecDefinitionJsonSchema = {
    type: 'object',
    title: 'E-bike',
    properties: {},
  };

  const data: DeterministicProductData = {
    brand: 'KTM',
    model: 'Macina Scarp',
    specs: { weight: 17 },
    releaseYear: 2024,
  };

  function buildTask(postProcessConfig?: { enabled: boolean; model?: string }): ScrapeTask {
    return {
      id: 'task-1',
      url: 'https://speedbike.hu/product/1',
      source: {
        name: 'speedbike',
        config: {
          detailPage: {
            postProcess: postProcessConfig,
          },
        },
      },
    } as unknown as ScrapeTask;
  }

  beforeEach(() => {
    categoryConfigService = {
      getGoldenSample: jest.fn(),
      getConfig: jest.fn().mockReturnValue(undefined),
    };
    postProcess = { process: jest.fn() };
    postProcessMerge = { merge: jest.fn() };

    service = new ProductDetailsPageScraperService(
      {} as any, // scraperService
      {} as any, // productUpdaterService
      {} as any, // scrapingMetrics
      {} as any, // interpreter
      {} as any, // runtime
      categoryConfigService as any,
      {} as any, // specExtraction
      postProcess as any,
      postProcessMerge as any,
      {} as any, // translationSelector
      {} as any, // translationService
      {} as any, // sourceRecordRepo
      {} as any, // scrapeTaskPublisher
    );
  });

  function callMaybePostProcess(task: ScrapeTask) {
    return (service as any).maybePostProcess({
      task,
      data,
      rawSpecs: [],
      jsonSchema,
      categorySlug: 'ebikes',
    });
  }

  it('skips the LLM call and merges with undefined when post-processing is disabled', async () => {
    const task = buildTask(undefined);
    const merged = { ...data };
    postProcessMerge.merge.mockReturnValueOnce(merged);

    const result = await callMaybePostProcess(task);

    expect(postProcess.process).not.toHaveBeenCalled();
    expect(postProcessMerge.merge).toHaveBeenCalledWith(data, undefined);
    expect(result).toBe(merged);
  });

  it('skips the LLM call and merges with undefined when the category has no golden sample', async () => {
    const task = buildTask({ enabled: true });
    categoryConfigService.getGoldenSample.mockReturnValueOnce(undefined);
    const merged = { ...data };
    postProcessMerge.merge.mockReturnValueOnce(merged);

    const result = await callMaybePostProcess(task);

    expect(postProcess.process).not.toHaveBeenCalled();
    expect(postProcessMerge.merge).toHaveBeenCalledWith(data, undefined);
    expect(result).toBe(merged);
  });

  it('calls postProcess.process with the deterministic data and merges its result when enabled with a golden sample', async () => {
    const task = buildTask({ enabled: true, model: 'custom-model' });
    const goldenSample = { weight: 22 };
    categoryConfigService.getGoldenSample.mockReturnValueOnce(goldenSample);
    const llmContribution = { specs: { motorPosition: 'Középmotor' } };
    postProcess.process.mockResolvedValueOnce(llmContribution);
    const merged = { ...data, specs: { ...data.specs, motorPosition: 'Középmotor' } };
    postProcessMerge.merge.mockReturnValueOnce(merged);

    const result = await callMaybePostProcess(task);

    expect(postProcess.process).toHaveBeenCalledWith({
      data,
      rawSpecs: [],
      schema: jsonSchema,
      goldenSample,
      model: 'custom-model',
      offerLevelSpecs: undefined,
    });
    expect(postProcessMerge.merge).toHaveBeenCalledWith(data, llmContribution);
    expect(result).toBe(merged);
  });

  it('passes the category offerLevelSpecs config through to postProcess.process', async () => {
    const task = buildTask({ enabled: true });
    categoryConfigService.getGoldenSample.mockReturnValueOnce({ weight: 22 });
    categoryConfigService.getConfig.mockReturnValueOnce({
      offerLevelSpecs: ['frameSize', 'color'],
    });
    postProcess.process.mockResolvedValueOnce(undefined);
    postProcessMerge.merge.mockReturnValueOnce(data);

    await callMaybePostProcess(task);

    expect(postProcess.process).toHaveBeenCalledWith(
      expect.objectContaining({ offerLevelSpecs: ['frameSize', 'color'] }),
    );
  });
});

describe('ProductDetailsPageScraperService.extractProduct', () => {
  let service: ProductDetailsPageScraperService;
  let interpreter: { runDetailPage: jest.Mock };
  let runtime: { getCategoryBySlug: jest.Mock };
  let categoryConfigService: {
    getJsonSchema: jest.Mock;
    getConfig: jest.Mock;
    getGoldenSample: jest.Mock;
  };
  let sourceRecordRepo: {
    findBySourceAndExternalId: jest.Mock;
    findByUrl: jest.Mock;
  };
  let postProcessMerge: { merge: jest.Mock };

  const category = { id: 'cat-1', slug: 'ebikes', name: 'Ebikes' } as ProductCategory;
  const jsonSchema: SpecDefinitionJsonSchema = {
    type: 'object',
    title: 'E-bike',
    properties: {},
  };

  function buildTask(force = false): ScrapeTask {
    return {
      id: 'task-1',
      url: 'https://speedbike.hu/product/1',
      force,
      source: {
        name: 'speedbike',
        config: {
          categories: { ebikes: { enabled: true } },
          detailPage: { specMapping: {}, postProcess: undefined },
        },
      },
    } as unknown as ScrapeTask;
  }

  // "raw title" is speedbike.hu's uncleaned marketing title — the exact
  // scenario originalName exists to preserve.
  const detail = {
    categorySlug: 'ebikes',
    brand: 'KTM',
    model: 'KTM Macina Scarp SX Prestige Di2 M/43 Olive Pearl',
    rawSpecs: [],
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
      getConfig: jest.fn().mockReturnValue(undefined),
      getGoldenSample: jest.fn().mockReturnValue(undefined),
    };
    sourceRecordRepo = {
      findBySourceAndExternalId: jest.fn().mockResolvedValue(null),
      findByUrl: jest.fn().mockResolvedValue(null),
    };
    postProcessMerge = {
      merge: jest.fn().mockImplementation((data) => data),
    };

    service = new ProductDetailsPageScraperService(
      {} as any, // scraperService
      {} as any, // productUpdaterService
      { recordExtractionSkipReason: jest.fn() } as any, // scrapingMetrics
      interpreter as any,
      runtime as any,
      categoryConfigService as any,
      { extractSpecs: jest.fn().mockReturnValue({}) } as any, // specExtraction
      {} as any, // postProcess
      postProcessMerge as any,
      {} as any, // translationSelector
      {} as any, // translationService
      sourceRecordRepo as any,
      {} as any, // scrapeTaskPublisher
    );
  });

  function callExtractProduct(task: ScrapeTask) {
    return (service as any).extractProduct(task, {} as any);
  }

  it('carries the raw scraped title through as originalName alongside the cleaned model', async () => {
    const task = buildTask();

    const result = await callExtractProduct(task);

    expect(result.scrapedProduct.model).toBe(detail.model);
    expect(result.scrapedProduct.originalName).toBe(detail.model);
  });

  it('sets originalName on the raw-specs-unchanged fast path too', async () => {
    const task = buildTask();
    sourceRecordRepo.findBySourceAndExternalId.mockResolvedValueOnce({
      rawSpecsHash: hashRawSpecs(detail.rawSpecs),
      model: { model: 'Reused Model Name' },
    });

    const result = await callExtractProduct(task);

    expect(result.scrapedProduct.model).toBe('Reused Model Name');
    expect(result.scrapedProduct.originalName).toBe(detail.model);
  });

  it('carries the pre-LLM deterministic specs through alongside the post-process-merged specs', async () => {
    const task = buildTask();
    task.source.config.detailPage.specMapping = { ebikes: { mappings: [] } };
    const deterministicSpecs = { weight: 17 };
    const specExtraction = { extractSpecs: jest.fn().mockReturnValue(deterministicSpecs) };
    (service as any).specExtraction = specExtraction;
    postProcessMerge.merge.mockImplementation((data) => ({
      ...data,
      specs: { ...data.specs, motorPosition: 'Középmotor' },
    }));

    const result = await callExtractProduct(task);

    expect(result.scrapedProduct.extractedSpecs).toBe(deterministicSpecs);
    expect(result.scrapedProduct.specs).toEqual({ weight: 17, motorPosition: 'Középmotor' });
  });

  it('leaves extractedSpecs undefined on the raw-specs-unchanged fast path', async () => {
    const task = buildTask();
    sourceRecordRepo.findBySourceAndExternalId.mockResolvedValueOnce({
      rawSpecsHash: hashRawSpecs(detail.rawSpecs),
      model: { model: 'Reused Model Name' },
    });

    const result = await callExtractProduct(task);

    expect(result.scrapedProduct.extractedSpecs).toBeUndefined();
    expect(result.scrapedProduct.specs).toBeUndefined();
  });

  // Regression: on the raw-specs-unchanged fast path, offer-level keys
  // (e.g. frameSize/color) used to be hardcoded to {}. A first attempted fix
  // picked them from existingSource.scrapedProduct.specs, but that field
  // structurally never carries offer-level keys — they're omit()'d before
  // being persisted there (see the non-fast-path branch's
  // pageOfferLevelSpecs/strippedSpecs split). The only place they survive
  // across scrapes is the previously-persisted Offer row itself, so that's
  // what the fast path must read from.
  it('picks offer-level specs from the existing Offer row on the raw-specs-unchanged fast path', async () => {
    const task = buildTask();
    const detailWithOffer = {
      ...detail,
      rawOffers: [{ price: 3359000 }],
    };
    interpreter.runDetailPage.mockResolvedValueOnce(detailWithOffer);
    categoryConfigService.getConfig.mockReturnValue({
      offerLevelSpecs: ['frameSize', 'color'],
    });
    sourceRecordRepo.findBySourceAndExternalId.mockResolvedValueOnce({
      rawSpecsHash: hashRawSpecs(detailWithOffer.rawSpecs),
      model: { model: 'Reused Model Name' },
      // scrapedProduct.specs deliberately has no frameSize/color — proving
      // the fix doesn't (and structurally can't) read offer-level keys from
      // here.
      scrapedProduct: { specs: { motorPosition: 'Középmotor' } },
      offers: [
        {
          externalId: 'sku-1',
          specs: { frameSize: 48, color: 'Olíva' },
        },
      ],
    });

    const result = await callExtractProduct(task);

    expect(result.offerLevelSpecs).toEqual({ frameSize: 48, color: 'Olíva' });
    expect(result.scrapedProduct.offers).toEqual([
      expect.objectContaining({
        price: 3359000,
        specs: { frameSize: 48, color: 'Olíva' },
      }),
    ]);
  });

  it('falls back to the record\'s single offer when externalId does not match any of them', async () => {
    const task = buildTask();
    const detailWithOffer = {
      ...detail,
      externalId: 'sku-different',
      rawOffers: [{ price: 3359000 }],
    };
    interpreter.runDetailPage.mockResolvedValueOnce(detailWithOffer);
    categoryConfigService.getConfig.mockReturnValue({
      offerLevelSpecs: ['frameSize'],
    });
    sourceRecordRepo.findBySourceAndExternalId.mockResolvedValueOnce({
      rawSpecsHash: hashRawSpecs(detailWithOffer.rawSpecs),
      model: { model: 'Reused Model Name' },
      scrapedProduct: { specs: {} },
      offers: [{ externalId: 'sku-1', specs: { frameSize: 53 } }],
    });

    const result = await callExtractProduct(task);

    expect(result.offerLevelSpecs).toEqual({ frameSize: 53 });
  });
});

describe('ProductDetailsPageScraperService.dispatchVariantTasks', () => {
  let service: ProductDetailsPageScraperService;
  let scrapeTaskPublisher: { dispatchIfNeeded: jest.Mock };

  function buildTask(fullSyncInterval?: string): ScrapeTask {
    return {
      id: 'task-1',
      url: 'https://speedbike.hu/product/1',
      source: {
        id: 'source-1',
        name: 'speedbike',
        fullSyncInterval,
        config: {},
      },
    } as unknown as ScrapeTask;
  }

  function callDispatchVariantTasks(task: ScrapeTask, offerLinks: Array<{ url: string; title?: string }>) {
    return (service as any).dispatchVariantTasks(task, {
      scrapedProduct: {} as any,
      offerLevelSpecs: {},
      offerLinks,
    });
  }

  beforeEach(() => {
    scrapeTaskPublisher = {
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
      {} as any, // postProcess
      {} as any, // postProcessMerge
      {} as any, // translationSelector
      {} as any, // translationService
      {} as any, // sourceRecordRepo
      scrapeTaskPublisher as any,
    );
  });

  it('does nothing when there are no offerLinks', async () => {
    const task = buildTask();

    await callDispatchVariantTasks(task, []);

    expect(scrapeTaskPublisher.dispatchIfNeeded).not.toHaveBeenCalled();
  });

  it('dedupes offerLinks pointing at the same normalized URL into a single dispatch', async () => {
    const task = buildTask();

    await callDispatchVariantTasks(task, [
      { url: 'https://speedbike.hu/product/1-red', title: 'Red' },
      { url: 'https://speedbike.hu/product/1-red/', title: 'Red (again)' },
      { url: 'https://speedbike.hu/product/1-blue', title: 'Blue' },
    ]);

    expect(scrapeTaskPublisher.dispatchIfNeeded).toHaveBeenCalledTimes(2);
    const dispatchedUrls = scrapeTaskPublisher.dispatchIfNeeded.mock.calls.map(
      ([params]) => params.url,
    );
    expect(dispatchedUrls).toEqual([
      'https://speedbike.hu/product/1-red',
      'https://speedbike.hu/product/1-blue',
    ]);
  });

  it('passes a processedSince cutoff derived from the source fullSyncInterval', async () => {
    const task = buildTask('1 day');
    const before = Date.now();

    await callDispatchVariantTasks(task, [{ url: 'https://speedbike.hu/product/1-red' }]);

    const [params] = scrapeTaskPublisher.dispatchIfNeeded.mock.calls[0];
    expect(params.source).toBe(task.source);
    expect(params.queue).toBeDefined();
    const expectedCutoff = before - 24 * 60 * 60 * 1000;
    expect(params.processedSince.getTime()).toBeGreaterThanOrEqual(expectedCutoff - 1000);
    expect(params.processedSince.getTime()).toBeLessThanOrEqual(Date.now() - 24 * 60 * 60 * 1000 + 1000);
  });

  it('defaults to a 7 day cutoff when fullSyncInterval is unset', async () => {
    const task = buildTask(undefined);

    await callDispatchVariantTasks(task, [{ url: 'https://speedbike.hu/product/1-red' }]);

    const [params] = scrapeTaskPublisher.dispatchIfNeeded.mock.calls[0];
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(params.processedSince.getTime()).toBeGreaterThanOrEqual(sevenDaysAgo - 1000);
    expect(params.processedSince.getTime()).toBeLessThanOrEqual(sevenDaysAgo + 1000);
  });

  it('does not throw when dispatchIfNeeded reports the URL is pending or recently processed', async () => {
    const task = buildTask();
    scrapeTaskPublisher.dispatchIfNeeded.mockResolvedValueOnce({
      dispatched: false,
      reason: 'pending_task',
    });

    await expect(
      callDispatchVariantTasks(task, [{ url: 'https://speedbike.hu/product/1-red' }]),
    ).resolves.toBeUndefined();
  });

  it('isolates a failing dispatch for one link, continuing to dispatch the rest', async () => {
    const task = buildTask();
    scrapeTaskPublisher.dispatchIfNeeded
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ dispatched: true, task: {} });

    await callDispatchVariantTasks(task, [
      { url: 'https://speedbike.hu/product/1-red' },
      { url: 'https://speedbike.hu/product/1-blue' },
    ]);

    expect(scrapeTaskPublisher.dispatchIfNeeded).toHaveBeenCalledTimes(2);
  });
});
