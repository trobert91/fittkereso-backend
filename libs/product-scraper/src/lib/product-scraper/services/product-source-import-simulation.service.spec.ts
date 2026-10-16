import { Readable } from 'stream';
import { ProductSourceImportSimulationService } from './product-source-import-simulation.service';
import { ArukeresoFeedParserService } from '../../arukereso/arukereso-feed-parser.service';
import { ArukeresoProductMapperService } from '../../arukereso/arukereso-product-mapper.service';
import { ListProductRefreshService } from './list-product-refresh.service';
import { OfferCondition } from '@fittkereso-backend/database';
import type { ProductSource } from '@fittkereso-backend/database';

const DAY = 24 * 60 * 60 * 1000;

describe('ProductSourceImportSimulationService', () => {
  let service: ProductSourceImportSimulationService;
  let mapper: {
    classify: jest.Mock;
    map: jest.Mock;
    resolveTarget: jest.Mock;
    isMapped: jest.Mock;
  };
  let interpreter: { runValuePipeline: jest.Mock; runListPage: jest.Mock };
  let scraperService: { getHtml: jest.Mock; stream: jest.Mock };
  let scrapingImport: { planRun: jest.Mock };
  let sourceRecordRepo: { findBySourceAndUrl: jest.Mock; findBySourceAndExternalId: jest.Mock };
  let specPostProcess: { extractIdentity: jest.Mock };
  let feedTriage: { triage: jest.Mock };
  let offerRepo: { findSyncStates: jest.Mock };
  let pageReader: { read: jest.Mock };
  let brandResolution: { resolve: jest.Mock };
  let reidentification: { keyChangeOf: jest.Mock };

  const feedSource = {
    id: 'source-1',
    name: 'speedbike-arukereso',
    type: 'arukereso',
    fetchMode: 'direct',
    config: {
      baseUrl: 'https://speedbike.hu',
      feedUrl: 'https://speedbike.hu/feed',
      categories: { ebikes: { enabled: true } },
      mapping: { externalId: { field: 'identifier' } },
    },
  } as unknown as ProductSource;

  const scrapingSource = {
    id: 'source-2',
    name: 'ebikeshop',
    type: 'scraping',
    fetchMode: 'proxied',
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
    scraperService.stream.mockResolvedValue({
      statusCode: 200,
      contentType: 'application/xml',
      stream: Readable.from([xml]),
    });

  beforeEach(() => {
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
      isMapped: jest.fn((...args: Parameters<ArukeresoProductMapperService['isMapped']>) =>
        new ArukeresoProductMapperService(
          interpreter as never,
          {} as never,
          {} as never,
          {} as never,
        ).isMapped(...args),
      ),
    };
    interpreter = { runValuePipeline: jest.fn(), runListPage: jest.fn() };
    scraperService = {
      getHtml: jest.fn().mockResolvedValue('<html></html>'),
      stream: jest.fn(),
    };
    scrapingImport = {
      planRun: jest
        .fn()
        .mockResolvedValue({ categoryUrls: ['c1'], pageUrls: ['p1', 'p2'] }),
    };
    sourceRecordRepo = {
      findBySourceAndUrl: jest.fn().mockResolvedValue(null),
      findBySourceAndExternalId: jest.fn().mockResolvedValue(null),
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
        .mockImplementation(async ({ scrapedProduct }) => ({ ...scrapedProduct, model: 'Named' })),
    };
    pageReader = { read: jest.fn() };
    brandResolution = { resolve: jest.fn().mockResolvedValue({ entity: { name: 'KTM' } }) };
    reidentification = { keyChangeOf: jest.fn().mockReturnValue(undefined) };

    service = new ProductSourceImportSimulationService(
      scraperService as never,
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
        {} as never,
      ),
      // The real parser: a stub would leave the wiring untested.
      new ArukeresoFeedParserService(),
      mapper as never,
      specPostProcess as never,
      feedTriage as never,
      offerRepo as never,
      pageReader as never,
      { getConfig: jest.fn().mockReturnValue({ offerLevelSpecs: ['frameSize'] }) } as never,
      sourceRecordRepo as never,
      brandResolution as never,
      { normalizedModelOf: jest.fn().mockReturnValue('named') } as never,
      reidentification as never,
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
      expect(result.feed?.products[0]).toMatchObject({ model: 'Named' });
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
      // Its previews go through the extraction as its import would: the
      // source's postProcess.identity decides whether that calls the LLM. The
      // spec rows it would read are no concern of a contributing source.
      expect(specPostProcess.extractIdentity).toHaveBeenCalledTimes(3);
      expect(result.warnings.join(' ')).not.toMatch(/identitySpecRows/);
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

    // What tells a config author the mapping reads the shop's labels.
    it('counts the rows per condition once the config maps it', async () => {
      givenFeed(feed(['a', 'b', 'c', 'd']));
      const conditions = [OfferCondition.new, OfferCondition.used, null, OfferCondition.new];
      let row = 0;
      mapper.map.mockImplementation(async () => ({
        status: 'mapped',
        url: `https://speedbike.hu/p/${row}`,
        scrapedProduct: {
          offers: [{ externalId: `sku-${row}`, price: 1, condition: conditions[row++] }],
        },
      }));
      const mapsCondition = {
        ...feedSource,
        config: {
          ...feedSource.config,
          mapping: { externalId: { field: 'identifier' }, condition: { field: 'condition' } },
        },
      } as ProductSource;

      const result = await service.simulate(mapsCondition);

      expect(result.feed?.conditions).toEqual({ new: 2, used: 1, none: 1 });
    });

    it('leaves the condition tally out when the config does not map it', async () => {
      givenFeed(feed(['a']));

      const result = await service.simulate(feedSource);

      expect(result.feed?.conditions).toBeUndefined();
    });

    it('leaves the offer match unreported for an identifying source', async () => {
      givenFeed(feed(['a']));

      const result = await service.simulate(feedSource);

      expect(result.feed?.matchingOffers).toBeUndefined();
      expect(offerRepo.findSyncStates).not.toHaveBeenCalled();
    });

    // Rows sharing a page are each their own listing now: counted, not warned about.
    it('counts rows that share a product page, without a warning', async () => {
      givenFeed(feed(['a', 'b']));

      const result = await service.simulate(feedSource);

      expect(result.feed?.duplicateUrls).toBe(1);
      expect(result.warnings.join(' ')).not.toMatch(/share a URL|only the last/);
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

    // The check this simulator exists for. A listing is unique per (source,
    // externalId) and its offer per (seller, externalId), so a run imports only
    // the first row of a repeated id. speedbike's feed repeats `sku` across size
    // variants for exactly this reason.
    it('fails the simulation when the chosen externalId is not unique', async () => {
      givenFeed(feed(['dup', 'dup', 'unique']));

      const result = await service.simulate(feedSource);

      expect(result.feed?.distinctExternalIds).toBe(2);
      expect(result.feed?.duplicateExternalIds).toEqual([
        { externalId: 'dup', count: 2 },
      ]);
      expect(result.errors.join(' ')).toMatch(/imports only the first row of each/);
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
          categories: { ebikes: { enabled: true, identitySpecRows: ['Motor', 'Váz', 'Kerék'] } },
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
            { category: 'ebikes', label: 'Motor', listings: 2 },
            { category: 'ebikes', label: 'Váz', listings: 1 },
            { category: 'ebikes', label: 'Kerék', listings: 0 },
          ],
        });
        expect(result.warnings.join(' ')).toMatch(/1 eligible items match none/);
      });

      // A section's extraSpecRows reach the identity extraction too: the
      // count reads the mapped product's rows, not only the feed's.
      it('counts the extra rows the mapper appends', async () => {
        givenFeed(identifierFeed);
        mapper.map.mockImplementation(async ({ item }: { item: { attributes: { name: string; value: string }[] } }) => ({
          status: 'mapped',
          url: 'u',
          scrapedProduct: {
            rawSpecs: [
              ...item.attributes.map(({ name, value }) => ({ name, values: [value] })),
              { name: 'Webshop kategória', values: ['E-BIKE > Trekking'] },
            ],
          },
        }));
        const withExtraRow = {
          ...identifierSource,
          config: {
            ...identifierSource.config,
            categories: { ebikes: { enabled: true, identitySpecRows: ['Motor', 'Webshop kategória'] } },
          },
        } as unknown as ProductSource;

        const result = await service.simulate(withExtraRow, { limit: 1 });

        expect(result.feed?.identifiers.specRows.byLabel).toEqual([
          { category: 'ebikes', label: 'Motor', listings: 2 },
          { category: 'ebikes', label: 'Webshop kategória', listings: 3 },
        ]);
        expect(result.feed?.identifiers.specRows.listingsWithNoRowSent).toBe(0);
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
      scraperService.stream.mockRejectedValue(new Error('HTTP 404'));

      const result = await service.simulate(feedSource);

      expect(result.errors).toEqual(['HTTP 404']);
      expect(result.feed).toBeUndefined();
    });

    // Rows sharing a page are each their own listing, triaged on their own.
    it('triages every listing of a page, not one row per URL', async () => {
      givenFeed(feed(['a', 'b']));
      let row = 0;
      mapper.map.mockImplementation(async () => {
        row += 1;
        return {
          status: 'mapped',
          url: 'https://speedbike.hu/p/scale',
          scrapedProduct: { externalId: `sku-${row}`, offers: [{ externalId: `sku-${row}` }] },
        };
      });

      const result = await service.simulate(feedSource);

      expect(feedTriage.triage.mock.calls[0][1]).toHaveLength(2);
      expect(result.feed?.wouldQueue).toBe(2);
    });

    // A source with a detailPage: the previews read their page as their page
    // import would, and the counts say how many pages a run would fetch.
    describe('a source that reads product pages', () => {
      const ebikes = { id: 'cat-ebikes', slug: 'ebikes', name: 'E-bikes' };
      const pageSource = {
        ...feedSource,
        fetchMode: 'proxied',
        config: { ...feedSource.config, detailPage: { fetchMode: 'direct', rawSpecs: [] } },
      } as unknown as ProductSource;

      /** The feed row: its title and price, no spec but its own model year. */
      const feedRow = (id: string, url = `https://speedbike.hu/p/${id}`) => ({
        status: 'mapped',
        url,
        scrapedProduct: {
          category: ebikes,
          brand: 'KTM',
          originalName: 'KTM Macina Tour',
          externalId: id,
          extractedSpecs: { modelYear: 2026 },
          specs: { modelYear: 2026 },
          rawSpecs: [{ name: 'Webshop kategória', values: ['Elektromos Kerékpárok'] }],
          offers: [{ externalId: id, price: 1_259_640 }],
        },
      });

      /** What the page shows: gender, torque and its description. */
      const pageRead = (url: string) => ({
        url,
        fetchMode: 'direct',
        detail: {
          rawSpecs: [
            { name: 'Neme:', values: ['Férfi'] },
            { name: 'Motor típusa:', values: ['Bosch Performance Line PX (90 Nm)'] },
          ],
          description: 'QUALITY. COMFORT.',
          imageUrls: [],
          rawOffers: [],
        },
        category: ebikes,
        specs: { gender: 'Férfi', torque: 90, modelYear: 2025 },
        contentHash: 'hash',
      });

      beforeEach(() => {
        mapper.map.mockImplementation(async ({ item }) => feedRow(item.fields['identifier']));
        pageReader.read.mockImplementation(async ({ task }) => pageRead(task.url));
      });

      it('counts the rows a run would read the page of', async () => {
        givenFeed(feed(['a', 'b', 'c']));
        feedTriage.triage.mockImplementation(async (_source, rows) => ({
          unchanged: [],
          toImport: rows,
          needsPage: new Set(['a', 'c']),
        }));

        const result = await service.simulate(pageSource);

        expect(result.feed?.wouldFetchPage).toBe(2);
      });

      it('previews each row with its page merged in, the feed winning', async () => {
        givenFeed(feed(['a']));

        const result = await service.simulate(pageSource);

        const [preview] = result.feed?.products ?? [];
        // The page filled gender and torque; the feed's model year stands.
        expect(preview.extractedSpecs).toEqual({ modelYear: 2026, gender: 'Férfi', torque: 90 });
        expect(preview.description).toBe('QUALITY. COMFORT.');
        expect(result.feed?.pages).toEqual([
          {
            url: 'https://speedbike.hu/p/a',
            fetchMode: 'direct',
            rows: 2,
            filledSpecs: ['gender', 'torque'],
            filledDescription: true,
          },
        ]);
        // The rows the extraction is given are counted after the merge.
        expect(result.feed?.productIdentifiers?.[0]).toMatchObject({ specRowsSent: 3, specRowsTotal: 3 });
        // Extracted as the page import would: the feed row apart, the page read now.
        expect(specPostProcess.extractIdentity).toHaveBeenCalledWith({
          context: expect.objectContaining({
            feedListing: expect.objectContaining({ externalId: 'a' }),
            pageRead: { fetchedAt: expect.any(Date) },
          }),
          scrapedProduct: expect.objectContaining({ page: expect.objectContaining({ rowCount: 1 }) }),
        });
        expect(pageReader.read).toHaveBeenCalledWith(
          expect.objectContaining({
            category: ebikes,
            expectedExternalIds: ['a', 'a', undefined, undefined],
          }),
        );
      });

      it('reads a page its preview rows share once', async () => {
        givenFeed(feed(['a', 'b']));
        mapper.map.mockImplementation(async ({ item }) =>
          feedRow(item.fields['identifier'], 'https://speedbike.hu/p/scale'),
        );

        const result = await service.simulate(pageSource);

        expect(pageReader.read).toHaveBeenCalledTimes(1);
        expect(result.feed?.pages).toHaveLength(2);
      });

      it('previews the row from the feed alone when its page cannot be read', async () => {
        givenFeed(feed(['a']));
        pageReader.read.mockRejectedValue(new Error('HTTP 404'));

        const result = await service.simulate(pageSource);

        expect(result.feed?.pages?.[0]).toMatchObject({ error: 'HTTP 404', rows: 0 });
        expect(result.feed?.products[0].extractedSpecs).toEqual({ modelYear: 2026 });
        expect(specPostProcess.extractIdentity).toHaveBeenCalledWith(
          expect.objectContaining({ context: expect.objectContaining({ pageRead: undefined }) }),
        );
      });

      /** The mode a read was asked in, as the reader resolves it (pageFetchModeOf). */
      const fetchModeOfRead = (call: number) => {
        const { task, config } = pageReader.read.mock.calls[call][0];
        return config.detailPage.fetchMode ?? task.source.fetchMode;
      };

      // The tool's argument wins over detailPage.fetchMode, which wins over the source's.
      it('reads pages in detailPage.fetchMode, unless the simulation overrides it', async () => {
        givenFeed(feed(['a']));
        await service.simulate(pageSource);
        expect(fetchModeOfRead(0)).toEqual('direct');

        givenFeed(feed(['a']));
        const overridden = await service.simulate(pageSource, { fetchMode: 'proxied' });
        expect(fetchModeOfRead(1)).toEqual('proxied');
        expect(overridden.feed?.pages?.[0].fetchMode).toBe('proxied');
      });

      it('reads no page for a source without a detailPage', async () => {
        givenFeed(feed(['a']));

        const plain = await service.simulate(feedSource);

        expect(pageReader.read).not.toHaveBeenCalled();
        expect(plain.feed?.pages).toBeUndefined();
      });
    });

    // What would put a listing's product in question once it is imported.
    describe("a preview's identity key", () => {
      beforeEach(() => {
        mapper.map.mockResolvedValue({
          status: 'mapped',
          url: 'https://speedbike.hu/p/a',
          scrapedProduct: { brand: 'KTM', originalName: 'KTM Macina', externalId: 'a', offers: [{ externalId: 'a', mpn: '1260161111' }] },
        });
      });

      it('is new without a stored listing', async () => {
        givenFeed(feed(['a']));

        const result = await service.simulate(feedSource);

        expect(result.feed?.identityKeys).toEqual([{ status: 'new' }]);
        expect(sourceRecordRepo.findBySourceAndExternalId).toHaveBeenCalledWith('source-1', 'a');
      });

      it('names what changed against the stored listing', async () => {
        givenFeed(feed(['a']));
        const record = { id: 'record-a' };
        sourceRecordRepo.findBySourceAndExternalId.mockResolvedValue(record);
        const change = { anchorsChanged: false, addedIdentifiers: [], changedSpecs: ['gender'] };
        reidentification.keyChangeOf.mockReturnValue(change);

        const result = await service.simulate(feedSource);

        expect(result.feed?.identityKeys).toEqual([{ status: 'changed', change }]);
        expect(reidentification.keyChangeOf).toHaveBeenCalledWith({
          extracted: expect.objectContaining({ model: 'Named' }),
          normalizedModel: 'named',
          identifiers: [{ gtin: undefined, mpn: '1260161111' }],
          record,
        });
      });

      it('is unchanged, or not comparable without a stored key', async () => {
        givenFeed(feed(['a', 'b']));
        sourceRecordRepo.findBySourceAndExternalId.mockResolvedValue({ id: 'record' });
        reidentification.keyChangeOf.mockReturnValueOnce(undefined).mockReturnValueOnce(null);

        const result = await service.simulate(feedSource);

        expect(result.feed?.identityKeys).toEqual([{ status: 'unchanged' }, { status: 'not_comparable' }]);
      });

      it('is not comparable when the extraction named nothing', async () => {
        givenFeed(feed(['a']));
        sourceRecordRepo.findBySourceAndExternalId.mockResolvedValue({ id: 'record' });
        specPostProcess.extractIdentity.mockImplementation(async ({ scrapedProduct }) => ({
          ...scrapedProduct,
          flags: ['identity_failed'],
        }));

        const result = await service.simulate(feedSource);

        expect(result.feed?.identityKeys).toEqual([{ status: 'not_comparable' }]);
        expect(reidentification.keyChangeOf).not.toHaveBeenCalled();
      });

      it('is not reported for a source that does not identify products', async () => {
        givenFeed(feed(['a']));

        const result = await service.simulate({
          ...feedSource,
          identifiesProducts: false,
          seller: { id: 'seller-1' },
        } as ProductSource);

        expect(result.feed?.identityKeys).toEqual([undefined]);
      });
    });

    it("fetches the feed in the source's mode unless told another", async () => {
      givenFeed(feed(['a']));
      const asStored = await service.simulate(feedSource);

      expect(asStored.fetchMode).toBe('direct');
      expect(scraperService.stream).toHaveBeenLastCalledWith('https://speedbike.hu/feed', 'direct');

      givenFeed(feed(['a']));
      const overridden = await service.simulate(feedSource, { fetchMode: 'proxied' });

      expect(overridden.fetchMode).toBe('proxied');
      expect(scraperService.stream).toHaveBeenLastCalledWith('https://speedbike.hu/feed', 'proxied');
      // Only the simulation's copy: the source itself is not switched.
      expect(feedSource.fetchMode).toBe('direct');
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
      product: { id: 'model-1' },
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

    // The check before switching a shop to direct: the page walk and the list
    // page both have to come back from the shop itself.
    it('walks and reads the list page in the overriding fetch mode', async () => {
      interpreter.runListPage.mockResolvedValue({ products: [card()] });

      const result = await service.simulate(scrapingSource, { fetchMode: 'direct' });

      expect(result.fetchMode).toBe('direct');
      expect(scrapingImport.planRun).toHaveBeenCalledWith(
        expect.objectContaining({ fetchMode: 'direct' }),
        expect.anything(),
      );
      expect(scraperService.getHtml).toHaveBeenCalledWith('p1', 'direct');
    });

    it("reads the list page in the source's own mode by default", async () => {
      interpreter.runListPage.mockResolvedValue({ products: [card()] });

      const result = await service.simulate(scrapingSource);

      expect(result.fetchMode).toBe('proxied');
      expect(scraperService.getHtml).toHaveBeenCalledWith('p1', 'proxied');
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
      sourceRecordRepo.findBySourceAndExternalId.mockResolvedValue(
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
