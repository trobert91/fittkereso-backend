import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ScrapeTask } from "../models/scrape-task.entity";
import { TaskStatus } from "../models/task.entity";
import { BasePostgresRepository } from "./base-postgres-repository";
import { ScrapeQueueName } from "../types";
import { nameOf } from "@ebike-backend/utils";
import { ProductSource } from "../models";
import { isEmpty } from "lodash";

const DEFAULT_REQUEST_PER_HOUR = 50;

@Injectable()
export class ScrapeTaskRepository extends BasePostgresRepository<ScrapeTask> {
  constructor(
    @InjectRepository(ScrapeTask, "postgres")
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
  ): Promise<ScrapeTask | null> {
    const queryRunner = this.repo.manager.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Lock only the task row — FOR UPDATE cannot be used with outer joins,
      // so we select just the ID here and load relations in a separate query.
      const lockedTask = await queryRunner.manager
        .createQueryBuilder(ScrapeTask, "task")
        .setLock("pessimistic_write")
        .select(`task.${nameOf<ScrapeTask>("id")}`)
        .innerJoin(`task.${nameOf<ScrapeTask>("source")}`, "source")
        .where(
          `(task.${nameOf<ScrapeTask>("status")} = :pendingStatus OR
           (task.${nameOf<ScrapeTask>("status")} = :failedStatus AND task.${nameOf<ScrapeTask>("attempts")} < :maxAttempts) OR
           (task.${nameOf<ScrapeTask>("status")} = :processingStatus AND task."${nameOf<ScrapeTask>("lockedAt")}" < NOW() - MAKE_INTERVAL(mins => :staleTimeoutMinutes)))`,
          {
            pendingStatus: TaskStatus.PENDING,
            failedStatus: TaskStatus.FAILED,
            processingStatus: TaskStatus.PROCESSING,
            maxAttempts: 3,
            staleTimeoutMinutes: staleTaskTimeoutMinutes,
          },
        )
        .andWhere(`source.${nameOf<ProductSource>("processingEnabled")} = true`)
        .andWhere(`task.${nameOf<ScrapeTask>("queue")} IN (:...queues)`, {
          queues,
        })
        .andWhere(
          `(task.${nameOf<ScrapeTask>("scheduledAt")} IS NULL OR task.${nameOf<ScrapeTask>("scheduledAt")} <= NOW())`,
        )
        .andWhere((qb) => {
          const subQuery = qb
            .subQuery()
            .select("COUNT(*)")
            .from(ScrapeTask, "t2")
            .leftJoin(`t2.${nameOf<ScrapeTask>("source")}`, "s2")
            .where(
              `s2.${nameOf<ProductSource>("id")} = source.${nameOf<ProductSource>("id")}`,
            )
            .andWhere(`t2.${nameOf<ScrapeTask>("status")} = :activeProcessing`)
            .andWhere(
              `t2."${nameOf<ScrapeTask>("lockedAt")}" >= NOW() - MAKE_INTERVAL(mins => :staleTimeoutMinutes)`,
            )
            .getQuery();

          return `${subQuery} < COALESCE(source.${nameOf<ProductSource>("maxConcurrent")}, 1)`;
        })
        .andWhere((qb) => {
          const subQuery = qb
            .subQuery()
            .select(`MAX(t3.${nameOf<ScrapeTask>("lockedAt")})`)
            .from(ScrapeTask, "t3")
            .leftJoin(`t3.${nameOf<ScrapeTask>("source")}`, "s3")
            .where(
              `s3.${nameOf<ProductSource>("id")} = source.${nameOf<ProductSource>("id")}`,
            )
            .getQuery();

          return `
            (
              ${subQuery} IS NULL
              OR
              NOW() - (${subQuery})
                >= INTERVAL '1 second'
                  * (3600 / COALESCE(source.${nameOf<ProductSource>("requestsPerHour")}, ${DEFAULT_REQUEST_PER_HOUR}))
            )
          `;
        })
        .setParameters({
          activeProcessing: TaskStatus.PROCESSING,
          staleTimeoutMinutes: staleTaskTimeoutMinutes,
        })
        .orderBy(`task.${nameOf<ScrapeTask>("createdAt")}`, "ASC")
        .getOne();

      if (!lockedTask) {
        await queryRunner.rollbackTransaction();
        await queryRunner.release();
        return null;
      }

      // Load full task with relations now that the row is locked
      const task = await queryRunner.manager.findOneOrFail(ScrapeTask, {
        where: { id: lockedTask.id },
        relations: [
          nameOf<ScrapeTask>("source"),
          nameOf<ScrapeTask>("product"),
        ],
      });

      task.status = TaskStatus.PROCESSING;
      task.lockedAt = new Date();
      await queryRunner.manager.save(task);

      await queryRunner.commitTransaction();
      await queryRunner.release();

      return task;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      await queryRunner.release();
      throw err;
    }
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
      url.toLowerCase().replace(/\/+$/, ""),
    );

    return this.repo
      .createQueryBuilder("task")
      .where(
        `LOWER(RTRIM(task.${nameOf<ScrapeTask>("url")}, :slash)) IN (:...urls)`,
        {
          urls: normalizedUrls,
          slash: "/",
        },
      )
      .andWhere(`task.${nameOf<ScrapeTask>("status")} IN (:...statuses)`, {
        statuses,
      })
      .getMany();
  }
}
