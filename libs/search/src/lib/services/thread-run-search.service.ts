import { Injectable } from "@nestjs/common";
import {
  ThreadRun,
  ThreadRunRepository,
  ThreadRunStatus,
} from "@ebike-backend/database";
import { SelectQueryBuilder } from "typeorm";
import { nameOf } from "@ebike-backend/utils";
import { ThreadRunSearchParams } from "../models/thread-run-search-params";
import { ThreadRunSearchResult } from "../models/thread-run-search-result";
import { isEmpty, isNil } from "lodash";

const DEFAULT_PAGE_SIZE = 100;

@Injectable()
export class ThreadRunSearchService {
  constructor(private readonly threadRunRepository: ThreadRunRepository) {}

  public async search(
    params: ThreadRunSearchParams,
  ): Promise<ThreadRunSearchResult> {
    const finalParams = {
      ...params,
      sort: params.sort ?? "createdAt",
      order: params.order ?? "DESC",
    };

    const query = this.buildQuery(finalParams);
    const [items, totalItems] = await query.getManyAndCount();

    return this.mapToSearchResult([items, totalItems], finalParams);
  }

  private buildQuery(
    params: ThreadRunSearchParams,
  ): SelectQueryBuilder<ThreadRun> {
    let query = this.threadRunRepository.repo
      .createQueryBuilder("threadRun")
      .leftJoin("threadRun.thread", "thread")
      .addSelect("thread.id");

    if (!isEmpty(params.statuses)) {
      query = query.andWhere(
        `threadRun.${nameOf<ThreadRun>("status")} IN (:...statuses)`,
        { statuses: params.statuses },
      );
    }

    if (!isNil(params.threadId)) {
      query = query.andWhere("thread.id = :threadId", {
        threadId: params.threadId,
      });
    }

    if (!isNil(params.startedAtFrom)) {
      query = query.andWhere(
        `threadRun.${nameOf<ThreadRun>("startedAt")} >= :startedAtFrom`,
        { startedAtFrom: params.startedAtFrom },
      );
    }

    if (!isNil(params.startedAtTo)) {
      query = query.andWhere(
        `threadRun.${nameOf<ThreadRun>("startedAt")} <= :startedAtTo`,
        { startedAtTo: params.startedAtTo },
      );
    }

    query = query.orderBy(
      `threadRun.${params.sort}`,
      params.order as "ASC" | "DESC",
      "NULLS LAST",
    );

    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    query = query.skip((page - 1) * pageSize).take(pageSize);

    return query;
  }

  private mapToSearchResult(
    result: [ThreadRun[], number],
    params: ThreadRunSearchParams,
  ): ThreadRunSearchResult {
    const [items, totalItems] = result;
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const totalPages = Math.ceil(totalItems / pageSize);

    const searchResult = new ThreadRunSearchResult();
    searchResult.page = page;
    searchResult.pageSize = pageSize;
    searchResult.totalItems = totalItems;
    searchResult.totalPages = totalPages;
    searchResult.items = items;
    searchResult.sort = params.sort;
    searchResult.order = params.order as "ASC" | "DESC";
    searchResult.statuses = params.statuses;
    searchResult.threadId = params.threadId;
    searchResult.startedAtFrom = params.startedAtFrom;
    searchResult.startedAtTo = params.startedAtTo;

    return searchResult;
  }
}
