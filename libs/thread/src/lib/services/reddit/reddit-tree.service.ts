import { Injectable } from "@nestjs/common";
import { CommentTree, Thread } from "@ebike-backend/database";
import { RedditThreadService } from "@ebike-backend/reddit";
import { Submission } from "snoowrap";
import { RedditThreadTreeExtractor } from "./reddit-thead-tree-extractor";
import { extractSubmissionMedia } from "./reddit-image-url-extractor";

@Injectable()
export class RedditTreeService {
  constructor(private readonly threadService: RedditThreadService) {}

  public async getTree(thread: Thread): Promise<CommentTree | undefined> {
    const submission = (await this.threadService.getFullThread(
      thread.externalId,
    )) as Submission;

    // Backfill media if not yet captured (threads created before this feature)
    if (!thread.media?.length) {
      thread.media = extractSubmissionMedia(submission);
    }

    const extractor = new RedditThreadTreeExtractor(submission);
    return extractor.createCommentTree();
  }
}
