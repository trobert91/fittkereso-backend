import { Injectable } from '@nestjs/common';
import {
  Brand,
  ProductCategory,
  ProductDuplicatePair,
  ProductDuplicatePairRepository,
  ProductModel,
  ProductSourceRecord,
} from '@fittkereso-backend/database';
import { nameOf } from '@fittkereso-backend/utils';
import { isEmpty } from 'lodash';
import { SelectQueryBuilder } from 'typeorm';
import { ProductDuplicatePairSearchParams } from '../models/product-duplicate-pair-search-params';
import { ProductDuplicatePairSearchResult } from '../models/product-duplicate-pair-search-result';

const DEFAULT_PAGE_SIZE = 50;

/**
 * The Duplicates page's query. Both products come back with the brand,
 * category, main image and source listings the page shows, and every filter
 * matches either side of the pair — a pair belongs to both its products.
 */
@Injectable()
export class ProductDuplicatePairSearchService {
  constructor(private readonly pairRepo: ProductDuplicatePairRepository) {}

  public async search(
    params: ProductDuplicatePairSearchParams,
  ): Promise<ProductDuplicatePairSearchResult> {
    const finalParams = {
      ...params,
      // Worst offenders first: the highest-scoring pairs are the likeliest duplicates.
      sort: params.sort ?? ('similarityScore' as const),
      order: params.order ?? ('DESC' as const),
    };

    const query = this.buildQuery(finalParams);
    const [items, totalItems] = await query.getManyAndCount();

    return this.mapToSearchResult([items, totalItems], finalParams);
  }

  private buildQuery(
    params: ProductDuplicatePairSearchParams,
  ): SelectQueryBuilder<ProductDuplicatePair> {
    let query = this.pairRepo.repo.createQueryBuilder('pair');

    for (const side of ['productA', 'productB'] as const) {
      query = query
        .leftJoinAndSelect(`pair.${side}`, side)
        .leftJoinAndSelect(
          `${side}.${nameOf<ProductModel>('brand')}`,
          `${side}Brand`,
        )
        .leftJoinAndSelect(
          `${side}.${nameOf<ProductModel>('productCategory')}`,
          `${side}Category`,
        )
        .leftJoinAndSelect(
          `${side}.${nameOf<ProductModel>('mainImage')}`,
          `${side}Image`,
        )
        // Which shops each side is sold in, and for how much — the reviewer's
        // first question about a pair. `skip`/`take` still paginate correctly
        // with these one-to-many joins: TypeORM selects the page's ids in its
        // own query before joining.
        .leftJoinAndSelect(
          `${side}.${nameOf<ProductModel>('sources')}`,
          `${side}Sources`,
        )
        .leftJoinAndSelect(
          `${side}Sources.${nameOf<ProductSourceRecord>('source')}`,
          `${side}Source`,
        )
        .leftJoinAndSelect(
          `${side}Sources.${nameOf<ProductSourceRecord>('offers')}`,
          `${side}SourceOffers`,
        );
    }

    const dismissedAt = `pair.${nameOf<ProductDuplicatePair>('dismissedAt')}`;
    if (params.status === 'open') {
      query = query.andWhere(`${dismissedAt} IS NULL`);
    }
    if (params.status === 'dismissed') {
      query = query.andWhere(`${dismissedAt} IS NOT NULL`);
    }

    if (!isEmpty(params.categoryIds)) {
      query = query.andWhere(
        `(productACategory.${nameOf<ProductCategory>('id')} IN (:...categoryIds)
          OR productBCategory.${nameOf<ProductCategory>('id')} IN (:...categoryIds))`,
        { categoryIds: params.categoryIds },
      );
    }

    if (!isEmpty(params.brandIds)) {
      query = query.andWhere(
        `(productABrand.${nameOf<Brand>('id')} IN (:...brandIds)
          OR productBBrand.${nameOf<Brand>('id')} IN (:...brandIds))`,
        { brandIds: params.brandIds },
      );
    }

    if (params.productId) {
      query = query.andWhere(
        `(pair.${nameOf<ProductDuplicatePair>('productAId')} = :productId
          OR pair.${nameOf<ProductDuplicatePair>('productBId')} = :productId)`,
        { productId: params.productId },
      );
    }

    if (params.minScore !== undefined) {
      query = query.andWhere(
        `pair.${nameOf<ProductDuplicatePair>('similarityScore')} >= :minScore`,
        { minScore: params.minScore },
      );
    }

    if (params.maxScore !== undefined) {
      query = query.andWhere(
        `pair.${nameOf<ProductDuplicatePair>('similarityScore')} <= :maxScore`,
        { maxScore: params.maxScore },
      );
    }

    if (!isEmpty(params.detectedBy)) {
      query = query.andWhere(
        `pair.${nameOf<ProductDuplicatePair>('detectedBy')} IN (:...detectedBy)`,
        { detectedBy: params.detectedBy },
      );
    }

    query = query
      .orderBy(`pair.${params.sort}`, params.order)
      // Stable order for pairs sharing a score.
      .addOrderBy(`pair.${nameOf<ProductDuplicatePair>('createdAt')}`, 'DESC');

    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    query = query.skip((page - 1) * pageSize).take(pageSize);

    return query;
  }

  private mapToSearchResult(
    result: [ProductDuplicatePair[], number],
    params: ProductDuplicatePairSearchParams,
  ): ProductDuplicatePairSearchResult {
    const [items, totalItems] = result;
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;

    const searchResult = new ProductDuplicatePairSearchResult();
    searchResult.page = page;
    searchResult.pageSize = pageSize;
    searchResult.totalItems = totalItems;
    searchResult.totalPages = Math.ceil(totalItems / pageSize);
    searchResult.items = items;
    searchResult.sort = params.sort;
    searchResult.order = params.order;
    searchResult.status = params.status;
    searchResult.categoryIds = params.categoryIds;
    searchResult.minScore = params.minScore;
    searchResult.maxScore = params.maxScore;

    return searchResult;
  }
}
