import { Injectable } from '@nestjs/common';
import { Submission, VoteableContent } from 'snoowrap';
import { RedditClientService } from './reddit-client.service';
import { RedditApiQueueService } from './reddit-api-queue.service';

// Return type is `any` because snoowrap's Submission is a thenable that
// causes TS1062 when referenced as Promise<Submission> in an async function.

@Injectable()
export class RedditThreadService {
  constructor(
    private readonly redditService: RedditClientService,
    private readonly apiQueue: RedditApiQueueService,
  ) {}

  async getThreadMetadata(threadId: string): Promise<any> {
    return this.apiQueue.enqueue(
      () =>
        new Promise<any>((resolve, reject) => {
          (this.redditService.redditClient.getSubmission(threadId) as any)
            .fetch()
            .then(resolve)
            .catch(reject);
        }),
    );
  }

  async getThread(
    threadId: string,
    maxCommentCount: number,
  ): Promise<any> {
    return this.apiQueue.enqueue(
      () =>
        new Promise<any>((resolve, reject) => {
          (this.redditService.redditClient.getSubmission(threadId) as any)
            .fetch()
            .then((fetched: any) => {
              const initialCount = fetched.comments?.length ?? 0;
              const additionalNeeded = maxCommentCount - initialCount;

              if (additionalNeeded <= 0 || !fetched.comments || fetched.comments.isFinished) {
                return fetched;
              }

              return fetched.comments
                .fetchMore({ amount: additionalNeeded })
                .then((expandedComments: any) => {
                  fetched.comments = expandedComments;
                  return fetched;
                });
            })
            .then(resolve)
            .catch(reject);
        }),
    );
  }

  async getFullThread(threadId: string): Promise<any> {
    return this.apiQueue.enqueue(
      () =>
        new Promise<any>((resolve, reject) => {
          (
            this.redditService.redditClient.getSubmission(
              threadId,
            ) as VoteableContent<Submission>
          )
            .expandReplies({ limit: Infinity, depth: Infinity })
            .then(resolve)
            .catch(reject);
        }),
    );
  }
}
