import { Readable } from 'stream';
import { ProductSourceImportSimulationService } from './product-source-import-simulation.service';
import { ArukeresoFeedParserService } from '../../arukereso/arukereso-feed-parser.service';
import { ArukeresoProductMapperService } from '../../arukereso/arukereso-product-mapper.service';
import { ListProductRefreshService } from './list-product-refresh.service';
import type { ProductSource } from '@fittkereso-backend/database';

const DAY = 24 * 60 * 60 * 1000;

describe('ProductSourceImportSimulationService', () => {
  let service: ProductSourceImportSimulationService;
  let nativeScraper: { stream: jest.Mock };
  let mapper: { classify: jest.Mock; map: jest.Mock; resolveTarget: jest.Mock };
  let interpreter: { runValuePipeline: jest.Mock; runListPage: jest.Mock };
  let scraperService: { getHtml: jest.Mock };
  let scrapingImport: { planRun: jest.Mock };
  let sourceRecordRepo: { findBySourceAndUrl: jest.Mock; findUniqueBySourceAndExternalId: jest.Mock };
  let specPostProcess: { extractIdentity: jest.Mock };
  let feedTriage: { triage: jest.Mock };
  let offerRepo: { findSyncStates: jest.Mock };

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
    detailRefreshInterval: '60 days',
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
      // The real target resolution: what the previews and the tallies read.
      resolveTarget: jest.fn((...args: Parameters<ArukeresoProductMapperService['resolveTarget']>) =>
        new ArukeresoProductMapperService(
          interpreter as never,
          {} as never,
          {} as never,
          {} as never,
        ).resolveTarget(...args),
      ),
    };
    interpreter = { runValuePipeline: jest.fn(), runListPage: jest.fn() };
    scraperService = { getHtml: jest.fn().mockResolvedValue('<html></html>') };
    scrapingImport = {
      planRun: jest
        .fn()
        .mockResolvedValue({ categoryUrls: ['c1'], pageUrls: ['p1', 'p2'] }),
    };
    sourceRecordRepo = {
      findBySourceAndUrl: jest.fn().mockResolvedValue(null),
      findUniqueBySourceAndExternalId: jest.fn().mockResolvedValue(null),
    };
    offerRepo = { findSyncStates: jest.fn().mockResolvedValue([]) };
    // Every row new unless a test says otherwise.
    feedTriage = {
      triage: jest.fn().mockImplementation(async (_source, rows) => ({
        unchanged: [],
        toImport: rows,
      })),
    };
    specPostProcess = {
      extractIdentity: jest
        .fn()
        .mockImplementation(async ({ scrapedProduct }) => ({ ...scrapedProduct, nameCleaned: true })),
    };

    service = new ProductSourceImportSimulationService(
      scraperService as never,
      nativeScraper as never,
      interpreter as never,
      scrapingImport as never,
      // The real decision: the simulation reports what a run would do, so a
      // stub here would check the wrong thing. It only reads.
      new ListProductRefreshService(
        sourceRecordRepo as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      ),
      // The real parser: a stub would leave the wiring untested.
      new ArukeresoFeedParserService(),
      mapper as never,
      specPostProcess as never,
      feedTriage as never,
      offerRepo as never,
    );
  });

  describe('a feed source', () => {
    it('counts the whole feed while previewing only a few items in full', async () => {
      givenFeed(feed(['a', 'b', 'c', 'd', 'e', 'f', 'g']));

      const result = await service.simulate(feedSource, { limit: 2 });

      expect(result.feed?.itemsParsed).toBe(7);
      expect(result.feed?.wouldImport).toBe(7);
      // Every eligible item is mapped (free, and what the triage needs); only
      // the previews are extracted, and the extraction is what spends LLM calls.
      expect(mapper.classify).toHaveBeenCalledTimes(7);
      expect(mapper.map).toHaveBeenCalledTimes(7);
      expect(result.feed?.products).toHaveLength(2);
      // Each preview shows what a first import would extract — the one part
      // of the simulation that calls the LLM — never a stored result.
      expect(specPostProcess.extractIdentity).toHaveBeenCalledTimes(2);
      expect(specPostProcess.extractIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ context: expect.objectContaining({ force: true }) }),
      );
      expect(result.feed?.products[0]).toMatchObject({ nameCleaned: true });
    });

    it('reports what a run would queue and what it would only refresh', async () => {
      givenFeed(feed(['a', 'b', 'c']));
      let row = 0;
      mapper.map.mockImplementation(async () => {
        row += 1;
        return {
          status: 'mapped',
          url: `https://speedbike.hu/p/${row}`,
          scrapedProduct: { offers: [{ externalId: `sku-${row}` }] },
        };
      });
      feedTriage.triage.mockImplementation(async (_source, rows) => ({
        unchanged: rows.slice(0, 1).map((r: unknown) => ({ row: r })),
        toImport: rows.slice(1),
      }));

      const result = await service.simulate(feedSource);

      expect(result.feed).toMatchObject({ wouldQueue: 2, wouldRefresh: 1, duplicateUrls: 0 });
      expect(feedTriage.triage.mock.calls[0][1][0]).toMatchObject({
        url: 'https://speedbike.hu/p/1',
        externalId: 'sku-1',
        rowHash: expect.any(String),
      });
    });

    // A contributing source joins the seller's offers; how many it would join
    // is the number worth knowing before its first run.
    it('counts, for a source that does not identify products, the rows matching the seller\'s offers', async () => {
      givenFeed(feed(['a', 'b', 'c']));
      let row = 0;
      mapper.map.mockImplementation(async () => {
        row += 1;
        return {
          status: 'mapped',
          url: `https://speedbike.hu/p/${row}`,
          scrapedProduct: { offers: [{ externalId: `sku-${row}` }] },
        };
      });
      offerRepo.findSyncStates.mockImplementation(async (_sellerId, ids: string[]) =>
        ids.filter((id) => id !== 'sku-2').map((id) => ({ externalId: id })),
      );
      const contributing = {
        ...feedSource,
        identifiesProducts: false,
        seller: { id: 'seller-1' },
      } as ProductSource;

      const result = await service.simulate(contributing);

      expect(result.feed?.matchingOffers).toBe(2);
      expect(offerRepo.findSyncStates).toHaveBeenCalledWith('seller-1', ['sku-1', 'sku-2', 'sku-3']);
      // It runs no identity extraction, so its previews cost nothing either,
      // and what the extraction would read is no concern of its.
      expect(specPostProcess.extractIdentity).not.toHaveBeenCalled();
      expect(result.warnings.join(' ')).not.toMatch(/identityExtraction\.specRows/);
    });

    // Google's reason to exist next to the Árukereső feed.
    it('counts the rows whose old price is above their price', async () => {
      givenFeed(feed(['a', 'b', 'c']));
      const prices = [
        { price: 1_499_990, priceWithoutDiscount: 2_269_000 },
        { price: 2_149_990, priceWithoutDiscount: 2_149_990 },
        { price: 999_000, priceWithoutDiscount: null },
      ];
      let row = 0;
      mapper.map.mockImplementation(async () => ({
        status: 'mapped',
        url: `https://speedbike.hu/p/${row}`,
        scrapedProduct: { offers: [{ externalId: `sku-${row}`, ...prices[row++] }] },
      }));

      const result = await service.simulate(feedSource);

      expect(result.feed?.rowsWithOldPrice).toBe(1);
    });

    it('leaves the offer match unreported for an identifying source', async () => {
      givenFeed(feed(['a']));

      const result = await service.simulate(feedSource);

      expect(result.feed?.matchingOffers).toBeUndefined();
      expect(offerRepo.findSyncStates).not.toHaveBeenCalled();
    });

    it('warns about rows that share a URL, since a run keeps only the last', async () => {
      givenFeed(feed(['a', 'b']));

      const result = await service.simulate(feedSource);

      expect(result.feed?.duplicateUrls).toBe(1);
      expect(result.warnings.join(' ')).toMatch(/share a URL/);
    });

    it('tallies why items were skipped rather than only how many', async () => {
      givenFeed(feed(['a', 'b', 'c']));
      mapper.classify
        .mockResolvedValueOnce({ status: 'eligible', slug: 'ebikes' })
        .mockResolvedValueOnce({ status: 'skipped', reason: 'category_not_enabled' })
        .mockResolvedValueOnce({ status: 'skipped', reason: 'category_not_enabled' });

      const result = await service.simulate(feedSource);

      expect(result.feed?.wouldImport).toBe(1);
      expect(result.feed?.wouldSkip).toBe(2);
      expect(result.feed?.skipReasons).toEqual({ category_not_enabled: 2 });
    });

    // The check this simulator exists for. Offer is @Unique([seller, externalId]),
    // so a repeated id does not error at import — it silently collapses those
    // offers onto one row, keeping only the last. speedbike's feed repeats `sku`
    // across size variants for exactly this reason.
    it('fails the simulation when the chosen externalId is not unique', async () => {
      givenFeed(feed(['dup', 'dup', 'unique']));

      const result = await service.simulate(feedSource);

      expect(result.feed?.distinctExternalIds).toBe(2);
      expect(result.feed?.duplicateExternalIds).toEqual([
        { externalId: 'dup', count: 2 },
      ]);
      expect(result.errors.join(' ')).toMatch(/WOULD COLLAPSE onto one row/);
    });

    describe('identifiers, counted over the whole feed', () => {
      const identifierSource = {
        ...feedSource,
        config: {
          ...feedSource.config,
          mapping: {
            externalId: { field: 'identifier' },
            brand: { field: 'manufacturer' },
            gtin: { field: 'ean_code' },
            mpn: { field: 'sku' },
          },
          identityExtraction: { specRows: ['Motor', 'Váz', 'Kerék'] },
        },
      } as unknown as ProductSource;

      const product = (
        id: string,
        brand: string,
        ean: string,
        sku: string,
        attributes: string[],
      ) =>
        `<Product><Identifier>${id}</Identifier><Manufacturer>${brand}</Manufacturer>` +
        `<ean_code>${ean}</ean_code><sku>${sku}</sku><attributes>${attributes
          .map(
            (name) =>
              `<attribute><attribute_name>${name}</attribute_name><attribute_value>x</attribute_value></attribute>`,
          )
          .join('')}</attributes></Product>`;

      // Real shapes from speedbike's feed: a KTM barcode, a GIANT article
      // stub in the barcode field, and a row with neither.
      const identifierFeed = `<?xml version="1.0"?><Products>${[
        product('a', 'KTM', '9008594503199', '1260040108', ['Motor', 'Váz', 'Fékbetét']),
        product('b', 'GIANT', '5461000', '2300160206', ['Motor']),
        product('c', 'CUBE', '', '', ['Fékbetét']),
      ].join('')}</Products>`;

      it('sorts GTINs into valid, invalid and absent, naming the brands behind the invalid ones', async () => {
        givenFeed(identifierFeed);

        const result = await service.simulate(identifierSource, { limit: 1 });

        expect(result.feed?.identifiers).toMatchObject({
          gtinMapped: true,
          gtin: { valid: 1, invalid: 1, absent: 1 },
          invalidGtinByBrand: { GIANT: 1 },
          invalidGtinSamples: ['5461000'],
          mpn: { valid: 2, invalid: 0, absent: 1 },
        });
      });

      it('measures what the spec-row list lets through, and flags listings it leaves empty', async () => {
        givenFeed(identifierFeed);

        const result = await service.simulate(identifierSource, { limit: 1 });

        expect(result.feed?.identifiers.specRows).toEqual({
          configured: true,
          listings: 3,
          listingsWithNoRowSent: 1,
          meanRowsSent: 1,
          meanRowsTotal: 1.7,
          byLabel: [
            { label: 'Motor', listings: 2 },
            { label: 'Váz', listings: 1 },
            { label: 'Kerék', listings: 0 },
          ],
        });
        expect(result.warnings.join(' ')).toMatch(/1 eligible items match none/);
      });

      it('previews each fully mapped item\'s identifiers as they would be stored', async () => {
        givenFeed(identifierFeed);
        mapper.map.mockResolvedValueOnce({
          status: 'mapped',
          url: 'u',
          scrapedProduct: {
            offers: [{ price: 1, externalId: 'a', gtin: '9008594503199', mpn: '1260040108' }],
          },
        });

        const result = await service.simulate(identifierSource, { limit: 1 });

        expect(result.feed?.productIdentifiers).toEqual([
          {
            externalId: 'a',
            gtin: { raw: '9008594503199', stored: '09008594503199', outcome: 'valid' },
            mpn: { raw: '1260040108', stored: '1260040108', outcome: 'valid' },
            siblingIds: undefined,
            specRowsSent: 2,
            specRowsTotal: 3,
          },
        ]);
      });
    });

    it('passes cleanly when every externalId is distinct', async () => {
      givenFeed(feed(['a', 'b', 'c']));

      const result = await service.simulate(feedSource);

      expect(result.feed?.duplicateExternalIds).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('warns about items that would fall back to the URL slug', async () => {
      givenFeed(feed(['a', '', 'c']));

      const result = await service.simulate(feedSource);

      expect(result.feed?.itemsWithoutExternalId).toBe(1);
      expect(result.warnings.join(' ')).toMatch(/would fall back to the URL slug/);
    });

    it('calls a gate that keeps nothing an error, not a quiet zero', async () => {
      givenFeed(feed(['a', 'b']));
      mapper.classify.mockResolvedValue({
        status: 'skipped',
        reason: 'category_not_identified',
      });

      const result = await service.simulate(feedSource);

      expect(result.feed?.wouldImport).toBe(0);
      expect(result.errors.join(' ')).toMatch(/No item survives the category gate/);
    });

    it('simulates a googleshop source as a feed', async () => {
      givenFeed(feed(['a', 'b']));

      const result = await service.simulate({ ...feedSource, type: 'googleshop' } as ProductSource);

      expect(result.type).toBe('googleshop');
      expect(result.feed?.itemsParsed).toBe(2);
      expect(result.scraping).toBeUndefined();
      expect(scrapingImport.planRun).not.toHaveBeenCalled();
    });

    it('reports a feed that cannot be fetched as an error, not an empty run', async () => {
      nativeScraper.stream.mockRejectedValue(new Error('HTTP 404'));

      const result = await service.simulate(feedSource);

      expect(result.errors).toEqual(['HTTP 404']);
      expect(result.feed).toBeUndefined();
    });
  });

  describe('a scraping source', () => {
    const card = (overrides: Record<string, unknown> = {}) => ({
      url: 'https://ebikeshop.hu/p/1',
      price: 100,
      availability: 'in_stock',
      ...overrides,
    });

    /** This source's record of the card's page, on a product, with one offer entry. */
    const knownRecord = (overrides: Record<string, unknown> = {}) => ({
      id: 'record-1',
      url: 'https://ebikeshop.hu/p/1',
      model: { id: 'model-1' },
      scrapedProduct: { offers: [{ price: 90, resolvedExternalId: 'p/1' }] },
      lastUpdated: new Date(Date.now() - DAY),
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
      sourceRecordRepo.findBySourceAndUrl.mockResolvedValue(knownRecord());
      interpreter.runListPage.mockResolvedValue({
        products: [card({ availability: undefined })],
      });

      const result = await service.simulate(scrapingSource);

      expect(result.scraping?.decisions[0]).toMatchObject({
        known: true,
        outcome: 'incomplete',
        satisfiesMinimumSet: false,
        missingFields: ['availability'],
        wouldScrapeDetail: true,
      });
      expect(result.scraping?.wouldScrapeDetail).toBe(1);
    });

    it('refreshes in place when a known listing satisfies the minimum set', async () => {
      sourceRecordRepo.findBySourceAndUrl.mockResolvedValue(knownRecord());
      interpreter.runListPage.mockResolvedValue({ products: [card()] });

      const result = await service.simulate(scrapingSource);

      expect(result.scraping?.decisions[0]).toMatchObject({ outcome: 'refresh', wouldScrapeDetail: false });
      expect(result.scraping?.decisions[0].reason).toMatch(/detail page due again on \d{4}-\d{2}-\d{2}/);
      expect(result.scraping?.wouldRefreshInline).toBe(1);
      expect(result.scraping?.outcomes).toEqual({ refresh: 1 });
    });

    it('still needs a detail fetch for a known listing with no offer yet', async () => {
      sourceRecordRepo.findBySourceAndUrl.mockResolvedValue(
        knownRecord({ scrapedProduct: { offers: [] } }),
      );
      interpreter.runListPage.mockResolvedValue({ products: [card()] });

      const result = await service.simulate(scrapingSource);

      expect(result.scraping?.decisions[0].reason).toMatch(/no offer to refresh/);
      expect(result.scraping?.decisions[0].wouldScrapeDetail).toBe(true);
    });

    it('fetches the detail page of a listing past its detailRefreshInterval', async () => {
      sourceRecordRepo.findBySourceAndUrl.mockResolvedValue(
        knownRecord({ lastUpdated: new Date(Date.now() - 61 * DAY) }),
      );
      interpreter.runListPage.mockResolvedValue({ products: [card()] });

      const result = await service.simulate(scrapingSource);

      expect(result.scraping?.decisions[0]).toMatchObject({ outcome: 'stale', wouldScrapeDetail: true });
      expect(result.scraping?.decisions[0].reason).toMatch(/due again on \d{4}-\d{2}-\d{2} \(detailRefreshInterval: 60 days\)/);
    });

    it('says when a listing found by its externalId moves to the card’s URL', async () => {
      sourceRecordRepo.findUniqueBySourceAndExternalId.mockResolvedValue(
        knownRecord({ url: 'https://ebikeshop.hu/p/old-name' }),
      );
      interpreter.runListPage.mockResolvedValue({ products: [card({ externalId: 'CODE-1' })] });

      const result = await service.simulate(scrapingSource);

      expect(result.scraping?.decisions[0]).toMatchObject({
        known: true,
        outcome: 'refresh',
        movedFrom: 'https://ebikeshop.hu/p/old-name',
      });
      expect(result.scraping?.decisions[0].reason).toContain('moves here from https://ebikeshop.hu/p/old-name');
    });

    it('calls a page that yields no cards an error', async () => {
      interpreter.runListPage.mockResolvedValue({ products: [] });

      const result = await service.simulate(scrapingSource);

      expect(result.errors.join(' ')).toMatch(/produced no cards/);
    });
  });
});
