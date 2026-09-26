import {
  ListingExternalIdMismatchError,
  ProductSourceConfigInvalidError,
  ProductImportTaskKind,
  ProductImportTask,
  TaskStatus,
} from '@fittkereso-backend/database';
import {
  BaseProductImportTaskManagerService,
  IMPORT_TASK_TICK_INTERVAL,
} from './base-product-import-task-manager.service';

/** A manager whose every task is whatever `work` does. */
class TestManager extends BaseProductImportTaskManagerService {
  constructor(
    deps: ConstructorParameters<typeof BaseProductImportTaskManagerService>,
    private readonly work: (task: ProductImportTask) => Promise<void>,
  ) {
    super(...deps);
  }

  protected async processTask(task: ProductImportTask): Promise<void> {
    return this.work(task);
  }
}

const makeTask = (id = 'task-1'): ProductImportTask =>
  ({
    id,
    kind: ProductImportTaskKind.DetailPage,
    priority: 50,
    url: `https://example.com/p/${id}`,
    status: TaskStatus.PROCESSING,
    attempts: 0,
    terminal: false,
    source: { id: 'source-1', name: 'speedbike', config: {} },
  }) as unknown as ProductImportTask;

/** A promise the test settles by hand, to hold a task mid-run. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(
  work: (task: ProductImportTask) => Promise<void>,
  scheduling: Record<string, number> = {},
) {
  const taskRepo = {
    claimBatch: jest.fn().mockResolvedValue([]),
    releaseClaims: jest.fn().mockResolvedValue(0),
    save: jest.fn(async (saved: ProductImportTask) => saved),
    repo: { manager: { connection: { options: { poolSize: 50 } } } },
  };
  const metrics = {
    taskStarted: jest.fn(),
    taskFinished: jest.fn(),
    taskFailed: jest.fn(),
    recordTaskDuration: jest.fn(),
    setInFlight: jest.fn(),
  };
  const schedulerRegistry = {
    addInterval: jest.fn(),
    doesExist: jest.fn().mockReturnValue(true),
    deleteInterval: jest.fn(),
  };
  const manager = new TestManager(
    [
      { maxAttempts: 3 } as any,
      taskRepo as any,
      [ProductImportTaskKind.DetailPage],
      metrics as any,
      { scheduling } as any,
      schedulerRegistry as any,
    ],
    work,
  );
  return { manager, taskRepo, metrics, schedulerRegistry };
}

describe('BaseProductImportTaskManagerService failure handling', () => {
  const run = async (error: unknown, attempts = 0) => {
    const task = makeTask();
    task.attempts = attempts;
    const { manager, taskRepo } = setup(async () => {
      throw error;
    });
    taskRepo.claimBatch.mockResolvedValueOnce([task]);

    await manager.tick();
    await manager.whenIdle();

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

  // The URL answers with another product on every retry, and every retry is a
  // paid fetch.
  it('marks a page showing another product terminal, with both ids on the task', async () => {
    const { task } = await run(
      new ListingExternalIdMismatchError({
        source: { id: 'source-1', name: 'ebikeshop' },
        url: 'https://ebikeshop.hu/termek/ktm-macina-old',
        expectedExternalId: '1250158236',
        pageExternalIds: ['AKA-B002-X'],
      }),
    );

    expect(task.status).toBe(TaskStatus.FAILED);
    expect(task.terminal).toBe(true);
    expect(task.attempts).toBe(1);
    expect(task.scheduledAt).toBeNull();
    expect(task.error).toMatchObject({
      kind: 'listing_external_id_mismatch',
      url: 'https://ebikeshop.hu/termek/ktm-macina-old',
      expectedExternalId: '1250158236',
      pageExternalIds: ['AKA-B002-X'],
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

describe('BaseProductImportTaskManagerService scheduling', () => {
  it('ticks on the configured interval', () => {
    const { manager, schedulerRegistry } = setup(async () => undefined, {
      importTaskTickMs: 45000,
    });
    jest.useFakeTimers();
    try {
      manager.onModuleInit();
      expect(schedulerRegistry.addInterval).toHaveBeenCalledWith(
        IMPORT_TASK_TICK_INTERVAL,
        expect.anything(),
      );
      const claims = jest.spyOn(manager, 'tick').mockResolvedValue(undefined);
      jest.advanceTimersByTime(45000 * 2);
      expect(claims).toHaveBeenCalledTimes(2);
      clearInterval(schedulerRegistry.addInterval.mock.calls[0][1]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('claims one batch of the configured size per tick, with the claim gates', async () => {
    const { manager, taskRepo } = setup(async () => undefined, {
      importTaskBatchSize: 8,
      staleImportTaskTimeoutMinutes: 120,
    });

    await manager.tick();

    expect(taskRepo.claimBatch).toHaveBeenCalledTimes(1);
    expect(taskRepo.claimBatch).toHaveBeenCalledWith({
      kinds: [ProductImportTaskKind.DetailPage],
      limit: 8,
      maxAttempts: 3,
      staleTimeoutMinutes: 120,
    });
  });

  it('costs an idle collector one query per tick, and nothing else', async () => {
    const { manager, taskRepo } = setup(async () => undefined);

    await manager.tick();

    expect(taskRepo.claimBatch).toHaveBeenCalledTimes(1);
    expect(taskRepo.save).not.toHaveBeenCalled();
  });

  it('starts every claimed task without waiting for them', async () => {
    const held = deferred();
    const started: string[] = [];
    const { manager, taskRepo, metrics } = setup(async (task) => {
      started.push(task.id);
      await held.promise;
    });
    taskRepo.claimBatch.mockResolvedValueOnce([makeTask('a'), makeTask('b')]);

    await manager.tick();

    expect(started).toEqual(['a', 'b']);
    expect(metrics.setInFlight).toHaveBeenLastCalledWith(2);
    held.resolve();
    await manager.whenIdle();
    expect(metrics.setInFlight).toHaveBeenLastCalledWith(0);
  });

  it('claims again on the next tick while earlier tasks still run', async () => {
    const held = deferred();
    const { manager, taskRepo } = setup(async () => held.promise);
    taskRepo.claimBatch
      .mockResolvedValueOnce([makeTask('a')])
      .mockResolvedValueOnce([makeTask('b')]);

    await manager.tick();
    await manager.tick();

    expect(taskRepo.claimBatch).toHaveBeenCalledTimes(2);
    held.resolve();
    await manager.whenIdle();
    expect(taskRepo.save).toHaveBeenCalledTimes(2);
  });

  it('never runs two claims at once in one process', async () => {
    const claim = deferred();
    const { manager, taskRepo } = setup(async () => undefined);
    taskRepo.claimBatch.mockReturnValueOnce(claim.promise.then(() => []));

    const first = manager.tick();
    await manager.tick();
    claim.resolve();
    await first;

    expect(taskRepo.claimBatch).toHaveBeenCalledTimes(1);
  });

  it('keeps ticking after a claim fails', async () => {
    const { manager, taskRepo } = setup(async () => undefined);
    taskRepo.claimBatch.mockRejectedValueOnce(new Error('connection reset'));

    await manager.tick();
    await manager.tick();

    expect(taskRepo.claimBatch).toHaveBeenCalledTimes(2);
  });
});

describe('BaseProductImportTaskManagerService shutdown', () => {
  it('stops ticking and lets finished work keep its result', async () => {
    const { manager, taskRepo, schedulerRegistry } = setup(async () => undefined);
    taskRepo.claimBatch.mockResolvedValueOnce([makeTask('a')]);
    await manager.tick();

    await manager.beforeApplicationShutdown();
    await manager.tick();

    expect(schedulerRegistry.deleteInterval).toHaveBeenCalledWith(
      IMPORT_TASK_TICK_INTERVAL,
    );
    expect(taskRepo.claimBatch).toHaveBeenCalledTimes(1);
    expect(taskRepo.releaseClaims).not.toHaveBeenCalled();
  });

  it('hands tasks still running after the grace period back to the queue', async () => {
    const { manager, taskRepo } = setup(() => new Promise<void>(() => undefined));
    taskRepo.claimBatch.mockResolvedValueOnce([makeTask('stuck')]);
    await manager.tick();

    jest.useFakeTimers();
    try {
      const shutdown = manager.beforeApplicationShutdown();
      await jest.advanceTimersByTimeAsync(60 * 1000);
      await shutdown;
    } finally {
      jest.useRealTimers();
    }

    expect(taskRepo.releaseClaims).toHaveBeenCalledWith(['stuck']);
  });
});
