import { Injectable } from "@nestjs/common";
import { HttpException } from "@nestjs/common";
import { chunk } from "lodash";
import {
  ThreadSearchTask,
  TaskStatus,
  ThreadRepository,
  ThreadPlatform,
  ThreadStatus,
} from "@ebike-backend/database";
import type { PlatformSearchResult } from "@ebike-backend/database";
import { ThreadCreatorService } from "@ebike-backend/thread";
import { ThreadRelevanceEstimationService } from "@ebike-backend/relevance";
import { ThreadSearchMetricsService } from "@ebike-backend/metrics";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { DebugTraceService } from "@ebike-backend/debug";
import { CategoryConfigService } from "@ebike-backend/config";
import { CustomLogger } from "@ebike-backend/logger";
import type { ThreadSearchExecutionTraceData } from "@ebike-backend/debug";
import { RedditSearchHandler } from "../handlers/reddit-search.handler";

type SearchErrorType = "rate_limit" | "timeout" | "auth" | "unknown";
type PassMode = "scoped" | "broad";

interface PassThresholds {
  minScore: number;
  minComments: number;
  minRelevanceForIngestion: number;
  avgRelevanceThreshold: number;
}

interface SinglePassResult {
  totalResults: number;
  duplicates: number;
  offScope: number;
  belowQualityGate: number;
  belowRelevance: number;
  discovered: number;
  earlyStop: boolean;
  earlyStopChunkIndex: number | null;
  earlyStopChunkAvgRelevance: number | null;
  relevances: number[];
  sampleResults: ThreadSearchExecutionTraceData["sampleResults"];
}

export interface ExecutionResult {
  totalResults: number;
  duplicates: number;
  offScope: number;
  belowQualityGate: number;
  belowRelevance: number;
  discovered: number;
  earlyStop: boolean;
  relevances: number[];
  sampleResults: ThreadSearchExecutionTraceData["sampleResults"];
  passesRun: number;
}

const PRODUCT_QUERY_PATTERNS = [" review", " vs"];
const MAX_SAMPLE_RESULTS_AGGREGATED = 20;

function classifySearchError(error: unknown): SearchErrorType {
  if (error instanceof HttpException) {
    if (error.getStatus() === 429) return "rate_limit";
    if (error.getStatus() === 401 || error.getStatus() === 403) return "auth";
  }
  if (error instanceof Error && error.message?.includes("timeout"))
    return "timeout";
  return "unknown";
}

function isProductQuery(keyword: string): boolean {
  return PRODUCT_QUERY_PATTERNS.some((pattern) =>
    keyword.toLowerCase().endsWith(pattern),
  );
}

function computeRelevanceDistribution(
  relevances: number[],
): ThreadSearchExecutionTraceData["relevanceDistribution"] {
  if (relevances.length === 0) return null;

  const sorted = [...relevances].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    median: sorted[Math.floor(sorted.length / 2)],
    p25: sorted[Math.floor(sorted.length * 0.25)],
    p75: sorted[Math.floor(sorted.length * 0.75)],
  };
}

function emptyPassResult(totalResults = 0): SinglePassResult {
  return {
    totalResults,
    duplicates: 0,
    offScope: 0,
    belowQualityGate: 0,
    belowRelevance: 0,
    discovered: 0,
    earlyStop: false,
    earlyStopChunkIndex: null,
    earlyStopChunkAvgRelevance: null,
    relevances: [],
    sampleResults: [],
  };
}

function emptyAggregatedResult(): ExecutionResult {
  return {
    totalResults: 0,
    duplicates: 0,
    offScope: 0,
    belowQualityGate: 0,
    belowRelevance: 0,
    discovered: 0,
    earlyStop: false,
    relevances: [],
    sampleResults: [],
    passesRun: 0,
  };
}

@Injectable()
export class ThreadSearchExecutor {
  private readonly logger = new CustomLogger(ThreadSearchExecutor.name);

  constructor(
    private readonly threadRepository: ThreadRepository,
    private readonly threadCreatorService: ThreadCreatorService,
    private readonly threadRelevanceEstimator: ThreadRelevanceEstimationService,
    private readonly metricsService: ThreadSearchMetricsService,
    private readonly dynamicConfigService: DynamicConfigService,
    private readonly debugTraceService: DebugTraceService,
    private readonly categoryConfigService: CategoryConfigService,
    private readonly redditSearchHandler: RedditSearchHandler,
  ) {}

  private resolveHandler(platform: ThreadPlatform): RedditSearchHandler {
    if (platform === ThreadPlatform.Reddit) {
      return this.redditSearchHandler;
    }
    throw new Error(`No search handler registered for platform: ${platform}`);
  }

