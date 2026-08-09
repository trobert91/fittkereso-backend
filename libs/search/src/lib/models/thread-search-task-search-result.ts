import {
  TaskStatus,
  ThreadPlatform,
  ThreadSearchTask,
} from "@ebike-backend/database";
import { BasePageResult } from "./base-page-result";

export class ThreadSearchTaskSearchResult extends BasePageResult<ThreadSearchTask> {
  statuses?: TaskStatus[];

  platforms?: ThreadPlatform[];

  categorySlugs?: string[];
}
