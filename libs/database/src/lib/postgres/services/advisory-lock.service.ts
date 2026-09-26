import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * What an advisory lock guards. The value is the lock's first key, so the same
 * id in two namespaces never collides.
 */
export enum AdvisoryLockNamespace {
  /** Every write to one product, its listings, offers, aliases and images. */
  Product = 1,
  /** Creating a product of this brand, from the identity re-check to its offers. */
  Brand = 2,
  /**
   * Claiming import tasks: one claimer at a time, across every collector, so
   * the per-source and per-seller gates count exactly. Taken by
   * ProductImportTaskRepository.claimBatch inside its own transaction.
   */
  ImportTaskClaim = 3,
  /**
   * One seller's offer identity, whether or not the offer exists yet. A
   * contributing listing that finds no offer is stored unattached under it,
   * and an identifying listing holds it from attaching the waiting records
   * until its offers are written — so the two can never miss each other.
   * Held on its own, never while waiting for another lock.
   */
  OfferKey = 4,
  /**
   * One source's run-wide cap on the detail tasks it queues
   * (ScrapingSourceConfig.maxItems). A run's list pages are separate tasks
   * that can finish at once; holding this makes "count the run's detail tasks,
   * then queue up to the cap" one step. Held on its own.
   */
  SourceTaskCap = 5,
}

export interface AdvisoryLockKey {
  namespace: AdvisoryLockNamespace;
  id: string;
}

export const productLock = (id: string): AdvisoryLockKey => ({
  namespace: AdvisoryLockNamespace.Product,
  id,
});

export const brandLock = (id: string): AdvisoryLockKey => ({
  namespace: AdvisoryLockNamespace.Brand,
  id,
});

export const offerKeyLock = (sellerId: string, externalId: string): AdvisoryLockKey => ({
  namespace: AdvisoryLockNamespace.OfferKey,
  id: `${sellerId}:${externalId}`,
});

export const sourceTaskCapLock = (sourceId: string): AdvisoryLockKey => ({
  namespace: AdvisoryLockNamespace.SourceTaskCap,
  id: sourceId,
});

/**
 * How long a caller waits for a lock before giving up. A product import holds
 * its product lock for a few seconds; two minutes means something is stuck.
 */
const LOCK_TIMEOUT = '120s';

/**
 * Serializes writers of the same product (or the creation of one brand's
 * products) across tasks and processes, with Postgres transaction-level
 * advisory locks.
 *
 * The lock lives in a transaction of its own, on a connection of its own.
 * `fn` keeps using the ordinary repositories: its writes commit as they
 * happen, so the next holder reads them, and a statement `fn` fails on purpose
 * (an ON CONFLICT probe, a duplicate insert it catches) cannot abort anything
 * but itself. The lock is released when the transaction ends, however `fn`
 * ends — a crashed process releases it with its connection.
 *
 * Keys are taken in one sorted order, so two callers locking the same set can
 * never deadlock on each other. Callers that nest (a brand lock, then the
 * product lock inside it) must always nest in that order: brand, then product.
 * Offer keys are taken in the same call as the product lock they go with, or
 * alone by a caller that waits for nothing while holding them.
 *
 * Each call holds one pooled connection for as long as `fn` runs, on top of
 * whatever `fn` itself uses, so the pool must be sized for about two
 * connections per concurrent import.
 */
@Injectable()
export class AdvisoryLockService {
  constructor(
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
  ) {}

  async withLocks<T>(keys: AdvisoryLockKey[], fn: () => Promise<T>): Promise<T> {
    const ordered = [
      ...new Map(keys.map((key) => [`${key.namespace}:${key.id}`, key])).values(),
    ].sort((a, b) => a.namespace - b.namespace || a.id.localeCompare(b.id));

    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction();
      await runner.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      for (const key of ordered) {
        await runner.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
          key.namespace,
          key.id,
        ]);
      }

      const result = await fn();
      await runner.commitTransaction();
      return result;
    } catch (error) {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }
      throw error;
    } finally {
      await runner.release();
    }
  }
}
