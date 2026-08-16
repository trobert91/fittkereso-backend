import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ScrapeTask } from '../models/scrape-task.entity';
import { TaskStatus } from '../models/task.entity';
import { BasePostgresRepository } from './base-postgres-repository';
import { ScrapeQueueName } from '../types';
import { nameOf } from '@fittkereso-backend/utils';
import { ProductSource } from '../models';
import { isEmpty } from 'lodash';

const DEFAULT_REQUEST_PER_HOUR = 50;

// Per-candidate reason(s) a task sitting in a claimable status/queue was not
// actually claimed by fetchNextScrapeTask — surfaced so a caller (e.g.
// BaseScrapeTaskManagerService, which owns logging) can explain an otherwise
// silent "nothing to do" poll tick instead of just returning null.
export interface ScrapeTaskClaimBlockedInfo {
  taskId: string;
  status: TaskStatus;
  sourceId: string;
  sourceName: string;
  maxConcurrent: number;
  requestsPerHour: number;
  blockedReasons: string[];
}

export interface FetchNextScrapeTaskResult {
  task: ScrapeTask | null;
  // Only populated when task is null; libs/database can't depend on
  // libs/logger (circular via libs/config), so diagnostics are returned as
  // data for the caller to log rather than logged here.
  noTaskDiagnostics?: {
    candidateCount: number;
    blocked: ScrapeTaskClaimBlockedInfo[];
  };
}

@Injectable()
export class ScrapeTaskRepository extends BasePostgresRepository<ScrapeTask> {
  constructor(
    @InjectRepository(ScrapeTask, 'postgres')
    repository: Repository<ScrapeTask>,
  ) {
    super(repository, ScrapeTask);
  }

