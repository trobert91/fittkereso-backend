import { Injectable } from "@nestjs/common";
import { UserComment } from "@ebike-backend/database";
import { ThreadContext } from "@ebike-backend/thread-processor";

@Injectable()
export class ThreadContextService {
  public createThreadContext(comments: UserComment[]): ThreadContext {
    const opComment = comments?.find((comment) => comment.externalId === "OP");
    const map = new ThreadContext();
    if (!opComment) {
      return map;
    }

    map.addComment(opComment);
    this.processComment(opComment, comments, map);

    return map;
  }

  private processComment(
    comment: UserComment,
    comments: UserComment[],
    map: ThreadContext,
  ) {
    map.addComment(comment);

    const children = comments.filter(
      (c) => c.parent?.externalId === comment.externalId,
    );

    for (const reply of children) {
      this.processComment(reply, comments, map);
    }
  }
}
