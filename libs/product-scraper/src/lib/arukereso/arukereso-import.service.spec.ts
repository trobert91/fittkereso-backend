import { Readable } from 'stream';
import {
  ArukeresoImportService,
  MAX_CONSECUTIVE_ITEM_FAILURES,
} from './arukereso-import.service';
import { ArukeresoFeedParserService } from './arukereso-feed-parser.service';
import type { ProductSource } from '@fittkereso-backend/database';

describe('ArukeresoImportService', () => {
  let service: ArukeresoImportService;
  let nativeScraper: { stream: jest.Mock };
  let mapper: { map: jest.Mock };
  let productUpdater: { createOrUpdateProduct: jest.Mock };
  let metrics: {
    fullSyncCompleted: jest.Mock;
    fullSyncFailed: jest.Mock;
    recordFullSyncDuration: jest.Mock;
  };

  const source = {
    id: 'source-1',
    name: 'speedbike',
    type: 'arukereso',
    config: {
      baseUrl: 'https://speedbike.hu',
      feedUrl: 'https://speedbike.hu/api/?route=export/feed&id=arukereso',
      category: { slugLookup: [] },
      mapping: {},
    },
  } as unknown as ProductSource;

  const feed = (productCount: number) =>
    `<?xml version="1.0" encoding="UTF-8"?><Products>${Array.from(
      { length: productCount },
      (_, i) =>
        `<Product><Identifier>${i}</Identifier><Name>Product ${i}</Name></Product>`,
    ).join('')}</Products>`;

  const givenFeed = (xml: string) =>
    nativeScraper.stream.mockResolvedValue({
      statusCode: 200,
      contentType: 'application/xml',
      stream: Readable.from([xml]),
    });

  beforeEach(() => {
    nativeScraper = { stream: jest.fn() };
    mapper = {
      map: jest.fn().mockResolvedValue({
        status: 'mapped',
        url: 'https://speedbike.hu/p',
        scrapedProduct: {},
      }),
    };
    productUpdater = {
      createOrUpdateProduct: jest.fn().mockResolvedValue({ id: 'model-1' }),
    };
    metrics = {
      fullSyncCompleted: jest.fn(),
      fullSyncFailed: jest.fn(),
      recordFullSyncDuration: jest.fn(),
    };

    service = new ArukeresoImportService(
      nativeScraper as any,
      // The real parser: this service's job is wiring it to persistence, and a
      // stubbed parser would test the wiring against nothing.
      new ArukeresoFeedParserService(),
      mapper as any,
      productUpdater as any,
      metrics as any,
    );
  });

  it('persists every item the feed yields and reports what it did', async () => {
    givenFeed(feed(3));

    const summary = await service.import(source);

    expect(summary.itemsSeen).toBe(3);
    expect(summary.offersUpdated).toBe(3);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    // A feed enqueues nothing — it is the whole catalogue in one GET, which is
    // the entire point of this source type.
    expect(summary.detailTasksEnqueued).toBe(0);
    expect(summary.listTasksEnqueued).toBe(0);
    expect(productUpdater.createOrUpdateProduct).toHaveBeenCalledTimes(3);
  });

  it('never gives the persistence path a ScrapeTask', async () => {
    givenFeed(feed(1));

    await service.import(source);

    const [context] = productUpdater.createOrUpdateProduct.mock.calls[0];
    expect(context.source).toBe(source);
    expect(context.url).toBe('https://speedbike.hu/p');
    // Inventing a throwaway ScrapeTask to satisfy a signature would put fake
    // work in a table the workers poll.
    expect(context.task).toBeUndefined();
  });

  it('counts a skipped item without persisting it', async () => {
    givenFeed(feed(2));
    mapper.map
      .mockResolvedValueOnce({ status: 'skipped', reason: 'category_not_enabled' })
      .mockResolvedValueOnce({
        status: 'mapped',
        url: 'https://speedbike.hu/p',
        scrapedProduct: {},
      });

    const summary = await service.import(source);

    expect(summary.skipped).toBe(1);
    expect(summary.offersUpdated).toBe(1);
    expect(productUpdater.createOrUpdateProduct).toHaveBeenCalledTimes(1);
  });

  // One malformed row in a 3488-product feed must not cost the other 3487.
  it('isolates a failing item and keeps going', async () => {
    givenFeed(feed(3));
    productUpdater.createOrUpdateProduct.mockRejectedValueOnce(
      new Error('constraint violation'),
    );

    const summary = await service.import(source);

    expect(summary.failed).toBe(1);
    expect(summary.offersUpdated).toBe(2);
    expect(metrics.fullSyncCompleted).toHaveBeenCalled();
  });

  // ...but a long unbroken streak is not bad rows, it is the database being
  // down or a config that no longer matches the feed, and writing the same
  // failure 3000 more times helps nobody.
  it('abandons the run after a streak of consecutive failures', async () => {
    givenFeed(feed(MAX_CONSECUTIVE_ITEM_FAILURES + 10));
    productUpdater.createOrUpdateProduct.mockRejectedValue(new Error('db down'));

    await expect(service.import(source)).rejects.toThrow(
      /consecutive items failed/,
    );

    expect(productUpdater.createOrUpdateProduct).toHaveBeenCalledTimes(
      MAX_CONSECUTIVE_ITEM_FAILURES,
    );
    expect(metrics.fullSyncFailed).toHaveBeenCalled();
  });

  it('resets the streak on any item that succeeds', async () => {
    const total = MAX_CONSECUTIVE_ITEM_FAILURES * 2;
    givenFeed(feed(total));
    // Every other item fails: never a streak, so the run completes.
    let call = 0;
    productUpdater.createOrUpdateProduct.mockImplementation(() =>
      (call += 1) % 2 === 0
        ? Promise.resolve({ id: 'model-1' })
        : Promise.reject(new Error('one bad row')),
    );

    const summary = await service.import(source);

    expect(summary.failed).toBe(total / 2);
    expect(summary.offersUpdated).toBe(total / 2);
  });

  it('narrows the run to the categories it was asked for', async () => {
    givenFeed(feed(1));

    await service.import(source, { categorySlugs: ['ebikes'] });

    expect(mapper.map).toHaveBeenCalledWith(
      expect.objectContaining({ requestedSlugs: ['ebikes'] }),
    );
  });

  // A 404 or a 500 page parsed as a feed yields zero items, which reads as
  // "the shop sells nothing" — exactly the reading that would let a delisting
  // sweep destroy a catalogue. NativeScraperService throws instead, and that
  // must reach the caller rather than be reported as an empty success.
  it('fails the run when the feed cannot be fetched', async () => {
    nativeScraper.stream.mockRejectedValue(new Error('HTTP 404'));

    await expect(service.import(source)).rejects.toThrow('HTTP 404');
    expect(metrics.fullSyncFailed).toHaveBeenCalled();
    expect(metrics.fullSyncCompleted).not.toHaveBeenCalled();
  });
});

