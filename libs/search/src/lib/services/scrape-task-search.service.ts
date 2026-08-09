import { Injectable } from "@nestjs/common";
import {
  ProductModel,
  ProductSource,
  ScrapeTask,
  ScrapeTaskRepository,
} from "@ebike-backend/database";
import { SelectQueryBuilder } from "typeorm";
import { nameOf } from "@ebike-backend/utils";
import { ScrapeTaskSearchParams } from "../models/scrape-task-search-params";
import { ScrapeTaskSearchResult } from "../models/scrape-task-search-result";
import { isEmpty } from "lodash";

const DEFAULT_PAGE_SIZE = 50;

@Injectable()
export class ScrapeTaskSearchService {
  constructor(private readonly scrapeTaskRepo: ScrapeTaskRepository) {}

  public async search(
    params: ScrapeTaskSearchParams,
  ): Promise<ScrapeTaskSearchResult> {
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
    params: ScrapeTaskSearchParams,
  ): SelectQueryBuilder<ScrapeTask> {
    let query = this.scrapeTaskRepo.repo
      .createQueryBuilder("scrapeTask")
      .leftJoinAndSelect(`scrapeTask.${nameOf<ScrapeTask>("source")}`, "source")
      .leftJoinAndSelect(
        `scrapeTask.${nameOf<ScrapeTask>("product")}`,
        "product",
      )
      .leftJoinAndSelect(`product.${nameOf<ProductModel>("brand")}`, "brand");

    if (!isEmpty(params.statuses)) {
      query = query.andWhere(
        `scrapeTask.${nameOf<ScrapeTask>("status")} IN (:...statuses)`,
        { statuses: params.statuses },
      );
    }

    if (!isEmpty(params.queues)) {
      query = query.andWhere(
        `scrapeTask.${nameOf<ScrapeTask>("queue")} IN (:...queues)`,
        { queues: params.queues },
      );
    }

    if (!isEmpty(params.sourceTypes)) {
      query = query.andWhere(
        `source.${nameOf<ProductSource>("type")} IN (:...sourceTypes)`,
        { sourceTypes: params.sourceTypes },
      );
    }

    query = query.orderBy(
      `scrapeTask.${params.sort}`,
      params.order,
      "NULLS LAST",
    );

    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    query = query.skip((page - 1) * pageSize).take(pageSize);

    return query;
  }

  private mapToSearchResult(
    result: [ScrapeTask[], number],
    params: ScrapeTaskSearchParams,
  ): ScrapeTaskSearchResult {
    const [items, totalItems] = result;
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const totalPages = Math.ceil(totalItems / pageSize);

    const searchResult = new ScrapeTaskSearchResult();
    searchResult.page = page;
    searchResult.pageSize = pageSize;
    searchResult.totalItems = totalItems;
    searchResult.totalPages = totalPages;
    searchResult.items = items;
    searchResult.sort = params.sort;
    searchResult.order = params.order;
    searchResult.statuses = params.statuses;
    searchResult.queues = params.queues;
    searchResult.sourceTypes = params.sourceTypes;

    return searchResult;
  }
}
