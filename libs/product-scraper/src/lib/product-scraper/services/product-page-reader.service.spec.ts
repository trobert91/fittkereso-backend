import {
  ListingExternalIdMismatchError,
  ProductImportTask,
  SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import { DetailPageSourceConfig } from '@fittkereso-backend/scrape-interpreter';
import { ProductPageReaderService, pageContentHash } from './product-page-reader.service';

describe('ProductPageReaderService', () => {
  let reader: ProductPageReaderService;
  let scraperService: { getHtml: jest.Mock };
  let interpreter: { runDetailPage: jest.Mock };
  let runtime: { getCategoryBySlug: jest.Mock };
  let categoryConfigService: { getJsonSchema: jest.Mock; getConfig: jest.Mock };
  let specExtraction: { extractSpecs: jest.Mock };
  let translationSelector: { collectTranslatableValues: jest.Mock };
  let translationService: { translateBatch: jest.Mock };
  let scrapingMetrics: { recordExtractionSkipReason: jest.Mock };

  const ebikes = { id: 'cat-1', slug: 'ebikes', name: 'Ebikes' };
  const schema: SpecDefinitionJsonSchema = { type: 'object', title: 'E-bike', properties: {} };
  const specMapping = { mappings: [{ key: 'gender', labels: ['Neme:'] }] };

  const detail = (overrides: Record<string, unknown> = {}) => ({
    rawSpecs: [{ name: 'Neme:', values: ['Férfi'] }],
    description: 'QUALITY. COMFORT.',
    categorySlug: 'ebikes',
    brand: undefined,
    model: undefined,
    imageUrls: [],
    rawOffers: [],
    offerLinks: [],
    ...overrides,
  });

  const task = (fetchMode: 'proxied' | 'direct' = 'proxied') =>
    ({
      id: 'task-1',
      url: 'https://www.mangobike.hu/ktm-macina-tour/',
      source: { id: 'source-1', name: 'mangobike-arukereso', fetchMode },
    }) as unknown as ProductImportTask;

  const config = (detailPage: Record<string, unknown> = {}): DetailPageSourceConfig => ({
    baseUrl: 'https://www.mangobike.hu',
    categories: { ebikes: { enabled: true, specMapping } },
    detailPage: { rawSpecs: [], ...detailPage },
  });

  beforeEach(() => {
    scraperService = { getHtml: jest.fn().mockResolvedValue('<html></html>') };
    interpreter = { runDetailPage: jest.fn().mockResolvedValue(detail()) };
    runtime = { getCategoryBySlug: jest.fn().mockResolvedValue(ebikes) };
    categoryConfigService = {
      getJsonSchema: jest.fn().mockReturnValue(schema),
      getConfig: jest.fn().mockReturnValue({ offerLevelSpecs: ['frameSize'] }),
    };
    specExtraction = { extractSpecs: jest.fn().mockReturnValue({ gender: 'Férfi' }) };
    translationSelector = { collectTranslatableValues: jest.fn().mockReturnValue(['Férfi']) };
    translationService = {
      translateBatch: jest.fn().mockResolvedValue({ lookup: new Map([['Férfi', 'Male']]), stats: {} }),
    };
    scrapingMetrics = { recordExtractionSkipReason: jest.fn() };

    reader = new ProductPageReaderService(
      scraperService as any,
      interpreter as any,
      runtime as any,
      categoryConfigService as any,
      specExtraction as any,
      translationSelector as any,
      translationService as any,
      scrapingMetrics as any,
    );
  });

  describe('fetching', () => {
    it("fetches the task's URL, normalized, in the source's fetch mode", async () => {
      const result = await reader.read({ task: task('proxied'), config: config() });

      expect(scraperService.getHtml).toHaveBeenCalledWith('https://www.mangobike.hu/ktm-macina-tour', 'proxied');
      expect(result).toMatchObject({ url: 'https://www.mangobike.hu/ktm-macina-tour', fetchMode: 'proxied' });
    });

    // A shop that agreed to be read: its pages directly, its feed as before.
    it("fetches in detailPage.fetchMode when it is set, whatever the source's", async () => {
      const result = await reader.read({ task: task('proxied'), config: config({ fetchMode: 'direct' }) });

      expect(scraperService.getHtml).toHaveBeenCalledWith(expect.any(String), 'direct');
      expect(result.fetchMode).toBe('direct');
    });

    it('fetches proxied when detailPage says so on a direct source', async () => {
      await reader.read({ task: task('direct'), config: config({ fetchMode: 'proxied' }) });

      expect(scraperService.getHtml).toHaveBeenCalledWith(expect.any(String), 'proxied');
    });

    it('lets a failed fetch through to the caller', async () => {
      scraperService.getHtml.mockRejectedValueOnce(new Error('Fetching … returned HTTP 404'));

      await expect(reader.read({ task: task(), config: config() })).rejects.toThrow('HTTP 404');
      expect(interpreter.runDetailPage).not.toHaveBeenCalled();
    });
  });

  describe('the category', () => {
    // A feed brings its row's category: the page is never asked.
    it("maps the specs for the caller's category without looking up the page's", async () => {
      interpreter.runDetailPage.mockResolvedValueOnce(detail({ categorySlug: undefined }));

      const result = await reader.read({ task: task(), config: config(), category: ebikes });

      expect(runtime.getCategoryBySlug).not.toHaveBeenCalled();
      expect(result).toMatchObject({ category: ebikes, schema, specs: { gender: 'Férfi' } });
      expect(result.categoryProblem).toBeUndefined();
    });

    it("resolves the page's own category when the caller has none", async () => {
      const result = await reader.read({ task: task(), config: config() });

      expect(runtime.getCategoryBySlug).toHaveBeenCalledWith('ebikes');
      expect(result.category).toEqual(ebikes);
    });

    it.each([
      [
        'ambiguous',
        { categorySlug: undefined, ambiguousCategorySlugs: ['ebikes', 'bikes'] },
        { reason: 'ambiguous', slugs: ['ebikes', 'bikes'] },
      ],
      ['not identified', { categorySlug: undefined }, { reason: 'not_identified' }],
      ['not enabled', { categorySlug: 'bikes' }, { reason: 'not_enabled', slug: 'bikes' }],
    ])('returns, not throws, a page category that is %s', async (_label, overrides, problem) => {
      interpreter.runDetailPage.mockResolvedValueOnce(detail(overrides));

      const result = await reader.read({ task: task(), config: config() });

      expect(result.categoryProblem).toEqual(problem);
      expect(result.specs).toBeUndefined();
      expect(specExtraction.extractSpecs).not.toHaveBeenCalled();
    });

    it('returns a category missing from the database as not identified, naming it', async () => {
      runtime.getCategoryBySlug.mockResolvedValueOnce(null);

      const result = await reader.read({ task: task(), config: config() });

      expect(result.categoryProblem).toEqual({ reason: 'not_identified', slug: 'ebikes' });
    });

    it('returns a category without a spec schema as no_schema, also for a caller-given one', async () => {
      categoryConfigService.getJsonSchema.mockReturnValue(undefined);

      const result = await reader.read({ task: task(), config: config(), category: ebikes });

      expect(result.categoryProblem).toEqual({ reason: 'no_schema', slug: 'ebikes' });
    });
  });

  // A shop that never 404s a product URL redirects a delisted one to another
  // product; the page must show one of the ids it was fetched for.
  describe('the expected product', () => {
    it('refuses a page stating another id, before anything is mapped', async () => {
      interpreter.runDetailPage.mockResolvedValueOnce(detail({ externalId: 'other-1' }));

      const failure = reader.read({ task: task(), config: config(), expectedExternalIds: ['24384'] });

      await expect(failure).rejects.toBeInstanceOf(ListingExternalIdMismatchError);
      await expect(failure).rejects.toMatchObject({
        detail: { expectedExternalId: '24384', pageExternalIds: ['other-1'] },
      });
      expect(scrapingMetrics.recordExtractionSkipReason).toHaveBeenCalledWith(
        'mangobike-arukereso',
        'external_id_mismatch',
      );
      expect(runtime.getCategoryBySlug).not.toHaveBeenCalled();
      expect(specExtraction.extractSpecs).not.toHaveBeenCalled();
    });

    // A feed URL carrying several size rows: any one of them on the page will do.
    it('accepts the page when it shows any one of several expected ids', async () => {
      interpreter.runDetailPage.mockResolvedValueOnce(
        detail({ externalId: 'group-1', rawOffers: [{ price: 1, externalId: 'SC_L' }] }),
      );

      await expect(
        reader.read({ task: task(), config: config(), expectedExternalIds: ['SC_M', 'SC_L', undefined] }),
      ).resolves.toBeTruthy();
    });

    it('compares the ids as trimmed text', async () => {
      interpreter.runDetailPage.mockResolvedValueOnce(detail({ externalId: 1260161111 }));

      await expect(
        reader.read({ task: task(), config: config(), expectedExternalIds: [' 1260161111 '] }),
      ).resolves.toBeTruthy();
    });

    it('lets a page stating no id through', async () => {
      await expect(
        reader.read({ task: task(), config: config(), expectedExternalIds: ['24384'] }),
      ).resolves.toBeTruthy();
      expect(scrapingMetrics.recordExtractionSkipReason).not.toHaveBeenCalled();
    });

    it('checks nothing when no id is expected', async () => {
      interpreter.runDetailPage.mockResolvedValueOnce(detail({ externalId: 'other-1' }));

      await expect(
        reader.read({ task: task(), config: config(), expectedExternalIds: [null, undefined, ' '] }),
      ).resolves.toBeTruthy();
    });
  });

  describe('the specs', () => {
    it("maps the rows through the category section's specMapping", async () => {
      await reader.read({ task: task(), config: config(), category: ebikes });

      expect(specExtraction.extractSpecs).toHaveBeenCalledWith(
        expect.objectContaining({ scrapedSpecs: detail().rawSpecs, schema, sourceConfig: specMapping }),
      );
    });

    it('maps nothing, and translates nothing, without a specMapping for the category', async () => {
      const bare: DetailPageSourceConfig = {
        ...config({ translation: { enabled: true, sourceLanguage: 'hu', targetLanguage: 'hu', contextTemplate: '' } }),
        categories: { ebikes: { enabled: true } },
      };

      const result = await reader.read({ task: task(), config: bare, category: ebikes });

      expect(result.specs).toEqual({});
      expect(specExtraction.extractSpecs).not.toHaveBeenCalled();
      expect(translationService.translateBatch).not.toHaveBeenCalled();
    });

    it("translates the values first when the detailPage's translation is on", async () => {
      const translated = config({
        translation: {
          enabled: true,
          sourceLanguage: 'hu',
          targetLanguage: 'en',
          contextTemplate: 'A {{categoryName}} listing',
        },
      });

      await reader.read({ task: task(), config: translated, category: ebikes });

      expect(translationService.translateBatch).toHaveBeenCalledWith(
        expect.objectContaining({ texts: ['Férfi'], context: 'A Ebikes listing' }),
      );
      expect(specExtraction.extractSpecs).toHaveBeenCalledWith(
        expect.objectContaining({ translator: expect.any(Map) }),
      );
    });

    it('interprets without mapping: no translation, no extraction', async () => {
      const interpretation = await reader.interpret({ task: task(), config: config() });

      expect(interpretation.category).toEqual(ebikes);
      expect(specExtraction.extractSpecs).not.toHaveBeenCalled();
    });
  });

  describe('pageContentHash', () => {
    const rows = [{ name: 'Neme:', values: ['Férfi'] }];

    it('is the same for the same rows and description', () => {
      expect(pageContentHash({ rawSpecs: rows, description: 'a' })).toBe(
        pageContentHash({ rawSpecs: [{ name: 'Neme:', values: ['Férfi'] }], description: 'a' }),
      );
    });

    it('changes with a row or the description', () => {
      const base = pageContentHash({ rawSpecs: rows, description: 'a' });
      expect(pageContentHash({ rawSpecs: rows, description: 'b' })).not.toBe(base);
      expect(pageContentHash({ rawSpecs: [{ name: 'Neme:', values: ['Női'] }], description: 'a' })).not.toBe(base);
    });

    it('is in every read, also one with a category problem', async () => {
      interpreter.runDetailPage.mockResolvedValueOnce(detail({ categorySlug: undefined }));

      const result = await reader.read({ task: task(), config: config() });

      expect(result.contentHash).toBe(pageContentHash(detail()));
    });
  });
});
