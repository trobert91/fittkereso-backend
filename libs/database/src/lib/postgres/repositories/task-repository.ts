import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { BasePostgresRepository } from "./base-postgres-repository";
import { Task, TaskStatus } from "../models/task.entity";
import { QueueName } from "../types";
import { nameOf } from "@ebike-backend/utils";

@Injectable()
export class TaskRepository extends BasePostgresRepository<Task> {
  constructor(
    @InjectRepository(Task, "postgres")
    repository: Repository<Task>,
  ) {
    super(repository, Task);
  }

  public async fetchNextTask(
    queues: QueueName[],
    staleTaskTimeoutMinutes = 240,
  ): Promise<Task | null> {
    const queryRunner = this.repo.manager.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const statusColumn = `task.${nameOf<Task>("status")}`;
      const lockedAtColumn = `task."${nameOf<Task>("lockedAt")}"`;
      const scheduledAtColumn = `task.${nameOf<Task>("scheduledAt")}`;
      const queueColumn = `task.${nameOf<Task>("queue")}`;
      const task = await queryRunner.manager
        .createQueryBuilder(Task, "task")
        .setLock("pessimistic_write")
        .where(
          `(${statusColumn} = :pendingStatus OR (${statusColumn} = :failedStatus AND task.${nameOf<Task>("attempts")} < :maxAttempts) OR (${statusColumn} = :processingStatus AND ${lockedAtColumn} < NOW() - MAKE_INTERVAL(mins => :staleTimeoutMinutes)))`,
          {
            pendingStatus: TaskStatus.PENDING,
            failedStatus: TaskStatus.FAILED,
            processingStatus: TaskStatus.PROCESSING,
            maxAttempts: 3,
            staleTimeoutMinutes: staleTaskTimeoutMinutes,
          },
        )
        .andWhere(`${queueColumn} IN (:...queues)`, { queues })
        .andWhere(
          `(${scheduledAtColumn} IS NULL OR ${scheduledAtColumn} <= NOW())`,
        )
        .andWhere((qb) => {
          const subQuery = qb
            .subQuery()
            .select("COUNT(*)")
            .from(Task, "t2")
            .where(`t2.${nameOf<Task>("queue")} = ${queueColumn}`)
            .andWhere(`t2.${nameOf<Task>("status")} = :activeProcessingStatus`)
            .andWhere(
              `t2."${nameOf<Task>("lockedAt")}" >= NOW() - MAKE_INTERVAL(mins => :staleTimeoutMinutes)`,
            )
            .getQuery();

          return `${subQuery} <= :maxConcurrentPerQueue`;
        })
        .setParameters({
          activeProcessingStatus: "processing",
          maxConcurrentPerQueue: 3,
          staleTimeoutMinutes: staleTaskTimeoutMinutes,
        })
        .orderBy(`task.${nameOf<Task>("createdAt")}`, "ASC")
        .getOne();

      if (!task) {
        await queryRunner.rollbackTransaction();
        await queryRunner.release();
        return null;
      }

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

  /**
   * Returns the latest lockedAt timestamp for tasks in a specified queue.
   * Returns null if no tasks have been locked in the queue.
   */
  public async lastCreatedTimestamp(queue: QueueName): Promise<Date | null> {
    const result = await this.repo
      .createQueryBuilder("task")
      .select(`MAX(task.${nameOf<Task>("createdAt")})`, "maxCreatedAt")
      .where(`task.${nameOf<Task>("queue")} = :queue`, { queue })
      .andWhere(`task.${nameOf<Task>("createdAt")} IS NOT NULL`)
      .getRawOne<{ maxCreatedAt: Date | null }>();

    return result?.maxCreatedAt ?? null;
  }
}
