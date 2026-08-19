import {
  ScrapeQueueName,
  ScrapeTask,
  TaskStatus,
} from '@fittkereso-backend/database';
import { BasePageResult } from './base-page-result';

export class ScrapeTaskSearchResult extends BasePageResult<ScrapeTask> {
  statuses?: TaskStatus[];

  queues?: ScrapeQueueName[];

  sourceIds?: string[];
}
