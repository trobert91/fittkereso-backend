import {
  AdvisoryLockService,
  brandLock,
  productLock,
} from './advisory-lock.service';

describe('AdvisoryLockService', () => {
  let runner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    query: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    isTransactionActive: boolean;
  };
  let service: AdvisoryLockService;

  beforeEach(() => {
    runner = {
      connect: jest.fn(),
      startTransaction: jest.fn(async () => {
        runner.isTransactionActive = true;
      }),
      query: jest.fn(),
      commitTransaction: jest.fn(async () => {
        runner.isTransactionActive = false;
      }),
      rollbackTransaction: jest.fn(async () => {
        runner.isTransactionActive = false;
      }),
      release: jest.fn(),
      isTransactionActive: false,
    };
    service = new AdvisoryLockService({
      createQueryRunner: () => runner,
    } as never);
  });

  const lockCalls = () =>
    runner.query.mock.calls
      .filter(([sql]) => String(sql).includes('pg_advisory_xact_lock'))
      .map(([, params]) => params);

  it('takes every key once, in one order, so two callers cannot deadlock', async () => {
    await service.withLocks(
      [productLock('b'), brandLock('z'), productLock('a'), productLock('b')],
      async () => undefined,
    );

    expect(lockCalls()).toEqual([
      [1, 'a'],
      [1, 'b'],
      [2, 'z'],
    ]);
  });

  it('bounds the wait, then runs the work and commits', async () => {
    const order: string[] = [];
    runner.query.mockImplementation(async (sql: string) => {
      order.push(sql.startsWith('SET') ? 'timeout' : 'lock');
    });
    runner.commitTransaction.mockImplementation(async () => {
      order.push('commit');
    });

    const result = await service.withLocks([productLock('a')], async () => {
      order.push('work');
      return 42;
    });

    expect(result).toBe(42);
    expect(order).toEqual(['timeout', 'lock', 'work', 'commit']);
    expect(runner.query.mock.calls[0][0]).toMatch(/SET LOCAL lock_timeout/);
    expect(runner.release).toHaveBeenCalled();
  });

  it('rolls back, releases and rethrows when the work fails', async () => {
    const failure = new Error('boom');

    await expect(
      service.withLocks([productLock('a')], async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(runner.rollbackTransaction).toHaveBeenCalled();
    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalled();
  });

  it('releases the connection when the lock itself times out', async () => {
    runner.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) {
        throw new Error('canceling statement due to lock timeout');
      }
    });

    await expect(
      service.withLocks([productLock('a')], async () => undefined),
    ).rejects.toThrow(/lock timeout/);
    expect(runner.rollbackTransaction).toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalled();
  });
});
