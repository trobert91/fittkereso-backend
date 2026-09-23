import { Readable } from 'stream';
import { ProductSourceImportSimulationService } from './product-source-import-simulation.service';
import { ArukeresoFeedParserService } from '../../arukereso/arukereso-feed-parser.service';
import type { ProductSource } from '@fittkereso-backend/database';

describe('ProductSourceImportSimulationService', () => {
  let service: ProductSourceImportSimulationService;
  let nativeScraper: { stream: jest.Mock };
  let mapper: { classify: jest.Mock; map: jest.Mock };
  let interpreter: { runValuePipeline: jest.Mock; runListPage: jest.Mock };
  let scraperService: { getHtml: jest.Mock };
  let scrapingImport: { planRun: jest.Mock };
  let listRefresh: { requiredFields: string[] };
  let sourceRecordRepo: { findBySourceAndUrl: jest.Mock };

  const feedSource = {
    id: 'source-1',
    name: 'speedbike-arukereso',
    type: 'arukereso',
    config: {
      baseUrl: 'https://speedbike.hu',
      feedUrl: 'https://speedbike.hu/feed',
      category: { slugLookup: [] },
      mapping: { externalId: { field: 'identifier' } },
    },
  } as unknown as ProductSource;

  const scrapingSource = {
    id: 'source-2',
    name: 'ebikeshop',
    type: 'scraping',
    config: {
      baseUrl: 'https://ebikeshop.hu',
      startUrls: ['https://ebikeshop.hu/termekek'],
      listPage: {
        categoryName: [],
        items: [],
        itemMode: 'json',
        itemPipeline: [],
        pagination: { urlTemplate: '{{startUrl}}?page={{page}}', pageCount: [] },
      },
      detailPage: {},
    },
  } as unknown as ProductSource;

  /** A feed whose products carry the given identifiers, in order. */
  const feed = (identifiers: string[]) =>
    `<?xml version="1.0"?><Products>${identifiers
      .map((id) => `<Product><Identifier>${id}</Identifier></Product>`)
      .join('')}</Products>`;

  const givenFeed = (xml: string) =>
    nativeScraper.stream.mockResolvedValue({
      statusCode: 200,
      contentType: 'application/xml',
      stream: Readable.from([xml]),
    });

  beforeEach(() => {
    nativeScraper = { stream: jest.fn() };
    mapper = {
      classify: jest.fn().mockResolvedValue({ status: 'eligible', slug: 'ebikes' }),
      map: jest
        .fn()
        .mockResolvedValue({ status: 'mapped', url: 'u', scrapedProduct: {} }),
    };
    interpreter = { runValuePipeline: jest.fn(), runListPage: jest.fn() };
    scraperService = { getHtml: jest.fn().mockResolvedValue('<html></html>') };
    scrapingImport = {
      planRun: jest
        .fn()
        .mockResolvedValue({ categoryUrls: ['c1'], pageUrls: ['p1', 'p2'] }),
    };
    listRefresh = { requiredFields: ['url', 'price', 'availability'] };
    sourceRecordRepo = { findBySourceAndUrl: jest.fn().mockResolvedValue(null) };

    service = new ProductSourceImportSimulationService(
      scraperService as never,
      nativeScraper as never,
      interpreter as never,
      scrapingImport as never,
      listRefresh as never,
      // The real parser: a stub would leave the wiring untested.
      new ArukeresoFeedParserService(),
      mapper as never,
      sourceRecordRepo as never,
    );
  });

  describe('a feed source', () => {
    it('counts the whole feed while previewing only a few items in full', async () => {
      givenFeed(feed(['a', 'b', 'c', 'd', 'e', 'f', 'g']));

      const result = await service.simulate(feedSource, { limit: 2 });

      expect(result.arukereso?.itemsParsed).toBe(7);
      expect(result.arukereso?.wouldImport).toBe(7);
      // classify runs for every item; only the previews cost a full mapping,
      // which is what spends LLM calls.
      expect(mapper.classify).toHaveBeenCalledTimes(7);
      expect(mapper.map).toHaveBeenCalledTimes(2);
      expect(result.arukereso?.products).toHaveLength(2);
    });

    it('tallies why items were skipped rather than only how many', async () => {
      givenFeed(feed(['a', 'b', 'c']));
      mapper.classify
        .mockResolvedValueOnce({ status: 'eligible', slug: 'ebikes' })
        .mockResolvedValueOnce({ status: 'skipped', reason: 'category_not_enabled' })
        .mockResolvedValueOnce({ status: 'skipped', reason: 'category_not_enabled' });

      const result = await service.simulate(feedSource);

      expect(result.arukereso?.wouldImport).toBe(1);
      expect(result.arukereso?.wouldSkip).toBe(2);
      expect(result.arukereso?.skipReasons).toEqual({ category_not_enabled: 2 });
    });

    // The check this simulator exists for. Offer is @Unique([seller, externalId]),
    // so a repeated id does not error at import — it silently collapses those
    // offers onto one row, keeping only the last. speedbike's feed repeats `sku`
    // across size variants for exactly this reason.
    it('fails the simulation when the chosen externalId is not unique', async () => {
      givenFeed(feed(['dup', 'dup', 'unique']));

      const result = await service.simulate(feedSource);

      expect(result.arukereso?.distinctExternalIds).toBe(2);
      expect(result.arukereso?.duplicateExternalIds).toEqual([
        { externalId: 'dup', count: 2 },
      ]);
      expect(result.errors.join(' ')).toMatch(/WOULD COLLAPSE onto one row/);
    });

    it('passes cleanly when every externalId is distinct', async () => {
      givenFeed(feed(['a', 'b', 'c']));

      const result = await service.simulate(feedSource);

      expect(result.arukereso?.duplicateExternalIds).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('warns about items that would fall back to the URL slug', async () => {
      givenFeed(feed(['a', '', 'c']));

      const result = await service.simulate(feedSource);

      expect(result.arukereso?.itemsWithoutExternalId).toBe(1);
      expect(result.warnings.join(' ')).toMatch(/would fall back to the URL slug/);
    });

    it('calls a gate that keeps nothing an error, not a quiet zero', async () => {
      givenFeed(feed(['a', 'b']));
      mapper.classify.mockResolvedValue({
        status: 'skipped',
        reason: 'category_not_identified',
      });

      const result = await service.simulate(feedSource);

      expect(result.arukereso?.wouldImport).toBe(0);
      expect(result.errors.join(' ')).toMatch(/No item survives the category gate/);
    });

    it('reports a feed that cannot be fetched as an error, not an empty run', async () => {
      nativeScraper.stream.mockRejectedValue(new Error('HTTP 404'));

      const result = await service.simulate(feedSource);

      expect(result.errors).toEqual(['HTTP 404']);
      expect(result.arukereso).toBeUndefined();
    });
  });

  describe('a scraping source', () => {
    const card = (overrides: Record<string, unknown> = {}) => ({
      url: 'https://ebikeshop.hu/p/1',
      price: 100,
      availability: 'in_stock',
      ...overrides,
    });

    it('reports the whole page walk without enqueueing anything', async () => {
      interpreter.runListPage.mockResolvedValue({ products: [card()] });

      const result = await service.simulate(scrapingSource);

      expect(result.scraping?.pageUrls).toEqual(['p1', 'p2']);
      expect(result.scraping?.listPageParsed).toBe('p1');
      expect(scrapingImport.planRun).toHaveBeenCalled();
    });

    it('costs a detail fetch for a listing this source has never seen', async () => {
      interpreter.runListPage.mockResolvedValue({ products: [card()] });

      const result = await service.simulate(scrapingSource);

      expect(result.scraping?.decisions[0]).toMatchObject({
        known: false,
        wouldScrapeDetail: true,
      });
      expect(result.scraping?.decisions[0].reason).toMatch(/not seen by this source/);
    });

    // The number that says whether the minimum set is buying anything, and the
    // reason that makes it tunable: "every card is missing availability" is a
    // one-line config change, and invisible from a total.
    it('names the missing fields when a known listing is too thin to refresh', async () => {
      sourceRecordRepo.findBySourceAndUrl.mockResolvedValue({
        id: 'record-1',
        offers: [{ id: 'offer-1' }],
      });
      interpreter.runListPage.mockResolvedValue({
        products: [card({ availability: undefined })],
      });

      const result = await service.simulate(scrapingSource);

      expect(result.scraping?.decisions[0]).toMatchObject({
        known: true,
        satisfiesMinimumSet: false,
        missingFields: ['availability'],
        wouldScrapeDetail: true,
      });
      expect(result.scraping?.wouldScrapeDetail).toBe(1);
    });

    it('refreshes in place when a known listing satisfies the minimum set', async () => {
      sourceRecordRepo.findBySourceAndUrl.mockResolvedValue({
        id: 'record-1',
        offers: [{ id: 'offer-1' }],
      });
      interpreter.runListPage.mockResolvedValue({ products: [card()] });

      const result = await service.simulate(scrapingSource);

      expect(result.scraping?.decisions[0].wouldScrapeDetail).toBe(false);
      expect(result.scraping?.wouldRefreshInline).toBe(1);
    });

    it('still needs a detail fetch for a known listing with no offer row yet', async () => {
      sourceRecordRepo.findBySourceAndUrl.mockResolvedValue({
        id: 'record-1',
        offers: [],
      });
      interpreter.runListPage.mockResolvedValue({ products: [card()] });

      const result = await service.simulate(scrapingSource);

      expect(result.scraping?.decisions[0].reason).toMatch(/no offer row/);
      expect(result.scraping?.decisions[0].wouldScrapeDetail).toBe(true);
    });

    it('calls a page that yields no cards an error', async () => {
      interpreter.runListPage.mockResolvedValue({ products: [] });

      const result = await service.simulate(scrapingSource);

      expect(result.errors.join(' ')).toMatch(/produced no cards/);
    });
  });
});
