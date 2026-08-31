import { Injectable } from '@nestjs/common';
import {
  OPEN_RESOLUTION_STATUSES,
  ProductCategory,
  ProductModel,
  ProductResolution,
  ProductResolutionRepository,
  ProductResolutionStatus,
  ProductSourceRecord,
} from '@fittkereso-backend/database';
import { nameOf } from '@fittkereso-backend/utils';
import { compact, isEmpty, uniq } from 'lodash';
import type { SelectQueryBuilder } from 'typeorm';
import { ProductResolutionSearchParams } from '../models/product-resolution-search-params';
import { ProductResolutionSearchResult } from '../models/product-resolution-search-result';

const DEFAULT_PAGE_SIZE = 50;

/** Alias for the computed review-order rank. Must contain no dot — see
 *  `applyOrder`. */
const RELEVANCE_RANK_ALIAS = 'resolution_review_rank';

@Injectable()
export class ProductResolutionSearchService {
  constructor(private readonly resolutionRepo: ProductResolutionRepository) {}

  public async search(
    params: ProductResolutionSearchParams,
  ): Promise<ProductResolutionSearchResult> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * pageSize;

    const query = this.buildQuery(params);
    query.skip(offset).take(pageSize);

    const [items, totalItems] = await query.getManyAndCount();

    const result = new ProductResolutionSearchResult();
    result.items = items;
    result.page = page;
    result.pageSize = pageSize;
    result.totalItems = totalItems;
    result.totalPages = Math.ceil(totalItems / pageSize);

