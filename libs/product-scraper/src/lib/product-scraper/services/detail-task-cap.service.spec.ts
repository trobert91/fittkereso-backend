import {
  AdvisoryLockNamespace,
  ProductImportTask,
  ProductImportTaskKind,
} from '@fittkereso-backend/database';
import { DetailTaskCapService } from './detail-task-cap.service';
import { listPageTaskPayload, runStartedAtOf } from './list-page-task-payload';

const RUN_STARTED_AT = new Date('2026-09-26T02:10:00.000Z');
const LIST_TASK_CREATED_AT = new Date('2026-09-26T02:10:05.000Z');

const listTask = () =>
  ({
    id: 'list-task-1',
    source: { id: 'source-1', name: 'ebikeshop' },
    createdAt: LIST_TASK_CREATED_AT,
  }) as ProductImportTask;

const detailTasks = (count: number): ProductImportTask[] =>
  Array.from({ length: count }, (_, i) => ({ url: `https://ebikeshop.hu/termek/${i}` }) as ProductImportTask);

describe('DetailTaskCapService', () => {
  let service: DetailTaskCapService;
  let taskRepo: { loadPayload: jest.Mock; countCreatedSince: jest.Mock };
  let publisher: { addTasks: jest.Mock };
  let locks: { withLocks: jest.Mock };

  beforeEach(() => {
    taskRepo = {
      loadPayload: jest.fn().mockResolvedValue({ ...listPageTaskPayload(RUN_STARTED_AT) }),
      countCreatedSince: jest.fn().mockResolvedValue(0),
    };
    publisher = { addTasks: jest.fn() };
    locks = { withLocks: jest.fn(async (_keys: unknown, work: () => Promise<unknown>) => work()) };

    service = new DetailTaskCapService(taskRepo as never, publisher as never, locks as never);
  });

  it('queues every task, without counting or locking, when the source sets no cap', async () => {
    const tasks = detailTasks(40);

    const result = await service.queue({ listTask: listTask(), tasks, maxItems: undefined });

    expect(result).toEqual({ queued: 40, capped: 0 });
    expect(publisher.addTasks).toHaveBeenCalledWith(tasks);
    expect(taskRepo.countCreatedSince).not.toHaveBeenCalled();
    expect(locks.withLocks).not.toHaveBeenCalled();
  });

  it('queues all of them while the run is under its cap', async () => {
    taskRepo.countCreatedSince.mockResolvedValue(32);
    const tasks = detailTasks(32);

    const result = await service.queue({ listTask: listTask(), tasks, maxItems: 100 });

    expect(result).toEqual({ queued: 32, capped: 0 });
    expect(publisher.addTasks).toHaveBeenCalledWith(tasks);
  });

  it('queues only what is left of the cap, first cards first', async () => {
    taskRepo.countCreatedSince.mockResolvedValue(96);
    const tasks = detailTasks(10);

    const result = await service.queue({ listTask: listTask(), tasks, maxItems: 100 });

    expect(result).toEqual({ queued: 4, capped: 6 });
    expect(publisher.addTasks).toHaveBeenCalledWith(tasks.slice(0, 4));
  });

  it('queues nothing once the run has reached its cap', async () => {
    taskRepo.countCreatedSince.mockResolvedValue(100);

    const result = await service.queue({ listTask: listTask(), tasks: detailTasks(5), maxItems: 100 });

    expect(result).toEqual({ queued: 0, capped: 5 });
    expect(publisher.addTasks).not.toHaveBeenCalled();
  });

  // The count and the insert must be one step, or two list pages finishing at
  // once would both see the same free slots.
  it('counts the run’s detail tasks and queues under the source’s cap lock', async () => {
    let insideLock = false;
    locks.withLocks.mockImplementation(async (_keys: unknown, work: () => Promise<unknown>) => {
      insideLock = true;
      try {
        return await work();
      } finally {
        insideLock = false;
      }
    });
    taskRepo.countCreatedSince.mockImplementation(async () => {
      expect(insideLock).toBe(true);
      return 0;
    });
    publisher.addTasks.mockImplementation(async () => expect(insideLock).toBe(true));

    await service.queue({ listTask: listTask(), tasks: detailTasks(3), maxItems: 100 });

    expect(locks.withLocks).toHaveBeenCalledWith(
      [{ namespace: AdvisoryLockNamespace.SourceTaskCap, id: 'source-1' }],
      expect.any(Function),
    );
    expect(taskRepo.countCreatedSince).toHaveBeenCalledWith({
      sourceId: 'source-1',
      kinds: [ProductImportTaskKind.DetailPage],
      since: RUN_STARTED_AT,
    });
  });

  // A list task queued by hand, or before runs stamped their start, has no
  // payload: its cap covers that page alone.
  it('counts from the list task’s own creation when it carries no run start', async () => {
    taskRepo.loadPayload.mockResolvedValue(null);

    await service.queue({ listTask: listTask(), tasks: detailTasks(1), maxItems: 100 });

    expect(taskRepo.countCreatedSince).toHaveBeenCalledWith(
      expect.objectContaining({ since: LIST_TASK_CREATED_AT }),
    );
  });

  it('does nothing for a page with nothing to queue', async () => {
    const result = await service.queue({ listTask: listTask(), tasks: [], maxItems: 100 });

    expect(result).toEqual({ queued: 0, capped: 0 });
    expect(taskRepo.loadPayload).not.toHaveBeenCalled();
    expect(publisher.addTasks).not.toHaveBeenCalled();
  });
});

describe('list page task payload', () => {
  it('round-trips the run start', () => {
    expect(runStartedAtOf({ ...listPageTaskPayload(RUN_STARTED_AT) })).toEqual(RUN_STARTED_AT);
  });

  it('reads no run start from a missing or malformed payload', () => {
    expect(runStartedAtOf(null)).toBeUndefined();
    expect(runStartedAtOf({})).toBeUndefined();
    expect(runStartedAtOf({ runStartedAt: 'not a date' })).toBeUndefined();
    expect(runStartedAtOf({ runStartedAt: 1234 })).toBeUndefined();
  });
});
