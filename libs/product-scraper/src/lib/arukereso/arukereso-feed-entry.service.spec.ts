import { ArukeresoFeedEntryService } from './arukereso-feed-entry.service';
import { feedRowHash } from './feed-row-hash';
import { ListingExternalIdMismatchError } from '@fittkereso-backend/database';
import type { ProductImportTask, ScrapedPage } from '@fittkereso-backend/database';

const ebikes = { id: 'cat-1', slug: 'ebikes', name: 'Ebikes' };
const bikes = { id: 'cat-2', slug: 'bikes', name: 'Bikes' };

/** A feed row's raw item, and what the mapper makes of it. */
const item = (identifier: string) => ({ fields: { identifier }, attributes: [] });
const mappedRow = (identifier: string, overrides: Record<string, unknown> = {}) => ({
  status: 'mapped',
  url: 'https://www.k2shop.hu/scott-scale-940',
  scrapedProduct: {
    brand: 'Scott',
    originalName: `Scott Scale 940 ${identifier}`,
    externalId: identifier,
    category: ebikes,
    extractedSpecs: { modelYear: 2026 },
    specs: { modelYear: 2026 },
    rawSpecs: [{ name: 'Webshop kategória', values: ['MTB'] }],
    offers: [{ externalId: identifier, price: 1000, currency: 'HUF' }],
    ...overrides,
  },
});

const storedPage = (overrides: Partial<ScrapedPage> = {}): ScrapedPage => ({
  url: 'https://www.k2shop.hu/scott-scale-940',
  rawSpecs: [{ name: 'Neme:', values: ['Férfi'] }],
  specs: { gender: 'Férfi' },
  rowCount: 1,
  contentHash: 'stored-hash',
  ...overrides,
});

