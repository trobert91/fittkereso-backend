import { ProductDetailsPageScraperService } from './product-details-page-scraper.service';
import type { DeterministicProductData } from '@fittkereso-backend/product';
import type {
  ProductCategory,
  ScrapeTask,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import { hashSpecs } from '@fittkereso-backend/utils';

describe('ProductDetailsPageScraperService.maybePostProcess', () => {
  let service: ProductDetailsPageScraperService;
  let categoryConfigService: { getGoldenSample: jest.Mock; getConfig: jest.Mock };
  let postProcess: { processOfferIdentity: jest.Mock; processModelSpecs: jest.Mock };
  let postProcessMerge: { merge: jest.Mock };
  let sourceRecordRepo: { findBySourceAndProductSpecsHash: jest.Mock };

  const jsonSchema: SpecDefinitionJsonSchema = {
    type: 'object',
    title: 'E-bike',
    properties: {},
  };

  const data: DeterministicProductData = {
    brand: 'KTM',
    model: 'Macina Scarp',
    specs: { weight: 17, modelYear: 2024 },
  };

  function buildTask(
    postProcessConfig?: {
      enabled: boolean;
      model?: string;
      includeDescriptionInOfferIdentity?: boolean;
      includeDescriptionInModelSpecs?: boolean;
    },
    force = false,
  ): ScrapeTask {
    return {
      id: 'task-1',
      url: 'https://speedbike.hu/product/1',
      force,
      source: {
        id: 'source-1',
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
    postProcess = {
      processOfferIdentity: jest.fn(),
      processModelSpecs: jest.fn(),
    };
    postProcessMerge = { merge: jest.fn() };
    sourceRecordRepo = { findBySourceAndProductSpecsHash: jest.fn().mockResolvedValue(null) };

    service = new ProductDetailsPageScraperService(
      {} as any, // scraperService
      {} as any, // productUpdaterService
      { recordExtractionSkipReason: jest.fn() } as any, // scrapingMetrics
      {} as any, // interpreter
      {} as any, // runtime
      categoryConfigService as any,
      {} as any, // specExtraction
      postProcess as any,
      postProcessMerge as any,
      {} as any, // translationSelector
      {} as any, // translationService
      sourceRecordRepo as any,
      {} as any, // scrapeTaskPublisher
    );
  });

  const productLevelDeterministicSpecs = {
    weight: 17,
    motorPosition: 'Középmotor',
    torque: 60,
  };
  const productSpecsHash = hashSpecs(productLevelDeterministicSpecs);

  function callMaybePostProcess(
    task: ScrapeTask,
    overrides: Partial<Record<string, unknown>> = {},
  ) {
    return (service as any).maybePostProcess({
      task,
      data,
      offerLevelDeterministicSpecs: {},
      productLevelDeterministicSpecs,
      rawSpecs: [],
      productSpecsHash,
      jsonSchema,
      categorySlug: 'ebikes',
      offerIdentitySameRecordHit: false,
      existingSource: undefined,
      existingOfferForSpecs: undefined,
      offerLevelKeys: [],
      ...overrides,
    });
  }

  it('skips both LLM calls and merges with undefined when post-processing is disabled', async () => {
    const task = buildTask(undefined);
    const merged = { ...data };
    postProcessMerge.merge.mockReturnValueOnce(merged);

    const result = await callMaybePostProcess(task);

    expect(postProcess.processOfferIdentity).not.toHaveBeenCalled();
    expect(postProcess.processModelSpecs).not.toHaveBeenCalled();
    expect(postProcessMerge.merge).toHaveBeenCalledWith(data, undefined, undefined);
    expect(result).toBe(merged);
  });

  it('skips both LLM calls and merges with undefined when the category has no golden sample', async () => {
    const task = buildTask({ enabled: true });
    categoryConfigService.getGoldenSample.mockReturnValueOnce(undefined);
    const merged = { ...data };
    postProcessMerge.merge.mockReturnValueOnce(merged);

    const result = await callMaybePostProcess(task);

    expect(postProcess.processOfferIdentity).not.toHaveBeenCalled();
    expect(postProcess.processModelSpecs).not.toHaveBeenCalled();
    expect(postProcessMerge.merge).toHaveBeenCalledWith(data, undefined, undefined);
    expect(result).toBe(merged);
  });

  it('calls both LLM methods and merges their results when enabled with a golden sample', async () => {
    const task = buildTask({ enabled: true, model: 'custom-model' });
    const goldenSample = { weight: 22 };
    categoryConfigService.getGoldenSample.mockReturnValueOnce(goldenSample);
    const offerIdentity = { specs: { frameSize: 43 } };
    const modelSpecs = { specs: { motorPosition: 'Középmotor' } };
    postProcess.processOfferIdentity.mockResolvedValueOnce(offerIdentity);
    postProcess.processModelSpecs.mockResolvedValueOnce(modelSpecs);
    const merged = { ...data, specs: { ...data.specs, motorPosition: 'Középmotor', frameSize: 43 } };
    postProcessMerge.merge.mockReturnValueOnce(merged);

    const result = await callMaybePostProcess(task, { offerLevelDeterministicSpecs: { frameSize: 43 } });

    expect(postProcess.processOfferIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ specs: { frameSize: 43 } }),
        schema: jsonSchema,
        goldenSample,
        offerLevelSpecs: [],
        model: 'custom-model',
      }),
    );
    expect(postProcess.processModelSpecs).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ specs: productLevelDeterministicSpecs }),
        schema: jsonSchema,
        goldenSample,
        offerLevelSpecs: [],
        model: 'custom-model',
      }),
    );
    expect(postProcessMerge.merge).toHaveBeenCalledWith(data, offerIdentity, modelSpecs);
    expect(result).toBe(merged);
  });

  it('passes the category offerLevelSpecs config through to both LLM calls', async () => {
    const task = buildTask({ enabled: true });
    categoryConfigService.getGoldenSample.mockReturnValueOnce({ weight: 22 });
    postProcess.processOfferIdentity.mockResolvedValueOnce(undefined);
    postProcess.processModelSpecs.mockResolvedValueOnce(undefined);
    postProcessMerge.merge.mockReturnValueOnce(data);

    await callMaybePostProcess(task, { offerLevelKeys: ['frameSize', 'color'] });

    expect(postProcess.processOfferIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ offerLevelSpecs: ['frameSize', 'color'] }),
    );
    expect(postProcess.processModelSpecs).toHaveBeenCalledWith(
      expect.objectContaining({ offerLevelSpecs: ['frameSize', 'color'] }),
    );
  });

  describe('description toggles', () => {
    beforeEach(() => {
      categoryConfigService.getGoldenSample.mockReturnValue({ weight: 22 });
      postProcess.processOfferIdentity.mockResolvedValue(undefined);
      postProcess.processModelSpecs.mockResolvedValue(undefined);
      postProcessMerge.merge.mockReturnValue(data);
    });

    it('withholds description from offer-identity but forwards it to model-spec by default', async () => {
      const task = buildTask({ enabled: true });

      await callMaybePostProcess(task, { description: 'Marketing blurb' });

      expect(postProcess.processOfferIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ description: undefined }),
      );
      expect(postProcess.processModelSpecs).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Marketing blurb' }),
      );
    });

    it('forwards description to offer-identity when includeDescriptionInOfferIdentity is true', async () => {
      const task = buildTask({
        enabled: true,
        includeDescriptionInOfferIdentity: true,
      });

      await callMaybePostProcess(task, { description: 'Marketing blurb' });

      expect(postProcess.processOfferIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Marketing blurb' }),
      );
    });

    it('withholds description from model-spec when includeDescriptionInModelSpecs is false', async () => {
      const task = buildTask({
        enabled: true,
        includeDescriptionInModelSpecs: false,
      });

      await callMaybePostProcess(task, { description: 'Marketing blurb' });

      expect(postProcess.processModelSpecs).toHaveBeenCalledWith(
        expect.objectContaining({ description: undefined }),
      );
    });
  });

  it('reuses offer-level specs from the existing offer instead of calling processOfferIdentity on a same-record hit', async () => {
    const task = buildTask({ enabled: true });
    categoryConfigService.getGoldenSample.mockReturnValueOnce({ weight: 22 });
    postProcess.processModelSpecs.mockResolvedValueOnce(undefined);
    postProcessMerge.merge.mockReturnValueOnce(data);

    await callMaybePostProcess(task, {
      offerIdentitySameRecordHit: true,
      existingOfferForSpecs: { specs: { frameSize: 48, color: 'Olíva' } },
      offerLevelKeys: ['frameSize', 'color'],
    });

    expect(postProcess.processOfferIdentity).not.toHaveBeenCalled();
    expect(postProcessMerge.merge).toHaveBeenCalledWith(
      data,
      { specs: { frameSize: 48, color: 'Olíva' } },
      undefined,
    );
  });

  it('reuses product-level specs from existingSource instead of calling processModelSpecs on a same-record productSpecsHash hit', async () => {
    const task = buildTask({ enabled: true });
    categoryConfigService.getGoldenSample.mockReturnValueOnce({ weight: 22 });
    postProcess.processOfferIdentity.mockResolvedValueOnce(undefined);
    postProcessMerge.merge.mockReturnValueOnce(data);

    await callMaybePostProcess(task, {
      existingSource: {
        productSpecsHash,
        scrapedProduct: { productLevelDeterministicSpecs },
      },
    });

    expect(postProcess.processModelSpecs).not.toHaveBeenCalled();
    expect(sourceRecordRepo.findBySourceAndProductSpecsHash).not.toHaveBeenCalled();
    expect(postProcessMerge.merge).toHaveBeenCalledWith(
      data,
      undefined,
      { specs: productLevelDeterministicSpecs },
    );
  });

  it('reuses product-level specs from a sibling source record when no same-record hit exists', async () => {
    const task = buildTask({ enabled: true });
    categoryConfigService.getGoldenSample.mockReturnValueOnce({ weight: 22 });
    postProcess.processOfferIdentity.mockResolvedValueOnce(undefined);
    postProcessMerge.merge.mockReturnValueOnce(data);
    sourceRecordRepo.findBySourceAndProductSpecsHash.mockResolvedValueOnce({
      id: 'sibling-source-id',
      url: 'https://speedbike.hu/product/1-blue',
      lastUpdated: new Date('2026-01-01'),
      scrapedProduct: { productLevelDeterministicSpecs },
    });

    await callMaybePostProcess(task);

    expect(sourceRecordRepo.findBySourceAndProductSpecsHash).toHaveBeenCalledWith(
      'source-1',
      productSpecsHash,
    );
    expect(postProcess.processModelSpecs).not.toHaveBeenCalled();
    expect(postProcessMerge.merge).toHaveBeenCalledWith(
      data,
      undefined,
      { specs: productLevelDeterministicSpecs },
    );
  });

  it('falls through to processModelSpecs when a sibling is found but its productLevelDeterministicSpecs is undefined', async () => {
    const task = buildTask({ enabled: true });
    categoryConfigService.getGoldenSample.mockReturnValueOnce({ weight: 22 });
    postProcess.processOfferIdentity.mockResolvedValueOnce(undefined);
    postProcess.processModelSpecs.mockResolvedValueOnce({ specs: { weight: 22 } });
    postProcessMerge.merge.mockReturnValueOnce(data);
    sourceRecordRepo.findBySourceAndProductSpecsHash.mockResolvedValueOnce({
      id: 'sibling-source-id',
      scrapedProduct: undefined,
    });

    await callMaybePostProcess(task);

    expect(postProcess.processModelSpecs).toHaveBeenCalled();
  });

  it('skips the sibling lookup entirely and always calls both LLM methods when task.force is set', async () => {
    const task = buildTask({ enabled: true }, true);
    categoryConfigService.getGoldenSample.mockReturnValueOnce({ weight: 22 });
    postProcess.processOfferIdentity.mockResolvedValueOnce(undefined);
    postProcess.processModelSpecs.mockResolvedValueOnce(undefined);
    postProcessMerge.merge.mockReturnValueOnce(data);

    await callMaybePostProcess(task, {
      existingSource: { productSpecsHash, scrapedProduct: { productLevelDeterministicSpecs } },
    });

    expect(sourceRecordRepo.findBySourceAndProductSpecsHash).not.toHaveBeenCalled();
    expect(postProcess.processModelSpecs).toHaveBeenCalled();
  });

  it('skips the sibling lookup when productLevelDeterministicSpecs is below the minimum-key threshold', async () => {
    const task = buildTask({ enabled: true });
    categoryConfigService.getGoldenSample.mockReturnValueOnce({ weight: 22 });
    postProcess.processOfferIdentity.mockResolvedValueOnce(undefined);
    postProcess.processModelSpecs.mockResolvedValueOnce(undefined);
    postProcessMerge.merge.mockReturnValueOnce(data);

    await callMaybePostProcess(task, {
      productLevelDeterministicSpecs: { weight: 22 }, // only 1 key, below MIN_PRODUCT_SPEC_KEYS_FOR_SIBLING_REUSE
    });

    expect(sourceRecordRepo.findBySourceAndProductSpecsHash).not.toHaveBeenCalled();
    expect(postProcess.processModelSpecs).toHaveBeenCalled();
  });

  describe('logging', () => {
    let logger: { debug: jest.Mock };

    beforeEach(() => {
      logger = { debug: jest.fn() };
      (service as any).logger = logger;
    });

    it('logs when the offer-identity call actually runs, with the offer-level key count', async () => {
      const task = buildTask({ enabled: true });
      categoryConfigService.getGoldenSample.mockReturnValueOnce({ weight: 22 });
      postProcess.processOfferIdentity.mockResolvedValueOnce(undefined);
      postProcess.processModelSpecs.mockResolvedValueOnce(undefined);
      postProcessMerge.merge.mockReturnValueOnce(data);

      await callMaybePostProcess(task, { offerLevelDeterministicSpecs: { frameSize: 43 } });

      expect(logger.debug).toHaveBeenCalledWith(
        'Running offer-identity LLM call',
        expect.objectContaining({ taskId: 'task-1', url: task.url, offerLevelKeyCount: 1 }),
      );
    });

    it('logs when the model-spec call actually runs, with the product-level key count', async () => {
      const task = buildTask({ enabled: true });
      categoryConfigService.getGoldenSample.mockReturnValueOnce({ weight: 22 });
      postProcess.processOfferIdentity.mockResolvedValueOnce(undefined);
      postProcess.processModelSpecs.mockResolvedValueOnce(undefined);
      postProcessMerge.merge.mockReturnValueOnce(data);

      await callMaybePostProcess(task);

      expect(logger.debug).toHaveBeenCalledWith(
        'Running model-spec LLM call',
        expect.objectContaining({
          taskId: 'task-1',
          url: task.url,
          productSpecsHash,
          productLevelKeyCount: Object.keys(productLevelDeterministicSpecs).length,
        }),
      );
    });

    it('logs a sibling hit with the sibling identifying fields', async () => {
      const task = buildTask({ enabled: true });
      categoryConfigService.getGoldenSample.mockReturnValueOnce({ weight: 22 });
      postProcess.processOfferIdentity.mockResolvedValueOnce(undefined);
      postProcessMerge.merge.mockReturnValueOnce(data);
      const siblingLastUpdated = new Date('2026-01-01');
      sourceRecordRepo.findBySourceAndProductSpecsHash.mockResolvedValueOnce({
        id: 'sibling-source-id',
        url: 'https://speedbike.hu/product/1-blue',
        lastUpdated: siblingLastUpdated,
        scrapedProduct: { productLevelDeterministicSpecs },
      });

      await callMaybePostProcess(task);

      expect(logger.debug).toHaveBeenCalledWith(
        'Product specs match a sibling source record, reusing its unified model-level specs',
        expect.objectContaining({
          taskId: 'task-1',
          url: task.url,
          productSpecsHash,
          siblingSourceId: 'sibling-source-id',
          siblingUrl: 'https://speedbike.hu/product/1-blue',
          siblingLastUpdated,
        }),
      );
    });
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
    findBySourceAndProductSpecsHash: jest.Mock;
  };
  let postProcessMerge: { merge: jest.Mock };
  let postProcess: { processOfferIdentity: jest.Mock; processModelSpecs: jest.Mock };

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
        id: 'source-1',
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
      findBySourceAndProductSpecsHash: jest.fn().mockResolvedValue(null),
    };
    postProcessMerge = {
      merge: jest.fn().mockImplementation((data) => data),
    };
    postProcess = {
      processOfferIdentity: jest.fn().mockResolvedValue(undefined),
      processModelSpecs: jest.fn().mockResolvedValue(undefined),
    };

    service = new ProductDetailsPageScraperService(
      {} as any, // scraperService
      {} as any, // productUpdaterService
      { recordExtractionSkipReason: jest.fn() } as any, // scrapingMetrics
      interpreter as any,
      runtime as any,
      categoryConfigService as any,
      { extractSpecs: jest.fn().mockReturnValue({}) } as any, // specExtraction
      postProcess as any,
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

  it('sets originalName on the both-hashes-unchanged fast path too', async () => {
    const task = buildTask();
    sourceRecordRepo.findBySourceAndExternalId.mockResolvedValueOnce({
      offerSpecsHash: hashSpecs({}),
      productSpecsHash: hashSpecs({}),
      model: { model: 'Reused Model Name' },
    });

    const result = await callExtractProduct(task);

    expect(result.scrapedProduct.model).toBe('Reused Model Name');
    expect(result.scrapedProduct.originalName).toBe(detail.model);
    expect(postProcess.processOfferIdentity).not.toHaveBeenCalled();
    expect(postProcess.processModelSpecs).not.toHaveBeenCalled();
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

  it('computes offerLevelDeterministicSpecs/productLevelDeterministicSpecs by splitting the deterministic mapping via offerLevelSpecs config', async () => {
    const task = buildTask();
    task.source.config.detailPage.specMapping = { ebikes: { mappings: [] } };
    const deterministicSpecs = { weight: 17, frameSize: 43 };
    (service as any).specExtraction = {
      extractSpecs: jest.fn().mockReturnValue(deterministicSpecs),
    };
    categoryConfigService.getConfig.mockReturnValue({ offerLevelSpecs: ['frameSize'] });

    const result = await callExtractProduct(task);

    expect(result.scrapedProduct.offerLevelDeterministicSpecs).toEqual({ frameSize: 43 });
    expect(result.scrapedProduct.productLevelDeterministicSpecs).toEqual({ weight: 17 });
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
  // same-record skip and the cross-sibling reuse lookup.
  it('filters undefined-valued keys out of offerLevelDeterministicSpecs/productLevelDeterministicSpecs before hashing, so a phantom key does not change the hash', async () => {
    const task = buildTask();
    task.source.config.detailPage.specMapping = { ebikes: { mappings: [] } };
    const deterministicSpecsWithPhantomKey = {
      weight: 17,
      frameSize: 43,
      display: undefined,
    };
    const deterministicSpecsWithoutPhantomKey = { weight: 17, frameSize: 43 };
    categoryConfigService.getConfig.mockReturnValue({ offerLevelSpecs: ['frameSize'] });

    (service as any).specExtraction = {
      extractSpecs: jest.fn().mockReturnValue(deterministicSpecsWithPhantomKey),
    };
    const resultWithPhantomKey = await callExtractProduct(task);

    (service as any).specExtraction = {
      extractSpecs: jest.fn().mockReturnValue(deterministicSpecsWithoutPhantomKey),
    };
    const resultWithoutPhantomKey = await callExtractProduct(task);

    expect(resultWithPhantomKey.scrapedProduct.productLevelDeterministicSpecs).toEqual({
      weight: 17,
    });
    expect(resultWithPhantomKey.scrapedProduct.offerSpecsHash).toBe(
      resultWithoutPhantomKey.scrapedProduct.offerSpecsHash,
    );
    expect(resultWithPhantomKey.scrapedProduct.productSpecsHash).toBe(
      resultWithoutPhantomKey.scrapedProduct.productSpecsHash,
    );
  });

  it('leaves extractedSpecs undefined on the both-hashes-unchanged fast path', async () => {
    const task = buildTask();
    sourceRecordRepo.findBySourceAndExternalId.mockResolvedValueOnce({
      offerSpecsHash: hashSpecs({}),
      productSpecsHash: hashSpecs({}),
      model: { model: 'Reused Model Name' },
    });

    const result = await callExtractProduct(task);

    expect(result.scrapedProduct.extractedSpecs).toBeUndefined();
    expect(result.scrapedProduct.specs).toBeUndefined();
  });

  // Regression: on the both-hashes-unchanged fast path, offer-level keys
  // (e.g. frameSize/color) used to be hardcoded to {}. A first attempted fix
  // picked them from existingSource.scrapedProduct.specs, but that field
  // structurally never carries offer-level keys — they're omit()'d before
  // being persisted there (see the non-fast-path branch's
  // pageOfferLevelSpecs/strippedSpecs split). The only place they survive
  // across scrapes is the previously-persisted Offer row itself, so that's
  // what the fast path must read from.
  it('picks offer-level specs from the existing Offer row on the both-hashes-unchanged fast path', async () => {
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
      offerSpecsHash: hashSpecs({}),
      productSpecsHash: hashSpecs({}),
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
      offerSpecsHash: hashSpecs({}),
      productSpecsHash: hashSpecs({}),
      model: { model: 'Reused Model Name' },
      scrapedProduct: { specs: {} },
      offers: [{ externalId: 'sku-1', specs: { frameSize: 53 } }],
    });

    const result = await callExtractProduct(task);

    expect(result.offerLevelSpecs).toEqual({ frameSize: 53 });
  });

  it('only skips the offer-identity call when just offerSpecsHash matches, still running processModelSpecs', async () => {
    const task = buildTask();
    categoryConfigService.getGoldenSample.mockReturnValue({ weight: 22 });
    sourceRecordRepo.findBySourceAndExternalId.mockResolvedValueOnce({
      offerSpecsHash: hashSpecs({}),
      productSpecsHash: 'stale-hash',
      model: { model: 'Reused Model Name' },
    });

    await callExtractProduct(task);

    expect(postProcess.processOfferIdentity).not.toHaveBeenCalled();
    expect(postProcess.processModelSpecs).toHaveBeenCalled();
  });

  it('only skips the model-spec call when just productSpecsHash matches, still running processOfferIdentity', async () => {
    const task = buildTask();
    categoryConfigService.getGoldenSample.mockReturnValue({ weight: 22 });
    sourceRecordRepo.findBySourceAndExternalId.mockResolvedValueOnce({
      offerSpecsHash: 'stale-hash',
      productSpecsHash: hashSpecs({}),
      scrapedProduct: { productLevelDeterministicSpecs: {} },
      model: { model: 'Reused Model Name' },
    });

    await callExtractProduct(task);

    expect(postProcess.processOfferIdentity).toHaveBeenCalled();
    expect(postProcess.processModelSpecs).not.toHaveBeenCalled();
  });

  it('reuses a sibling record\'s product-level specs for a brand-new listing never scraped before', async () => {
    const task = buildTask();
    categoryConfigService.getGoldenSample.mockReturnValue({ weight: 22 });
    task.source.config.detailPage.specMapping = { ebikes: { mappings: [] } };
    const deterministicSpecs = { weight: 22, motorPosition: 'Bosch', torque: 60 };
    (service as any).specExtraction = {
      extractSpecs: jest.fn().mockReturnValue(deterministicSpecs),
    };
    // No existing record at all for this exact listing.
    sourceRecordRepo.findBySourceAndExternalId.mockResolvedValueOnce(null);
    sourceRecordRepo.findBySourceAndProductSpecsHash.mockResolvedValueOnce({
      id: 'sibling-id',
      url: 'https://speedbike.hu/product/1-blue',
      lastUpdated: new Date('2026-01-01'),
      scrapedProduct: { productLevelDeterministicSpecs: deterministicSpecs },
    });

    await callExtractProduct(task);

    expect(sourceRecordRepo.findBySourceAndProductSpecsHash).toHaveBeenCalledWith(
      'source-1',
      hashSpecs(deterministicSpecs),
    );
    expect(postProcess.processModelSpecs).not.toHaveBeenCalled();
    expect(postProcess.processOfferIdentity).toHaveBeenCalled();
  });

  it('never queries for a sibling when task.force is set', async () => {
    const task = buildTask(true);
    categoryConfigService.getGoldenSample.mockReturnValue({ weight: 22 });
    task.source.config.detailPage.specMapping = { ebikes: { mappings: [] } };
    (service as any).specExtraction = {
      extractSpecs: jest.fn().mockReturnValue({ weight: 22, motorPosition: 'Bosch', torque: 60 }),
    };

    await callExtractProduct(task);

    expect(sourceRecordRepo.findBySourceAndProductSpecsHash).not.toHaveBeenCalled();
    expect(postProcess.processModelSpecs).toHaveBeenCalled();
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
