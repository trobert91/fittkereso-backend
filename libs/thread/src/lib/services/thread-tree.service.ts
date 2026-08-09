import { Injectable } from "@nestjs/common";
import {
  CommentTree,
  Thread,
  ThreadRepository,
  ThreadPlatform,
} from "@ebike-backend/database";
import { nameOf } from "@ebike-backend/utils";
import { differenceInDays } from "date-fns";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { RedditTreeService } from "./reddit/reddit-tree.service";

@Injectable()
export class ThreadTreeService {
  constructor(
    private readonly threadRepository: ThreadRepository,
    private readonly redditTreeService: RedditTreeService,
    private readonly dynamicConfigService: DynamicConfigService,
  ) {}

  public async getOrCreateTree(
    thread: Thread,
  ): Promise<CommentTree | undefined> {
    const threadWithTree = await this.threadRepository.repo
      .createQueryBuilder("thread")
      .addSelect(`thread.${nameOf<Thread>("commentTree")}`)
      .where(`thread.${nameOf<Thread>("id")} = :id`, { id: thread.id })
      .getOne();
    if (!threadWithTree) {
      return undefined;
    }

    if (this.isCachedTreeValid(threadWithTree)) {
      return CommentTree.fromObject(threadWithTree.commentTree);
    }

    const tree = await this.getTree(threadWithTree);

    thread.commentTree = tree;
    thread.media = threadWithTree.media;
    await this.threadRepository.save(thread);

    return tree;
  }

  private getTree(thread: Thread): Promise<CommentTree | undefined> {
    switch (thread.source) {
      case ThreadPlatform.Reddit:
        return this.redditTreeService.getTree(thread);
      default:
        throw new Error(
          `Cannot get tree, unsupported thread source: ${thread.source}`,
        );
    }
  }

  private isCachedTreeValid(thread: Thread): boolean {
    return (
      (thread.commentTree &&
        thread.lastSynced &&
        differenceInDays(new Date(), thread.lastSynced) <
          this.dynamicConfigService.general.redditThreadExpiryInDays) ??
      false
    );
  }
}