describe('ArukeresoFeedEntryService', () => {
  let service: ArukeresoFeedEntryService;
  let taskRepo: { loadPayload: jest.Mock };
  let mapper: { map: jest.Mock };
  let updater: { createOrUpdateProduct: jest.Mock };
  let metrics: { feedEntrySkippedAt: jest.Mock; feedPageFailed: jest.Mock };
  let pageReader: { read: jest.Mock; mapSpecs: jest.Mock };
  let sourceRecordRepo: { findStoredPages: jest.Mock };
  let categoryConfigService: { getConfig: jest.Mock; getJsonSchema: jest.Mock };
  let taskConfig: { maxAttempts: number };

  const config = (withDetailPage = true) => ({
    baseUrl: 'https://www.k2shop.hu',
    feedUrl: 'https://www.k2shop.hu/feed',
    categories: { ebikes: { enabled: true } },
    mapping: {},
    ...(withDetailPage ? { detailPage: { rawSpecs: [] } } : {}),
  });

  const task = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'task-1',
      url: 'https://www.k2shop.hu/scott-scale-940',
      priority: 50,
      attempts: 0,
      product: null,
      source: { id: 'source-1', name: 'k2shop-arukereso', type: 'arukereso', fetchMode: 'direct', config: config() },
      ...overrides,
    }) as unknown as ProductImportTask;

  /** A page read: the reader's answer for the rows' category. */
  const pageRead = (overrides: Record<string, unknown> = {}) => ({
    url: 'https://www.k2shop.hu/scott-scale-940',
    fetchMode: 'direct',
    detail: {
      rawSpecs: [{ name: 'Neme:', values: ['Férfi'] }],
      description: 'A page description',
      imageUrls: [],
      rawOffers: [],
      offerLinks: [],
    },
    category: ebikes,
    specs: { gender: 'Férfi', frameSize: 51 },
    contentHash: 'page-hash',
    ...overrides,
  });

  const payloadOf = (...identifiers: string[]) => ({
    rows: identifiers.map((identifier) => ({ item: item(identifier), listingId: identifier, rowHash: identifier })),
    requestedSlugs: ['ebikes'],
  });

  beforeEach(() => {
    taskRepo = { loadPayload: jest.fn().mockResolvedValue(payloadOf('SC_M')) };
    mapper = {
      map: jest.fn().mockImplementation(async ({ item: row }) => mappedRow(row.fields.identifier)),
    };
    updater = { createOrUpdateProduct: jest.fn().mockResolvedValue({ id: 'model-1' }) };
    metrics = { feedEntrySkippedAt: jest.fn(), feedPageFailed: jest.fn() };
    pageReader = { read: jest.fn().mockResolvedValue(pageRead()), mapSpecs: jest.fn().mockResolvedValue({}) };
    sourceRecordRepo = { findStoredPages: jest.fn().mockResolvedValue(new Map()) };
    categoryConfigService = {
      getConfig: jest.fn().mockReturnValue({ offerLevelSpecs: ['frameSize', 'color'] }),
      getJsonSchema: jest.fn().mockReturnValue({ type: 'object', properties: {} }),
    };
    taskConfig = { maxAttempts: 3 };
    service = new ArukeresoFeedEntryService(
      taskRepo as never,
      mapper as never,
      updater as never,
      metrics as never,
      pageReader as never,
      sourceRecordRepo as never,
      categoryConfigService as never,
      taskConfig as never,
    );
  });

  const imported = () =>
    updater.createOrUpdateProduct.mock.calls.map(([context, listing]) => ({ context, listing }));

  describe('a feed_entry task (no page read)', () => {
    it('maps the stored row with the current config and imports it under this task', async () => {
      const source = task().source;
      await service.importEntry(task());

      expect(mapper.map).toHaveBeenCalledWith({ config: source.config, item: item('SC_M'), requestedSlugs: ['ebikes'] });
      const [{ context, listing }] = imported();
      expect(context).toMatchObject({
        url: 'https://www.k2shop.hu/scott-scale-940',
        feedRowHash: feedRowHash(mappedRow('SC_M').url, mappedRow('SC_M').scrapedProduct as never),
      });
      expect(context.pageRead).toBeUndefined();
      expect(listing).toEqual(mappedRow('SC_M').scrapedProduct);
      expect(pageReader.read).not.toHaveBeenCalled();
    });

    // A task queued before rows were grouped by page.
    it('imports a one-row payload of before grouping', async () => {
      taskRepo.loadPayload.mockResolvedValue({ item: item('SC_M'), requestedSlugs: ['ebikes'] });

      await service.importEntry(task());

      expect(imported()).toHaveLength(1);
    });

    // The page its record kept is merged in again, so a feed-only import gives
    // the same listing — the same identity input, no LLM call — as the read did.
    it('merges the page the listing kept, without fetching', async () => {
      sourceRecordRepo.findStoredPages.mockResolvedValue(new Map([['SC_M', storedPage()]]));

      await service.importEntry(task());

      expect(sourceRecordRepo.findStoredPages).toHaveBeenCalledWith('source-1', ['SC_M']);
      const [{ listing, context }] = imported();
      expect(listing.extractedSpecs).toEqual({ modelYear: 2026, gender: 'Férfi' });
      expect(listing.page).toEqual(storedPage());
      expect(context.pageRead).toBeUndefined();
      // The row hash stays the feed row's own.
      expect(context.feedRowHash).toBe(feedRowHash(mappedRow('SC_M').url, mappedRow('SC_M').scrapedProduct as never));
    });

    it('merges no stored page once the source has no detailPage any more', async () => {
      sourceRecordRepo.findStoredPages.mockResolvedValue(new Map([['SC_M', storedPage()]]));

      await service.importEntry(task({ source: { ...task().source, config: config(false) } }));

      expect(sourceRecordRepo.findStoredPages).not.toHaveBeenCalled();
      expect(imported()[0].listing.page).toBeUndefined();
    });

    it('finishes without importing a row the config now rejects, counting why', async () => {
      mapper.map.mockResolvedValue({ status: 'skipped', reason: 'category_not_enabled' });

      await service.importEntry(task());

      expect(updater.createOrUpdateProduct).not.toHaveBeenCalled();
      expect(metrics.feedEntrySkippedAt).toHaveBeenCalledWith('k2shop-arukereso', 'category_not_enabled');
    });

    it('fails a task that carries no feed row', async () => {
      taskRepo.loadPayload.mockResolvedValue(null);

      await expect(service.importEntry(task())).rejects.toThrow(/carries no feed row/);
      expect(updater.createOrUpdateProduct).not.toHaveBeenCalled();
    });
  });

  // k2shop: a bike's sizes share one product URL.
  describe('a page several rows share', () => {
    beforeEach(() => {
      taskRepo.loadPayload.mockResolvedValue(payloadOf('SC_M', 'SC_L', 'SC_XL'));
    });

    it('imports every row as its own listing', async () => {
      await service.importEntry(task());

      expect(imported().map(({ listing }) => listing.externalId)).toEqual(['SC_M', 'SC_L', 'SC_XL']);
      expect(new Set(imported().map(({ context }) => context.feedRowHash)).size).toBe(3);
    });

    it('reads the page once for all of them', async () => {
      await service.importEntry(task(), { fetchPage: true });

      expect(pageReader.read).toHaveBeenCalledTimes(1);
      expect(imported()).toHaveLength(3);
      for (const { listing, context } of imported()) {
        expect(listing.page).toMatchObject({ rowCount: 3, contentHash: 'page-hash' });
        expect(context.pageRead).toEqual({ fetchedAt: expect.any(Date) });
      }
    });

    // Which size the page's size means is unknown on a shared page.
    it('leaves the page’s offer-level values out of each row', async () => {
      await service.importEntry(task(), { fetchPage: true });

      for (const { listing } of imported()) {
        expect(listing.extractedSpecs).toEqual({ modelYear: 2026, gender: 'Férfi' });
      }
    });

    it('expects the page to show any of its rows', async () => {
      await service.importEntry(task(), { fetchPage: true });

      expect(pageReader.read.mock.calls[0][0].expectedExternalIds).toEqual(['SC_M', 'SC_L', 'SC_XL']);
    });

    // A pin is for one listing: a page's rows would all follow it to one product.
    it('ignores a product pin on a page of several rows', async () => {
      await service.importEntry(task({ product: { id: 'pinned' } }));

      for (const { context } of imported()) expect(context.product).toBeUndefined();
    });

    it('keeps a product pin on a one-row task, as a resync queues it', async () => {
      taskRepo.loadPayload.mockResolvedValue(payloadOf('SC_M'));

      await service.importEntry(task({ product: { id: 'pinned' } }));

      expect(imported()[0].context.product).toEqual({ id: 'pinned' });
    });

    it('goes on with the other rows when one fails, and succeeds', async () => {
      updater.createOrUpdateProduct
        .mockResolvedValueOnce({ id: 'm' })
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ id: 'm' });

      await expect(service.importEntry(task())).resolves.toBeUndefined();
      expect(updater.createOrUpdateProduct).toHaveBeenCalledTimes(3);
    });

    it('fails the task when every row failed, for its retries to try them all', async () => {
      updater.createOrUpdateProduct.mockRejectedValue(new Error('boom'));

      await expect(service.importEntry(task())).rejects.toThrow('boom');
      expect(updater.createOrUpdateProduct).toHaveBeenCalledTimes(3);
    });

    it('skips the rows the config now rejects and imports the rest', async () => {
      mapper.map.mockImplementation(async ({ item: row }) =>
        row.fields.identifier === 'SC_L' ? { status: 'skipped', reason: 'filtered_out' } : mappedRow(row.fields.identifier),
      );

      await service.importEntry(task());

      expect(imported().map(({ listing }) => listing.externalId)).toEqual(['SC_M', 'SC_XL']);
      expect(metrics.feedEntrySkippedAt).toHaveBeenCalledWith('k2shop-arukereso', 'filtered_out');
    });

    // Rows of one page may fall in two categories: the page is read once and
    // its rows mapped again for the other one.
    it("maps the page's rows again for a row of another category", async () => {
      mapper.map.mockImplementation(async ({ item: row }) =>
        mappedRow(row.fields.identifier, row.fields.identifier === 'SC_XL' ? { category: bikes } : {}),
      );
      pageReader.mapSpecs.mockResolvedValue({ wheelSize: 29 });

      await service.importEntry(task(), { fetchPage: true });

      expect(pageReader.read).toHaveBeenCalledTimes(1);
      expect(pageReader.mapSpecs).toHaveBeenCalledTimes(1);
      expect(pageReader.mapSpecs.mock.calls[0][0].interpretation.category).toEqual(bikes);
      const xl = imported().find(({ listing }) => listing.externalId === 'SC_XL');
      expect(xl?.listing.extractedSpecs).toEqual({ modelYear: 2026, wheelSize: 29 });
    });
  });

  describe('a detail_page task (the page read)', () => {
    it('reads the page with the row’s category and merges it in, the feed primary', async () => {
      await service.importEntry(task(), { fetchPage: true });

      expect(pageReader.read).toHaveBeenCalledWith(
        expect.objectContaining({
          category: ebikes,
          config: expect.objectContaining({ baseUrl: 'https://www.k2shop.hu', detailPage: { rawSpecs: [] } }),
        }),
      );
      const [{ listing, context }] = imported();
      // One row on the page: its offer-level values are this row's.
      expect(listing.extractedSpecs).toEqual({ modelYear: 2026, gender: 'Férfi', frameSize: 51 });
      expect(listing.description).toBe('A page description');
      expect(listing.page).toMatchObject({ rowCount: 1, contentHash: 'page-hash' });
      expect(context.pageRead).toEqual({ fetchedAt: expect.any(Date) });
    });

    it('expects the page to show the row’s id, its offer’s, MPN or GTIN', async () => {
      mapper.map.mockResolvedValue(
        mappedRow('24384', { offers: [{ externalId: '24384', mpn: '1260161111', gtin: '9008594507326', price: 1 }] }),
      );

      await service.importEntry(task(), { fetchPage: true });

      expect(pageReader.read.mock.calls[0][0].expectedExternalIds).toEqual(['24384', '1260161111', '9008594507326']);
    });

    it('leaves a failed read to the task’s retries before its last attempt', async () => {
      pageReader.read.mockRejectedValue(new Error('Fetching … returned HTTP 503'));

      await expect(service.importEntry(task({ attempts: 0 }), { fetchPage: true })).rejects.toThrow('HTTP 503');
      await expect(service.importEntry(task({ attempts: 1 }), { fetchPage: true })).rejects.toThrow('HTTP 503');
      expect(updater.createOrUpdateProduct).not.toHaveBeenCalled();
    });

    // The offer never waits on a page: the last attempt imports the feed rows,
    // with the page their records kept, and records the failure for the backoff.
    it('imports the rows without a fresh page on the last attempt, recording the failure', async () => {
      pageReader.read.mockRejectedValue(new Error('Fetching … returned HTTP 404'));
      sourceRecordRepo.findStoredPages.mockResolvedValue(new Map([['SC_M', storedPage()]]));

      await service.importEntry(task({ attempts: 2 }), { fetchPage: true });

      const [{ listing, context }] = imported();
      expect(listing.page).toEqual(storedPage());
      expect(context.pageRead).toEqual({ failedAt: expect.any(Date) });
      expect(metrics.feedPageFailed).toHaveBeenCalledWith('k2shop-arukereso', 'error');
    });

    it('imports the rows from the feed alone when no page was ever kept', async () => {
      pageReader.read.mockRejectedValue(new Error('timeout'));

      await service.importEntry(task({ attempts: 2 }), { fetchPage: true });

      expect(imported()[0].listing).toEqual(mappedRow('SC_M').scrapedProduct);
    });

    // A delisted URL redirected to another product: no retry fixes that.
    it('falls back at once when the page shows another product', async () => {
      pageReader.read.mockRejectedValue(
        new ListingExternalIdMismatchError({
          source: task().source,
          url: 'https://www.k2shop.hu/scott-scale-940',
          expectedExternalId: 'SC_M',
          pageExternalIds: ['OTHER'],
        }),
      );

      await service.importEntry(task({ attempts: 0 }), { fetchPage: true });

      expect(imported()).toHaveLength(1);
      expect(imported()[0].context.pageRead).toEqual({ failedAt: expect.any(Date) });
      expect(metrics.feedPageFailed).toHaveBeenCalledWith('k2shop-arukereso', 'mismatch');
    });

    it('reads nothing on a source without a detailPage, even as a page task', async () => {
      await service.importEntry(task({ source: { ...task().source, config: config(false) } }), { fetchPage: true });

      expect(pageReader.read).not.toHaveBeenCalled();
      expect(imported()[0].context.pageRead).toBeUndefined();
    });
  });
});
