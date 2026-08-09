import { Injectable } from "@nestjs/common";
import { Thread } from "@ebike-backend/database";
import { ThreadIterator } from "../thread-iterator";

@Injectable()
export class RedditThreadSerializerService {
  public async getComments(thread: Thread): Promise<string[]> {
    if (!thread.commentTree) {
      return [];
    }

    const comments: string[] = [];
    const iterator = new ThreadIterator(false);

    await iterator.iterate({
      tree: thread.commentTree,
      visitor: async (nodeIndex, node) => {
        comments.push(node.body);
        return undefined;
      },
      stopIfNotApproved: false,
    });

    return comments;
  }
}
