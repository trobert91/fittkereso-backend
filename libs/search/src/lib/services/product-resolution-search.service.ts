import { Injectable } from '@nestjs/common';
import {
  ProductCategory,
  ProductModel,
  ProductResolution,
  ProductResolutionRepository,
} from '@fittkereso-backend/database';
import { nameOf } from '@fittkereso-backend/utils';
import type { SelectQueryBuilder } from 'typeorm';
import { ProductResolutionSearchParams } from '../models/product-resolution-search-params';
import { ProductResolutionSearchResult } from '../models/product-resolution-search-result';

const DEFAULT_PAGE_SIZE = 50;

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
        `resolution.${nameOf<ProductResolution>('productB')}`,
        'productB',
      )
      .leftJoinAndSelect(`productB.${nameOf<ProductModel>('brand')}`, 'brandB')
      .leftJoinAndSelect(
        `productB.${nameOf<ProductModel>('productCategory')}`,
        'categoryB',
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
      );

    if (params.flow) {
      query.andWhere(`resolution.${nameOf<ProductResolution>('flow')} = :flow`, {
        flow: params.flow,
      });
    }

    if (params.decision) {
      query.andWhere(
        `resolution.${nameOf<ProductResolution>('decision')} = :decision`,
        {
          decision: params.decision,
        },
      );
    }

    if (params.categoryId) {
      const categoryIdColumn = nameOf<ProductCategory>('id');
      query.andWhere(
        `(categoryA.${categoryIdColumn} = :categoryId OR categoryB.${categoryIdColumn} = :categoryId OR resolvedProductCategory.${categoryIdColumn} = :categoryId)`,
        { categoryId: params.categoryId },
      );
    }

    if (params.origin) {
      query.andWhere(
        `resolution.${nameOf<ProductResolution>('origin')} = :origin`,
        {
          origin: params.origin,
        },
      );
    }

    query.orderBy(`resolution.${nameOf<ProductResolution>('createdAt')}`, 'DESC');

    return query;
  }
}
