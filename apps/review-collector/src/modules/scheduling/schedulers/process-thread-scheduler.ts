import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
  QueueName,
  TaskRepository,
  Thread,
  ThreadRepository,
  ThreadStatus,
} from "@ebike-backend/database";
import { BaseScheduler, QueuePublisherService } from "@ebike-backend/task";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { differenceInMinutes } from "date-fns";
import { isEmpty } from "lodash";
import { ThreadStatusSearchService } from "@ebike-backend/thread";
import {
  SchedulerMetricsService,
  ThreadMetricsService,
} from "@ebike-backend/metrics";
import {
  ThreadSelectionService,
  ThreadSelectionServiceConfig,
} from "@ebike-backend/relevance";
import { ProcessorConfigService } from "@ebike-backend/config";

@Injectable()
export class ProcessThreadScheduler extends BaseScheduler {
  constructor(
    private readonly threadRepo: ThreadRepository,
    private readonly taskRepo: TaskRepository,
    private readonly publisher: QueuePublisherService,
    private readonly dynamicConfigService: DynamicConfigService,
    private readonly searchService: ThreadStatusSearchService,
    private readonly processorConfig: ProcessorConfigService,
    private readonly selectionService: ThreadSelectionService,
    private readonly threadMetrics: ThreadMetricsService,
    readonly metricsService: SchedulerMetricsService,
  ) {
    super(ProcessThreadScheduler.name, metricsService);
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async schedule() {
    await super.schedule(this.scheduleThreadProcessTasks.bind(this));
  }

  async scheduleThreadProcessTasks() {
    const threadProcessingPerDay =
      this.dynamicConfigService.general.threadProcessingPerDay;
    const numberOfThreadsToSchedule = await this.calculateThreadsToSchedule(
      threadProcessingPerDay,
    );

    if (numberOfThreadsToSchedule < 1) {
      return;
    }

    await this.scheduleWithBudget(numberOfThreadsToSchedule);
  }

  async scheduleWithBudget(numberOfThreadsToSchedule: number): Promise<void> {
    const reprocessConfig = this.dynamicConfigService.reprocessing;
    const reprocessEnabled = reprocessConfig?.enabled ?? false;
    const reprocessFraction = reprocessConfig?.dailyBudgetFraction ?? 0.2;
    const maxReprocessPerCycle = reprocessConfig?.maxReprocessPerCycle ?? 3;
    const reprocessAfterDays = reprocessConfig?.reprocessAfterDays ?? 30;

    let reprocessBudget = 0;
    let newThreadBudget = numberOfThreadsToSchedule;

    if (reprocessEnabled) {
      reprocessBudget = Math.min(
        Math.floor(numberOfThreadsToSchedule * reprocessFraction),
        maxReprocessPerCycle,
      );
      newThreadBudget = numberOfThreadsToSchedule - reprocessBudget;
    }

    // Phase A: run LLM selection on NEW threads. The selection service writes
    // status = SELECTED, LLM_LOW_RELEVANCE, or LLM_NO_CATEGORY. Phase B then
    // drains SELECTED + REPROCESSING.
    if (newThreadBudget > 0) {
      await this.runSelectionPhase(newThreadBudget);
    }

    // Phase B: pick up SELECTED threads (just produced by Phase A, plus any
    // backlog) and enqueue them for extraction. Status moves to PROCESSING.
    if (newThreadBudget > 0) {
      await this.runExtractionEnqueuePhase(newThreadBudget);
    }

    if (reprocessBudget > 0) {
      const threads = await this.searchService.findThreadsToReprocess(
        reprocessBudget,
        reprocessAfterDays,
      );
      this.logger.debug(
        `Found ${threads.length} threads eligible for reprocessing.`,
      );
      if (!isEmpty(threads)) {
        await this.publishThreadTasks(threads, "reprocess");
      }
    }
  }

  // ─── Phase A: LLM Selection ───────────────────────────────────────────────

  private async runSelectionPhase(budget: number): Promise<void> {
    const minIngestionRelevance =
      this.processorConfig.extraction.minIngestionRelevance;
    const relevanceConfig = this.processorConfig.relevanceCalculation;

    const overFetchMultiplier = relevanceConfig.overFetchMultiplier;
    const fetchLimit = Math.ceil(budget * overFetchMultiplier);

    const candidates = await this.searchService.findThreadsForSelection(
      fetchLimit,
      minIngestionRelevance,
    );

    this.logger.debug(
      `Phase A: found ${candidates.length} candidate threads for LLM selection (limit: ${fetchLimit}, budget: ${budget}).`,
    );

    const selectionConfig = this.buildSelectionConfig();
    let selectedCount = 0;

    for (const thread of candidates) {
      if (selectedCount >= budget) break;

      try {
        const result = await this.selectionService.select(
          thread,
          selectionConfig,
        );
        this.threadMetrics.relevanceCalculationCompleted(
          result.outcome === "selected" ? "passed" : "skipped",
        );
        if (result.outcome === "selected") {
          selectedCount++;
        }
      } catch (error) {
        this.logger.error(
          `Thread selection failed for thread ${thread.id}; leaving in NEW for retry.`,
          { threadId: thread.id, error },
        );
      }
    }

    if (selectedCount === 0 && candidates.length > 0) {
      this.logger.debug(
        `Phase A produced 0 SELECTED threads (out of ${candidates.length} candidates).`,
      );
    }
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

  // ─── Phase B: enqueue SELECTED for extraction ─────────────────────────────

  private async runExtractionEnqueuePhase(budget: number): Promise<void> {
    const threads = await this.searchService.findThreadsForExtraction(budget);
    if (isEmpty(threads)) return;
    this.logger.debug(
      `Phase B: enqueueing ${threads.length} threads for extraction (SELECTED + REPROCESSING).`,
    );
    await this.publishThreadTasks(threads, "new");
  }

  private async publishThreadTasks(
    threads: Thread[],
    reason: string,
  ): Promise<void> {
    // Capture pre-PROCESSING status so a queue-publish failure can restore
    // the row to whatever it was (SELECTED vs REPROCESSING vs PROCESSED for
    // the reprocess path) rather than collapsing everything to one state.
    const originalStatusById = new Map<string, ThreadStatus>(
      threads.map((thread) => [thread.id, thread.status]),
    );

    for (const thread of threads) {
      thread.status = ThreadStatus.PROCESSING;
    }
    await this.threadRepo.saveAll(threads);

    const results = await Promise.allSettled(
      threads.map((thread) =>
        this.publisher.addThreadProcessTask({ threadId: thread.id }),
      ),
    );

    const failed = threads.filter(
      (_, index) => results[index].status === "rejected",
    );
    if (failed.length > 0) {
      for (const thread of failed) {
        thread.status =
          originalStatusById.get(thread.id) ?? ThreadStatus.SELECTED;
      }
      await this.threadRepo.saveAll(failed);
      this.logger.warn(
        `${failed.length} threads (${reason}) failed to queue and were reset.`,
      );
    }

    const queued = threads.length - failed.length;
    this.logger.debug(`${queued} threads queued for processing (${reason}).`);
  }

  private async calculateThreadsToSchedule(
    threadProcessingPerDay: number,
  ): Promise<number> {
    const taskLastCreated = await this.taskRepo.lastCreatedTimestamp(
      QueueName.ThreadProcess,
    );

    if (!threadProcessingPerDay || threadProcessingPerDay === 0) {
      return 0;
    }

    // Calculate interval in minutes between each thread (24 hours / threadsPerDay)
    const minutesBetweenThreads = (24 * 60) / threadProcessingPerDay;

    // If no last run, schedule one thread
    if (!taskLastCreated) {
      return 1;
    }

    // Calculate minutes since last run
    const minutesSinceLastRun = differenceInMinutes(
      Date.now(),
      taskLastCreated,
    );

    // Calculate how many threads we can schedule based on time passed
    const threadsAllowed = Math.min(
      threadProcessingPerDay,
      Math.floor(minutesSinceLastRun / minutesBetweenThreads),
    );

    return threadsAllowed;
  }
}
