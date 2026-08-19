import { Injectable } from '@nestjs/common';
import {
  Brand,
  Offer,
  ProductCategory,
  ProductModel,
  ProductModelRepository,
} from '@fittkereso-backend/database';
import { CategoryConfigService } from '@fittkereso-backend/config';
import { ProductSearchParams } from '../models/product-search-params';
import { ProductSearchResult } from '../models/product-search-result';
import { SelectQueryBuilder } from 'typeorm';
import { nameOf } from '@fittkereso-backend/utils';
import { isEmpty, isArray } from 'lodash';

const DEFAULT_PAGE_SIZE = 100;

@Injectable()
export class ProductSearchService {
  constructor(
    private readonly productRepo: ProductModelRepository,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

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

    if (!isEmpty(params.specFilters)) {
      query = this.applySpecFilters(query, params.specFilters!);
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

  // A spec key is offer-level if ANY known category flags it as such —
  // search can span multiple categories, so there's no single category
  // config to check against at query-build time. Cheap: category configs
  // are filesystem-cached, not a DB round-trip.
  private isOfferLevelSpecKey(key: string): boolean {
    return this.categoryConfigService
      .getAllSlugs()
      .some((slug) =>
        (
          this.categoryConfigService.getConfig(slug)?.offerLevelSpecs ?? []
        ).includes(key),
      );
  }

  // Offer-level keys (e.g. frameSize, color) live on Offer.specs, not
  // ProductModel.specs — a product matches if ANY of its active offers
  // carries the filtered value. Uses leftJoin, not innerJoin: a product
  // whose offers happen to have no value for a given key must still be
  // findable by searches that don't filter on that key, and must simply
  // not match a search that does — never treated as an error either way.
  private applySpecFilters(
    query: SelectQueryBuilder<ProductModel>,
    specFilters: Record<string, string | number | [number, number]>,
  ): SelectQueryBuilder<ProductModel> {
    let offerJoined = false;

    Object.entries(specFilters).forEach(([key, value], idx) => {
      const isOfferLevel = this.isOfferLevelSpecKey(key);
      const column = isOfferLevel
        ? `offer.${nameOf<Offer>('specs')}`
        : `product.${nameOf<ProductModel>('specs')}`;

      if (isOfferLevel && !offerJoined) {
        // Plain leftJoin (no ON-clause restriction to active offers): an
        // inactive offer's spec values still shouldn't satisfy the filter,
        // but that's enforced per-condition below via offer.active, not by
        // narrowing the join — narrowing the join here would also drop
        // products whose only offers are inactive from the base result set
        // entirely, which isn't what an unrelated filter should do.
        query = query.leftJoin(
          `product.${nameOf<ProductModel>('offers')}`,
          'offer',
        );
        offerJoined = true;
      }

      const activeGuard = isOfferLevel
        ? `offer.${nameOf<Offer>('active')} = true AND `
        : '';
      const valueParam = `specFilterValue${idx}`;
      if (isArray(value)) {
        const [min, max] = value;
        query = query.andWhere(
          `${activeGuard}(${column}->>'${key}')::numeric BETWEEN :${valueParam}Min AND :${valueParam}Max`,
          { [`${valueParam}Min`]: min, [`${valueParam}Max`]: max },
        );
      } else {
        query = query.andWhere(
          `${activeGuard}${column}->>'${key}' = :${valueParam}`,
          { [valueParam]: String(value) },
        );
      }
    });

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
