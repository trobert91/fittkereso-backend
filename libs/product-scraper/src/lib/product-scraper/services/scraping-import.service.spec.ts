import { ProductImportTask, ProductImportTaskKind, ProductSource } from '@fittkereso-backend/database';
import { ScrapingImportService } from './scraping-import.service';
import { runStartedAtOf } from './list-page-task-payload';

const START_URL = 'https://ebikeshop.hu/termekek/elektromos-kerekparok?rendezes=nev_szerint_novekvo';

const sourceWith = (config: Record<string, unknown>): ProductSource =>
  ({
    id: 'source-1',
    name: 'ebikeshop',
    config: {
      baseUrl: 'https://ebikeshop.hu',
      startUrls: [START_URL],
      listPage: {
        categoryName: [],
        pagination: {
          urlTemplate: '{{startUrl}}&oldal={{page}}',
          pageCount: [{ op: 'literal', value: 3 }],
        },
        items: [],
        itemMode: 'json',
        itemPipeline: [],
      },
      ...config,
    },
  }) as unknown as ProductSource;

describe('ScrapingImportService', () => {
  let service: ScrapingImportService;
  let scraperService: { getHtml: jest.Mock };
  let interpreter: { runPipeline: jest.Mock };
  let publisher: { addTask: jest.Mock };
  let metrics: Record<string, jest.Mock>;

  const queuedTasks = (): ProductImportTask[] =>
    publisher.addTask.mock.calls.map(([task]) => task as ProductImportTask);

  beforeEach(() => {
    scraperService = { getHtml: jest.fn().mockResolvedValue('<div id="app"></div>') };
    interpreter = { runPipeline: jest.fn().mockResolvedValue(3) };
    publisher = { addTask: jest.fn() };
    metrics = {
      recordListTasksCreated: jest.fn(),
      recordCategoriesDiscovered: jest.fn(),
      fullSyncCompleted: jest.fn(),
      fullSyncFailed: jest.fn(),
      recordFullSyncDuration: jest.fn(),
    };

    service = new ScrapingImportService(
      scraperService as never,
      interpreter as never,
      publisher as never,
      metrics as never,
    );
  });

  // The cap limits the detail tasks a run queues, not the pages it walks: every
  // known card on every page can still be refreshed in place.
  it('walks every page of the listing even when maxItems is set', async () => {
    const summary = await service.import(sourceWith({ maxItems: 100 }));

    expect(summary.listTasksEnqueued).toBe(3);
    expect(queuedTasks().map((task) => task.url)).toEqual([
      START_URL,
      `${START_URL}&oldal=2`,
      `${START_URL}&oldal=3`,
    ]);
    expect(queuedTasks().every((task) => task.kind === ProductImportTaskKind.ListPage)).toBe(true);
  });

  // The pages are separate tasks; the run's start is what lets them share the
  // run's maxItems.
  it('stamps the run’s start on every list task', async () => {
    const before = Date.now();
    await service.import(sourceWith({}));
    const after = Date.now();

    const starts = queuedTasks().map((task) => runStartedAtOf(task.payload));
    expect(starts).toHaveLength(3);
    const [first] = starts;
    expect(first).toBeInstanceOf(Date);
    expect(starts.every((start) => start?.getTime() === first?.getTime())).toBe(true);
    expect(first?.getTime()).toBeGreaterThanOrEqual(before);
    expect(first?.getTime()).toBeLessThanOrEqual(after);
  });
});
