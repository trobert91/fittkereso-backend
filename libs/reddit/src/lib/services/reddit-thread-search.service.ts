import { Injectable } from "@nestjs/common";
import { Submission } from "snoowrap";
import type Snoowrap from "snoowrap";
import { RedditClientService } from "./reddit-client.service";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { RedditApiQueueService } from "./reddit-api-queue.service";

export interface SearchThreadRequest {
  query: string;
  limit?: number;
  time?: "hour" | "day" | "week" | "month" | "year" | "all";
  sort?: "relevance" | "hot" | "top" | "new" | "comments";
  syntax?: "cloudsearch" | "lucene" | "plain";
  subreddit?: string;
}

@Injectable()
export class RedditThreadSearchService {
  constructor(
    private readonly redditService: RedditClientService,
    private readonly dynamicConfigService: DynamicConfigService,
    private readonly apiQueue: RedditApiQueueService,
  ) {}

  async searchThreads(
    request: SearchThreadRequest,
  ): Promise<Array<Submission>> {
    const limit =
      request.limit ??
      this.dynamicConfigService.general.redditSearchThreadLimit;

    const searchOptions: Snoowrap.SearchOptions = {
      query: request.query,
      limit,
      time: request.time ?? "all",
      sort: request.sort ?? "relevance",
      syntax: request.syntax,
      include_facets: true,
    };

    if (request.subreddit) {
      return this.searchThreadsInSubreddit(request.subreddit, searchOptions);
    }

    return this.apiQueue.enqueue(() =>
      this.redditService.redditClient.search(searchOptions),
    );
  }

  private searchThreadsInSubreddit(
    subreddit: string,
    searchOptions: Snoowrap.SearchOptions,
  ): Promise<Array<Submission>> {
    return this.apiQueue.enqueue(() =>
      this.redditService.redditClient
        .getSubreddit(subreddit)
        .search(searchOptions),
    );
  }
}