  async execute(task: ThreadSearchTask): Promise<ExecutionResult> {
    const totalStart = Date.now();

    // Resolve once up front so an unsupported platform fails the whole task
    // rather than being swallowed by the per-pass error handler.
    this.resolveHandler(task.platform);

    const searchConfig = this.categoryConfigService.getSearchConfig(
      task.categorySlug,
    );
    const subreddits = searchConfig?.platforms.reddit?.subreddits ?? [];
    const searchParams = {
      time: this.dynamicConfigService.keywordResearch?.searchTime ?? "year",
      limit: this.dynamicConfigService.keywordResearch?.searchLimit ?? 400,
    };

    if (!searchConfig?.platforms.reddit) {
      this.logger.warn(
        "No reddit search config for category — running broad pass only",
        {
          categorySlug: task.categorySlug,
          keyword: task.keyword,
          taskId: task.id,
        },
      );
    }

    const passes: Array<{ scope: string | null; mode: PassMode }> = [
      ...subreddits.map((subreddit) => ({
        scope: subreddit,
        mode: "scoped" as const,
      })),
      { scope: null, mode: "broad" as const },
    ];

    const aggregated = emptyAggregatedResult();

    for (const pass of passes) {
      try {
        const passResult = await this.runSinglePass({
          task,
          scope: pass.scope,
          mode: pass.mode,
          searchParams,
          allowedSubreddits: subreddits,
        });
        this.mergeInto(aggregated, passResult);
        aggregated.passesRun++;
      } catch (error: unknown) {
        if (classifySearchError(error) === "rate_limit") {
          // Backoff applies to the whole task; abort the remaining passes.
          throw error;
        }
        this.logger.warn("Pass failed, continuing with remaining passes", {
          taskId: task.id,
          keyword: task.keyword,
          scope: pass.scope,
          mode: pass.mode,
          error,
        });
      }
    }

    this.logger.debug("Task execution completed", {
      taskId: task.id,
      keyword: task.keyword,
      categorySlug: task.categorySlug,
      passesRun: aggregated.passesRun,
      totalResults: aggregated.totalResults,
      discovered: aggregated.discovered,
      duplicates: aggregated.duplicates,
      belowQualityGate: aggregated.belowQualityGate,
      belowRelevance: aggregated.belowRelevance,
      earlyStop: aggregated.earlyStop,
      durationMs: Date.now() - totalStart,
    });

    return aggregated;
  }

  private async runSinglePass(params: {
    task: ThreadSearchTask;
    scope: string | null;
    mode: PassMode;
    searchParams: { time: string; limit: number };
    allowedSubreddits: string[];
  }): Promise<SinglePassResult> {
    const { task, scope, mode, searchParams, allowedSubreddits } = params;
    const { keyword, platform, categorySlug } = task;

    const startTime = Date.now();
    const handler = this.resolveHandler(platform);
    const sortStrategy = isProductQuery(keyword) ? "top" : "relevance";

    let results: PlatformSearchResult[];
    let platformApiDurationMs: number;

    try {
      const apiStart = Date.now();
      results = await handler.search(keyword, scope, {
        sort: sortStrategy,
        time: searchParams.time,
        limit: searchParams.limit,
      });
      platformApiDurationMs = Date.now() - apiStart;
    } catch (error: unknown) {
      const errorType = classifySearchError(error);
      this.metricsService.recordPlatformApiError(platform, errorType);
      this.logger.error("Platform search failed", {
        taskId: task.id,
        categorySlug,
        keyword,
        scope,
        mode,
        errorType,
        error,
      });

      if (errorType === "rate_limit") {
        const backoffSeconds =
          this.dynamicConfigService.keywordResearch?.rateLimitBackoffSeconds ??
          60;
        task.scheduledAt = new Date(Date.now() + backoffSeconds * 1000);
        task.status = TaskStatus.PENDING;
      }

      throw error;
    }

    const thresholds = this.resolveThresholds(mode);

    const passResult = await this.processResults({
      results,
      categorySlug,
      keyword,
      // Broad pass skips the allowlist; scoped pass applies it as a defense
      // against Reddit returning off-topic results inside a scoped query.
      allowedSubreddits: mode === "broad" ? undefined : allowedSubreddits,
      thresholds,
    });

    const totalDurationMs = Date.now() - startTime;

    this.recordMetrics({
      categorySlug,
      platform,
      result: passResult,
      totalDurationMs,
    });

    await this.recordTrace({
      task,
      scope,
      mode,
      searchParams,
      sortStrategy,
      thresholds,
      passResult,
      platformApiDurationMs,
      totalDurationMs,
    });

    return passResult;
  }

