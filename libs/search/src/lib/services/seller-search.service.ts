import { Injectable } from '@nestjs/common';
import { Seller, SellerRepository } from '@fittkereso-backend/database';
import { SelectQueryBuilder } from 'typeorm';
import { nameOf } from '@fittkereso-backend/utils';
import { isEmpty, isNil } from 'lodash';
import { SellerSearchParams } from '../models/seller-search-params';
import { SellerSearchResult } from '../models/seller-search-result';

const DEFAULT_PAGE_SIZE = 50;

@Injectable()
export class SellerSearchService {
  constructor(private readonly sellerRepo: SellerRepository) {}

  public async search(
    params: SellerSearchParams,
  ): Promise<SellerSearchResult> {
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
    params: SellerSearchParams,
  ): SelectQueryBuilder<Seller> {
    let query = this.sellerRepo.repo.createQueryBuilder('seller');

    if (!isEmpty(params.searchTerm)) {
      query = query.andWhere(
        `seller.${nameOf<Seller>('name')} ILIKE :searchTerm`,
        { searchTerm: `%${params.searchTerm}%` },
      );
    }

    if (!isEmpty(params.types)) {
      query = query.andWhere(
        `seller.${nameOf<Seller>('type')} IN (:...types)`,
        { types: params.types },
      );
    }

    if (!isNil(params.verified)) {
      query = query.andWhere(
        `seller.${nameOf<Seller>('verified')} = :verified`,
        { verified: params.verified },
      );
    }

    if (!isNil(params.active)) {
      query = query.andWhere(
        `seller.${nameOf<Seller>('active')} = :active`,
        { active: params.active },
      );
    }

    query = query.orderBy(`seller.${params.sort}`, params.order, 'NULLS LAST');

    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    query = query.skip((page - 1) * pageSize).take(pageSize);

    return query;
  }

  private mapToSearchResult(
    result: [Seller[], number],
    params: SellerSearchParams,
  ): SellerSearchResult {
    const [items, totalItems] = result;
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const totalPages = Math.ceil(totalItems / pageSize);

    const searchResult = new SellerSearchResult();
    searchResult.page = page;
    searchResult.pageSize = pageSize;
    searchResult.totalItems = totalItems;
    searchResult.totalPages = totalPages;
    searchResult.items = items;
    searchResult.sort = params.sort;
    searchResult.order = params.order;
    searchResult.searchTerm = params.searchTerm;
    searchResult.types = params.types;
    searchResult.verified = params.verified;
    searchResult.active = params.active;

    return searchResult;
  }
}
