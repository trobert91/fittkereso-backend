import { Readable } from 'stream';
import {
  ArukeresoImportService,
  FEED_FLUSH_SIZE,
  MAX_CONSECUTIVE_ITEM_FAILURES,
} from './arukereso-import.service';
import { ArukeresoFeedParserService } from './arukereso-feed-parser.service';
import { ArukeresoFeedTriageService } from './arukereso-feed-triage.service';
import { feedRowHash } from './feed-row-hash';
import {
  ProductImportTaskKind,
  TaskStatus,
  type ProductImportTask,
  type ProductSource,
} from '@fittkereso-backend/database';

const urlOf = (id: string | number) => `https://speedbike.hu/p/${id}`;
const productOf = (id: string | number, price = 100) =>
  ({
    displayName: `Bike ${id}`,
    offers: [{ externalId: `sku-${id}`, price, currency: 'HUF' }],
  }) as never;

describe('ArukeresoImportService', () => {
  let service: ArukeresoImportService;
  let nativeScraper: { stream: jest.Mock };
  let mapper: { map: jest.Mock };
  let sourceRecordRepo: { findFeedRowHashes: jest.Mock };
  let offerRepo: { findSyncStates: jest.Mock; stampSynced: jest.Mock };
  let taskRepo: {
    findOpenFeedEntries: jest.Mock;
    saveAll: jest.Mock;
    repo: { update: jest.Mock };
  };
  let productRepo: { findOne: jest.Mock; save: jest.Mock };
  let mergeService: { recomputePrice: jest.Mock };
  let locks: { withLocks: jest.Mock };
  let metrics: {
    fullSyncCompleted: jest.Mock;
    fullSyncFailed: jest.Mock;
    recordFullSyncDuration: jest.Mock;
  };

  const CUTOFF = new Date('2026-09-17T00:00:00Z');

  const sourceWith = (config: Record<string, unknown> = {}) =>
    ({
      id: 'source-1',
      name: 'speedbike-arukereso',
      type: 'arukereso',
      seller: { id: 'seller-1' },
      config: {
        baseUrl: 'https://speedbike.hu',
        feedUrl: 'https://speedbike.hu/feed',
        category: { slugLookup: [] },
        mapping: {},
        ...config,
      },
    }) as unknown as ProductSource;
  const source = sourceWith();

  /** A feed of these row ids, each mapped to its own URL, product and offer. */
  const givenFeed = (ids: (string | number)[]) =>
    nativeScraper.stream.mockResolvedValue({
      statusCode: 200,
      contentType: 'application/xml',
      stream: Readable.from([
        `<?xml version="1.0"?><Products>${ids
          .map((id) => `<Product><Identifier>${id}</Identifier></Product>`)
          .join('')}</Products>`,
      ]),
    });

  /** Stored listings whose feed row is exactly this row, with their offers. */
  const givenImported = (
    rows: { id: string | number; price?: number; lastSynced?: Date | null; offer?: boolean }[],
  ) => {
    sourceRecordRepo.findFeedRowHashes.mockImplementation(async (_sourceId, urls: string[]) =>
      new Map(
        rows
          .filter((row) => urls.includes(urlOf(row.id)))
          .map((row) => [urlOf(row.id), feedRowHash(urlOf(row.id), productOf(row.id, row.price))]),
      ),
    );
    offerRepo.findSyncStates.mockImplementation(async (_sellerId, externalIds: string[]) =>
      rows
        .filter((row) => row.offer !== false && externalIds.includes(`sku-${row.id}`))
        .map((row) => ({
          id: `offer-${row.id}`,
          externalId: `sku-${row.id}`,
          modelId: `model-${row.id}`,
          lastSynced: row.lastSynced === undefined ? new Date() : row.lastSynced,
        })),
    );
  };

  const queuedTasks = (): ProductImportTask[] =>
    taskRepo.saveAll.mock.calls.flatMap(([tasks]) => tasks);

  beforeEach(() => {
    nativeScraper = { stream: jest.fn() };
    mapper = {
      map: jest.fn().mockImplementation(async ({ item }) => {
        const id = item.fields['identifier'];
        return { status: 'mapped', url: urlOf(id), scrapedProduct: productOf(id) };
      }),
    };
    sourceRecordRepo = { findFeedRowHashes: jest.fn().mockResolvedValue(new Map()) };
    offerRepo = {
      findSyncStates: jest.fn().mockResolvedValue([]),
      stampSynced: jest.fn().mockResolvedValue(undefined),
    };
    taskRepo = {
      findOpenFeedEntries: jest.fn().mockResolvedValue([]),
      saveAll: jest.fn().mockImplementation(async (tasks) => tasks),
      repo: { update: jest.fn().mockResolvedValue(undefined) },
    };
    productRepo = {
      findOne: jest.fn().mockImplementation(async ({ where }) => ({ id: where.id })),
      save: jest.fn().mockResolvedValue(undefined),
    };
    mergeService = { recomputePrice: jest.fn().mockResolvedValue(undefined) };
    locks = {
      withLocks: jest.fn(async (_keys: unknown, work: () => Promise<unknown>) => work()),
    };
    metrics = {
      fullSyncCompleted: jest.fn(),
      fullSyncFailed: jest.fn(),
      recordFullSyncDuration: jest.fn(),
    };

    service = new ArukeresoImportService(
      nativeScraper as never,
      // The real parser and triage: this service's job is wiring them to the
      // task queue, and stubs would test the wiring against nothing.
      new ArukeresoFeedParserService(),
      mapper as never,
      new ArukeresoFeedTriageService(sourceRecordRepo as never, offerRepo as never),
      taskRepo as never,
      offerRepo as never,
      productRepo as never,
      mergeService as never,
      { visibleCutoff: () => CUTOFF } as never,
      locks as never,
      { maxAttempts: 3 } as never,
      metrics as never,
    );
  });

  it('queues a feed_entry task for every new row, and imports nothing itself', async () => {
    givenFeed([1, 2, 3]);

    const summary = await service.import(source, { categorySlugs: ['ebikes'] });

    expect(summary).toMatchObject({
      itemsSeen: 3,
      feedTasksEnqueued: 3,
      offersUpdated: 0,
      detailTasksEnqueued: 0,
      listTasksEnqueued: 0,
    });
    const [task] = queuedTasks();
    expect(task).toMatchObject({
      kind: ProductImportTaskKind.FeedEntry,
      url: urlOf(1),
      status: TaskStatus.PENDING,
      priority: 50,
      payloadHash: feedRowHash(urlOf(1), productOf(1)),
      payload: { requestedSlugs: ['ebikes'] },
    });
    expect(task.payload?.['item']).toMatchObject({ fields: { identifier: '1' } });
    expect(task.source).toBe(source);
  });

  it('confirms an unchanged row in place instead of queuing it', async () => {
    givenFeed([1, 2]);
    givenImported([{ id: 1 }]);

    const summary = await service.import(source);

    expect(summary.offersUpdated).toBe(1);
    expect(summary.feedTasksEnqueued).toBe(1);
    expect(offerRepo.stampSynced).toHaveBeenCalledWith(['offer-1']);
    expect(queuedTasks().map((task) => task.url)).toEqual([urlOf(2)]);
    expect(mergeService.recomputePrice).not.toHaveBeenCalled();
  });

  it('queues a changed row even though its listing exists', async () => {
    givenFeed([1]);
    givenImported([{ id: 1, price: 999 }]);

    const summary = await service.import(source);

    expect(summary.feedTasksEnqueued).toBe(1);
    expect(offerRepo.stampSynced).not.toHaveBeenCalled();
  });

  it('queues an unchanged row whose offer is gone', async () => {
    givenFeed([1]);
    givenImported([{ id: 1, offer: false }]);

    const summary = await service.import(source);

    expect(summary.offersUpdated).toBe(0);
    expect(summary.feedTasksEnqueued).toBe(1);
  });

  it("recomputes, under its lock, the price of a product whose offer had aged out", async () => {
    givenFeed([1, 2]);
    givenImported([{ id: 1, lastSynced: new Date('2026-09-01') }, { id: 2 }]);

    await service.import(source);

    expect(locks.withLocks).toHaveBeenCalledTimes(1);
    expect(locks.withLocks.mock.calls[0][0]).toEqual([{ namespace: 1, id: 'model-1' }]);
    expect(mergeService.recomputePrice).toHaveBeenCalledWith({ id: 'model-1' });
    expect(productRepo.save).toHaveBeenCalledWith({ id: 'model-1' });
  });

  describe('a row with a task already open', () => {
    const openTask = (status: TaskStatus, fields: Record<string, unknown> = {}) =>
      taskRepo.findOpenFeedEntries.mockResolvedValue([
        { id: 'task-open', url: urlOf(1), status, attempts: 0, payloadHash: 'old', ...fields },
      ]);

    it('gives a pending task the new row instead of queuing another', async () => {
      givenFeed([1]);
      openTask(TaskStatus.PENDING);

      const summary = await service.import(source);

      expect(summary.tasksReplaced).toBe(1);
      expect(summary.feedTasksEnqueued).toBe(0);
      expect(taskRepo.repo.update).toHaveBeenCalledWith(
        'task-open',
        expect.objectContaining({
          payloadHash: feedRowHash(urlOf(1), productOf(1)),
          scheduledAt: null,
        }),
      );
    });

    it('leaves a pending task that already has this row alone', async () => {
      givenFeed([1]);
      openTask(TaskStatus.PENDING, { payloadHash: feedRowHash(urlOf(1), productOf(1)) });

      const summary = await service.import(source);

      expect(summary.tasksReplaced).toBe(0);
      expect(summary.feedTasksEnqueued).toBe(0);
      expect(taskRepo.repo.update).not.toHaveBeenCalled();
    });

    it('gives a failed task with retries left the new row, to run at once', async () => {
      givenFeed([1]);
      openTask(TaskStatus.FAILED, { attempts: 2 });

      const summary = await service.import(source);

      expect(summary.tasksReplaced).toBe(1);
      expect(summary.feedTasksEnqueued).toBe(0);
    });

    it('queues a new task past a failed one that has no retries left', async () => {
      givenFeed([1]);
      openTask(TaskStatus.FAILED, { attempts: 3 });

      const summary = await service.import(source);

      expect(summary.feedTasksEnqueued).toBe(1);
    });

    it('adds nothing while a task is already importing this very row', async () => {
      givenFeed([1]);
      openTask(TaskStatus.PROCESSING, { payloadHash: feedRowHash(urlOf(1), productOf(1)) });

      const summary = await service.import(source);

      expect(summary.feedTasksEnqueued).toBe(0);
    });

    it('queues the new row behind a task still importing an older one', async () => {
      givenFeed([1]);
      openTask(TaskStatus.PROCESSING);

      const summary = await service.import(source);

      expect(summary.feedTasksEnqueued).toBe(1);
    });
  });

  it('counts a URL the feed repeats, and imports its last row', async () => {
    givenFeed([1, 1]);
    let call = 0;
    mapper.map.mockImplementation(async () => {
      call += 1;
      return { status: 'mapped', url: urlOf(1), scrapedProduct: productOf(1, call * 100) };
    });

    const summary = await service.import(source);

    expect(summary.duplicateUrls).toBe(1);
    expect(queuedTasks()).toHaveLength(1);
    expect(queuedTasks()[0].payloadHash).toBe(feedRowHash(urlOf(1), productOf(1, 200)));
  });

  it('triages in batches, a few lookups each', async () => {
    const ids = Array.from({ length: FEED_FLUSH_SIZE * 2 + 50 }, (_, i) => i);
    givenFeed(ids);

    const summary = await service.import(source);

    expect(summary.feedTasksEnqueued).toBe(ids.length);
    expect(sourceRecordRepo.findFeedRowHashes).toHaveBeenCalledTimes(3);
    expect(taskRepo.saveAll).toHaveBeenCalledTimes(3);
  });

  it('counts a skipped row by reason without queuing it', async () => {
    givenFeed([1, 2]);
    mapper.map.mockResolvedValueOnce({ status: 'skipped', reason: 'category_not_enabled' });

    const summary = await service.import(source);

    expect(summary.skipped).toBe(1);
    expect(summary.feedTasksEnqueued).toBe(1);
  });

  // One malformed row in a 3488-product feed must not cost the other 3487.
  it('isolates a row that fails to map and keeps going', async () => {
    givenFeed([1, 2, 3]);
    mapper.map.mockRejectedValueOnce(new Error('pipeline threw'));

    const summary = await service.import(source);

    expect(summary.failed).toBe(1);
    expect(summary.feedTasksEnqueued).toBe(2);
    expect(metrics.fullSyncCompleted).toHaveBeenCalled();
  });

  // ...but a long unbroken streak is a config that no longer matches the feed.
  it('abandons the run after a streak of consecutive failures', async () => {
    givenFeed(Array.from({ length: MAX_CONSECUTIVE_ITEM_FAILURES + 10 }, (_, i) => i));
    mapper.map.mockRejectedValue(new Error('config rot'));

    await expect(service.import(source)).rejects.toThrow(/consecutive items failed/);
    expect(mapper.map).toHaveBeenCalledTimes(MAX_CONSECUTIVE_ITEM_FAILURES);
    expect(metrics.fullSyncFailed).toHaveBeenCalled();
  });

  it('resets the streak on any row that maps', async () => {
    const total = MAX_CONSECUTIVE_ITEM_FAILURES * 2;
    givenFeed(Array.from({ length: total }, (_, i) => i));
    let call = 0;
    mapper.map.mockImplementation(async ({ item }) =>
      (call += 1) % 2 === 0
        ? { status: 'mapped', url: urlOf(item.fields['identifier']), scrapedProduct: productOf(1) }
        : Promise.reject(new Error('one bad row')),
    );

    const summary = await service.import(source);

    expect(summary.failed).toBe(total / 2);
    expect(summary.feedTasksEnqueued).toBe(total / 2);
  });

  // A 404 or a 500 page parsed as a feed yields zero items, which reads as
  // "the shop sells nothing". NativeScraperService throws instead, and that
  // must reach the caller rather than be reported as an empty success.
  it('fails the run when the feed cannot be fetched', async () => {
    nativeScraper.stream.mockRejectedValue(new Error('HTTP 404'));

    await expect(service.import(source)).rejects.toThrow('HTTP 404');
    expect(metrics.fullSyncFailed).toHaveBeenCalled();
    expect(metrics.fullSyncCompleted).not.toHaveBeenCalled();
  });

  it('refuses a source loaded without its seller, before fetching the feed', async () => {
    const withoutSeller = { ...source, seller: undefined } as unknown as ProductSource;

    await expect(service.import(withoutSeller)).rejects.toThrow('without its seller');
    expect(nativeScraper.stream).not.toHaveBeenCalled();
  });

  describe('maxItems', () => {
    it('stops once the cap of eligible rows is reached, reading the feed out', async () => {
      givenFeed(Array.from({ length: 50 }, (_, i) => i));

      const summary = await service.import(sourceWith({ maxItems: 10 }));

      expect(summary.feedTasksEnqueued).toBe(10);
      expect(summary.itemsSeen).toBe(50);
    });

    // Counting only queued rows would make a second run reach for the next
    // ten: rows confirmed in place count toward the cap as well.
    it('counts rows confirmed in place, so a second run stays on the same rows', async () => {
      givenFeed(Array.from({ length: 50 }, (_, i) => i));
      givenImported(Array.from({ length: 10 }, (_, i) => ({ id: i })));

      const summary = await service.import(sourceWith({ maxItems: 10 }));

      expect(summary.offersUpdated).toBe(10);
      expect(summary.feedTasksEnqueued).toBe(0);
    });

    it('counts eligible rows, not attempts, when most rows are skipped', async () => {
      givenFeed(Array.from({ length: 50 }, (_, i) => i));
      let seen = 0;
      mapper.map.mockImplementation(async ({ item }) =>
        (seen += 1) % 5 === 0
          ? { status: 'mapped', url: urlOf(item.fields['identifier']), scrapedProduct: productOf(1) }
          : { status: 'skipped', reason: 'filtered_out' },
      );

      const summary = await service.import(sourceWith({ maxItems: 5 }));

      expect(summary.feedTasksEnqueued).toBe(5);
      expect(summary.skipped).toBe(20);
    });
  });
});
