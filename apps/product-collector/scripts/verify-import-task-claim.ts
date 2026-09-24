/**
 * Checks ProductImportTaskRepository.claimBatch against real Postgres: the
 * order it claims in, the gates it holds, and that concurrent claimers never
 * share a task.
 *
 * It works on sources and sellers of its own (named `claim-check-*`), created
 * at the start and deleted at the end with their tasks, and refuses to run
 * while any other task in the database could be claimed — the claim is global,
 * so a stray pending task would be taken by these checks. It also refuses any
 * database whose name does not end in `_e2e`.
 *
 * Usage (from fittkereso-backend/):
 *   PRODUCT_COLLECTOR_CONFIG_PATH=<config pointing at a *_e2e database> \
 *     npx ts-node --project apps/product-collector/tsconfig.app.json \
 *     -r tsconfig-paths/register \
 *     apps/product-collector/scripts/verify-import-task-claim.ts
 */
import { NestFactory } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource, In, Like } from 'typeorm';
import {
  ClaimImportTasksParams,
  ProductImportTask,
  ProductImportTaskKind,
  ProductImportTaskRepository,
  ProductSource,
  ProductSourceRepository,
  Seller,
  SellerRepository,
  SellerType,
  TaskStatus,
} from '@fittkereso-backend/database';
import { AppModule } from '../src/app.module';

const PREFIX = 'claim-check-';
/** A pace no check has to wait for: one request a millisecond. */
const UNPACED = 3_600_000;

type Check = { name: string; run: () => Promise<string | undefined> };

let taskRepo: ProductImportTaskRepository;
let sourceRepo: ProductSourceRepository;
let sellerRepo: SellerRepository;
let db: DataSource;
let freeSeller: Seller;
let cappedSeller: Seller;

const claim = (limit: number, overrides: Partial<ClaimImportTasksParams> = {}) =>
  taskRepo.claimBatch({
    kinds: [ProductImportTaskKind.ListPage, ProductImportTaskKind.DetailPage],
    limit,
    maxAttempts: 3,
    staleTimeoutMinutes: 240,
    ...overrides,
  });

async function makeSource(
  name: string,
  limits: { maxConcurrent?: number; requestsPerHour?: number; seller?: Seller } = {},
): Promise<ProductSource> {
  const source = new ProductSource();
  source.name = `${PREFIX}${name}`;
  source.type = 'scraping' as ProductSource['type'];
  source.config = {} as ProductSource['config'];
  source.seller = limits.seller ?? freeSeller;
  source.maxConcurrent = limits.maxConcurrent ?? 1000;
  source.requestsPerHour = limits.requestsPerHour ?? UNPACED;
  source.processingEnabled = true;
  source.schedulingEnabled = false;
  return sourceRepo.save(source);
}

async function makeTask(
  source: ProductSource,
  label: string,
  fields: Partial<ProductImportTask> = {},
): Promise<ProductImportTask> {
  const task = new ProductImportTask();
  task.source = source;
  task.kind = ProductImportTaskKind.DetailPage;
  task.url = `https://${source.name}.invalid/${label}`;
  task.status = TaskStatus.PENDING;
  Object.assign(task, fields);
  return taskRepo.save(task);
}

const labelOf = (task: ProductImportTask) => task.url.split('/').pop();

async function setStatus(ids: string[], fields: Record<string, unknown>) {
  await taskRepo.repo.update({ id: In(ids) }, fields);
}

async function clearTasks() {
  await db.query(
    `DELETE FROM product_import_task
      WHERE "sourceId" IN (SELECT id FROM product_source WHERE name LIKE $1)`,
    [`${PREFIX}%`],
  );
}

async function removeFixtures() {
  await clearTasks();
  await sourceRepo.repo.delete({ name: Like(`${PREFIX}%`) });
  await sellerRepo.repo.delete({ name: Like(`${PREFIX}%`) });
}

