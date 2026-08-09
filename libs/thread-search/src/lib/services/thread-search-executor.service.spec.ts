import { HttpException, HttpStatus } from "@nestjs/common";
import {
  TaskStatus,
  Thread,
  ThreadPlatform,
  ThreadSearchTask,
  ThreadStatus,
} from "@ebike-backend/database";
import type { PlatformSearchResult } from "@ebike-backend/database";

// Mock modules that have ESM dependencies (openai via thread → product-resolution chain)
jest.mock("@ebike-backend/thread", () => ({
  ThreadCreatorService: jest.fn(),
}));
jest.mock("@ebike-backend/relevance", () => ({
  ThreadRelevanceEstimationService: jest.fn(),
}));
jest.mock("@ebike-backend/debug", () => ({
  DebugTraceService: jest.fn(),
}));
jest.mock("../handlers/reddit-search.handler", () => ({
  RedditSearchHandler: jest.fn(),
}));

import { ThreadSearchExecutor } from "./thread-search-executor.service";
import { RedditSearchHandler } from "../handlers/reddit-search.handler";

const SCOPED_SUBREDDIT = "Monitors";

function createMockResult(
  overrides: Partial<PlatformSearchResult> = {},
): PlatformSearchResult {
  return {
    externalId: `ext-${Math.random().toString(36).substring(7)}`,
    title: "Test Thread",
    url: "https://reddit.com/r/Monitors/123",
    author: "testuser",
    text: "test text",
    commentCount: 20,
    score: 50,
    createdAt: new Date(),
    topic: "r/Monitors",
    platform: ThreadPlatform.Reddit,
    ...overrides,
  };
}

function createMockThread(
  overrides: Partial<Thread> & { relevance?: number } = {},
): Thread {
  const thread = new Thread();
  thread.id =
    overrides.id ?? `thread-${Math.random().toString(36).substring(7)}`;
  thread.externalId = overrides.externalId ?? "ext-123";
  thread.title = overrides.title ?? "Test Thread";
  thread.topic = overrides.topic ?? "r/Monitors";
  thread.relevanceEstimation = overrides.relevance ?? 60;
  thread.commentCount = overrides.commentCount ?? 20;
  thread.source = overrides.source ?? ThreadPlatform.Reddit;
  thread.status = overrides.status ?? ThreadStatus.NEW;
  thread.keywords = overrides.keywords ?? [];
  return thread;
}

function createTask(
  overrides: Partial<ThreadSearchTask> = {},
): ThreadSearchTask {
  const task = new ThreadSearchTask();
  task.id = overrides.id ?? "task-1";
  task.keyword = overrides.keyword ?? "best monitors";
  task.platform = overrides.platform ?? ThreadPlatform.Reddit;
  task.categorySlug = overrides.categorySlug ?? "monitors";
  task.status = overrides.status ?? TaskStatus.PROCESSING;
  task.attempts = overrides.attempts ?? 0;
  return task;
}

