import { Controller, Get, Param } from "@nestjs/common";
import {
  Thread,
  ThreadProductCategory,
  ThreadRepository,
} from "@ebike-backend/database";
import { ThreadSelectionService } from "@ebike-backend/relevance";
import { nameOf } from "@ebike-backend/utils";
import { ProcessorConfigService } from "@ebike-backend/config";

@Controller("relevance-test")
export class RelevanceTestController {
  constructor(
    private readonly threadRepository: ThreadRepository,
    private readonly selectionService: ThreadSelectionService,
    private readonly processorConfig: ProcessorConfigService,
  ) {}

  @Get("thread/:id")
  async calculateRelevance(@Param("id") threadId: string): Promise<any> {
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
      .getOneOrFail();

    const relevanceConfig = this.processorConfig.relevanceCalculation;
    const threadSelection = this.processorConfig.threadSelection;

    return this.selectionService.select(thread, {
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
  }
}
