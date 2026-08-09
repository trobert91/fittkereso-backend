import { ThreadPlatform, ThreadSearchKeyword } from "@ebike-backend/database";
import { BasePageResult } from "./base-page-result";

export class ThreadSearchKeywordSearchResult extends BasePageResult<ThreadSearchKeyword> {
  categoryIds?: string[];

  platforms?: ThreadPlatform[];
}
