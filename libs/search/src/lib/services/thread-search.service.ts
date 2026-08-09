import { Injectable } from "@nestjs/common";
import {
  ProductCategory,
  Thread,
  ThreadProductCategory,
  ThreadRepository,
} from "@ebike-backend/database";
import { SelectQueryBuilder } from "typeorm";
import { isEmpty } from "lodash";
import { ThreadSearchParams } from "../models/thread-search-params";
import { ThreadSearchResult } from "../models/thread-search-result";
import { nameOf } from "@ebike-backend/utils";

const DEFAULT_PAGE_SIZE = 100;

@Injectable()
export class ThreadSearchService {
  constructor(private readonly threadRepo: ThreadRepository) {}

  public async search(params: ThreadSearchParams): Promise<ThreadSearchResult> {
    const finalParams = {
      ...params,
      sort: params.sort ?? "lastSynced",
      order: params.order ?? "DESC",
    };

    const query = this.buildQuery(finalParams);

    const [items, totalItems] = await query.getManyAndCount();

    return this.mapToSearchResult([items, totalItems], finalParams);
  }

  private buildQuery(params: ThreadSearchParams): SelectQueryBuilder<Thread> {
    let query = this.threadRepo.repo
      .createQueryBuilder("thread")
      .leftJoinAndSelect(
        `thread.${nameOf<Thread>("categories")}`,
        "threadCategory",
      )
      .leftJoinAndSelect(
        `threadCategory.${nameOf<ThreadProductCategory>("productCategory")}`,
        "category",
      );

    // --- Filters ---
    if (!isEmpty(params.externalId)) {
      query = query.andWhere(
        `thread.${nameOf<Thread>("externalId")} = :externalId`,
        {
          externalId: params.externalId,
        },
      );
    }

    if (!isEmpty(params.source)) {
      query = query.andWhere(`thread.${nameOf<Thread>("source")} = :source`, {
        source: params.source,
      });
    }

    if (!isEmpty(params.topic)) {
      query = query.andWhere(`thread.${nameOf<Thread>("topic")} = :topic`, {
        topic: params.topic,
      });
    }

    if (params.filterByUncategorized) {
      query = query.andWhere(
        `threadCategory.${nameOf<ThreadProductCategory>("id")} IS NULL`,
      );
    } else if (!isEmpty(params.categoryIds)) {
      query = query.andWhere(
        `category.${nameOf<ProductCategory>("id")} IN (:...categoryIds)`,
        {
          categoryIds: params.categoryIds,
        },
      );
    }

    if (!isEmpty(params.statuses)) {
      query = query.andWhere(
        `thread.${nameOf<Thread>("status")} IN (:...statuses)`,
        {
          statuses: params.statuses,
        },
      );
    }

    // --- Text search ---
    if (params.searchTerm && !isEmpty(params.searchTerm.trim())) {
      const rawTerm = params.searchTerm.trim().toLowerCase();
      const likeTerm = `%${rawTerm}%`;
      const similarityThreshold = 0.1; // tune if recall/precision needs adjustment

      query = query.andWhere(
        `(
          LOWER(thread.${nameOf<Thread>("title")}) LIKE :likeTerm
          OR similarity(
            LOWER(thread.${nameOf<Thread>("title")}),
            :rawTerm
          ) >= :similarityThreshold
        )`,
        { likeTerm, rawTerm, similarityThreshold },
      );

      query.addSelect(
        `similarity(LOWER(thread.${nameOf<Thread>("title")}), :rawTerm)`,
        "similarity_score",
      );

      query = query.orderBy("similarity_score", "DESC", "NULLS LAST");
    } else {
      // --- Ordering ---
      const sort = params.sort;
      query = query.orderBy(`thread.${sort}`, params.order, "NULLS LAST");
    }

    // --- Pagination ---
    const page: number = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    query = query.skip((page - 1) * pageSize).take(pageSize);

    return query;
  }

  private mapToSearchResult(
    result: [Thread[], number],
    params: ThreadSearchResult,
  ): ThreadSearchResult {
    const [items, totalItems] = result;
    const page = params.page ?? 0;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;

    const totalPages = Math.ceil(totalItems / pageSize);

    const searchResult = new ThreadSearchResult();
    searchResult.page = page;
    searchResult.pageSize = pageSize;
    searchResult.totalItems = totalItems;
    searchResult.totalPages = totalPages;
    searchResult.items = items;
    searchResult.sort = params.sort;
    searchResult.order = params.order;
    searchResult.statuses = params.statuses;
    searchResult.categoryIds = params.categoryIds;

    return searchResult;
  }
}