describe("ThreadSearchExecutor", () => {
  let executor: ThreadSearchExecutor;
  let mockHandler: jest.Mocked<Pick<RedditSearchHandler, "search">>;
  let mockThreadRepository: any;
  let mockThreadCreatorService: any;
  let mockThreadRelevanceEstimator: any;
  let mockMetricsService: any;
  let mockDynamicConfigService: any;
  let mockDebugTraceService: any;
  let mockCategoryConfigService: any;

  beforeEach(() => {
    mockHandler = {
      search: jest.fn().mockResolvedValue([]),
    };

    mockThreadRepository = {
      findAllByExternalId: jest.fn().mockResolvedValue([]),
      appendKeyword: jest.fn().mockResolvedValue(true),
    };

    mockThreadCreatorService = {
      persistWithScore: jest
        .fn()
        .mockImplementation(
          async (
            result: PlatformSearchResult,
            score: number,
            status: ThreadStatus,
            keyword?: string,
          ) =>
            createMockThread({
              externalId: result.externalId,
              relevance: score,
              topic: result.topic,
              commentCount: result.commentCount,
              status,
              keywords: keyword ? [keyword] : [],
            }),
        ),
    };

    mockThreadRelevanceEstimator = {
      score: jest.fn().mockResolvedValue({
        score: 60,
        signals: {
          category: 60,
          intent: 30,
          experience: 20,
          productMention: 10,
        },
        categoryFocus: 0.5,
        commentCount: 5,
        commentFetchFailed: false,
        corpusSize: 7,
        topCategories: [],
      }),
    };

    mockMetricsService = {
      recordSearchExecuted: jest.fn(),
      recordSearchDuration: jest.fn(),
      recordDiscovered: jest.fn(),
      recordDuplicates: jest.fn(),
      recordRejected: jest.fn(),
      recordAverageRelevance: jest.fn(),
      recordEarlyStop: jest.fn(),
      recordPlatformApiError: jest.fn(),
      recordPlatformApiDuration: jest.fn(),
    };

    mockDynamicConfigService = {
      preprocessing: {
        minScore: 15,
        minComments: 8,
        minRelevanceForIngestion: 40,
      },
      scheduling: {
        searchQueryProcessing: {
          chunkSize: 30,
          avgRelevanceThreshold: 45,
        },
      },
      keywordResearch: {
        rateLimitBackoffSeconds: 60,
        searchTime: "year",
        searchLimit: 25,
        broadSearchMinScore: 100,
        broadSearchMinComments: 50,
        broadSearchMinRelevance: 90,
        broadSearchAvgRelevanceThreshold: 90,
      },
    };

    mockDebugTraceService = {
      record: jest.fn().mockResolvedValue(undefined),
    };

    mockCategoryConfigService = {
      getSearchConfig: jest.fn().mockReturnValue({
        platforms: {
          reddit: {
            subreddits: [SCOPED_SUBREDDIT],
          },
        },
      }),
    };

    executor = new ThreadSearchExecutor(
      mockThreadRepository,
      mockThreadCreatorService,
      mockThreadRelevanceEstimator,
      mockMetricsService,
      mockDynamicConfigService,
      mockDebugTraceService,
      mockCategoryConfigService,
      mockHandler as unknown as RedditSearchHandler,
    );
  });

  it("runs one pass per configured subreddit plus a broad (scope=null) pass", async () => {
    mockCategoryConfigService.getSearchConfig.mockReturnValue({
      platforms: {
        reddit: { subreddits: ["Monitors", "ultrawidemasterrace"] },
      },
    });
    mockHandler.search.mockResolvedValue([]);

    const result = await executor.execute(createTask());

    expect(mockHandler.search).toHaveBeenCalledTimes(3);
    expect(mockHandler.search.mock.calls[0][1]).toBe("Monitors");
    expect(mockHandler.search.mock.calls[1][1]).toBe("ultrawidemasterrace");
    expect(mockHandler.search.mock.calls[2][1]).toBeNull();
    expect(result.passesRun).toBe(3);
  });

  it("runs only the broad pass when category has no reddit search config", async () => {
    mockCategoryConfigService.getSearchConfig.mockReturnValue(undefined);
    mockHandler.search.mockResolvedValue([]);

    const result = await executor.execute(createTask());

    expect(mockHandler.search).toHaveBeenCalledTimes(1);
    expect(mockHandler.search.mock.calls[0][1]).toBeNull();
    expect(result.passesRun).toBe(1);
  });

  it("applies stricter quality gates on the broad pass", async () => {
    const passesScoped = createMockResult({
      externalId: "in-scope",
      topic: `r/${SCOPED_SUBREDDIT}`,
      score: 50,
      commentCount: 20,
    });
    const failsBroadButPassesScoped = createMockResult({
      externalId: "mid-quality",
      topic: "r/SomeOtherSub",
      score: 50,
      commentCount: 20,
    });

    mockHandler.search.mockImplementation(async (_keyword, scope) =>
      scope === null ? [failsBroadButPassesScoped] : [passesScoped],
    );

    await executor.execute(createTask());

    // The scoped result was scored and discovered; the broad result was
    // rejected at the quality gate (score=50 < broadSearchMinScore=100).
    expect(mockThreadRelevanceEstimator.score).toHaveBeenCalledTimes(1);
    expect(mockThreadRelevanceEstimator.score).toHaveBeenCalledWith(
      passesScoped,
    );
    expect(mockMetricsService.recordRejected).toHaveBeenCalledWith(
      "monitors",
      ThreadPlatform.Reddit,
      "below_quality_gate",
      1,
    );
  });

  it("skips the allowlist filter on the broad pass", async () => {
    const offScopeResult = createMockResult({
      externalId: "off-scope",
      topic: "r/AnyRandomSub",
      score: 200,
      commentCount: 100,
    });

    mockHandler.search.mockImplementation(async (_keyword, scope) =>
      scope === null ? [offScopeResult] : [],
    );

    // Score above broadSearchMinRelevance so it should be ingested.
    mockThreadRelevanceEstimator.score.mockResolvedValue({
      score: 95,
      signals: { category: 95, intent: 50, experience: 30, productMention: 15 },
      categoryFocus: 0.9,
      commentCount: 100,
      commentFetchFailed: false,
      corpusSize: 100,
      topCategories: [],
    });

    await executor.execute(createTask());

    expect(mockThreadCreatorService.persistWithScore).toHaveBeenCalledWith(
      offScopeResult,
      95,
      ThreadStatus.NEW,
      "best monitors",
    );
  });

  it("appends keyword to existing thread on duplicate, persists new ones", async () => {
    const results = [
      createMockResult({ externalId: "existing-1" }),
      createMockResult({ externalId: "new-1" }),
    ];
    // Only the scoped pass returns results; broad returns empty.
    mockHandler.search.mockImplementation(async (_keyword, scope) =>
      scope === SCOPED_SUBREDDIT ? results : [],
    );
    const existingThread = createMockThread({
      id: "thread-existing-1",
      externalId: "existing-1",
    });
    mockThreadRepository.findAllByExternalId.mockImplementation(
      async (ids: string[]) =>
        ids.includes("existing-1") ? [existingThread] : [],
    );

    await executor.execute(createTask());

    expect(mockThreadRepository.appendKeyword).toHaveBeenCalledWith(
      "thread-existing-1",
      "best monitors",
    );
    expect(mockMetricsService.recordDuplicates).toHaveBeenCalledWith(
      "monitors",
      ThreadPlatform.Reddit,
      1,
    );
    expect(mockThreadCreatorService.persistWithScore).toHaveBeenCalledWith(
      results[1],
      60,
      ThreadStatus.NEW,
      "best monitors",
    );
  });

  it("rejects scoped-pass results from subreddits not in allowedSubreddits", async () => {
    const results = [
      createMockResult({
        externalId: "on-scope",
        topic: `r/${SCOPED_SUBREDDIT}`,
      }),
      createMockResult({
        externalId: "off-scope",
        topic: "r/BestofRedditorUpdates",
      }),
    ];
    mockHandler.search.mockImplementation(async (_keyword, scope) =>
      scope === SCOPED_SUBREDDIT ? results : [],
    );

    await executor.execute(createTask());

    expect(mockThreadRelevanceEstimator.score).toHaveBeenCalledTimes(1);
    expect(mockThreadRelevanceEstimator.score).toHaveBeenCalledWith(results[0]);
    expect(mockMetricsService.recordRejected).toHaveBeenCalledWith(
      "monitors",
      ThreadPlatform.Reddit,
      "off_scope",
      1,
    );
  });

  it("uses top sort for product queries", async () => {
    mockHandler.search.mockResolvedValue([]);

    await executor.execute(createTask({ keyword: "LG 27GR93U review" }));

    expect(mockHandler.search).toHaveBeenCalledWith(
      "LG 27GR93U review",
      SCOPED_SUBREDDIT,
      expect.objectContaining({ sort: "top" }),
    );
  });

  it("uses relevance sort for category queries", async () => {
    mockHandler.search.mockResolvedValue([]);

    await executor.execute(createTask({ keyword: "best monitors 2026" }));

    expect(mockHandler.search).toHaveBeenCalledWith(
      "best monitors 2026",
      SCOPED_SUBREDDIT,
      expect.objectContaining({ sort: "relevance" }),
    );
  });

  it("classifies rate-limit errors, sets task backoff, and aborts the remaining passes", async () => {
    const rateLimitError = new HttpException(
      "Rate Limited",
      HttpStatus.TOO_MANY_REQUESTS,
    );
    mockHandler.search.mockRejectedValueOnce(rateLimitError);

    const task = createTask();
    await expect(executor.execute(task)).rejects.toThrow(rateLimitError);

    expect(task.status).toBe(TaskStatus.PENDING);
    expect(task.scheduledAt).toBeInstanceOf(Date);
    // Rate-limit on the first (scoped) pass aborts the broad pass too.
    expect(mockHandler.search).toHaveBeenCalledTimes(1);
    expect(mockMetricsService.recordPlatformApiError).toHaveBeenCalledWith(
      ThreadPlatform.Reddit,
      "rate_limit",
    );
  });

  it("continues to remaining passes when a non-rate-limit error occurs", async () => {
    const timeoutError = new Error("Request timeout");
    mockHandler.search
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce([]);

    const result = await executor.execute(createTask());

    expect(mockHandler.search).toHaveBeenCalledTimes(2);
    expect(result.passesRun).toBe(1); // scoped failed, broad succeeded
    expect(mockMetricsService.recordPlatformApiError).toHaveBeenCalledWith(
      ThreadPlatform.Reddit,
      "timeout",
    );
  });

  it("throws when no handler registered for platform", async () => {
    const task = createTask({ platform: "youtube" as ThreadPlatform });

    await expect(executor.execute(task)).rejects.toThrow(
      "No search handler registered for platform",
    );
  });

  it("records one debug trace per pass, tagged with mode", async () => {
    mockHandler.search.mockResolvedValue([]);

    await executor.execute(createTask());

    expect(mockDebugTraceService.record).toHaveBeenCalledTimes(2);
    const calls = mockDebugTraceService.record.mock.calls;
    expect(calls[0][0].data.mode).toBe("scoped");
    expect(calls[0][0].data.scope).toBe(SCOPED_SUBREDDIT);
    expect(calls[1][0].data.mode).toBe("broad");
    expect(calls[1][0].data.scope).toBeNull();
  });

  it("aggregates counters across passes", async () => {
    const scopedDiscovered = createMockResult({
      externalId: "scoped-1",
      topic: `r/${SCOPED_SUBREDDIT}`,
    });
    const broadDiscovered = createMockResult({
      externalId: "broad-1",
      topic: "r/SomeRandom",
      score: 200,
      commentCount: 100,
    });

    mockHandler.search.mockImplementation(async (_keyword, scope) =>
      scope === SCOPED_SUBREDDIT ? [scopedDiscovered] : [broadDiscovered],
    );

    mockThreadRelevanceEstimator.score.mockResolvedValue({
      score: 95,
      signals: { category: 95, intent: 50, experience: 30, productMention: 15 },
      categoryFocus: 0.9,
      commentCount: 100,
      commentFetchFailed: false,
      corpusSize: 100,
      topCategories: [],
    });

    const result = await executor.execute(createTask());

    expect(result.totalResults).toBe(2);
    expect(result.discovered).toBe(2);
    expect(result.passesRun).toBe(2);
  });
});
