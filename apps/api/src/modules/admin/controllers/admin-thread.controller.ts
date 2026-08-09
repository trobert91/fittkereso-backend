import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  SerializeOptions,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard, RoleGuard, Roles } from "@ebike-backend/auth";
import {
  RelevanceCriteriaRatings,
  RelevanceScoreBreakdown,
  Thread,
  ThreadProductCategory,
  ThreadRepository,
  ThreadStatus,
  UserRole,
} from "@ebike-backend/database";
import {
  ThreadSearchParams,
  ThreadSearchResult,
  ThreadSearchService,
} from "@ebike-backend/search";
import {
  RelevanceDebugDto,
  ThreadCreatorService,
  ThreadCreateDto,
  ThreadDeletionService,
  ThreadDetailService,
} from "@ebike-backend/thread";
import { QueuePublisherService } from "@ebike-backend/task";
import {
  CategoryScoreBreakdown,
  SignalScores,
  ThreadSelectionService,
  ThreadSelectionServiceConfig,
} from "@ebike-backend/relevance";
import { ProcessorConfigService } from "@ebike-backend/config";
import { CustomLogger } from "@ebike-backend/logger";
import { nameOf } from "@ebike-backend/utils";

import { SerializeGroup } from "@ebike-backend/utils";

@Controller("admin-thread")
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class AdminThreadController {
  private readonly logger = new CustomLogger(AdminThreadController.name);

  constructor(
    private readonly searchService: ThreadSearchService,
    private readonly threadCreatorService: ThreadCreatorService,
    private readonly threadDeletionService: ThreadDeletionService,
    private readonly threadDetailService: ThreadDetailService,
    private readonly queuePublisher: QueuePublisherService,
    private readonly threadRepository: ThreadRepository,
    private readonly selectionService: ThreadSelectionService,
    private readonly processorConfig: ProcessorConfigService,
  ) {}

  @Get(":id")
  @SerializeOptions({
    strategy: "exposeAll",
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
    ],
  })
  async getThread(@Param("id") threadId: string): Promise<Thread> {
    return await this.threadDetailService.getThreadById(threadId);
  }

  /**
   * Stage 1 + Stage 2 in one call. Fetches the Reddit submission, runs the
   * cheap term scorer to populate `relevanceEstimation`, persists the row,
   * then immediately runs the LLM selection service. Final status reflects
   * the LLM's verdict: SELECTED, LLM_LOW_RELEVANCE, or LLM_NO_CATEGORY.
   *
   * `relevanceEstimation` is informational here — the LLM has the final say
   * regardless of whether the cheap scorer would have tombstoned the thread
   * (as LOW_ESTIMATION) in the search-executor flow.
   */
  @Post("create")
  @SerializeOptions({
    strategy: "exposeAll",
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
    ],
  })
  async createThread(@Body() createDto: ThreadCreateDto): Promise<Thread> {
    const created = await this.threadCreatorService.createFromDto(createDto);
    try {
      await this.selectionService.select(created, this.buildSelectionConfig());
    } catch (error) {
      // createFromDto always persists as NEW, so on Stage 2 failure the thread
      // is already in the correct state for scheduler retry — just log and
      // return. Note: Phase A also gates on `relevanceEstimation >= minRelevance`.
      // If the original Stage 1 score was below threshold, the scheduler won't
      // re-pick it; admin must call POST :id/select directly in that case.
      this.logger.warn(
        `Stage 2 selection failed for thread ${created.id} during POST create; ` +
          `leaving in NEW for scheduler retry.`,
        { threadId: created.id, error },
      );
    }
    return this.threadDetailService.getThreadById(created.id);
  }

  @Post("search")
  @SerializeOptions({
    strategy: "exposeAll",
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
    ],
  })
  async searchThreads(
    @Body() searchParams: ThreadSearchParams,
  ): Promise<ThreadSearchResult> {
    const result = await this.searchService.search(searchParams);

    return result;
  }

  /**
   * Manually retrigger LLM-based thread selection. Reuses the same
   * ThreadSelectionService that the scheduler uses, so behavior is identical.
   * Useful for debugging a misclassified thread or testing after a prompt change.
   */
  @Post(":id/select")
  @SerializeOptions({
    strategy: "exposeAll",
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
    ],
  })
  async selectThread(@Param("id") threadId: string): Promise<Thread> {
    const thread = await this.loadThreadWithCategories(threadId);
    await this.selectionService.select(thread, this.buildSelectionConfig());
    return this.threadDetailService.getThreadById(threadId);
  }

  /**
   * Debug endpoint for a Reddit submission's relevance pipeline. Always runs
   * Stage 1 (cheap term scorer). Opt-in to Stage 2 (LLM selection) via the
   * `llmCalculation` flag — default off, because Stage 2 costs a real LLM
   * call. When Stage 2 is requested it is invoked even if Stage 1 would
   * tombstone the thread in production, so admin can see what the LLM would
   * have said. If the LLM call fails (e.g. zero comments), `selection` is
   * null and `selectionError` is set; the Stage 1 result is still returned.
   *
   * Nothing is persisted.
   */
  @Post("relevance-debug")
  @SerializeOptions({ strategy: "exposeAll" })
  async relevanceDebug(
    @Body() dto: RelevanceDebugDto,
  ): Promise<ThreadRelevanceDebugResult> {
    const { searchResult, estimate, minRelevanceForIngestion } =
      await this.threadCreatorService.previewEstimate(dto);

    const stage1WouldPersistAs =
      estimate.score < minRelevanceForIngestion
        ? ThreadStatus.LOW_ESTIMATION
        : ThreadStatus.NEW;

    let selection: ThreadRelevanceDebugResult["selection"] = null;
    let selectionError: string | null = null;
    const selectionRan = dto.llmCalculation === true;

    if (selectionRan) {
      const inMemoryThread =
        this.threadCreatorService.mapSearchResultToThreadEntity(searchResult);
      const selectionConfig = this.buildSelectionConfig();
      try {
        const result = await this.selectionService.previewSelection(
          inMemoryThread,
          selectionConfig,
        );
        const stage2WouldPersistAs =
          result.outcome === "selected"
            ? ThreadStatus.SELECTED
            : result.outcome === "llm_low_relevance"
              ? ThreadStatus.LLM_LOW_RELEVANCE
              : ThreadStatus.LLM_NO_CATEGORY;
        selection = {
          outcome: result.outcome,
          weightedScore: result.weightedScore,
          minWeightedScore: selectionConfig.minWeightedScore,
          criteria: result.criteria,
          breakdown: result.breakdown,
          categories: result.categories,
          sampledCommentCount: result.sampledComments.length,
          wouldPersistAs: stage2WouldPersistAs,
          hardGateFailedCriteria: result.hardGateFailedCriteria,
        };
      } catch (error: unknown) {
        selectionError =
          error instanceof Error ? error.message : "Stage 2 failed.";
      }
    }

    const finalWouldPersistAs =
      stage1WouldPersistAs === ThreadStatus.LOW_ESTIMATION
        ? ThreadStatus.LOW_ESTIMATION
        : (selection?.wouldPersistAs ?? stage1WouldPersistAs);

    return {
      externalId: searchResult.externalId,
      title: searchResult.title,
      topic: searchResult.topic,
      url: searchResult.url,
      commentCount: estimate.commentCount,
      estimation: {
        score: estimate.score,
        signals: estimate.signals,
        categoryFocus: estimate.categoryFocus,
        minRelevanceForIngestion,
        topCategories: estimate.topCategories,
        commentFetchFailed: estimate.commentFetchFailed,
        corpusSize: estimate.corpusSize,
        wouldPersistAs: stage1WouldPersistAs,
      },
      selectionRan,
      selection,
      selectionError,
      finalWouldPersistAs,
    };
  }

  /**
   * Flag-driven pipeline runner.
   *
   * - rerunRelevanceCalculation=true: always run Stage 2 selection. If the
   *   outcome is SELECTED, also enqueue Stage 3 extraction. Other outcomes
   *   (LLM_LOW_RELEVANCE, LLM_NO_CATEGORY) do not enqueue.
   *
   * - rerunRelevanceCalculation=false (default): skip Stage 2. Enqueue
   *   Stage 3 if the thread already has categories (SELECTED, REPROCESSING).
   *   For PROCESSED threads, flip status to REPROCESSING first (admin wants
   *   a fresh extraction with the existing categories), then enqueue.
   *   Reject for NEW / LOW_ESTIMATION / LLM_NO_CATEGORY / LLM_LOW_RELEVANCE
   *   (no categories to extract with).
   *
   * Rejects PROCESSING regardless of flag — worker has it.
   */
  @Post(":id/run-pipeline")
  async runPipeline(
    @Param("id") threadId: string,
    @Body() body: RunPipelineDto = {},
  ): Promise<RunPipelineResult> {
    const thread = await this.loadThreadWithCategories(threadId);

    if (thread.status === ThreadStatus.PROCESSING) {
      throw new ConflictException(
        `Thread ${threadId} is currently being processed by a worker.`,
      );
    }

    if (body.rerunRelevanceCalculation) {
      return this.runPipelineWithReselect(thread);
    }
    return this.runPipelineWithoutReselect(thread);
  }

  private async runPipelineWithReselect(
    thread: Thread,
  ): Promise<RunPipelineResult> {
    const result = await this.selectionService.select(
      thread,
      this.buildSelectionConfig(),
    );

    const queued = result.outcome === "selected";
    if (queued) {
      await this.queuePublisher.addThreadProcessTask({ threadId: thread.id });
    }

    return {
      selectionRan: true,
      selectionOutcome: result.outcome,
      queued,
      thread: await this.threadDetailService.getThreadById(thread.id),
    };
  }

  private async runPipelineWithoutReselect(
    thread: Thread,
  ): Promise<RunPipelineResult> {
    if (thread.status === ThreadStatus.PROCESSED) {
      await this.threadRepository.repo.update(thread.id, {
        status: ThreadStatus.REPROCESSING,
      });
      await this.queuePublisher.addThreadProcessTask({ threadId: thread.id });
      return {
        selectionRan: false,
        selectionOutcome: null,
        queued: true,
        thread: await this.threadDetailService.getThreadById(thread.id),
      };
    }

    if (
      thread.status === ThreadStatus.SELECTED ||
      thread.status === ThreadStatus.REPROCESSING
    ) {
      await this.queuePublisher.addThreadProcessTask({ threadId: thread.id });
      return {
        selectionRan: false,
        selectionOutcome: null,
        queued: true,
        thread: await this.threadDetailService.getThreadById(thread.id),
      };
    }

    throw new ConflictException(
      `Thread ${thread.id} is in status ${thread.status} and has no categories ` +
        `to extract with. Call run-pipeline with rerunRelevanceCalculation=true ` +
        `or use /select first.`,
    );
  }

  /**
   * Flip a PROCESSED thread to REPROCESSING so the next scheduler tick
   * (or a subsequent run-pipeline call) picks it up for a fresh extraction.
   * Preserves the existing categories. Rejects for any other status — only
   * PROCESSED threads make sense to mark for reprocessing.
   */
  @Post(":id/mark-for-reprocess")
  @SerializeOptions({
    strategy: "exposeAll",
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
    ],
  })
  async markForReprocess(@Param("id") threadId: string): Promise<Thread> {
    const thread = await this.threadRepository.findByIdOrFail(threadId);
    if (thread.status !== ThreadStatus.PROCESSED) {
      throw new ConflictException(
        `Thread ${threadId} is in status ${thread.status}. Only PROCESSED ` +
          `threads can be marked for reprocessing.`,
      );
    }
    await this.threadRepository.repo.update(threadId, {
      status: ThreadStatus.REPROCESSING,
    });
    return this.threadDetailService.getThreadById(threadId);
  }

  private async loadThreadWithCategories(threadId: string): Promise<Thread> {
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
    return thread;
  }

  private buildSelectionConfig(): ThreadSelectionServiceConfig {
    const relevanceConfig = this.processorConfig.relevanceCalculation;
    const threadSelection = this.processorConfig.threadSelection;
    return {
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
    };
  }

  @Delete(":id")
  @SerializeOptions({
    strategy: "exposeAll",
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
    ],
  })
  async deleteThread(@Param("id") threadId: string): Promise<Thread> {
    return this.threadDeletionService.removeThreadData(threadId, true);
  }

  @Post(":id/reset")
  @SerializeOptions({
    strategy: "exposeAll",
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
    ],
  })
  async resetThread(@Param("id") threadId: string): Promise<Thread> {
    return this.threadDeletionService.removeThreadData(threadId, false);
  }
}