const checks: Check[] = [
  {
    name: 'higher priority first, shuffled within a priority, 100 before a late 90',
    run: async () => {
      const source = await makeSource('order');
      const inserted: Record<number, string[]> = { 10: [], 50: [], 90: [] };
      for (let i = 0; i < 30; i++) {
        const priority = [10, 50, 90][i % 3];
        const label = `p${priority}-${i}`;
        inserted[priority].push(label);
        await makeTask(source, label, { priority });
      }
      // The admin's resync, queued last, and an urgent one.
      await makeTask(source, 'resync-90', { priority: 90 });
      await makeTask(source, 'urgent-100', { priority: 100 });
      inserted[90].push('resync-90');

      const order: { label?: string; priority: number }[] = [];
      for (let i = 0; i < 32; i++) {
        const [task] = await claim(1);
        if (!task) return `stopped after ${i} claims`;
        order.push({ label: labelOf(task), priority: task.priority });
        await setStatus([task.id], { status: TaskStatus.DONE });
      }

      const priorities = order.map((entry) => entry.priority);
      if (priorities.some((p, i) => i > 0 && p > priorities[i - 1])) {
        return `priorities out of order: ${priorities.join(',')}`;
      }
      if (order[0].label !== 'urgent-100') return `first was ${order[0].label}`;
      const nineties = order.filter((e) => e.priority === 90).map((e) => e.label);
      if (!nineties.includes('resync-90')) return 'the late resync never ran among the 90s';
      const shuffled = [10, 50, 90].filter(
        (p) =>
          order.filter((e) => e.priority === p).map((e) => e.label).join() !==
          inserted[p].join(),
      );
      if (shuffled.length === 0) return 'every priority ran in insertion order';
      return undefined;
    },
  },
  {
    name: 'a batch takes one page task per source, the highest first',
    run: async () => {
      for (let s = 0; s < 6; s++) {
        const source = await makeSource(`batch-${s}`);
        for (let t = 0; t < 3; t++) {
          await makeTask(source, `s${s}-t${t}`, { priority: s * 10 + t });
        }
      }
      const claimed = await claim(4);
      const labels = claimed.map(labelOf);
      const expected = ['s5-t2', 's4-t2', 's3-t2', 's2-t2'];
      return labels.join() === expected.join()
        ? undefined
        : `claimed ${labels.join()} instead of ${expected.join()}`;
    },
  },
  {
    name: 'concurrent claimers never share a task, and maxConcurrent holds',
    run: async () => {
      for (let s = 0; s < 8; s++) {
        const source = await makeSource(`race-${s}`, { maxConcurrent: 1 });
        for (let t = 0; t < 5; t++) await makeTask(source, `r${s}-${t}`);
      }
      const batches = await Promise.all(Array.from({ length: 6 }, () => claim(3)));
      const ids = batches.flat().map((task) => task.id);
      if (new Set(ids).size !== ids.length) return 'a task was claimed twice';
      const perSource: Record<string, number> = await db
        .query(
          `SELECT s.name, COUNT(*)::int AS n FROM product_import_task t
             JOIN product_source s ON s.id = t."sourceId"
            WHERE s.name LIKE '${PREFIX}race-%' AND t.status = 'processing'
            GROUP BY s.name`,
        )
        .then((rows: { name: string; n: number }[]) =>
          Object.fromEntries(rows.map((row) => [row.name, row.n])),
        );
      const over = Object.entries(perSource).filter(([, n]) => n > 1);
      if (over.length > 0) return `sources over maxConcurrent: ${JSON.stringify(over)}`;
      return ids.length === 8 ? undefined : `claimed ${ids.length}, expected 8 (one per source)`;
    },
  },
  {
    name: "a source's maxConcurrent and requestsPerHour pace (ebikeshop: 2, 180/h)",
    run: async () => {
      const source = await makeSource('paced', { maxConcurrent: 2, requestsPerHour: 180 });
      for (let t = 0; t < 4; t++) await makeTask(source, `g${t}`);
      const backdate = async (seconds: number) =>
        db.query(
          `UPDATE product_import_task SET "lockedAt" = "lockedAt" - make_interval(secs => $1)
            WHERE "sourceId" = $2 AND "lockedAt" IS NOT NULL`,
          [seconds, source.id],
        );

      const first = await claim(5);
      if (first.length !== 1) return `first claim took ${first.length}`;
      if ((await claim(5)).length !== 0) return 'claimed again inside the 20 s pace';
      await backdate(21);
      const second = await claim(5);
      if (second.length !== 1) return `after the pace, took ${second.length}`;
      await backdate(21);
      if ((await claim(5)).length !== 0) return 'claimed a third while 2 were in flight';
      await setStatus([first[0].id], { status: TaskStatus.DONE });
      if ((await claim(5)).length !== 1) return 'did not claim once one finished';
      return undefined;
    },
  },
  {
    name: "a seller's maxConcurrent across its sources",
    run: async () => {
      for (let s = 0; s < 2; s++) {
        const source = await makeSource(`seller-${s}`, { seller: cappedSeller });
        for (let t = 0; t < 3; t++) await makeTask(source, `c${s}-${t}`);
      }
      const first = await claim(5);
      if (first.length !== 1) return `claimed ${first.length} under a seller capped at 1`;
      if ((await claim(5)).length !== 0) return 'claimed past the seller cap';
      await setStatus([first[0].id], { status: TaskStatus.DONE });
      return (await claim(5)).length === 1 ? undefined : 'did not claim once the seller had room';
    },
  },
  {
    name: 'retries, terminal, delayed, stale and disabled tasks',
    run: async () => {
      const source = await makeSource('eligibility');
      const disabled = await makeSource('disabled');
      disabled.processingEnabled = false;
      await sourceRepo.save(disabled);
      const staleLockedAt = new Date(Date.now() - 5 * 60 * 60 * 1000);
      const freshLockedAt = new Date(Date.now() - 60 * 1000);
      const expected = new Set(['retry', 'stale']);
      await makeTask(source, 'retry', { status: TaskStatus.FAILED, attempts: 2 });
      await makeTask(source, 'exhausted', { status: TaskStatus.FAILED, attempts: 3 });
      await makeTask(source, 'terminal', { status: TaskStatus.FAILED, attempts: 1, terminal: true });
      await makeTask(source, 'later', { scheduledAt: new Date(Date.now() + 3_600_000) });
      await makeTask(source, 'stale', { status: TaskStatus.PROCESSING, lockedAt: staleLockedAt });
      await makeTask(source, 'running', { status: TaskStatus.PROCESSING, lockedAt: freshLockedAt });
      await makeTask(disabled, 'disabled');

      const claimed: string[] = [];
      for (let i = 0; i < 4; i++) {
        const [task] = await claim(1);
        if (task) {
          claimed.push(labelOf(task) ?? '');
          await setStatus([task.id], { status: TaskStatus.DONE });
        }
      }
      const got = new Set(claimed);
      return got.size === expected.size && [...expected].every((label) => got.has(label))
        ? undefined
        : `claimed ${claimed.join(',')}, expected retry and stale only`;
    },
  },
  {
    name: 'a released claim is pending again, a finished one keeps its result',
    run: async () => {
      const source = await makeSource('release');
      const running = await makeTask(source, 'running', { status: TaskStatus.PROCESSING, lockedAt: new Date() });
      const done = await makeTask(source, 'done', { status: TaskStatus.DONE });
      const released = await taskRepo.releaseClaims([running.id, done.id]);
      const after = await taskRepo.repo.find({ where: { id: In([running.id, done.id]) } });
      const statusOf = (id: string) => after.find((task) => task.id === id)?.status;
      return released === 1 &&
        statusOf(running.id) === TaskStatus.PENDING &&
        statusOf(done.id) === TaskStatus.DONE
        ? undefined
        : `released ${released}; running=${statusOf(running.id)} done=${statusOf(done.id)}`;
    },
  },
  {
    name: 'the database refuses a priority outside 0–100',
    run: async () => {
      const source = await makeSource('bounds');
      const refused: number[] = [];
      for (const priority of [-1, 101]) {
        try {
          await makeTask(source, `p${priority}`, { priority });
        } catch {
          refused.push(priority);
        }
      }
      return refused.length === 2 ? undefined : `accepted ${[-1, 101].filter((p) => !refused.includes(p))}`;
    },
  },
];

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const scheduler = app.get(SchedulerRegistry);
  for (const name of scheduler.getIntervals()) scheduler.deleteInterval(name);
  for (const [name] of scheduler.getCronJobs()) scheduler.deleteCronJob(name);
  for (const name of scheduler.getTimeouts()) scheduler.deleteTimeout(name);

  taskRepo = app.get(ProductImportTaskRepository);
  sourceRepo = app.get(ProductSourceRepository);
  sellerRepo = app.get(SellerRepository);
  db = app.get<DataSource>(getDataSourceToken('postgres'));

  let failed = 0;
  try {
    const database = String(db.options.database);
    if (!database.endsWith('_e2e')) {
      throw new Error(`Refusing to run against "${database}": point it at a *_e2e database.`);
    }
    await removeFixtures();
    const stray: { n: number }[] = await db.query(
      `SELECT COUNT(*)::int AS n FROM product_import_task
        WHERE status IN ('pending', 'failed', 'processing') AND terminal = false`,
    );
    if (stray[0].n > 0) {
      throw new Error(`${stray[0].n} other claimable tasks in ${database}; these checks would take them.`);
    }

    freeSeller = await sellerRepo.save(
      Object.assign(new Seller(), { name: `${PREFIX}free`, type: SellerType.business }),
    );
    cappedSeller = await sellerRepo.save(
      Object.assign(new Seller(), { name: `${PREFIX}capped`, type: SellerType.business, maxConcurrent: 1 }),
    );

    for (const check of checks) {
      await clearTasks();
      const problem = await check.run().catch((error: Error) => `threw: ${error.message}`);
      if (problem) failed++;
      console.log(`${problem ? 'FAIL' : 'ok  '} ${check.name}${problem ? ` — ${problem}` : ''}`);
    }
  } finally {
    await removeFixtures();
    await app.close();
  }
  console.log(failed === 0 ? 'All claim checks passed.' : `${failed} claim checks failed.`);
  process.exitCode = failed === 0 ? 0 : 1;
}

// Explicit exits: the app context leaves handles open after close.
main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
