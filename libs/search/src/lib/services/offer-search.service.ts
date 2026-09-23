import { Injectable } from '@nestjs/common';
import { Offer, OfferRepository } from '@fittkereso-backend/database';
import { nameOf } from '@fittkereso-backend/utils';
import { isEmpty } from 'lodash';
import { SelectQueryBuilder } from 'typeorm';
import { OfferSearchParams } from '../models/offer-search-params';
import { OfferSearchResult } from '../models/offer-search-result';

const DEFAULT_PAGE_SIZE = 100;

@Injectable()
export class OfferSearchService {
  constructor(private readonly offerRepo: OfferRepository) {}

  public async search(params: OfferSearchParams): Promise<OfferSearchResult> {
    const finalParams = {
      ...params,
      sort: params.sort ?? 'lastSynced',
      order: params.order ?? 'DESC',
    };

    const query = this.buildQuery(finalParams);
    const [items, totalItems] = await query.getManyAndCount();

    return this.mapToSearchResult([items, totalItems], finalParams);
  }

  private buildQuery(params: OfferSearchParams): SelectQueryBuilder<Offer> {
    let query = this.offerRepo.repo
      .createQueryBuilder('offer')
      .leftJoinAndSelect(`offer.${nameOf<Offer>('seller')}`, 'seller')
      .leftJoin(`offer.${nameOf<Offer>('model')}`, 'model');

    if (!isEmpty(params.productId)) {
      query = query.andWhere('model.id = :productId', {
        productId: params.productId,
      });
    }

    query = query.orderBy(`offer.${params.sort}`, params.order, 'NULLS LAST');

    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    query = query.skip((page - 1) * pageSize).take(pageSize);

    return query;
  }

  private mapToSearchResult(
    result: [Offer[], number],
    params: OfferSearchParams,
  ): OfferSearchResult {
    const [items, totalItems] = result;
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const totalPages = Math.ceil(totalItems / pageSize);

    const searchResult = new OfferSearchResult();
    searchResult.page = page;
    searchResult.pageSize = pageSize;
    searchResult.totalItems = totalItems;
    searchResult.totalPages = totalPages;
    searchResult.items = items;
    searchResult.sort = params.sort;
    searchResult.order = params.order;
    searchResult.productId = params.productId;

    return searchResult;
  }
}
