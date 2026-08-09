import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { EntityManager, Repository } from "typeorm";
import { BasePostgresRepository } from "./base-postgres-repository";
import { Thread } from "../models/thread.entity";
import { isEmpty } from "lodash";
import { nameOf } from "@ebike-backend/utils";

@Injectable()
export class ThreadRepository extends BasePostgresRepository<Thread> {
  constructor(
    @InjectRepository(Thread, "postgres")
    repository: Repository<Thread>,
  ) {
    super(repository, Thread);
  }

  async findAllByExternalId(
    externalIds: string[],
    transaction?: EntityManager,
  ): Promise<Thread[]> {
    if (isEmpty(externalIds)) {
      return [];
    }

    const queryBuilder = transaction
      ? transaction.createQueryBuilder(this.classConstructor, "t")
      : this.repo.createQueryBuilder("t");

    return queryBuilder
      .where(`t.${nameOf<Thread>("externalId")} IN (:...externalIds)`, {
        externalIds,
      })
      .getMany();
  }

  /**
   * Atomically append `keyword` to the thread's `keywords` array unless it is
   * already present (set semantics). Returns true if the row was updated,
   * false if the keyword was already there. One statement, race-safe under
   * concurrent searches.
   */
  async appendKeyword(threadId: string, keyword: string): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(Thread)
      .set({ keywords: () => `keywords || ARRAY[:keyword]::text[]` })
      .where("id = :threadId", { threadId })
      .andWhere("NOT (keywords @> ARRAY[:keyword]::text[])")
      .setParameter("keyword", keyword)
      .execute();

    return (result.affected ?? 0) > 0;
  }
}
