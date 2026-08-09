import {
  Controller,
  Get,
  NotFoundException,
  Query,
  SerializeOptions,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard, RoleGuard, Roles } from "@ebike-backend/auth";
import {
  ProductCategoryRepository,
  Thread,
  ThreadRepository,
  UserRole,
} from "@ebike-backend/database";
import { nameOf } from "@ebike-backend/utils";
import { RedditThreadSerializerService } from "@ebike-backend/thread";
import { CategoryContentRelevanceScorerService } from "@ebike-backend/relevance";
import { CategoryConfigService } from "@ebike-backend/config";

@Controller("test/category")
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class CategoryTestController {
  constructor(
    private readonly threadRepository: ThreadRepository,
    private readonly serializer: RedditThreadSerializerService,
    private readonly categoryRepository: ProductCategoryRepository,
    private readonly categoryScorer: CategoryContentRelevanceScorerService,
    private readonly categoryConfigService: CategoryConfigService,
  ) {}

  /**
   * Admin diagnostic: run the cheap term-based category scorer (the same one
   * used by the ingestion pre-filter and the LLM-candidate pre-filter) against
   * a persisted thread and return the per-category scores including subreddit
   * boost. Useful for debugging why a thread did or did not get a category.
   */
  @Get("/identify")
  @SerializeOptions({ strategy: "exposeAll" })
  async identify(
    @Query("threadId") threadId: string,
  ): Promise<CategoryIdentificationResult> {
    const thread = await this.threadRepository.repo
      .createQueryBuilder("thread")
      .addSelect(`thread.${nameOf<Thread>("commentTree")}`)
      .where(`thread.${nameOf<Thread>("id")} = :id`, { id: threadId })
      .getOne();

    if (!thread) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }

    const comments = await this.serializer.getComments(thread);
    const categories = await this.categoryRepository.getAll({
      where: { enabled: true },
    });
    const results = this.categoryScorer.resolveByContent(comments, categories);

    if (thread.topic) {
      for (const result of results) {
        const catConfig = this.categoryConfigService.getConfig(
          result.category.slug,
        );
        const subredditMatch = catConfig?.subreddits?.find(
          (sub) => sub.name.toLowerCase() === thread.topic.toLowerCase(),
        );
        if (subredditMatch) {
          result.relevance = Math.min(
            100,
            result.relevance + subredditMatch.boost,
          );
        }
      }
      results.sort((a, b) => b.relevance - a.relevance);
    }

    return {
      threadId: thread.id,
      threadTitle: thread.title ?? "",
      commentCount: comments.length,
      categories: results.map((result) => ({
        categoryId: result.category.id,
        categoryName: result.category.name,
        relevance: result.relevance,
        topTerms: result.topTerms,
      })),
    };
  }
}

interface CategoryIdentificationResult {
  threadId: string;
  threadTitle: string;
  commentCount: number;
  categories: {
    categoryId: string;
    categoryName: string;
    relevance: number;
    topTerms: { term: string; score: number; maxScore: number }[];
  }[];
}
