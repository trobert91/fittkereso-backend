import { ThreadRun, ThreadRunStatus } from "@ebike-backend/database";
import { BasePageResult } from "./base-page-result";

export class ThreadRunSearchResult extends BasePageResult<ThreadRun> {
  statuses?: ThreadRunStatus[];
  threadId?: string;
  startedAtFrom?: string;
  startedAtTo?: string;
}
