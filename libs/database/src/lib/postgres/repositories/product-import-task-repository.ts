import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ProductImportTask } from '../models/product-import-task.entity';
import { TaskStatus } from '../models/task.entity';
import { BasePostgresRepository } from './base-postgres-repository';
import { ProductImportTaskKind } from '../types';
import { nameOf } from '@fittkereso-backend/utils';
import { ProductSource, Seller } from '../models';
import { isEmpty } from 'lodash';
import { AdvisoryLockNamespace } from '../services/advisory-lock.service';

/** A source with no requestsPerHour set gets this pace. */
const DEFAULT_REQUESTS_PER_HOUR = 50;

/**
 * The kinds that fetch a page from a shop, and are therefore held to their
 * source's and seller's maxConcurrent and requestsPerHour.
 */
export const PAGE_IMPORT_TASK_KINDS: ProductImportTaskKind[] = [
  ProductImportTaskKind.ListPage,
  ProductImportTaskKind.DetailPage,
];

export interface ClaimImportTasksParams {
  kinds: ProductImportTaskKind[];
  /** Most tasks to claim. */
  limit: number;
  maxAttempts: number;
  /** A task still `processing` after this long is presumed dead and claimable again. */
  staleTimeoutMinutes: number;
}

@Injectable()
export class ProductImportTaskRepository extends BasePostgresRepository<ProductImportTask> {
  constructor(
    @InjectRepository(ProductImportTask, 'postgres')
    repository: Repository<ProductImportTask>,
  ) {
    super(repository, ProductImportTask);
  }

  /**
   * Claims up to `limit` tasks — higher priority first, then by sortKey — and
   * marks them `processing` in the same statement, so no later claim, from
   * this collector or another, can take them again until they finish or go
   * stale.
   *
   * Page-fetching kinds are gated per source and per seller: fewer in flight
   * than maxConcurrent, and at least 3600 / requestsPerHour seconds since the
   * last claim. Because that pace is measured from the last claim, at most one
   * page task per source (and per rate-limited seller) is claimed per call.
   *
   * The whole claim runs under one advisory lock, so two collectors claiming
   * at once see each other's claims and the gates count exactly. The row
   * locks (SKIP LOCKED) only keep the claim off rows another transaction is
   * writing.
   *
   * One statement, plus one to load the claimed tasks' relations when there
   * are any: an idle call costs a single query.
   */
  async claimBatch(params: ClaimImportTasksParams): Promise<ProductImportTask[]> {
    if (params.limit <= 0 || isEmpty(params.kinds)) return [];

    const runner = this.repo.manager.connection.createQueryRunner();
    await runner.connect();
    let ids: string[];
    try {
      await runner.startTransaction();
      await runner.query('SELECT pg_advisory_xact_lock($1, 0)', [
        AdvisoryLockNamespace.ImportTaskClaim,
      ]);
      // Structured: for an UPDATE the plain form returns [rows, affected].
      const { records } = await runner.query(
        this.claimSql(),
        [
          params.kinds,
          PAGE_IMPORT_TASK_KINDS,
          params.maxAttempts,
          params.staleTimeoutMinutes,
          DEFAULT_REQUESTS_PER_HOUR,
          // Page tasks past the first of their source are scanned but not
          // taken, so the scan reaches well past the limit.
          Math.max(params.limit * 20, 200),
          params.limit,
        ],
        true,
      );
      const rows = records as { id: string; priority: number; sort_key: number }[];
      await runner.commitTransaction();
      // RETURNING keeps no order; claim order is priority, then sortKey.
      ids = rows
        .sort((a, b) => b.priority - a.priority || a.sort_key - b.sort_key)
        .map((row) => row.id);
    } catch (error) {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }
      throw error;
    } finally {
      await runner.release();
    }

    if (isEmpty(ids)) return [];

