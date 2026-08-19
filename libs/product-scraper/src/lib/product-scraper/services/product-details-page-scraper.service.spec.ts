import { ProductDetailsPageScraperService } from './product-details-page-scraper.service';
import type { DeterministicProductData } from '@fittkereso-backend/product';
import type { ScrapeTask, SpecDefinitionJsonSchema } from '@fittkereso-backend/database';

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
