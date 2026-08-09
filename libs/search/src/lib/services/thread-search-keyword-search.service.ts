import { Injectable } from "@nestjs/common";
import {
  ThreadSearchKeyword,
  ThreadSearchKeywordRepository,
} from "@ebike-backend/database";
import { SelectQueryBuilder } from "typeorm";
import { nameOf } from "@ebike-backend/utils";
import { ThreadSearchKeywordSearchParams } from "../models/thread-search-keyword-search-params";
import { ThreadSearchKeywordSearchResult } from "../models/thread-search-keyword-search-result";
import { isEmpty } from "lodash";

const DEFAULT_PAGE_SIZE = 50;

@Injectable()
export class ThreadSearchKeywordSearchService {
  constructor(
    private readonly threadSearchKeywordRepo: ThreadSearchKeywordRepository,
  ) {}

  public async search(
    params: ThreadSearchKeywordSearchParams,
  ): Promise<ThreadSearchKeywordSearchResult> {
    const finalParams = {
      ...params,
      sort: params.sort ?? "lastSearchedAt",
      order: params.order ?? ("DESC" as const),
    };

    const query = this.buildQuery(finalParams);
    const [items, totalItems] = await query.getManyAndCount();

    return this.mapToSearchResult([items, totalItems], finalParams);
  }

  private buildQuery(
    params: ThreadSearchKeywordSearchParams,
  ): SelectQueryBuilder<ThreadSearchKeyword> {
    let query = this.threadSearchKeywordRepo.repo
      .createQueryBuilder("threadSearchKeyword")
      .leftJoinAndSelect(
        `threadSearchKeyword.${nameOf<ThreadSearchKeyword>("category")}`,
        "category",
      );

    if (!isEmpty(params.categoryIds)) {
      query = query.andWhere(
        `threadSearchKeyword.${nameOf<ThreadSearchKeyword>("categoryId")} IN (:...categoryIds)`,
        { categoryIds: params.categoryIds },
      );
    }

    if (!isEmpty(params.platforms)) {
      query = query.andWhere(
        `threadSearchKeyword.${nameOf<ThreadSearchKeyword>("platform")} IN (:...platforms)`,
        { platforms: params.platforms },
      );
    }

    query = query.orderBy(
      `threadSearchKeyword.${params.sort}`,
      params.order,
      "NULLS LAST",
    );

    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    query = query.skip((page - 1) * pageSize).take(pageSize);

    return query;
  }

  private mapToSearchResult(
    result: [ThreadSearchKeyword[], number],
    params: ThreadSearchKeywordSearchParams,
  ): ThreadSearchKeywordSearchResult {
    const [items, totalItems] = result;
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const totalPages = Math.ceil(totalItems / pageSize);

    const searchResult = new ThreadSearchKeywordSearchResult();
    searchResult.page = page;
    searchResult.pageSize = pageSize;
    searchResult.totalItems = totalItems;
    searchResult.totalPages = totalPages;
    searchResult.items = items;
    searchResult.sort = params.sort;
    searchResult.order = params.order;
    searchResult.categoryIds = params.categoryIds;
    searchResult.platforms = params.platforms;

    return searchResult;
  }
}
