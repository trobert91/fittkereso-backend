import { SpecPostProcessService } from './spec-post-process.service';
import type { DeterministicProductData } from '@fittkereso-backend/product';
import type {
  ProductSource,
  ScrapeTask,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import { hashSpecs } from '@fittkereso-backend/utils';
import { ProductImportContext } from '../../interfaces/product-import-context.interface';

describe('SpecPostProcessService', () => {
  let service: SpecPostProcessService;
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

  function buildCase(
    config?: {
      enabled: boolean;
      model?: string;
      includeDescriptionInOfferIdentity?: boolean;
      includeDescriptionInModelSpecs?: boolean;
    },
    force = false,
  ): { context: ProductImportContext; config: typeof config } {
    return {
      context: {
        url: 'https://speedbike.hu/product/1',
        force,
        source: { id: 'source-1', name: 'speedbike' } as ProductSource,
        // The scrape path sets this; a feed run does not. Both reach the same
        // code, which is the point of the extraction.
        task: { id: 'task-1' } as ScrapeTask,
      },
      config,
    };
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

    service = new SpecPostProcessService(
      categoryConfigService as any,
      postProcess as any,
      postProcessMerge as any,
      sourceRecordRepo as any,
      { recordExtractionSkipReason: jest.fn() } as any,
    );
  });

  const productLevelDeterministicSpecs = {
    weight: 17,
    motorPosition: 'Középmotor',
    torque: 60,
  };
  const productSpecsHash = hashSpecs(productLevelDeterministicSpecs);

  function callResolve(
    testCase: ReturnType<typeof buildCase>,
    overrides: Partial<Record<string, unknown>> = {},
  ) {
    return service.resolve({
      context: testCase.context,
      config: testCase.config,
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
    const testCase = buildCase(undefined);
    const merged = { ...data };
    postProcessMerge.merge.mockReturnValueOnce(merged);

    const result = await callResolve(testCase);

    expect(postProcess.processOfferIdentity).not.toHaveBeenCalled();
    expect(postProcess.processModelSpecs).not.toHaveBeenCalled();
    expect(postProcessMerge.merge).toHaveBeenCalledWith(data, undefined, undefined);
    expect(result).toBe(merged);
  });

  it('skips both LLM calls and merges with undefined when the category has no golden sample', async () => {
    const testCase = buildCase({ enabled: true });
    categoryConfigService.getGoldenSample.mockReturnValueOnce(undefined);
    const merged = { ...data };
    postProcessMerge.merge.mockReturnValueOnce(merged);

    const result = await callResolve(testCase);

    expect(postProcess.processOfferIdentity).not.toHaveBeenCalled();
    expect(postProcess.processModelSpecs).not.toHaveBeenCalled();
    expect(postProcessMerge.merge).toHaveBeenCalledWith(data, undefined, undefined);
    expect(result).toBe(merged);
  });

  it('calls both LLM methods and merges their results when enabled with a golden sample', async () => {
    const testCase = buildCase({ enabled: true, model: 'custom-model' });
    const goldenSample = { weight: 22 };
    categoryConfigService.getGoldenSample.mockReturnValueOnce(goldenSample);
    const offerIdentity = { specs: { frameSize: 43 } };
    const modelSpecs = { specs: { motorPosition: 'Középmotor' } };
    postProcess.processOfferIdentity.mockResolvedValueOnce(offerIdentity);
    postProcess.processModelSpecs.mockResolvedValueOnce(modelSpecs);
    const merged = { ...data, specs: { ...data.specs, motorPosition: 'Középmotor', frameSize: 43 } };
    postProcessMerge.merge.mockReturnValueOnce(merged);

    const result = await callResolve(testCase, { offerLevelDeterministicSpecs: { frameSize: 43 } });

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
    const testCase = buildCase({ enabled: true });
    categoryConfigService.getGoldenSample.mockReturnValueOnce({ weight: 22 });
    postProcess.processOfferIdentity.mockResolvedValueOnce(undefined);
    postProcess.processModelSpecs.mockResolvedValueOnce(undefined);
    postProcessMerge.merge.mockReturnValueOnce(data);

    await callResolve(testCase, { offerLevelKeys: ['frameSize', 'color'] });

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
      const testCase = buildCase({ enabled: true });

      await callResolve(testCase, { description: 'Marketing blurb' });

      expect(postProcess.processOfferIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ description: undefined }),
      );
      expect(postProcess.processModelSpecs).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Marketing blurb' }),
      );
    });

    it('forwards description to offer-identity when includeDescriptionInOfferIdentity is true', async () => {
      const testCase = buildCase({
        enabled: true,
        includeDescriptionInOfferIdentity: true,
      });

      await callResolve(testCase, { description: 'Marketing blurb' });

      expect(postProcess.processOfferIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Marketing blurb' }),
      );
    });

    it('withholds description from model-spec when includeDescriptionInModelSpecs is false', async () => {
      const testCase = buildCase({
        enabled: true,
        includeDescriptionInModelSpecs: false,
      });

      await callResolve(testCase, { description: 'Marketing blurb' });

      expect(postProcess.processModelSpecs).toHaveBeenCalledWith(
        expect.objectContaining({ description: undefined }),
      );
    });
  });

  it('reuses offer-level specs from the existing offer instead of calling processOfferIdentity on a same-record hit', async () => {
    const testCase = buildCase({ enabled: true });
    categoryConfigService.getGoldenSample.mockReturnValueOnce({ weight: 22 });
    postProcess.processModelSpecs.mockResolvedValueOnce(undefined);
    postProcessMerge.merge.mockReturnValueOnce(data);

    await callResolve(testCase, {
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
    const testCase = buildCase({ enabled: true });
    categoryConfigService.getGoldenSample.mockReturnValueOnce({ weight: 22 });
    postProcess.processOfferIdentity.mockResolvedValueOnce(undefined);
    postProcessMerge.merge.mockReturnValueOnce(data);

    await callResolve(testCase, {
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
    const testCase = buildCase({ enabled: true });
    categoryConfigService.getGoldenSample.mockReturnValueOnce({ weight: 22 });
    postProcess.processOfferIdentity.mockResolvedValueOnce(undefined);
    postProcessMerge.merge.mockReturnValueOnce(data);
    sourceRecordRepo.findBySourceAndProductSpecsHash.mockResolvedValueOnce({
      id: 'sibling-source-id',
      url: 'https://speedbike.hu/product/1-blue',
      lastUpdated: new Date('2026-01-01'),
      scrapedProduct: { productLevelDeterministicSpecs },
    });

    await callResolve(testCase);

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
    const testCase = buildCase({ enabled: true });
    categoryConfigService.getGoldenSample.mockReturnValueOnce({ weight: 22 });
    postProcess.processOfferIdentity.mockResolvedValueOnce(undefined);
    postProcess.processModelSpecs.mockResolvedValueOnce({ specs: { weight: 22 } });
    postProcessMerge.merge.mockReturnValueOnce(data);
    sourceRecordRepo.findBySourceAndProductSpecsHash.mockResolvedValueOnce({
      id: 'sibling-source-id',
      scrapedProduct: undefined,
    });

    await callResolve(testCase);

    expect(postProcess.processModelSpecs).toHaveBeenCalled();
  });

  it('skips the sibling lookup entirely and always calls both LLM methods when force is set', async () => {
    const testCase = buildCase({ enabled: true }, true);
    categoryConfigService.getGoldenSample.mockReturnValueOnce({ weight: 22 });
    postProcess.processOfferIdentity.mockResolvedValueOnce(undefined);
    postProcess.processModelSpecs.mockResolvedValueOnce(undefined);
    postProcessMerge.merge.mockReturnValueOnce(data);

    await callResolve(testCase, {
      existingSource: { productSpecsHash, scrapedProduct: { productLevelDeterministicSpecs } },
    });

    expect(sourceRecordRepo.findBySourceAndProductSpecsHash).not.toHaveBeenCalled();
    expect(postProcess.processModelSpecs).toHaveBeenCalled();
  });

  it('skips the sibling lookup when productLevelDeterministicSpecs is below the minimum-key threshold', async () => {
    const testCase = buildCase({ enabled: true });
    categoryConfigService.getGoldenSample.mockReturnValueOnce({ weight: 22 });
    postProcess.processOfferIdentity.mockResolvedValueOnce(undefined);
    postProcess.processModelSpecs.mockResolvedValueOnce(undefined);
    postProcessMerge.merge.mockReturnValueOnce(data);

    await callResolve(testCase, {
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
      const testCase = buildCase({ enabled: true });
      categoryConfigService.getGoldenSample.mockReturnValueOnce({ weight: 22 });
      postProcess.processOfferIdentity.mockResolvedValueOnce(undefined);
      postProcess.processModelSpecs.mockResolvedValueOnce(undefined);
      postProcessMerge.merge.mockReturnValueOnce(data);

      await callResolve(testCase, { offerLevelDeterministicSpecs: { frameSize: 43 } });

      expect(logger.debug).toHaveBeenCalledWith(
        'Running offer-identity LLM call',
        expect.objectContaining({ taskId: 'task-1', url: testCase.context.url, offerLevelKeyCount: 1 }),
      );
    });

    it('logs when the model-spec call actually runs, with the product-level key count', async () => {
      const testCase = buildCase({ enabled: true });
      categoryConfigService.getGoldenSample.mockReturnValueOnce({ weight: 22 });
      postProcess.processOfferIdentity.mockResolvedValueOnce(undefined);
      postProcess.processModelSpecs.mockResolvedValueOnce(undefined);
      postProcessMerge.merge.mockReturnValueOnce(data);

      await callResolve(testCase);

      expect(logger.debug).toHaveBeenCalledWith(
        'Running model-spec LLM call',
        expect.objectContaining({
          taskId: 'task-1',
          url: testCase.context.url,
          productSpecsHash,
          productLevelKeyCount: Object.keys(productLevelDeterministicSpecs).length,
        }),
      );
    });

    it('logs a sibling hit with the sibling identifying fields', async () => {
      const testCase = buildCase({ enabled: true });
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

      await callResolve(testCase);

      expect(logger.debug).toHaveBeenCalledWith(
        'Product specs match a sibling source record, reusing its unified model-level specs',
        expect.objectContaining({
          taskId: 'task-1',
          url: testCase.context.url,
          productSpecsHash,
          siblingSourceId: 'sibling-source-id',
          siblingUrl: 'https://speedbike.hu/product/1-blue',
          siblingLastUpdated,
        }),
      );
    });
  });
});

