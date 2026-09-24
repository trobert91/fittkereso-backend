import { ArukeresoFeedEntryService } from './arukereso-feed-entry.service';
import { feedRowHash } from './feed-row-hash';
import type { ProductImportTask } from '@fittkereso-backend/database';

describe('ArukeresoFeedEntryService', () => {
  let service: ArukeresoFeedEntryService;
  let taskRepo: { loadPayload: jest.Mock };
  let mapper: { map: jest.Mock };
  let updater: { createOrUpdateProduct: jest.Mock };
  let metrics: { feedEntrySkippedAt: jest.Mock };

  const item = { fields: { identifier: '1260040108' }, attributes: [] };
  const scrapedProduct = { displayName: 'KTM MACINA SCARP SX', offers: [] };

  const task = {
    id: 'task-1',
    url: 'https://speedbike.hu/p',
    priority: 50,
    source: {
      id: 'source-1',
      name: 'speedbike-arukereso',
      type: 'arukereso',
      config: {
        baseUrl: 'https://speedbike.hu',
        feedUrl: 'https://speedbike.hu/feed',
        category: { slugLookup: [] },
        mapping: {},
      },
    },
  } as unknown as ProductImportTask;

  beforeEach(() => {
    taskRepo = {
      loadPayload: jest.fn().mockResolvedValue({ item, requestedSlugs: ['ebikes'] }),
    };
    mapper = {
      map: jest.fn().mockResolvedValue({
        status: 'mapped',
        url: 'https://speedbike.hu/p',
        scrapedProduct,
      }),
    };
    updater = { createOrUpdateProduct: jest.fn().mockResolvedValue({ id: 'model-1' }) };
    metrics = { feedEntrySkippedAt: jest.fn() };
    service = new ArukeresoFeedEntryService(
      taskRepo as never,
      mapper as never,
      updater as never,
      metrics as never,
    );
  });

  it('maps the stored row with the current config and imports it under this task', async () => {
    await service.importEntry(task);

    expect(mapper.map).toHaveBeenCalledWith({
      config: task.source.config,
      item,
      requestedSlugs: ['ebikes'],
    });
    const [context, product] = updater.createOrUpdateProduct.mock.calls[0];
    expect(product).toBe(scrapedProduct);
    expect(context).toMatchObject({
      source: task.source,
      url: 'https://speedbike.hu/p',
      task,
      feedRowHash: feedRowHash('https://speedbike.hu/p', scrapedProduct as never),
    });
  });

  it('finishes without importing a row the config now rejects, counting why', async () => {
    mapper.map.mockResolvedValue({ status: 'skipped', reason: 'category_not_enabled' });

    await service.importEntry(task);

    expect(updater.createOrUpdateProduct).not.toHaveBeenCalled();
    expect(metrics.feedEntrySkippedAt).toHaveBeenCalledWith(
      'speedbike-arukereso',
      'category_not_enabled',
    );
  });

  it('fails a task that carries no feed row', async () => {
    taskRepo.loadPayload.mockResolvedValue(null);

    await expect(service.importEntry(task)).rejects.toThrow(/carries no feed row/);
    expect(updater.createOrUpdateProduct).not.toHaveBeenCalled();
  });
});
