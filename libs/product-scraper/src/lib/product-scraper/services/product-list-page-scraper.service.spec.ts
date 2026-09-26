import { ProductImportTask, ProductImportTaskKind } from '@fittkereso-backend/database';
import { ProductListPageScraperService } from './product-list-page-scraper.service';

const listTask = (maxItems?: number) =>
  ({
    id: 'list-task-1',
    url: 'https://ebikeshop.hu/termekek/elektromos-kerekparok?oldal=2',
    priority: 50,
    source: {
      id: 'source-1',
      name: 'ebikeshop',
      config: {
        baseUrl: 'https://ebikeshop.hu',
        startUrls: ['https://ebikeshop.hu/termekek/elektromos-kerekparok'],
        listPage: { categoryName: [], items: [], itemMode: 'json', itemPipeline: [] },
        ...(maxItems === undefined ? {} : { maxItems }),
      },
    },
  }) as unknown as ProductImportTask;

const cards = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    url: `https://ebikeshop.hu/termek/bike-${i}`,
    externalId: `CODE-${i}`,
    name: `Bike ${i}`,
    price: 1_000_000 + i,
  }));

describe('ProductListPageScraperService', () => {
  let service: ProductListPageScraperService;
  let scraperService: { getHtml: jest.Mock };
  let dedup: { isDuplicate: jest.Mock };
  let listRefresh: { tryRefresh: jest.Mock };
  let metrics: {
    recordProductsFound: jest.Mock;
    recordDetailTasksCreated: jest.Mock;
    productSkipped: jest.Mock;
  };
  let interpreter: { runListPage: jest.Mock };
  let detailTaskCap: { queue: jest.Mock };

  beforeEach(() => {
    scraperService = { getHtml: jest.fn().mockResolvedValue('<div id="app"></div>') };
    dedup = { isDuplicate: jest.fn().mockResolvedValue({ isDuplicate: false }) };
    listRefresh = { tryRefresh: jest.fn().mockResolvedValue('unknown') };
    metrics = {
      recordProductsFound: jest.fn(),
      recordDetailTasksCreated: jest.fn(),
      productSkipped: jest.fn(),
    };
    interpreter = {
      runListPage: jest.fn().mockResolvedValue({ categoryName: 'Elektromos kerékpárok', products: cards(32) }),
    };
    detailTaskCap = {
      queue: jest.fn(async ({ tasks }: { tasks: unknown[] }) => ({ queued: tasks.length, capped: 0 })),
    };

    service = new ProductListPageScraperService(
      scraperService as never,
      dedup as never,
      listRefresh as never,
      metrics as never,
      interpreter as never,
      detailTaskCap as never,
    );
  });

  // maxItems used to cut each page to its first N cards. It now caps the run's
  // detail tasks instead, so every card is still looked at: one refreshed in
  // place costs no task and must not be skipped for the cap's sake.
  it('considers every card on the page, whatever maxItems says', async () => {
    await service.scrapeListPage(listTask(10));

    expect(listRefresh.tryRefresh).toHaveBeenCalledTimes(32);
  });

  it('hands every card that needs a detail page to the run-wide cap, with the run’s maxItems', async () => {
    listRefresh.tryRefresh.mockImplementation(async (_source: unknown, card: { externalId: string }) =>
      card.externalId === 'CODE-0' || card.externalId === 'CODE-1' ? 'refreshed' : 'unknown',
    );
    const task = listTask(100);

    await service.scrapeListPage(task);

    expect(detailTaskCap.queue).toHaveBeenCalledTimes(1);
    const [{ listTask: passedListTask, tasks, maxItems }] = detailTaskCap.queue.mock.calls[0];
    expect(passedListTask).toBe(task);
    expect(maxItems).toBe(100);
    // The two refreshed in place need no detail task.
    expect(tasks).toHaveLength(30);
    expect(tasks.every((detail: ProductImportTask) => detail.kind === ProductImportTaskKind.DetailPage)).toBe(true);
  });

  // The detail scraper refuses a page that states another one: a URL that now
  // redirects to another product.
  it("stores each card's externalId on its detail task, and null for a card without one", async () => {
    interpreter.runListPage.mockResolvedValue({
      categoryName: 'Elektromos kerékpárok',
      products: [...cards(2), { url: 'https://ebikeshop.hu/termek/no-code', price: 1 }],
    });

    await service.scrapeListPage(listTask(100));

    const [{ tasks }] = detailTaskCap.queue.mock.calls[0];
    expect(tasks.map((detail: ProductImportTask) => [detail.url, detail.externalId])).toEqual([
      ['https://ebikeshop.hu/termek/bike-0', 'CODE-0'],
      ['https://ebikeshop.hu/termek/bike-1', 'CODE-1'],
      ['https://ebikeshop.hu/termek/no-code', null],
    ]);
  });

  it('sends a stale or ambiguously moved listing to its detail page', async () => {
    const outcomes: Record<string, string> = { 'CODE-0': 'stale', 'CODE-1': 'moved' };
    listRefresh.tryRefresh.mockImplementation(
      async (_source: unknown, card: { externalId: string }) => outcomes[card.externalId] ?? 'refreshed',
    );

    await service.scrapeListPage(listTask(100));

    const [{ tasks }] = detailTaskCap.queue.mock.calls[0];
    expect(tasks.map((detail: ProductImportTask) => detail.url)).toEqual([
      'https://ebikeshop.hu/termek/bike-0',
      'https://ebikeshop.hu/termek/bike-1',
    ]);
  });

  it('counts only the tasks the cap let through as created', async () => {
    detailTaskCap.queue.mockResolvedValue({ queued: 4, capped: 28 });

    await service.scrapeListPage(listTask(100));

    expect(metrics.recordDetailTasksCreated).toHaveBeenCalledWith('ebikeshop', 4);
  });

  it('passes no cap when the source sets none', async () => {
    await service.scrapeListPage(listTask());

    expect(detailTaskCap.queue.mock.calls[0][0].maxItems).toBeUndefined();
  });
});
