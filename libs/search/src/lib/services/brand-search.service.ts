import { Injectable } from "@nestjs/common";
import { Brand, BrandRepository } from "@ebike-backend/database";
import { SelectQueryBuilder } from "typeorm";
import { isEmpty } from "lodash";
import { nameOf } from "@ebike-backend/utils";
import { BrandSearchParams } from "../models/brand-search-params";
import { BrandSearchResult } from "../models/brand-search-result";

const DEFAULT_PAGE_SIZE = 100;

@Injectable()
export class BrandSearchService {
  constructor(private readonly repo: BrandRepository) {}

  public async search(params: BrandSearchParams): Promise<BrandSearchResult> {
    const finalParams = {
      ...params,
      sort: params.sort ?? "name",
      order: params.order ?? "ASC",
    };

    const query = this.buildQuery(finalParams);

    // Execute query (returns [items, totalCount])
    const [items, totalItems] = await query.getManyAndCount();

    return this.mapToSearchResult([items, totalItems], finalParams);
  }

  private buildQuery(params: BrandSearchParams): SelectQueryBuilder<Brand> {
    let query = this.repo.repo.createQueryBuilder("brand");

    // --- Text search ---
    if (params.searchTerm && !isEmpty(params.searchTerm?.trim())) {
      const term = params.searchTerm.trim().toLowerCase();

      query = query.andWhere(
        `LOWER(brand.${nameOf<Brand>("name")}) LIKE :term`,
        { term: `%${term}%` },
      );
    }

    // --- Ordering ---
    const sort = params.sort;
    query = query.orderBy(`brand.${sort}`, params.order);

    // --- Pagination ---
    const page: number = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    query = query.skip((page - 1) * pageSize).take(pageSize);

    return query;
  }

  private mapToSearchResult(
    result: [Brand[], number],
    params: BrandSearchParams,
  ): BrandSearchResult {
    const [items, totalItems] = result;
    const page = params.page ?? 0;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;

    const totalPages = Math.ceil(totalItems / pageSize);

    const searchResult = new BrandSearchResult();
    searchResult.page = page;
    searchResult.pageSize = pageSize;
    searchResult.totalItems = totalItems;
    searchResult.totalPages = totalPages;
    searchResult.items = items;
    searchResult.sort = params.sort;
    searchResult.order = params.order;

    return searchResult;
  }
}
