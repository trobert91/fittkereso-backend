import { Injectable } from "@nestjs/common";
import { RedditThreadSearchService } from "@ebike-backend/reddit";
import { ThreadPlatform } from "@ebike-backend/database";
import type {
  PlatformSearchHandler,
  PlatformSearchParams,
  PlatformSearchResult,
} from "@ebike-backend/database";
import { ThreadSearchMetricsService } from "@ebike-backend/metrics";
import { CustomLogger } from "@ebike-backend/logger";

@Injectable()
export class RedditSearchHandler implements PlatformSearchHandler {
  readonly platform = ThreadPlatform.Reddit;

  private readonly logger = new CustomLogger(RedditSearchHandler.name);

  constructor(
    private readonly redditThreadSearchService: RedditThreadSearchService,
    private readonly metricsService: ThreadSearchMetricsService,
  ) {}

  async search(
    keyword: string,
    scope: string | null,
    params: PlatformSearchParams,
  ): Promise<PlatformSearchResult[]> {
    this.logger.debug("Reddit search starting", {
      keyword,
      scope,
      sort: params.sort,
      time: params.time,
      limit: params.limit,
    });

    const startTime = Date.now();

    const submissions = await this.redditThreadSearchService.searchThreads({
      query: keyword,
      subreddit: scope ?? undefined,
      sort: params.sort as "relevance" | "hot" | "top" | "new" | "comments",
      time: params.time as "hour" | "day" | "week" | "month" | "year" | "all",
      limit: params.limit,
    });

    const durationMs = Date.now() - startTime;
    this.metricsService.recordPlatformApiDuration(
      ThreadPlatform.Reddit,
      durationMs / 1000,
    );

    this.logger.debug("Reddit search completed", {
      keyword,
      scope,
      resultCount: submissions.length,
      durationMs,
    });

    return submissions.map((submission) => ({
      externalId: submission.id,
      title: submission.title,
      url: `https://www.reddit.com${submission.permalink}`,
      author: submission.author.name,
      text: submission.selftext,
      commentCount: submission.num_comments,
      score: submission.score,
      createdAt: new Date(submission.created_utc * 1000),
      topic: submission.subreddit_name_prefixed,
      platform: ThreadPlatform.Reddit,
    }));
  }
}