export interface ThreadRelevanceDebugResult {
  externalId: string;
  title: string;
  topic: string;
  url: string;
  commentCount: number;
  estimation: {
    score: number;
    signals: SignalScores;
    categoryFocus: number;
    minRelevanceForIngestion: number;
    topCategories: CategoryScoreBreakdown[];
    commentFetchFailed: boolean;
    corpusSize: number;
    wouldPersistAs: ThreadStatus;
  };
  /**
   * True when Stage 2 was attempted (caller passed llmCalculation=true).
   * False means Stage 2 was skipped — both `selection` and `selectionError`
   * will be null in that case.
   */
  selectionRan: boolean;
  selection: {
    outcome: "selected" | "llm_low_relevance" | "llm_no_category";
    weightedScore: number;
    minWeightedScore: number;
    criteria: RelevanceCriteriaRatings;
    breakdown: RelevanceScoreBreakdown;
    categories: Array<{ slug: string; name: string; relevance: number }>;
    sampledCommentCount: number;
    wouldPersistAs: ThreadStatus;
    /**
     * Criteria from the hard gate that came back 'low'. The hard gate
     * requires experienceDensity, productSpecificity, and buyerResearchValue
     * to be at least 'medium' — any 'low' here forces LLM_LOW_RELEVANCE
     * regardless of weightedScore. Empty array means the hard gate passed.
     */
    hardGateFailedCriteria: Array<keyof RelevanceCriteriaRatings>;
  } | null;
  selectionError: string | null;
  finalWouldPersistAs: ThreadStatus;
}

export interface RunPipelineDto {
  /** When true, always run Stage 2 selection. Defaults to false. */
  rerunRelevanceCalculation?: boolean;
}

export interface RunPipelineResult {
  /** True if Stage 2 selection ran during this call. */
  selectionRan: boolean;
  /** The outcome of Stage 2 if it ran, otherwise null. */
  selectionOutcome: "selected" | "llm_low_relevance" | "llm_no_category" | null;
  /** True if an extraction task was enqueued. */
  queued: boolean;
  thread: Thread;
}
