import { Injectable } from '@nestjs/common';
import {
  Brand,
  ProductCategory,
  ProductModel,
  ProductModelRepository,
} from '@fittkereso-backend/database';
import { ProductSearchParams } from '../models/product-search-params';
import { ProductSearchResult } from '../models/product-search-result';
import { SelectQueryBuilder } from 'typeorm';
import { nameOf } from '@fittkereso-backend/utils';
import { isEmpty } from 'lodash';

const DEFAULT_PAGE_SIZE = 100;

@Injectable()
export class ProductSearchService {
  constructor(private readonly productRepo: ProductModelRepository) {}

  public async searchProducts(
    params: ProductSearchParams,
  ): Promise<ProductSearchResult> {
    const finalParams = {
      ...params,
      sort: params.sort ?? ('createdAt' as const),
      order: params.order ?? ('DESC' as const),
    };

    const query = this.buildQuery(finalParams);

    // Execute query (returns [items, totalCount])
    const [items, totalItems] = await query.getManyAndCount();

    return this.mapToSearchResult([items, totalItems], finalParams);
  }

  private buildQuery(
    params: ProductSearchParams,
  ): SelectQueryBuilder<ProductModel> {
    let query = this.productRepo.repo
      .createQueryBuilder('product')
      .leftJoinAndSelect(`product.${nameOf<ProductModel>('brand')}`, 'brand')
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>('productCategory')}`,
        'category',
      )
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>('mainImage')}`,
        'mainImage',
      );
    if (params.includeImages) {
      query = query.leftJoinAndSelect(
        `product.${nameOf<ProductModel>('images')}`,
        'images',
      );
    }

    // --- Filters ---
    if (!isEmpty(params.categoryIds)) {
      query = query.andWhere(
        `category.${nameOf<ProductCategory>('id')} IN (:...categoryIds)`,
        {
          categoryIds: params.categoryIds,
        },
      );
    }

    if (!isEmpty(params.brandIds)) {
      query = query.andWhere(`brand.${nameOf<Brand>('id')} IN (:...brandIds)`, {
        brandIds: params.brandIds,
      });
    }

    // --- Text search (LIKE + similarity filter + ranking) ---
    if (params.searchTerm && !isEmpty(params.searchTerm.trim())) {
      const rawTerm = params.searchTerm!.trim().toLowerCase();
      const likeTerm = `%${rawTerm}%`;
      const similarityThreshold = 0.1; // tune this (0.1–0.3 typical)

      query = query.andWhere(
        `(
      -- LIKE for recall
      LOWER(product.${nameOf<ProductModel>('displayName')}) LIKE :likeTerm
      OR LOWER(product.${nameOf<ProductModel>('model')}) LIKE :likeTerm
      OR LOWER(product.${nameOf<ProductModel>('normalizedName')}) LIKE :likeTerm

      -- OR trigram similarity filter
      OR similarity(
          LOWER(product.${nameOf<ProductModel>('displayName')}),
          :rawTerm
        ) >= :similarityThreshold
      OR similarity(
          LOWER(product.${nameOf<ProductModel>('model')}),
          :rawTerm
        ) >= :similarityThreshold
      OR similarity(
          LOWER(product.${nameOf<ProductModel>('normalizedName')}),
          :rawTerm
        ) >= :similarityThreshold
    )`,
        { likeTerm, rawTerm, similarityThreshold },
      );

      query.addSelect(
        `
      GREATEST(
        similarity(LOWER(product.${nameOf<ProductModel>('displayName')}), :rawTerm),
        similarity(LOWER(product.${nameOf<ProductModel>('model')}), :rawTerm),
        similarity(LOWER(product.${nameOf<ProductModel>('normalizedName')}), :rawTerm)
      )
      `,
        'similarity_score',
      );

      query = query.orderBy('similarity_score', 'DESC');
    } else {
      // --- Ordering ---
      query = query.orderBy(`product.${params.sort}`, params.order);
    }

    // --- Pagination ---
    const page: number = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    query = query.skip((page - 1) * pageSize).take(pageSize);

    return query;
  }

  private mapToSearchResult(
    result: [ProductModel[], number],
    params: ProductSearchParams,
  ): ProductSearchResult {
    const [items, totalItems] = result;
    const page = params.page ?? 0;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;

    const totalPages = Math.ceil(totalItems / pageSize);

    const searchResult = new ProductSearchResult();
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
