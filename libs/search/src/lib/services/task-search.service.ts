import { Injectable } from '@nestjs/common';
import {
  QueueName,
  Task,
  TaskRepository,
  TaskStatus,
} from '@fittkereso-backend/database';
import { SelectQueryBuilder } from 'typeorm';
import { nameOf } from '@fittkereso-backend/utils';
import { TaskSearchParams } from '../models/task-search-params';
import { TaskSearchResult } from '../models/task-search-result';
import { isEmpty } from 'lodash';

const DEFAULT_PAGE_SIZE = 100;

@Injectable()
export class TaskSearchService {
  constructor(private readonly taskRepo: TaskRepository) {}

  public async search(params: TaskSearchParams): Promise<TaskSearchResult> {
    const finalParams = {
      ...params,
      sort: params.sort ?? 'createdAt',
      order: params.order ?? 'DESC',
    };

    const query = this.buildQuery(finalParams);

    const [items, totalItems] = await query.getManyAndCount();

    return this.mapToSearchResult([items, totalItems], finalParams);
  }

  private buildQuery(params: TaskSearchParams): SelectQueryBuilder<Task> {
    let query = this.taskRepo.repo.createQueryBuilder('task');

    if (!isEmpty(params.statuses)) {
      query = query.andWhere(
        `task.${nameOf<Task>('status')} IN (:...statuses)`,
        { statuses: params.statuses },
      );
    }

    if (!isEmpty(params.queues)) {
      query = query.andWhere(`task.${nameOf<Task>('queue')} IN (:...queues)`, {
        queues: params.queues,
      });
    }

    query = query.orderBy(`task.${params.sort}`, params.order, 'NULLS LAST');

    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    query = query.skip((page - 1) * pageSize).take(pageSize);

    return query;
  }

  private mapToSearchResult(
    result: [Task[], number],
    params: TaskSearchParams,
  ): TaskSearchResult {
    const [items, totalItems] = result;
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;

    const totalPages = Math.ceil(totalItems / pageSize);

    const searchResult = new TaskSearchResult();
    searchResult.page = page;
    searchResult.pageSize = pageSize;
    searchResult.totalItems = totalItems;
    searchResult.totalPages = totalPages;
    searchResult.items = items;
    searchResult.sort = params.sort;
    searchResult.order = params.order;
    searchResult.statuses = params.statuses;
    searchResult.queues = params.queues;

    return searchResult;
  }
}
