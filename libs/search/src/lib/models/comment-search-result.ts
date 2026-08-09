import { CommentStatus, UserComment } from "@ebike-backend/database";
import { BasePageResult } from "./base-page-result";

export class CommentSearchResult extends BasePageResult<UserComment> {
  categoryIds?: string[];

  statuses?: CommentStatus[];
}
