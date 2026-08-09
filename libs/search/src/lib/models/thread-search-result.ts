import { Thread, ThreadStatus } from "@ebike-backend/database";
import { BasePageResult } from "./base-page-result";

export class ThreadSearchResult extends BasePageResult<Thread> {
  categoryIds?: string[];

  statuses?: ThreadStatus[];
}
