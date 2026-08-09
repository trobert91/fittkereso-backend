import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { BasePostgresRepository } from "./base-postgres-repository";
import { ThreadSearchTask } from "../models/thread-search-task.entity";
import { TaskStatus } from "../models/task.entity";
import { nameOf } from "@ebike-backend/utils";

const MAX_ATTEMPTS = 3;

@Injectable()
export class ThreadSearchTaskRepository extends BasePostgresRepository<ThreadSearchTask> {
  constructor(
    @InjectRepository(ThreadSearchTask, "postgres")
    repository: Repository<ThreadSearchTask>,
  ) {
    super(repository, ThreadSearchTask);
  }

  async fetchNextThreadSearchTask(
    staleTaskTimeoutMinutes = 240,
  ): Promise<ThreadSearchTask | null> {
    const queryRunner = this.repo.manager.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const statusColumn = `task.${nameOf<ThreadSearchTask>("status")}`;
      const lockedAtColumn = `task."${nameOf<ThreadSearchTask>("lockedAt")}"`;
      const scheduledAtColumn = `task.${nameOf<ThreadSearchTask>("scheduledAt")}`;

      const task = await queryRunner.manager
        .createQueryBuilder(ThreadSearchTask, "task")
        .setLock("pessimistic_write")
        .where(
          `(${statusColumn} = :pendingStatus OR
           (${statusColumn} = :failedStatus AND task.${nameOf<ThreadSearchTask>("attempts")} < :maxAttempts) OR
           (${statusColumn} = :processingStatus AND ${lockedAtColumn} < NOW() - MAKE_INTERVAL(mins => :staleTimeoutMinutes)))`,
          {
            pendingStatus: TaskStatus.PENDING,
            failedStatus: TaskStatus.FAILED,
            processingStatus: TaskStatus.PROCESSING,
            maxAttempts: MAX_ATTEMPTS,
            staleTimeoutMinutes: staleTaskTimeoutMinutes,
          },
        )
        .andWhere(
          `(${scheduledAtColumn} IS NULL OR ${scheduledAtColumn} <= NOW())`,
        )
        .orderBy(`task.${nameOf<ThreadSearchTask>("createdAt")}`, "ASC")
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
}
