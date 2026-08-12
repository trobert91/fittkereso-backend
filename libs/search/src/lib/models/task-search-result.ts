import { QueueName, Task, TaskStatus } from '@fittkereso-backend/database';
import { BasePageResult } from './base-page-result';

export class TaskSearchResult extends BasePageResult<Task> {
  statuses?: TaskStatus[];

  queues?: QueueName[];
}
