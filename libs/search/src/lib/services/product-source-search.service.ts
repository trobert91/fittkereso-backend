import { Injectable } from '@nestjs/common';
import {
  ProductSource,
  ProductSourceRepository,
} from '@fittkereso-backend/database';
import { nameOf } from '@fittkereso-backend/utils';
import { isEmpty, isNil } from 'lodash';
import { SelectQueryBuilder } from 'typeorm';
import { ProductSourceSearchParams } from '../models/product-source-search-params';
import { ProductSourceSearchResult } from '../models/product-source-search-result';

const DEFAULT_PAGE_SIZE = 100;

@Injectable()
export class ProductSourceSearchService {
  constructor(private readonly productSourceRepo: ProductSourceRepository) {}

  public async search(
    params: ProductSourceSearchParams,
  ): Promise<ProductSourceSearchResult> {
    const finalParams = {
      ...params,
      sort: params.sort ?? 'createdAt',
      order: params.order ?? 'DESC',
    };

    const query = this.buildQuery(finalParams);
    const [items, totalItems] = await query.getManyAndCount();

    return this.mapToSearchResult([items, totalItems], finalParams);
  }

  private buildQuery(
    params: ProductSourceSearchParams,
  ): SelectQueryBuilder<ProductSource> {
    let query = this.productSourceRepo.repo.createQueryBuilder('productSource');

    if (!isEmpty(params.searchTerm)) {
      query = query.andWhere(
        `productSource.${nameOf<ProductSource>('name')} ILIKE :searchTerm`,
        {
          searchTerm: `%${params.searchTerm}%`,
        },
      );
    }

    if (!isNil(params.schedulingEnabled)) {
      query = query.andWhere(
        `productSource.${nameOf<ProductSource>('schedulingEnabled')} = :schedulingEnabled`,
        { schedulingEnabled: params.schedulingEnabled },
      );
    }

    query = query.orderBy(
      `productSource.${params.sort}`,
      params.order,
      'NULLS LAST',
    );

    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    query = query.skip((page - 1) * pageSize).take(pageSize);

    return query;
  }

  private mapToSearchResult(
    result: [ProductSource[], number],
    params: ProductSourceSearchParams,
  ): ProductSourceSearchResult {
    const [items, totalItems] = result;
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const totalPages = Math.ceil(totalItems / pageSize);

    const searchResult = new ProductSourceSearchResult();
    searchResult.page = page;
    searchResult.pageSize = pageSize;
    searchResult.totalItems = totalItems;
    searchResult.totalPages = totalPages;
    searchResult.items = items;
    searchResult.sort = params.sort;
    searchResult.order = params.order;
    searchResult.searchTerm = params.searchTerm;
    searchResult.schedulingEnabled = params.schedulingEnabled;

    return searchResult;
  }
}
