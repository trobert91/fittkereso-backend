import {
  ProductSourceConfigInvalidError,
  ScrapeQueueName,
  ScrapeTask,
  TaskStatus,
} from '@fittkereso-backend/database';
import { BaseScrapeTaskManagerService } from './base-scrape-task-manager.service';

/** A manager whose one task is whatever `thrower` does. */
class TestManager extends BaseScrapeTaskManagerService {
  constructor(
    deps: ConstructorParameters<typeof BaseScrapeTaskManagerService>,
    private readonly thrower: () => Promise<void>,
  ) {
    super(...deps);
  }

  protected async processTask(): Promise<void> {
    return this.thrower();
  }
}

describe('BaseScrapeTaskManagerService failure handling', () => {
  const makeTask = (): ScrapeTask =>
    ({
      id: 'task-1',
      queue: ScrapeQueueName.ScrapeProductDetails,
      url: 'https://example.com/p/1',
      status: TaskStatus.PENDING,
      attempts: 0,
      terminal: false,
      source: { id: 'source-1', name: 'speedbike', config: {} },
    }) as unknown as ScrapeTask;

  const run = async (error: unknown, attempts = 0) => {
    const task = makeTask();
    task.attempts = attempts;

    const taskRepo = {
      fetchNextScrapeTask: jest.fn().mockResolvedValue({ task }),
      save: jest.fn(async (saved: ScrapeTask) => saved),
    };
    const metrics = {
      taskStarted: jest.fn(),
      taskFinished: jest.fn(),
      taskFailed: jest.fn(),
      recordTaskDuration: jest.fn(),
    };

    const manager = new TestManager(
      [
        { maxAttempts: 3 } as any,
        taskRepo as any,
        [ScrapeQueueName.ScrapeProductDetails],
        metrics as any,
        { scheduling: {} } as any,
      ],
      async () => {
        throw error;
      },
    );

    await manager.processTasks();

    return { task, taskRepo };
  };

  it('marks an invalid-config failure terminal on the first attempt', async () => {
    const { task } = await run(
      new ProductSourceConfigInvalidError({ id: 'source-1', name: 'speedbike' }, [
        { path: '/detailPage/brand', message: 'must be array' },
      ]),
    );

    expect(task.status).toBe(TaskStatus.FAILED);
    expect(task.terminal).toBe(true);
    expect(task.attempts).toBe(1);
    // No backoff: there is nothing to come back for.
    expect(task.scheduledAt).toBeNull();
  });

  it('stores the config problems on the task, structured', async () => {
    const { task } = await run(
      new ProductSourceConfigInvalidError({ id: 'source-1', name: 'speedbike' }, [
        { path: '/detailPage/brand', message: 'must be array' },
      ]),
    );

    expect(task.error).toMatchObject({
      kind: 'product_source_config_invalid',
      sourceName: 'speedbike',
      problems: [{ path: '/detailPage/brand', message: 'must be array' }],
    });
  });

  it('still retries an ordinary failure with a backoff', async () => {
    const { task } = await run(new Error('vendor timeout'));

    expect(task.status).toBe(TaskStatus.FAILED);
    expect(task.terminal).toBe(false);
    expect(task.scheduledAt).toBeInstanceOf(Date);
  });

  it('stops retrying an ordinary failure once attempts run out', async () => {
    const { task } = await run(new Error('vendor timeout'), 2);

    expect(task.attempts).toBe(3);
    expect(task.terminal).toBe(false);
    expect(task.scheduledAt).toBeNull();
  });
});