    const tasks = await this.repo.find({
      where: { id: In(ids) },
      relations: [
        nameOf<ProductImportTask>('source'),
        `${nameOf<ProductImportTask>('source')}.${nameOf<ProductSource>('seller')}`,
        nameOf<ProductImportTask>('product'),
      ],
    });
    // In claim order, which find() does not keep.
    return ids
      .map((id) => tasks.find((task) => task.id === id))
      .filter((task): task is ProductImportTask => !!task);
  }

  /**
   * $1 kinds to claim, $2 page kinds, $3 max attempts, $4 stale minutes,
   * $5 default requests per hour, $6 candidates to scan, $7 limit.
   *
   * Window functions cannot share a query level with FOR UPDATE, hence the
   * separate `ranked` step over the locked candidates.
   */
  private claimSql(): string {
    const task = this.repo.metadata.tableName;
    const source = this.repo.manager.getRepository(ProductSource).metadata.tableName;
    const seller = this.repo.manager.getRepository(Seller).metadata.tableName;
    const t = (field: keyof ProductImportTask) => `"${nameOf<ProductImportTask>(field)}"`;
    const s = (field: keyof ProductSource) => `"${nameOf<ProductSource>(field)}"`;
    const se = (field: keyof Seller) => `"${nameOf<Seller>(field)}"`;
    const sourceId = `"${nameOf<ProductImportTask>('source')}Id"`;
    const sellerId = `"${nameOf<ProductSource>('seller')}Id"`;
    const live = `t.${t('status')} = '${TaskStatus.PROCESSING}' AND t.${t('lockedAt')} >= NOW() - MAKE_INTERVAL(mins => $4)`;
    // Only claims recent enough to matter: still in flight (within the stale
    // timeout), or within the slowest pace, an hour at 1 request per hour.
    const recent = `t.${t('lockedAt')} >= NOW() - MAKE_INTERVAL(mins => GREATEST($4, 60))`;
    const paceOf = (rph: string) => `INTERVAL '1 second' * (3600.0 / ${rph})`;

    return `
      WITH page_load AS (
        SELECT t.${sourceId} AS source_id,
               COUNT(*) FILTER (WHERE ${live}) AS in_flight,
               MAX(t.${t('lockedAt')}) AS last_claim
          FROM ${task} t
         WHERE t.${t('kind')} = ANY($2) AND ${recent}
         GROUP BY t.${sourceId}
      ),
      seller_load AS (
        SELECT s.${sellerId} AS seller_id,
               COUNT(*) FILTER (WHERE ${live}) AS in_flight,
               MAX(t.${t('lockedAt')}) AS last_claim
          FROM ${task} t
          JOIN ${source} s ON s.${s('id')} = t.${sourceId}
         WHERE t.${t('kind')} = ANY($2) AND ${recent} AND s.${sellerId} IS NOT NULL
         GROUP BY s.${sellerId}
      ),
      candidates AS (
        SELECT t.${t('id')} AS id,
               t.${t('priority')} AS priority,
               t.${t('sortKey')} AS sort_key,
               t.${sourceId} AS source_id,
               s.${sellerId} AS seller_id,
               t.${t('kind')} = ANY($2) AS is_page,
               (se.${se('maxConcurrent')} IS NOT NULL OR se.${se('requestsPerHour')} IS NOT NULL) AS seller_gated
          FROM ${task} t
          JOIN ${source} s ON s.${s('id')} = t.${sourceId}
          LEFT JOIN ${seller} se ON se.${se('id')} = s.${sellerId}
          LEFT JOIN page_load pl ON pl.source_id = t.${sourceId}
          LEFT JOIN seller_load sl ON sl.seller_id = s.${sellerId}
         WHERE s.${s('processingEnabled')} = true
           AND t.${t('terminal')} = false
           AND t.${t('kind')} = ANY($1)
           AND (t.${t('status')} = '${TaskStatus.PENDING}'
                OR (t.${t('status')} = '${TaskStatus.FAILED}' AND t.${t('attempts')} < $3)
                OR (t.${t('status')} = '${TaskStatus.PROCESSING}' AND t.${t('lockedAt')} < NOW() - MAKE_INTERVAL(mins => $4)))
           AND (t.${t('scheduledAt')} IS NULL OR t.${t('scheduledAt')} <= NOW())
           AND (
             NOT (t.${t('kind')} = ANY($2))
             OR (
               COALESCE(pl.in_flight, 0) < COALESCE(s.${s('maxConcurrent')}, 1)
               AND (pl.last_claim IS NULL
                    OR NOW() - pl.last_claim >= ${paceOf(`COALESCE(NULLIF(s.${s('requestsPerHour')}, 0), $5)`)})
               AND (se.${se('maxConcurrent')} IS NULL
                    OR COALESCE(sl.in_flight, 0) < se.${se('maxConcurrent')})
               AND (NULLIF(se.${se('requestsPerHour')}, 0) IS NULL
                    OR sl.last_claim IS NULL
                    OR NOW() - sl.last_claim >= ${paceOf(`NULLIF(se.${se('requestsPerHour')}, 0)`)})
             )
           )
         ORDER BY t.${t('priority')} DESC, t.${t('sortKey')} ASC
         LIMIT $6
           FOR UPDATE OF t SKIP LOCKED
      ),
      ranked AS (
        SELECT c.*,
               ROW_NUMBER() OVER (PARTITION BY c.source_id, c.is_page ORDER BY c.priority DESC, c.sort_key) AS nth_of_source,
               ROW_NUMBER() OVER (PARTITION BY c.seller_id, c.is_page ORDER BY c.priority DESC, c.sort_key) AS nth_of_seller
          FROM candidates c
      ),
      picked AS (
        SELECT id FROM ranked
         WHERE NOT is_page
            OR (nth_of_source = 1 AND (NOT seller_gated OR nth_of_seller = 1))
         ORDER BY priority DESC, sort_key
         LIMIT $7
      )
      UPDATE ${task} t
         SET ${t('status')} = '${TaskStatus.PROCESSING}', ${t('lockedAt')} = NOW()
        FROM picked
       WHERE t.${t('id')} = picked.id
      RETURNING t.${t('id')} AS id, t.${t('priority')} AS priority, t.${t('sortKey')} AS sort_key
    `;
  }

  /**
   * A source's feed_entry tasks for these URLs that have not settled: pending,
   * processing, or failed with retries still to come. Only the columns a feed
   * run needs to decide between replacing one and queuing another.
   */
  async findOpenFeedEntries(
    sourceId: string,
    urls: string[],
  ): Promise<ProductImportTask[]> {
    if (isEmpty(urls)) return [];
    const t = (field: keyof ProductImportTask) =>
      `task.${nameOf<ProductImportTask>(field)}`;
    return this.repo
      .createQueryBuilder('task')
      .select([t('id'), t('url'), t('status'), t('attempts'), t('payloadHash')])
      .where(`task."${nameOf<ProductImportTask>('source')}Id" = :sourceId`, {
        sourceId,
      })
      .andWhere(`${t('kind')} = :kind`, { kind: ProductImportTaskKind.FeedEntry })
      .andWhere(`${t('url')} IN (:...urls)`, { urls })
      .andWhere(`${t('status')} IN (:...statuses)`, {
        statuses: [TaskStatus.PENDING, TaskStatus.PROCESSING, TaskStatus.FAILED],
      })
      .andWhere(`${t('terminal')} = false`)
      .getMany();
  }

  /**
   * How many tasks of these kinds a source has had created since `since`,
   * whatever became of them since. A run-wide cap counts its run with it.
   */
  async countCreatedSince(params: {
    sourceId: string;
    kinds: ProductImportTaskKind[];
    since: Date;
  }): Promise<number> {
    const t = (field: keyof ProductImportTask) =>
      `task.${nameOf<ProductImportTask>(field)}`;
    return this.repo
      .createQueryBuilder('task')
      .where(`task."${nameOf<ProductImportTask>('source')}Id" = :sourceId`, {
        sourceId: params.sourceId,
      })
      .andWhere(`${t('kind')} IN (:...kinds)`, { kinds: params.kinds })
      .andWhere(`${t('createdAt')} >= :since`, { since: params.since })
      .getCount();
  }

  /** A task's payload, which is not selected by default. */
  async loadPayload(id: string): Promise<Record<string, any> | null> {
    const task = await this.repo
      .createQueryBuilder('task')
      .select(`task.${nameOf<ProductImportTask>('id')}`)
      .addSelect(`task.${nameOf<ProductImportTask>('payload')}`)
      .where(`task.${nameOf<ProductImportTask>('id')} = :id`, { id })
      .getOne();
    return task?.payload ?? null;
  }

  /**
   * The newest feed row stored for a listing: what a resync of a feed listing
   * imports again, since a feed has no page to fetch.
   */
  async latestFeedPayload(
    sourceId: string,
    url: string,
  ): Promise<{ payload: Record<string, any>; payloadHash?: string | null } | null> {
    const t = (field: keyof ProductImportTask) =>
      `task.${nameOf<ProductImportTask>(field)}`;
    const task = await this.repo
      .createQueryBuilder('task')
      .select([t('id'), t('payloadHash')])
      .addSelect(t('payload'))
      .where(`task."${nameOf<ProductImportTask>('source')}Id" = :sourceId`, {
        sourceId,
      })
      .andWhere(`${t('kind')} = :kind`, { kind: ProductImportTaskKind.FeedEntry })
      .andWhere(`${t('url')} = :url`, { url })
      .andWhere(`${t('payload')} IS NOT NULL`)
      .orderBy(t('createdAt'), 'DESC')
      .getOne();
    return task?.payload
      ? { payload: task.payload, payloadHash: task.payloadHash }
      : null;
  }

  /**
   * Puts claimed tasks back to `pending`, for a collector shutting down with
   * work still in flight. Only tasks still `processing`: one that finished in
   * the meantime keeps its result.
   */
  async releaseClaims(ids: string[]): Promise<number> {
    if (isEmpty(ids)) return 0;
    const result = await this.repo
      .createQueryBuilder()
      .update(ProductImportTask)
      .set({ status: TaskStatus.PENDING, lockedAt: () => 'NULL' })
      .where(`${nameOf<ProductImportTask>('id')} IN (:...ids)`, { ids })
      .andWhere(`${nameOf<ProductImportTask>('status')} = :processing`, {
        processing: TaskStatus.PROCESSING,
      })
      .execute();
    return result.affected ?? 0;
  }

  /**
   * An in-flight task for this URL, belonging to THIS source.
   *
   * `sourceId` is required rather than optional so every call site has to
   * decide. Unscoped, a webshop's second source could never get a task for a
   * URL its first source happens to have in flight — and it would not fail, it
   * would just silently create nothing, which is the kind of gap that shows up
   * weeks later as "that source imports about half the catalogue".
   */
  async findExistingUrl(
    sourceId: string,
    url: string,
    statuses: TaskStatus[],
  ): Promise<ProductImportTask | null> {
    const tasks = await this.findExistingUrls(sourceId, [url], statuses);
    return tasks[0] ?? null;
  }

  async findExistingUrls(
    sourceId: string,
    urls: string[],
    statuses: TaskStatus[],
  ): Promise<ProductImportTask[]> {
    if (isEmpty(urls)) return [];

    const normalizedUrls = urls.map((url) =>
      url.toLowerCase().replace(/\/+$/, ''),
    );

    return this.repo
      .createQueryBuilder('task')
      .where(
        `LOWER(RTRIM(task.${nameOf<ProductImportTask>('url')}, :slash)) IN (:...urls)`,
        {
          urls: normalizedUrls,
          slash: '/',
        },
      )
      .andWhere(`task.${nameOf<ProductImportTask>('status')} IN (:...statuses)`, {
        statuses,
      })
      .andWhere(`task.${nameOf<ProductImportTask>('source')} = :sourceId`, {
        sourceId,
      })
      .getMany();
  }
}
