import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProductImportTaskKind } from '@fittkereso-backend/database';
import { ProductImportTaskCreatorService } from './product-import-task-creator.service';

describe('ProductImportTaskCreatorService source resolution', () => {
  let service: ProductImportTaskCreatorService;
  let sourceRepo: { findOne: jest.Mock; findAllByDomain: jest.Mock };
  let taskRepo: { findOneOrFail: jest.Mock };
  let publisher: { addTask: jest.Mock };

  const source = (overrides: Record<string, unknown> = {}) => ({
    id: 'source-scraping',
    name: 'speedbike',
    type: 'scraping',
    processingEnabled: true,
    config: { baseUrl: 'https://speedbike.hu' },
    ...overrides,
  });

  const feedSource = () =>
    source({ id: 'source-feed', name: 'speedbike-arukereso', type: 'arukereso' });

  const create = (args: Record<string, unknown> = {}) =>
    service.create({
      kind: ProductImportTaskKind.DetailPage,
      url: 'https://speedbike.hu/some-bike',
      ...args,
    } as never);

  beforeEach(() => {
    sourceRepo = {
      findOne: jest.fn(),
      findAllByDomain: jest.fn().mockResolvedValue([]),
    };
    taskRepo = {
      findOneOrFail: jest.fn().mockImplementation(async () => ({ id: 'task-1' })),
    };
    publisher = {
      addTask: jest.fn().mockImplementation(async (task) => {
        task.id = 'task-1';
        return task;
      }),
    };

    service = new ProductImportTaskCreatorService(
      taskRepo as never,
      sourceRepo as never,
      { findById: jest.fn() } as never,
      publisher as never,
    );
  });

  it('refuses a feed_entry task: only a feed run has the row it needs', async () => {
    await expect(
      create({ kind: ProductImportTaskKind.FeedEntry, productSourceId: 'source-feed' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(publisher.addTask).not.toHaveBeenCalled();
  });

  it("queues a person's task at the manual priority unless it names one", async () => {
    sourceRepo.findOne.mockResolvedValue(source());

    await create({ productSourceId: 'source-scraping' });
    await create({ productSourceId: 'source-scraping', priority: 100 });

    expect(publisher.addTask.mock.calls[0][0].priority).toBe(90);
    expect(publisher.addTask.mock.calls[1][0].priority).toBe(100);
  });

  it('uses the source it was given, without consulting the domain at all', async () => {
    sourceRepo.findOne.mockResolvedValue(source());

    await create({ productSourceId: 'source-scraping' });

    expect(sourceRepo.findAllByDomain).not.toHaveBeenCalled();
    expect(publisher.addTask.mock.calls[0][0].source.id).toBe('source-scraping');
  });

  it('resolves from the domain when exactly one scraping source matches', async () => {
    sourceRepo.findAllByDomain.mockResolvedValue([source()]);

    await create();

    expect(publisher.addTask.mock.calls[0][0].source.id).toBe('source-scraping');
  });

  // The defect this resolution exists to fix. Two sources on one domain used to
  // mean "whichever row the database returned first", which is a silent wrong
  // answer — the task would run against the wrong config and quietly write its
  // results under the wrong source.
  it('refuses to guess when a domain has several scraping sources', async () => {
    sourceRepo.findAllByDomain.mockResolvedValue([
      source(),
      source({ id: 'source-scraping-2', name: 'speedbike-legacy' }),
    ]);

    await expect(create()).rejects.toBeInstanceOf(BadRequestException);
    await expect(create()).rejects.toThrow(/Pass productSourceId/);
    expect(publisher.addTask).not.toHaveBeenCalled();
  });

  // A feed source is not ambiguous with a scraping one — it simply cannot carry
  // an import task, so it is not a candidate and the scraping source wins.
  it('ignores a feed source on the same domain', async () => {
    sourceRepo.findAllByDomain.mockResolvedValue([feedSource(), source()]);

    await create();

    expect(publisher.addTask.mock.calls[0][0].source.id).toBe('source-scraping');
  });

  it('refuses an import task aimed explicitly at a feed source', async () => {
    sourceRepo.findOne.mockResolvedValue(feedSource());

    // A ProductImportTask fetches and parses a page; a feed source has no page
    // pipelines, so this would otherwise fail much later, inside a worker.
    await expect(create({ productSourceId: 'source-feed' })).rejects.toThrow(
      /imports a feed rather than scraping pages/,
    );
  });

  it('says so when a domain has only feed sources', async () => {
    sourceRepo.findAllByDomain.mockResolvedValue([feedSource()]);

    await expect(create()).rejects.toThrow(/none of which scrape pages/);
  });

  it('still reports an unknown domain as not found', async () => {
    sourceRepo.findAllByDomain.mockResolvedValue([]);

    await expect(create()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports an unknown productSourceId as not found', async () => {
    sourceRepo.findOne.mockResolvedValue(null);

    await expect(create({ productSourceId: 'nope' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