  private resolveThresholds(mode: PassMode): PassThresholds {
    if (mode === "broad") {
      return {
        minScore:
          this.dynamicConfigService.keywordResearch?.broadSearchMinScore ?? 30,
        minComments:
          this.dynamicConfigService.keywordResearch?.broadSearchMinComments ??
          15,
        minRelevanceForIngestion:
          this.dynamicConfigService.keywordResearch?.broadSearchMinRelevance ??
          60,
        avgRelevanceThreshold:
          this.dynamicConfigService.keywordResearch
            ?.broadSearchAvgRelevanceThreshold ?? 60,
      };
    }

    return {
      minScore: this.dynamicConfigService.preprocessing?.minScore ?? 15,
      minComments: this.dynamicConfigService.preprocessing?.minComments ?? 8,
      minRelevanceForIngestion:
        this.dynamicConfigService.preprocessing?.minRelevanceForIngestion ?? 40,
      avgRelevanceThreshold:
        this.dynamicConfigService.scheduling?.searchQueryProcessing
          ?.avgRelevanceThreshold ?? 45,
    };
  }

  private async processResults(params: {
    results: PlatformSearchResult[];
    categorySlug: string;
    keyword: string;
    allowedSubreddits?: string[];
    thresholds: PassThresholds;
  }): Promise<SinglePassResult> {
    const { results, categorySlug, keyword, allowedSubreddits, thresholds } =
      params;
    const {
      minScore,
      minComments,
      minRelevanceForIngestion,
      avgRelevanceThreshold,
    } = thresholds;
    const chunkSize =
      this.dynamicConfigService.scheduling?.searchQueryProcessing?.chunkSize ??
      30;

    const passResult = emptyPassResult(results.length);

    if (results.length === 0) {
      return passResult;
    }

    const externalIds = results.map((result) => result.externalId);
    const existingThreads =
      await this.threadRepository.findAllByExternalId(externalIds);
    const existingByExternalId = new Map(
      existingThreads.map((thread) => [thread.externalId, thread]),
    );

    const allowedSubredditSet = allowedSubreddits
      ? new Set(allowedSubreddits.map((subreddit) => subreddit.toLowerCase()))
      : null;

    const newResults: PlatformSearchResult[] = [];
    for (const result of results) {
      const existing = existingByExternalId.get(result.externalId);
      if (existing) {
        const appended = await this.threadRepository.appendKeyword(
          existing.id,
          keyword,
        );
        passResult.duplicates++;
        this.addSampleResult(passResult, result, null, "duplicate");
        this.logger.debug("Keyword appended to existing thread", {
          threadId: existing.id,
          externalId: existing.externalId,
          keyword,
          alreadyPresent: !appended,
        });
      } else {
        newResults.push(result);
      }
    }

    const scopePassedResults: PlatformSearchResult[] = [];
    if (allowedSubredditSet) {
      for (const result of newResults) {
        const resultSubreddit = result.topic.replace(/^r\//, "").toLowerCase();
        if (allowedSubredditSet.has(resultSubreddit)) {
          scopePassedResults.push(result);
        } else {
          passResult.offScope++;
          this.addSampleResult(passResult, result, null, "off_scope");
        }
      }
    } else {
      scopePassedResults.push(...newResults);
    }

    const qualityPassedResults: PlatformSearchResult[] = [];
    for (const result of scopePassedResults) {
      if (result.score < minScore || result.commentCount < minComments) {
        passResult.belowQualityGate++;
        this.addSampleResult(passResult, result, null, "below_quality_gate");
      } else {
        qualityPassedResults.push(result);
      }
    }

    if (qualityPassedResults.length === 0) {
      return passResult;
    }

    const resultChunks = chunk(qualityPassedResults, chunkSize);

    for (let chunkIndex = 0; chunkIndex < resultChunks.length; chunkIndex++) {
      const currentChunk = resultChunks[chunkIndex];
      const chunkRelevances: number[] = [];

      for (const result of currentChunk) {
        const { score } = await this.threadRelevanceEstimator.score(result);

        if (score < minRelevanceForIngestion) {
          await this.threadCreatorService.persistWithScore(
            result,
            score,
            ThreadStatus.LOW_ESTIMATION,
            keyword,
          );
          passResult.belowRelevance++;
          this.addSampleResult(passResult, result, score, "below_relevance");
        } else {
          await this.threadCreatorService.persistWithScore(
            result,
            score,
            ThreadStatus.NEW,
            keyword,
          );
          passResult.discovered++;
          passResult.relevances.push(score);
          chunkRelevances.push(score);
          this.addSampleResult(passResult, result, score, "discovered");
        }
      }

      if (chunkRelevances.length > 0) {
        const chunkAvgRelevance =
          chunkRelevances.reduce((sum, value) => sum + value, 0) /
          chunkRelevances.length;

        if (chunkAvgRelevance < avgRelevanceThreshold) {
          passResult.earlyStop = true;
          passResult.earlyStopChunkIndex = chunkIndex;
          passResult.earlyStopChunkAvgRelevance = chunkAvgRelevance;
          this.logger.debug(
            `Early stop: chunk ${chunkIndex} avg relevance ${chunkAvgRelevance.toFixed(1)} below threshold ${avgRelevanceThreshold}`,
            { keyword, categorySlug },
          );
          break;
        }
      }
    }

    return passResult;
  }

  private mergeInto(agg: ExecutionResult, pass: SinglePassResult): void {
    agg.totalResults += pass.totalResults;
    agg.duplicates += pass.duplicates;
    agg.offScope += pass.offScope;
    agg.belowQualityGate += pass.belowQualityGate;
    agg.belowRelevance += pass.belowRelevance;
    agg.discovered += pass.discovered;
    agg.earlyStop = agg.earlyStop || pass.earlyStop;
    agg.relevances.push(...pass.relevances);
    for (const sample of pass.sampleResults) {
      if (agg.sampleResults.length >= MAX_SAMPLE_RESULTS_AGGREGATED) break;
      agg.sampleResults.push(sample);
    }
  }

  private recordMetrics(params: {
    categorySlug: string;
    platform: ThreadPlatform;
    result: SinglePassResult;
    totalDurationMs: number;
  }): void {
    const { categorySlug, platform, result, totalDurationMs } = params;

    this.metricsService.recordSearchExecuted(categorySlug, platform, "success");
    this.metricsService.recordSearchDuration(platform, totalDurationMs / 1000);
    this.metricsService.recordDiscovered(
      categorySlug,
      platform,
      result.discovered,
    );
    this.metricsService.recordDuplicates(
      categorySlug,
      platform,
      result.duplicates,
    );

    if (result.offScope > 0) {
      this.metricsService.recordRejected(
        categorySlug,
        platform,
        "off_scope",
        result.offScope,
      );
    }

    if (result.belowQualityGate > 0) {
      this.metricsService.recordRejected(
        categorySlug,
        platform,
        "below_quality_gate",
        result.belowQualityGate,
      );
    }

    if (result.belowRelevance > 0) {
      this.metricsService.recordRejected(
        categorySlug,
        platform,
        "below_relevance",
        result.belowRelevance,
      );
    }

    for (const relevance of result.relevances) {
      this.metricsService.recordAverageRelevance(categorySlug, relevance);
    }

    if (result.earlyStop) {
      this.metricsService.recordEarlyStop(categorySlug);
    }
  }

  private async recordTrace(params: {
    task: ThreadSearchTask;
    scope: string | null;
    mode: PassMode;
    searchParams: { time: string; limit: number };
    sortStrategy: string;
    thresholds: PassThresholds;
    passResult: SinglePassResult;
    platformApiDurationMs: number;
    totalDurationMs: number;
  }): Promise<void> {
    const {
      task,
      scope,
      mode,
      searchParams,
      sortStrategy,
      thresholds,
      passResult,
      platformApiDurationMs,
      totalDurationMs,
    } = params;

    const traceData: ThreadSearchExecutionTraceData = {
      type: "thread-search-execution",
      keyword: task.keyword,
      platform: task.platform,
      categorySlug: task.categorySlug,
      scope,
      mode,
      sortStrategy,
      searchParams,
      totalResults: passResult.totalResults,
      duplicates: passResult.duplicates,
      offScope: passResult.offScope,
      belowQualityGate: passResult.belowQualityGate,
      belowRelevance: passResult.belowRelevance,
      discovered: passResult.discovered,
      qualityGates: {
        minScore: thresholds.minScore,
        minComments: thresholds.minComments,
        minRelevance: thresholds.minRelevanceForIngestion,
      },
      relevanceDistribution: computeRelevanceDistribution(
        passResult.relevances,
      ),
      sampleResults: passResult.sampleResults,
      earlyStop: passResult.earlyStop,
      earlyStopChunkIndex: passResult.earlyStopChunkIndex,
      earlyStopChunkAvgRelevance: passResult.earlyStopChunkAvgRelevance,
      keywordStatsUpdate: null,
      platformApiDurationMs,
      totalDurationMs,
    };

    await this.debugTraceService.record({
      batchId: task.id,
      step: "thread-search-execution",
      statusBefore: "searching",
      statusAfter: passResult.discovered > 0 ? "discovered" : "no_results",
      durationMs: totalDurationMs,
      data: traceData,
    });
  }

  private addSampleResult(
    passResult: SinglePassResult,
    result: Pick<
      PlatformSearchResult,
      "externalId" | "title" | "score" | "commentCount" | "topic"
    >,
    relevance: number | null,
    outcome: ThreadSearchExecutionTraceData["sampleResults"][number]["outcome"],
  ): void {
    if (passResult.sampleResults.length >= 20) return;

    passResult.sampleResults.push({
      externalId: result.externalId,
      title: result.title,
      score: result.score,
      commentCount: result.commentCount,
      relevance,
      outcome,
      topic: result.topic,
    });
  }
}
