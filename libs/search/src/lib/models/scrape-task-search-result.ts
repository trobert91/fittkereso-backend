import {
  ProductSourceType,
  ScrapeQueueName,
  ScrapeTask,
  TaskStatus,
} from "@ebike-backend/database";
import { BasePageResult } from "./base-page-result";

export class ScrapeTaskSearchResult extends BasePageResult<ScrapeTask> {
  statuses?: TaskStatus[];

  queues?: ScrapeQueueName[];

  sourceTypes?: ProductSourceType[];
}
