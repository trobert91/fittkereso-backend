import { Controller, Get, Param, Query } from "@nestjs/common";
import { ProductCategoryRepository } from "@ebike-backend/database";
import { CategoryContentRelevanceScorerService } from "@ebike-backend/relevance";
import {
  RedditThreadSearchService,
  RedditThreadService,
} from "@ebike-backend/reddit";

@Controller("reddit-test")
export class RedditTestController {
  constructor(
    private readonly threadSearchService: RedditThreadSearchService,
    private readonly threadService: RedditThreadService,
    private readonly categoryScorer: CategoryContentRelevanceScorerService,
    private readonly categoryRepo: ProductCategoryRepository,
  ) {}

  @Get("thread/:id")
  getThread(@Param("id") id: string) {
    return this.threadService.getFullThread(id);
  }

  @Get("threads")
  searchThreads(@Query("query") query: string) {
    return this.threadSearchService.searchThreads({ query });
  }

  @Get("thread/:id/resolve-category")
  async resolveCategories(@Param("id") threadId: string) {
    const thread = await this.threadService.getFullThread(threadId);
    const categories = await this.categoryRepo.getAll();

    const results = this.categoryScorer.resolveByContent(
      [
        thread.title,
        thread.selftext,
        ...thread.comments.flatMap((c) => [
          c.body,
          ...(c.replies ?? []).map((r) => r.body),
        ]),
      ],
      categories,
    );

    return results.map((result) => ({
      categoryName: result.category.name,
      relevance: result.relevance,
      topTerms: result.topTerms,
    }));
  }
}
