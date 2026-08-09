import { Injectable } from "@nestjs/common";
import {
  ProductCategory,
  ProductDuplicate,
  ProductDuplicateRepository,
  ProductModel,
} from "@ebike-backend/database";
import { nameOf } from "@ebike-backend/utils";
import type { SelectQueryBuilder } from "typeorm";
import { ProductDuplicateSearchParams } from "../models/product-duplicate-search-params";
import { ProductDuplicateSearchResult } from "../models/product-duplicate-search-result";

const DEFAULT_PAGE_SIZE = 50;

@Injectable()
export class ProductDuplicateSearchService {
  constructor(private readonly duplicateRepo: ProductDuplicateRepository) {}

  public async search(
    params: ProductDuplicateSearchParams,
  ): Promise<ProductDuplicateSearchResult> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * pageSize;

    const query = this.buildQuery(params);
    query.skip(offset).take(pageSize);

    const [items, totalItems] = await query.getManyAndCount();

    const result = new ProductDuplicateSearchResult();
    result.items = items;
    result.page = page;
    result.pageSize = pageSize;
    result.totalItems = totalItems;
    result.totalPages = Math.ceil(totalItems / pageSize);

    return result;
  }

  private buildQuery(
    params: ProductDuplicateSearchParams,
  ): SelectQueryBuilder<ProductDuplicate> {
    const query = this.duplicateRepo.repo
      .createQueryBuilder("duplicate")
      .leftJoinAndSelect(
        `duplicate.${nameOf<ProductDuplicate>("productA")}`,
        "productA",
      )
      .leftJoinAndSelect(`productA.${nameOf<ProductModel>("brand")}`, "brandA")
      .leftJoinAndSelect(
        `productA.${nameOf<ProductModel>("productCategory")}`,
        "categoryA",
      )
      .leftJoinAndSelect(
        `duplicate.${nameOf<ProductDuplicate>("productB")}`,
        "productB",
      )
      .leftJoinAndSelect(`productB.${nameOf<ProductModel>("brand")}`, "brandB")
      .leftJoinAndSelect(
        `productB.${nameOf<ProductModel>("productCategory")}`,
        "categoryB",
      );

    if (params.decision) {
      query.andWhere(
        `duplicate.${nameOf<ProductDuplicate>("decision")} = :decision`,
        {
          decision: params.decision,
        },
      );
    }

    if (params.categoryId) {
      const categoryIdColumn = nameOf<ProductCategory>("id");
      query.andWhere(
        `(categoryA.${categoryIdColumn} = :categoryId OR categoryB.${categoryIdColumn} = :categoryId)`,
        { categoryId: params.categoryId },
      );
    }

    query.orderBy(`duplicate.${nameOf<ProductDuplicate>("createdAt")}`, "DESC");

    return query;
  }
}
