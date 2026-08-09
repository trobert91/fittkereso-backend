import { Injectable } from "@nestjs/common";
import {
  ThreadSearchTask,
  ThreadSearchTaskRepository,
} from "@ebike-backend/database";
import { SelectQueryBuilder } from "typeorm";
import { nameOf } from "@ebike-backend/utils";
import { ThreadSearchTaskSearchParams } from "../models/thread-search-task-search-params";
import { ThreadSearchTaskSearchResult } from "../models/thread-search-task-search-result";
import { isEmpty } from "lodash";

const DEFAULT_PAGE_SIZE = 50;

@Injectable()
export class ThreadSearchTaskSearchService {
  constructor(
    private readonly threadSearchTaskRepo: ThreadSearchTaskRepository,
  ) {}

  public async search(
    params: ThreadSearchTaskSearchParams,
  ): Promise<ThreadSearchTaskSearchResult> {
    const finalParams = {
      ...params,
      sort: params.sort ?? "createdAt",
      order: params.order ?? ("DESC" as const),
    };

    const query = this.buildQuery(finalParams);
    const [items, totalItems] = await query.getManyAndCount();

    return this.mapToSearchResult([items, totalItems], finalParams);
  }

  private buildQuery(
    params: ThreadSearchTaskSearchParams,
  ): SelectQueryBuilder<ThreadSearchTask> {
    let query =
      this.threadSearchTaskRepo.repo.createQueryBuilder("threadSearchTask");

    if (!isEmpty(params.statuses)) {
      query = query.andWhere(
        `threadSearchTask.${nameOf<ThreadSearchTask>("status")} IN (:...statuses)`,
        { statuses: params.statuses },
      );
    }

    if (!isEmpty(params.platforms)) {
      query = query.andWhere(
        `threadSearchTask.${nameOf<ThreadSearchTask>("platform")} IN (:...platforms)`,
        { platforms: params.platforms },
      );
    }

    if (!isEmpty(params.categorySlugs)) {
      query = query.andWhere(
        `threadSearchTask.${nameOf<ThreadSearchTask>("categorySlug")} IN (:...categorySlugs)`,
        { categorySlugs: params.categorySlugs },
      );
    }

    query = query.orderBy(
      `threadSearchTask.${params.sort}`,
      params.order,
      "NULLS LAST",
    );

    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    query = query.skip((page - 1) * pageSize).take(pageSize);

    return query;
  }

  private mapToSearchResult(
    result: [ThreadSearchTask[], number],
    params: ThreadSearchTaskSearchParams,
  ): ThreadSearchTaskSearchResult {
    const [items, totalItems] = result;
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const totalPages = Math.ceil(totalItems / pageSize);

    const searchResult = new ThreadSearchTaskSearchResult();
    searchResult.page = page;
    searchResult.pageSize = pageSize;
    searchResult.totalItems = totalItems;
    searchResult.totalPages = totalPages;
    searchResult.items = items;
    searchResult.sort = params.sort;
    searchResult.order = params.order;
    searchResult.statuses = params.statuses;
    searchResult.platforms = params.platforms;
    searchResult.categorySlugs = params.categorySlugs;

    return searchResult;
  }
}
