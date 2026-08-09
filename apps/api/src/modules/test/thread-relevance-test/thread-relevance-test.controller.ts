import {
  Controller,
  Get,
  NotFoundException,
  Query,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard, RoleGuard, Roles } from "@ebike-backend/auth";
import {
  ThreadProductCategory,
  ThreadRepository,
  UserRole,
} from "@ebike-backend/database";
import { nameOf } from "@ebike-backend/utils";
import { Thread } from "@ebike-backend/database";
import {
  SampledComment,
  SelectionResult,
  ThreadSelectionService,
} from "@ebike-backend/relevance";
import {
  RelevanceCriteriaRatings,
  RelevanceScoreBreakdown,
} from "@ebike-backend/database";
import { ProcessorConfigService } from "@ebike-backend/config";

@Controller("test/thread-relevance")
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class ThreadRelevanceTestController {
  constructor(
    private readonly threadRepository: ThreadRepository,
    private readonly selectionService: ThreadSelectionService,
    private readonly processorConfig: ProcessorConfigService,
  ) {}

  @Get("/evaluate")
  async evaluate(
    @Query("threadId") threadId: string,
  ): Promise<ThreadRelevanceTestResult> {
    const thread = await this.threadRepository.repo
      .createQueryBuilder("thread")
      .leftJoinAndSelect(
        `thread.${nameOf<Thread>("categories")}`,
        "threadCategory",
      )
      .leftJoinAndSelect(
        `threadCategory.${nameOf<ThreadProductCategory>("productCategory")}`,
        "category",
      )
      .where(`thread.${nameOf<Thread>("id")} = :id`, { id: threadId })
      .getOne();

    if (!thread) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }

    const relevanceConfig = this.processorConfig.relevanceCalculation;
    const threadSelection = this.processorConfig.threadSelection;

    const result: SelectionResult = await this.selectionService.select(thread, {
      commentFetchLimit: relevanceConfig.commentFetchLimit,
      commentSampleSize: relevanceConfig.commentSampleSize,
      minWeightedScore: relevanceConfig.minWeightedScore,
      model: relevanceConfig.model,
      ...(relevanceConfig.thinking !== undefined && {
        thinking: relevanceConfig.thinking,
      }),
      ...(relevanceConfig.effort !== undefined && {
        effort: relevanceConfig.effort,
      }),
      compositeScoring: relevanceConfig.compositeScoring,
      candidatePoolSize: threadSelection.candidatePoolSize,
      minCategoryRelevance: threadSelection.minCategoryRelevance,
      maxCategoriesPerThread: threadSelection.maxCategoriesPerThread,
    });

    return {
      threadId: thread.id,
      threadTitle: thread.title,
      outcome: result.outcome,
      categories: result.categories,
      weightedScore: result.weightedScore,
      criteria: result.criteria,
      hardGateFailedCriteria: result.hardGateFailedCriteria,
      breakdown: result.breakdown,
      sampledComments: result.sampledComments,
    };
  }
}

interface ThreadRelevanceTestResult {
  threadId: string;
  threadTitle: string;
  outcome: "selected" | "llm_low_relevance" | "llm_no_category";
  categories: Array<{ slug: string; name: string; relevance: number }>;
  weightedScore: number;
  criteria: RelevanceCriteriaRatings;
  hardGateFailedCriteria: Array<keyof RelevanceCriteriaRatings>;
  breakdown?: RelevanceScoreBreakdown;
  sampledComments: SampledComment[];
}
