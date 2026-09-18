import { Injectable } from '@nestjs/common';
import { User, UserRepository } from '@fittkereso-backend/database';
import { SelectQueryBuilder } from 'typeorm';
import { nameOf } from '@fittkereso-backend/utils';
import { isEmpty, isNil } from 'lodash';
import { UserSearchParams } from '../models/user-search-params';
import { UserSearchResult } from '../models/user-search-result';

const DEFAULT_PAGE_SIZE = 50;

@Injectable()
export class UserSearchService {
  constructor(private readonly userRepo: UserRepository) {}

  public async search(params: UserSearchParams): Promise<UserSearchResult> {
    const finalParams = {
      ...params,
      // Alphabetical by default rather than newest-first like the other
      // searches: a user list is read as a directory, not as a feed.
      sort: params.sort ?? 'email',
      order: params.order ?? ('ASC' as const),
    };

    const query = this.buildQuery(finalParams);
    const [items, totalItems] = await query.getManyAndCount();

    return this.mapToSearchResult([items, totalItems], finalParams);
  }

  private buildQuery(params: UserSearchParams): SelectQueryBuilder<User> {
    let query = this.userRepo.repo.createQueryBuilder('user');

    if (!isEmpty(params.searchTerm)) {
      query = query.andWhere(
        `(user.${nameOf<User>('name')} ILIKE :searchTerm OR user.${nameOf<User>(
          'email',
        )} ILIKE :searchTerm)`,
        { searchTerm: `%${params.searchTerm}%` },
      );
    }

    if (!isEmpty(params.roles)) {
      query = query.andWhere(`user.${nameOf<User>('role')} IN (:...roles)`, {
        roles: params.roles,
      });
    }

    if (!isNil(params.passwordChangeRequired)) {
      query = query.andWhere(
        `user.${nameOf<User>('passwordChangeRequired')} = :passwordChangeRequired`,
        { passwordChangeRequired: params.passwordChangeRequired },
      );
    }

    query = query.orderBy(`user.${params.sort}`, params.order, 'NULLS LAST');

    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    query = query.skip((page - 1) * pageSize).take(pageSize);

    return query;
  }

  private mapToSearchResult(
    result: [User[], number],
    params: UserSearchParams,
  ): UserSearchResult {
    const [items, totalItems] = result;
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const totalPages = Math.ceil(totalItems / pageSize);

    const searchResult = new UserSearchResult();
    searchResult.page = page;
    searchResult.pageSize = pageSize;
    searchResult.totalItems = totalItems;
    searchResult.totalPages = totalPages;
    searchResult.items = items;
    searchResult.sort = params.sort;
    searchResult.order = params.order;
    searchResult.searchTerm = params.searchTerm;
    searchResult.roles = params.roles;
    searchResult.passwordChangeRequired = params.passwordChangeRequired;

    return searchResult;
  }
}