  /**
   * Fetches the next available scrape task across all product sources,
   * respecting each source's `maxConcurrent` limit.
   */
  async fetchNextScrapeTask(
    queues: ScrapeQueueName[],
    staleTaskTimeoutMinutes = 240,
  ): Promise<FetchNextScrapeTaskResult> {
    const queryRunner = this.repo.manager.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Lock only the task row — FOR UPDATE cannot be used with outer joins,
      // so we select just the ID here and load relations in a separate query.
      const lockedTask = await queryRunner.manager
        .createQueryBuilder(ScrapeTask, 'task')
        .setLock('pessimistic_write')
        .select(`task.${nameOf<ScrapeTask>('id')}`)
        .innerJoin(`task.${nameOf<ScrapeTask>('source')}`, 'source')
        .where(
          `(task.${nameOf<ScrapeTask>('status')} = :pendingStatus OR
           (task.${nameOf<ScrapeTask>('status')} = :failedStatus AND task.${nameOf<ScrapeTask>('attempts')} < :maxAttempts) OR
           (task.${nameOf<ScrapeTask>('status')} = :processingStatus AND task."${nameOf<ScrapeTask>('lockedAt')}" < NOW() - MAKE_INTERVAL(mins => :staleTimeoutMinutes)))`,
          {
            pendingStatus: TaskStatus.PENDING,
            failedStatus: TaskStatus.FAILED,
            processingStatus: TaskStatus.PROCESSING,
            maxAttempts: 3,
            staleTimeoutMinutes: staleTaskTimeoutMinutes,
          },
        )
        .andWhere(`source.${nameOf<ProductSource>('processingEnabled')} = true`)
        .andWhere(`task.${nameOf<ScrapeTask>('queue')} IN (:...queues)`, {
          queues,
        })
        .andWhere(
          `(task.${nameOf<ScrapeTask>('scheduledAt')} IS NULL OR task.${nameOf<ScrapeTask>('scheduledAt')} <= NOW())`,
        )
        .andWhere((qb) => {
          const subQuery = qb
            .subQuery()
            .select('COUNT(*)')
            .from(ScrapeTask, 't2')
            .leftJoin(`t2.${nameOf<ScrapeTask>('source')}`, 's2')
            .where(
              `s2.${nameOf<ProductSource>('id')} = source.${nameOf<ProductSource>('id')}`,
            )
            .andWhere(`t2.${nameOf<ScrapeTask>('status')} = :activeProcessing`)
            .andWhere(
              `t2."${nameOf<ScrapeTask>('lockedAt')}" >= NOW() - MAKE_INTERVAL(mins => :staleTimeoutMinutes)`,
            )
            .getQuery();

          return `${subQuery} < COALESCE(source.${nameOf<ProductSource>('maxConcurrent')}, 1)`;
        })
        .andWhere((qb) => {
          const subQuery = qb
            .subQuery()
            .select(`MAX(t3.${nameOf<ScrapeTask>('lockedAt')})`)
            .from(ScrapeTask, 't3')
            .leftJoin(`t3.${nameOf<ScrapeTask>('source')}`, 's3')
            .where(
              `s3.${nameOf<ProductSource>('id')} = source.${nameOf<ProductSource>('id')}`,
            )
            .getQuery();

          return `
            (
              ${subQuery} IS NULL
              OR
              NOW() - (${subQuery})
                >= INTERVAL '1 second'
                  * (3600 / COALESCE(source.${nameOf<ProductSource>('requestsPerHour')}, ${DEFAULT_REQUEST_PER_HOUR}))
            )
          `;
        })
        .setParameters({
          activeProcessing: TaskStatus.PROCESSING,
          staleTimeoutMinutes: staleTaskTimeoutMinutes,
        })
        .orderBy(`task.${nameOf<ScrapeTask>('createdAt')}`, 'ASC')
        .getOne();

      if (!lockedTask) {
        await queryRunner.rollbackTransaction();
        await queryRunner.release();
        const noTaskDiagnostics = await this.buildNoTaskClaimedDiagnostics(
          queues,
          staleTaskTimeoutMinutes,
        );
        return { task: null, noTaskDiagnostics };
      }

      // Load full task with relations now that the row is locked
      const task = await queryRunner.manager.findOneOrFail(ScrapeTask, {
        where: { id: lockedTask.id },
        relations: [
          nameOf<ScrapeTask>('source'),
          nameOf<ScrapeTask>('product'),
        ],
      });

      task.status = TaskStatus.PROCESSING;
      task.lockedAt = new Date();
      await queryRunner.manager.save(task);

      await queryRunner.commitTransaction();
      await queryRunner.release();

      return { task };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      await queryRunner.release();
      throw err;
    }
  }

  // Runs when the claim query returns nothing, to make otherwise-invisible
  // gating conditions (processingEnabled, maxConcurrent, requestsPerHour
  // throttle, scheduledAt, stale-lock timeout) diagnosable by the caller
  // instead of the poller silently doing nothing every 5s. Returns data
  // rather than logging directly — libs/database can't depend on
  // libs/logger (circular via libs/config).
  private async buildNoTaskClaimedDiagnostics(
    queues: ScrapeQueueName[],
    staleTaskTimeoutMinutes: number,
  ): Promise<FetchNextScrapeTaskResult['noTaskDiagnostics']> {
    const candidateStatuses = [TaskStatus.PENDING, TaskStatus.FAILED, TaskStatus.PROCESSING];
    const candidates = await this.repo
      .createQueryBuilder('task')
      .innerJoinAndSelect(`task.${nameOf<ScrapeTask>('source')}`, 'source')
      .where(`task.${nameOf<ScrapeTask>('status')} IN (:...statuses)`, {
        statuses: candidateStatuses,
      })
      .andWhere(`task.${nameOf<ScrapeTask>('queue')} IN (:...queues)`, { queues })
      .orderBy(`task.${nameOf<ScrapeTask>('createdAt')}`, 'ASC')
      .limit(20)
      .getMany();

    if (candidates.length === 0) {
      return { candidateCount: 0, blocked: [] };
    }

    const now = Date.now();
    const blocked: ScrapeTaskClaimBlockedInfo[] = candidates.map((task) => {
      const blockedReasons: string[] = [];
      if (!task.source.processingEnabled) {
        blockedReasons.push('source.processingEnabled=false');
      }
      if (task.scheduledAt && task.scheduledAt.getTime() > now) {
        blockedReasons.push(`scheduledAt in future (${task.scheduledAt.toISOString()})`);
      }
      if (
        task.status === TaskStatus.PROCESSING &&
        task.lockedAt &&
        now - task.lockedAt.getTime() < staleTaskTimeoutMinutes * 60 * 1000
      ) {
        blockedReasons.push(
          `status=processing and lockedAt not yet stale (staleTimeout=${staleTaskTimeoutMinutes}min)`,
        );
      }
      if (task.status === TaskStatus.FAILED && task.attempts >= 3) {
        blockedReasons.push(`attempts (${task.attempts}) >= max (3)`);
      }
      return {
        taskId: task.id,
        status: task.status,
        sourceId: task.source.id,
        sourceName: task.source.name,
        maxConcurrent: task.source.maxConcurrent,
        requestsPerHour: task.source.requestsPerHour,
        blockedReasons:
          blockedReasons.length > 0
            ? blockedReasons
            : ['none of the simple gates — likely maxConcurrent cap or requestsPerHour throttle window'],
      };
    });

    return { candidateCount: candidates.length, blocked };
  }

  async findExistingUrl(
    url: string,
    statuses: TaskStatus[],
  ): Promise<ScrapeTask | null> {
    const tasks = await this.findExistingUrls([url], statuses);
    return tasks[0] ?? null;
  }

  async findExistingUrls(
    urls: string[],
    statuses: TaskStatus[],
  ): Promise<ScrapeTask[]> {
    if (isEmpty(urls)) return [];

    const normalizedUrls = urls.map((url) =>
      url.toLowerCase().replace(/\/+$/, ''),
    );

    return this.repo
      .createQueryBuilder('task')
      .where(
        `LOWER(RTRIM(task.${nameOf<ScrapeTask>('url')}, :slash)) IN (:...urls)`,
        {
          urls: normalizedUrls,
          slash: '/',
        },
      )
      .andWhere(`task.${nameOf<ScrapeTask>('status')} IN (:...statuses)`, {
        statuses,
      })
      .getMany();
  }
}
