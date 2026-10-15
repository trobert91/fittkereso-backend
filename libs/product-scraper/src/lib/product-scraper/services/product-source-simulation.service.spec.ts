// Only types and injected mocks from here.
jest.mock('@fittkereso-backend/product', () => ({}));

import { ProductSourceSimulationService } from './product-source-simulation.service';

const EBIKES = { id: 'cat-ebikes', slug: 'ebikes', name: 'E-bikes' };

describe('ProductSourceSimulationService', () => {
  let service: ProductSourceSimulationService;
  let pageReader: { interpret: jest.Mock; mapSpecs: jest.Mock };
  let runtime: { getCategoryBySlug: jest.Mock };
  let specPostProcess: { extractIdentity: jest.Mock; unify: jest.Mock; scopesOf: jest.Mock };

  const detail = (overrides: Record<string, unknown> = {}) => ({
    rawSpecs: [{ name: 'Neme:', values: ['Férfi'] }],
    imageUrls: [],
    rawOffers: [],
    ...overrides,
  });

  const feedConfig = {
    baseUrl: 'https://mangobike.hu',
    categories: { ebikes: { enabled: true, specMapping: { gender: { label: 'Neme' } } } },
    detailPage: { fetchMode: 'direct', rawSpecs: [] },
  };

  const scrapingConfig = {
    baseUrl: 'https://ebikeshop.hu',
    categories: { ebikes: { enabled: false, specMapping: {} } },
    detailPage: { rawSpecs: [] },
  };

  beforeEach(() => {
    pageReader = {
      interpret: jest.fn(),
      mapSpecs: jest.fn().mockResolvedValue({ gender: 'Férfi' }),
    };
    runtime = { getCategoryBySlug: jest.fn().mockResolvedValue(EBIKES) };
    specPostProcess = {
      extractIdentity: jest.fn().mockImplementation(async ({ scrapedProduct }) => scrapedProduct),
      unify: jest.fn().mockImplementation(async ({ scrapedProduct }) => scrapedProduct),
      scopesOf: jest.fn().mockReturnValue({ identityKeys: ['gender'] }),
    };
    service = new ProductSourceSimulationService(
      pageReader as never,
      runtime as never,
      {
        getJsonSchema: jest.fn().mockReturnValue({ properties: {} }),
        getConfig: jest.fn().mockReturnValue({ offerLevelSpecs: [] }),
      } as never,
      specPostProcess as never,
      { resolve: jest.fn().mockResolvedValue({ entity: { name: 'KTM' }, similarity: 1 }) } as never,
      { normalizedModelOf: jest.fn().mockReturnValue('key') } as never,
    );
  });

  // The caller resolved it: the tool's argument, else detailPage's, else the source's.
  it('fetches the page in exactly the mode it is given', async () => {
    pageReader.interpret.mockResolvedValue({
      url: 'u',
      fetchMode: 'proxied',
      htmlLength: 10,
      detail: detail(),
      category: EBIKES,
      schema: { properties: {} },
    });

    await service.simulateDetailPageScrape('https://mangobike.hu/p', feedConfig as never, 'proxied', 'ebikes');

    const { task, config } = pageReader.interpret.mock.calls[0][0];
    expect(config.detailPage.fetchMode).toBe('proxied');
    expect(task.source.fetchMode).toBe('proxied');
  });

  describe("a feed source's page", () => {
    beforeEach(() => {
      pageReader.interpret.mockResolvedValue({
        url: 'u',
        fetchMode: 'direct',
        htmlLength: 1000,
        detail: detail(),
        category: EBIKES,
        schema: { properties: {} },
      });
    });

    it('is read for the category its rows bring, and only mapped', async () => {
      const result = await service.simulateDetailPageScrape(
        'https://mangobike.hu/p',
        feedConfig as never,
        'direct',
        'ebikes',
      );

      expect(pageReader.interpret).toHaveBeenCalledWith(
        expect.objectContaining({ category: EBIKES }),
      );
      expect(result.feedPage).toEqual({ categorySlug: 'ebikes' });
      expect(result.specs).toEqual({ deterministic: { gender: 'Férfi' } });
      expect(result.html.length).toBe(1000);
      // A feed row's own values decide identity: nothing is asked of the page.
      expect(specPostProcess.extractIdentity).not.toHaveBeenCalled();
      expect(result.productPreview).toBeUndefined();
      expect(result.errors).toEqual([]);
    });

    it('warns when its category section maps no page label', async () => {
      const result = await service.simulateDetailPageScrape(
        'https://mangobike.hu/p',
        { ...feedConfig, categories: { ebikes: { enabled: true } } } as never,
        'direct',
        'ebikes',
      );

      expect(result.warnings.join(' ')).toMatch(/No specMapping in the "ebikes" category section/);
    });

    it('refuses a category the database does not have', async () => {
      runtime.getCategoryBySlug.mockResolvedValue(null);

      await expect(
        service.simulateDetailPageScrape('https://mangobike.hu/p', feedConfig as never, 'direct', 'bikes'),
      ).rejects.toThrow('No category "bikes"');
    });
  });

  describe("a scraping source's page", () => {
    // The reader stops at a category not enabled; the simulation still shows
    // what the page would give, beside the warning.
    it('maps a page of a category not enabled, with a warning', async () => {
      pageReader.interpret.mockResolvedValue({
        url: 'u',
        fetchMode: 'proxied',
        htmlLength: 10,
        detail: detail({ categorySlug: 'ebikes', brand: 'KTM', model: 'Macina' }),
        categoryProblem: { reason: 'not_enabled', slug: 'ebikes' },
      });

      const result = await service.simulateDetailPageScrape(
        'https://ebikeshop.hu/p',
        scrapingConfig as never,
        'proxied',
      );

      expect(result.warnings.join(' ')).toMatch(/is not enabled/);
      expect(pageReader.mapSpecs).toHaveBeenCalledWith(
        expect.objectContaining({
          interpretation: expect.objectContaining({ category: EBIKES, categoryProblem: undefined }),
        }),
      );
      expect(result.specs?.deterministic).toEqual({ gender: 'Férfi' });
      expect(result.productPreview).toMatchObject({ brand: 'KTM', categorySlug: 'ebikes' });
    });

    it('stops at an ambiguous category', async () => {
      pageReader.interpret.mockResolvedValue({
        url: 'u',
        fetchMode: 'proxied',
        htmlLength: 10,
        detail: detail(),
        categoryProblem: { reason: 'ambiguous', slugs: ['ebikes', 'bikes'] },
      });

      const result = await service.simulateDetailPageScrape(
        'https://ebikeshop.hu/p',
        scrapingConfig as never,
        'proxied',
      );

      expect(result.errors.join(' ')).toMatch(/ambiguous: the rules of ebikes, bikes/);
      expect(pageReader.mapSpecs).not.toHaveBeenCalled();
    });

    it('stops at a page no category section claims', async () => {
      pageReader.interpret.mockResolvedValue({
        url: 'u',
        fetchMode: 'proxied',
        htmlLength: 10,
        detail: detail(),
        categoryProblem: { reason: 'not_identified' },
      });

      const result = await service.simulateDetailPageScrape(
        'https://ebikeshop.hu/p',
        scrapingConfig as never,
        'proxied',
      );

      expect(result.errors.join(' ')).toMatch(/could not be identified/);
    });
  });
});
