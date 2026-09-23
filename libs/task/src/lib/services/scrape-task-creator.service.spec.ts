import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ScrapeQueueName } from '@fittkereso-backend/database';
import { ScrapeTaskCreatorService } from './scrape-task-creator.service';

describe('ScrapeTaskCreatorService source resolution', () => {
  let service: ScrapeTaskCreatorService;
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
      queue: ScrapeQueueName.ScrapeProductDetails,
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

    service = new ScrapeTaskCreatorService(
      taskRepo as never,
      sourceRepo as never,
      { findById: jest.fn() } as never,
      publisher as never,
    );
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
  // a scrape task, so it is not a candidate and the scraping source wins.
  it('ignores a feed source on the same domain', async () => {
    sourceRepo.findAllByDomain.mockResolvedValue([feedSource(), source()]);

    await create();

    expect(publisher.addTask.mock.calls[0][0].source.id).toBe('source-scraping');
  });

  it('refuses a scrape task aimed explicitly at a feed source', async () => {
    sourceRepo.findOne.mockResolvedValue(feedSource());

    // A ScrapeTask fetches and parses a page; a feed source has no page
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
