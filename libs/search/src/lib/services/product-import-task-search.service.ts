import { Injectable } from '@nestjs/common';
import {
  ProductModel,
  ProductImportTask,
  ProductImportTaskRepository,
} from '@fittkereso-backend/database';
import { SelectQueryBuilder } from 'typeorm';
import { nameOf } from '@fittkereso-backend/utils';
import { ProductImportTaskSearchParams } from '../models/product-import-task-search-params';
import { ProductImportTaskSearchResult } from '../models/product-import-task-search-result';
import { isEmpty } from 'lodash';

const DEFAULT_PAGE_SIZE = 50;

@Injectable()
export class ProductImportTaskSearchService {
  constructor(private readonly importTaskRepo: ProductImportTaskRepository) {}

  public async search(
    params: ProductImportTaskSearchParams,
  ): Promise<ProductImportTaskSearchResult> {
    const finalParams = {
      ...params,
      sort: params.sort ?? 'createdAt',
      order: params.order ?? ('DESC' as const),
    };

    const query = this.buildQuery(finalParams);
    const [items, totalItems] = await query.getManyAndCount();

    return this.mapToSearchResult([items, totalItems], finalParams);
  }

  private buildQuery(
    params: ProductImportTaskSearchParams,
  ): SelectQueryBuilder<ProductImportTask> {
    let query = this.importTaskRepo.repo
      .createQueryBuilder('importTask')
      .leftJoinAndSelect(`importTask.${nameOf<ProductImportTask>('source')}`, 'source')
      .leftJoinAndSelect(
        `importTask.${nameOf<ProductImportTask>('product')}`,
        'product',
      )
      .leftJoinAndSelect(`product.${nameOf<ProductModel>('brand')}`, 'brand');

    if (!isEmpty(params.statuses)) {
      query = query.andWhere(
        `importTask.${nameOf<ProductImportTask>('status')} IN (:...statuses)`,
        { statuses: params.statuses },
      );
    }

    if (!isEmpty(params.kinds)) {
      query = query.andWhere(
        `importTask.${nameOf<ProductImportTask>('kind')} IN (:...kinds)`,
        { kinds: params.kinds },
      );
    }

    if (!isEmpty(params.sourceIds)) {
      query = query.andWhere('source.id IN (:...sourceIds)', {
        sourceIds: params.sourceIds,
      });
    }

    query = query.orderBy(
      `importTask.${params.sort}`,
      params.order,
      'NULLS LAST',
    );

    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    query = query.skip((page - 1) * pageSize).take(pageSize);

    return query;
  }

  private mapToSearchResult(
    result: [ProductImportTask[], number],
    params: ProductImportTaskSearchParams,
  ): ProductImportTaskSearchResult {
    const [items, totalItems] = result;
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const totalPages = Math.ceil(totalItems / pageSize);

    const searchResult = new ProductImportTaskSearchResult();
    searchResult.page = page;
    searchResult.pageSize = pageSize;
    searchResult.totalItems = totalItems;
    searchResult.totalPages = totalPages;
    searchResult.items = items;
    searchResult.sort = params.sort;
    searchResult.order = params.order;
    searchResult.statuses = params.statuses;
    searchResult.kinds = params.kinds;
    searchResult.sourceIds = params.sourceIds;

    return searchResult;
  }
}
