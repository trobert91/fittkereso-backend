import { Injectable } from '@nestjs/common';
import {
  ProductCategory,
  ProductCategoryRepository,
} from '@fittkereso-backend/database';
import { SelectQueryBuilder } from 'typeorm';
import { isEmpty } from 'lodash';
import { CategorySearchParams } from '../models/category-search-params';
import { CategorySearchResult } from '../models/category-search-result';
import { nameOf } from '@fittkereso-backend/utils';

const DEFAULT_PAGE_SIZE = 100;

@Injectable()
export class ProductCategorySearchService {
  constructor(private readonly repo: ProductCategoryRepository) {}

  public async search(
    params: CategorySearchParams,
  ): Promise<CategorySearchResult> {
    const finalParams = {
      ...params,
      sort: params.sort ?? 'name',
      order: params.order ?? 'ASC',
    };

    const query = this.buildQuery(finalParams);

    // Execute query (returns [items, totalCount])
    const [items, totalItems] = await query.getManyAndCount();

    return this.mapToSearchResult([items, totalItems], finalParams);
  }

  private buildQuery(
    params: CategorySearchParams,
  ): SelectQueryBuilder<ProductCategory> {
    let query = this.repo.repo.createQueryBuilder('category');

    // --- Text search ---
    if (params.searchTerm && !isEmpty(params.searchTerm?.trim())) {
      const term = params.searchTerm.trim().toLowerCase();

      // Trigram similarity search — uses pg_trgm GIN indexes
      query = query.andWhere(
        `(
        LOWER(category.${nameOf<ProductCategory>('name')}) % :term
        )`,
        { term },
      );

      // Optional: prioritize better matches
      query.addSelect(
        `
        greatest(
        similarity(LOWER(category."name"), :term)
        )`,
        'similarity_score',
      );
      query = query.orderBy('similarity_score', 'DESC');
    }

    // --- Boolean filters ---
    if (params.autoDeduplicationEnabled !== undefined) {
      query = query.andWhere(
        `category.${nameOf<ProductCategory>('autoDeduplicationEnabled')} = :autoDedup`,
        { autoDedup: params.autoDeduplicationEnabled },
      );
    }

    if (params.enabled !== undefined) {
      query = query.andWhere(
        `category.${nameOf<ProductCategory>('enabled')} = :enabled`,
        { enabled: params.enabled },
      );
    }

    if (params.searchEnabled !== undefined) {
      query = query.andWhere(
        `category.${nameOf<ProductCategory>('searchEnabled')} = :searchEnabled`,
        { searchEnabled: params.searchEnabled },
      );
    }

    // --- Ordering ---
    const sort = params.sort;
    query = query.orderBy(`category.${sort}`, params.order);

    // --- Pagination ---
    const page: number = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    query = query.skip((page - 1) * pageSize).take(pageSize);

    return query;
  }

  private mapToSearchResult(
    result: [ProductCategory[], number],
    params: CategorySearchParams,
  ): CategorySearchResult {
    const [items, totalItems] = result;
    const page = params.page ?? 0;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;

    const totalPages = Math.ceil(totalItems / pageSize);

    const searchResult = new CategorySearchResult();
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