    return result;
  }

  /** Every product a page of results refers to, so callers can resolve image
   *  URLs in one pass without re-walking the relation graph. */
  public collectProducts(items: ProductResolution[]): ProductModel[] {
    const products = items.flatMap((item) =>
      compact([
        item.productA,
        item.productB,
        item.resolvedProduct,
        item.sourceRecord?.model,
      ]),
    );
    return uniq(products);
  }

  private buildQuery(
    params: ProductResolutionSearchParams,
  ): SelectQueryBuilder<ProductResolution> {
    const query = this.resolutionRepo.repo
      .createQueryBuilder('resolution')
      .leftJoinAndSelect(
        `resolution.${nameOf<ProductResolution>('productA')}`,
        'productA',
      )
      .leftJoinAndSelect(`productA.${nameOf<ProductModel>('brand')}`, 'brandA')
      .leftJoinAndSelect(
        `productA.${nameOf<ProductModel>('productCategory')}`,
        'categoryA',
      )
      .leftJoinAndSelect(
        `productA.${nameOf<ProductModel>('mainImage')}`,
        'mainImageA',
      )
      .leftJoinAndSelect(
        `resolution.${nameOf<ProductResolution>('productB')}`,
        'productB',
      )
      .leftJoinAndSelect(`productB.${nameOf<ProductModel>('brand')}`, 'brandB')
      .leftJoinAndSelect(
        `productB.${nameOf<ProductModel>('productCategory')}`,
        'categoryB',
      )
      .leftJoinAndSelect(
        `productB.${nameOf<ProductModel>('mainImage')}`,
        'mainImageB',
      )
      .leftJoinAndSelect(
        `resolution.${nameOf<ProductResolution>('resolvedProduct')}`,
        'resolvedProduct',
      )
      .leftJoinAndSelect(
        `resolvedProduct.${nameOf<ProductModel>('brand')}`,
        'resolvedProductBrand',
      )
      .leftJoinAndSelect(
        `resolvedProduct.${nameOf<ProductModel>('productCategory')}`,
        'resolvedProductCategory',
      )
      .leftJoinAndSelect(
        `resolvedProduct.${nameOf<ProductModel>('mainImage')}`,
        'resolvedProductMainImage',
      )
      // The reviewed listing, plus the product it currently sits on — which is
      // what the reviewer needs to see, since an unrelated merge may have moved
      // it since the decision was recorded.
      .leftJoinAndSelect(
        `resolution.${nameOf<ProductResolution>('sourceRecord')}`,
        'sourceRecord',
      )
      .leftJoinAndSelect(
        `sourceRecord.${nameOf<ProductSourceRecord>('source')}`,
        'listingSource',
      )
      .leftJoinAndSelect(
        `sourceRecord.${nameOf<ProductSourceRecord>('model')}`,
        'listingProduct',
      )
      .leftJoinAndSelect(
        `listingProduct.${nameOf<ProductModel>('brand')}`,
        'listingProductBrand',
      )
      .leftJoinAndSelect(
        `listingProduct.${nameOf<ProductModel>('productCategory')}`,
        'listingProductCategory',
      )
      .leftJoinAndSelect(
        `listingProduct.${nameOf<ProductModel>('mainImage')}`,
        'listingProductMainImage',
      );

    this.applyFilters(query, params);
    this.applyOrder(query, params);

    return query;
  }

  private applyFilters(
    query: SelectQueryBuilder<ProductResolution>,
    params: ProductResolutionSearchParams,
  ): void {
    if (params.flow) {
      query.andWhere(`resolution.${nameOf<ProductResolution>('flow')} = :flow`, {
        flow: params.flow,
      });
    }

    // Default to the open statuses: the queue is a to-do list, and decided or
    // superseded rows are history the reviewer has to ask for explicitly.
    const statuses = uniq(
      compact([params.status, ...(params.statuses ?? [])]),
    );
    query.andWhere(
      `resolution.${nameOf<ProductResolution>('status')} IN (:...statuses)`,
      { statuses: isEmpty(statuses) ? OPEN_RESOLUTION_STATUSES : statuses },
    );

    if (params.accepted !== undefined) {
      query.andWhere(
        `resolution.${nameOf<ProductResolution>('accepted')} = :accepted`,
        { accepted: params.accepted },
      );
    }

    if (params.categoryId) {
      const categoryIdColumn = nameOf<ProductCategory>('id');
      query.andWhere(
        `(categoryA.${categoryIdColumn} = :categoryId OR categoryB.${categoryIdColumn} = :categoryId OR resolvedProductCategory.${categoryIdColumn} = :categoryId OR listingProductCategory.${categoryIdColumn} = :categoryId)`,
        { categoryId: params.categoryId },
      );
    }

    if (params.sourceId) {
      query.andWhere('listingSource.id = :sourceId', {
        sourceId: params.sourceId,
      });
    }

    if (params.productId) {
      query.andWhere(
        '(productA.id = :productId OR productB.id = :productId OR resolvedProduct.id = :productId OR listingProduct.id = :productId)',
        { productId: params.productId },
      );
    }

    if (params.origin) {
      query.andWhere(
        `resolution.${nameOf<ProductResolution>('origin')} = :origin`,
        { origin: params.origin },
      );
    }

    if (params.minSimilarityScore !== undefined) {
      query.andWhere(
        `resolution.${nameOf<ProductResolution>('similarityScore')} >= :minSimilarityScore`,
        { minSimilarityScore: params.minSimilarityScore },
      );
    }

    if (params.minConfidence !== undefined) {
      query.andWhere(
        `resolution.${nameOf<ProductResolution>('decisionConfidence')} >= :minConfidence`,
        { minConfidence: params.minConfidence },
      );
    }

    if (params.query) {
      const displayName = nameOf<ProductModel>('displayName');
      query.andWhere(
        `(productA.${displayName} ILIKE :query OR productB.${displayName} ILIKE :query OR resolvedProduct.${displayName} ILIKE :query OR listingProduct.${displayName} ILIKE :query OR resolution.${nameOf<ProductResolution>('anchorKey')} ILIKE :query)`,
        { query: `%${params.query}%` },
      );
    }
  }

  private applyOrder(
    query: SelectQueryBuilder<ProductResolution>,
    params: ProductResolutionSearchParams,
  ): void {
    const status = nameOf<ProductResolution>('status');
    const similarityScore = nameOf<ProductResolution>('similarityScore');
    const createdAt = nameOf<ProductResolution>('createdAt');

    if (!params.sortBy || params.sortBy === 'relevance') {
      // Review order: things still awaiting a decision first, then the closest
      // calls — where a wrong automated decision is most likely to be hiding.
      //
      // The rank is projected as an aliased column rather than written inline
      // into ORDER BY. With skip/take, TypeORM rewrites this into a DISTINCT
      // subquery and parses every order-by term containing a dot as
      // `alias.property` — so an inline `(resolution.status = 'pending')` is
      // read as the alias `(resolution` and throws. A dot-free alias is instead
      // matched against the select list and resolved against the subquery.
      query
        .addSelect(
          `CASE WHEN resolution.${status} = :relevancePendingStatus THEN 0 ELSE 1 END`,
          RELEVANCE_RANK_ALIAS,
        )
        .setParameter('relevancePendingStatus', ProductResolutionStatus.pending)
        .orderBy(RELEVANCE_RANK_ALIAS, 'ASC')
        .addOrderBy(`resolution.${similarityScore}`, 'DESC')
        .addOrderBy(`resolution.${createdAt}`, 'DESC');
      return;
    }

    query.orderBy(
      `resolution.${params.sortBy}`,
      params.sortDir ?? 'DESC',
      'NULLS LAST',
    );
    query.addOrderBy(`resolution.${createdAt}`, 'DESC');
  }
}