describe('ArukeresoImportService maxItems', () => {
  let service: ArukeresoImportService;
  let nativeScraper: { stream: jest.Mock };
  let mapper: { map: jest.Mock };
  let productUpdater: { createOrUpdateProduct: jest.Mock };

  const sourceWith = (maxItems?: number) =>
    ({
      id: 'source-1',
      name: 'speedbike-arukereso',
      type: 'arukereso',
      config: {
        baseUrl: 'https://speedbike.hu',
        feedUrl: 'https://speedbike.hu/feed',
        category: { slugLookup: [] },
        mapping: {},
        maxItems,
      },
    }) as never;

  const feed = (count: number) =>
    `<?xml version="1.0"?><Products>${Array.from(
      { length: count },
      (_, i) => `<Product><Identifier>${i}</Identifier></Product>`,
    ).join('')}</Products>`;

  beforeEach(() => {
    nativeScraper = {
      stream: jest.fn().mockResolvedValue({
        statusCode: 200,
        contentType: 'application/xml',
        stream: Readable.from([feed(50)]),
      }),
    };
    mapper = {
      map: jest
        .fn()
        .mockResolvedValue({ status: 'mapped', url: 'u', scrapedProduct: {} }),
    };
    productUpdater = {
      createOrUpdateProduct: jest.fn().mockResolvedValue({ id: 'model-1' }),
    };

    service = new ArukeresoImportService(
      nativeScraper as never,
      new ArukeresoFeedParserService(),
      mapper as never,
      productUpdater as never,
      {
        fullSyncCompleted: jest.fn(),
        fullSyncFailed: jest.fn(),
        recordFullSyncDuration: jest.fn(),
      } as never,
    );
  });

  it('stops importing once the cap is reached', async () => {
    const summary = await service.import(sourceWith(10));

    expect(summary.offersUpdated).toBe(10);
    expect(productUpdater.createOrUpdateProduct).toHaveBeenCalledTimes(10);
    // The whole feed is still parsed — the stream is open and reading it out is
    // cheap, whereas aborting mid-parse is not.
    expect(summary.itemsSeen).toBe(50);
  });

  it('imports everything when no cap is set', async () => {
    const summary = await service.import(sourceWith(undefined));

    expect(summary.offersUpdated).toBe(50);
  });

  // The cap counts items IMPORTED, not items seen. With a filter alongside it,
  // `maxItems: 10` has to mean ten matching products — a cap that counted
  // attempts would return two products and call it done.
  it('counts imported items, not attempts, when most items are skipped', async () => {
    let seen = 0;
    mapper.map.mockImplementation(async () => {
      seen += 1;
      // Only every fifth item survives the filter.
      return seen % 5 === 0
        ? { status: 'mapped', url: 'u', scrapedProduct: {} }
        : { status: 'skipped', reason: 'filtered_out' };
    });

    const summary = await service.import(sourceWith(5));

    expect(summary.offersUpdated).toBe(5);
    expect(summary.skipped).toBe(20);
  });
});
