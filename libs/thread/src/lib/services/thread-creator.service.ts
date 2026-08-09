import { Injectable } from "@nestjs/common";
import {
  Thread,
  ThreadRepository,
  ThreadPlatform,
  ThreadStatus,
} from "@ebike-backend/database";
import type { PlatformSearchResult } from "@ebike-backend/database";
import { ThreadCreateDto } from "../models/thread-create.dto";
import { RedditThreadService } from "@ebike-backend/reddit";
import { Submission } from "snoowrap";
import { CustomLogger } from "@ebike-backend/logger";
import { ThreadMetricsService } from "@ebike-backend/metrics";
import {
  ThreadRelevanceEstimationResult,
  ThreadRelevanceEstimationService,
} from "@ebike-backend/relevance";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import { sanitizeText } from "@ebike-backend/utils";

@Injectable()
export class ThreadCreatorService {
  private readonly logger = new CustomLogger(ThreadCreatorService.name);

  constructor(
    private readonly threadRepo: ThreadRepository,
    private readonly threadService: RedditThreadService,
    private readonly threadMetricsService: ThreadMetricsService,
    private readonly relevanceEstimator: ThreadRelevanceEstimationService,
    private readonly dynamicConfigService: DynamicConfigService,
  ) {}

  /**
   * Admin entry point: create a thread from an external id (Reddit submission).
   * Always persists as NEW — admin override semantic: the LLM is the final
   * arbiter, not the cheap term scorer. Stage 1 score is still computed and
   * stored in `relevanceEstimation` for diagnostic value but does NOT
   * tombstone the thread the way it does in the search-executor flow.
   *
   * The controller layer is expected to immediately run Stage 2
   * (ThreadSelectionService.select) so the final status reflects the LLM's
   * verdict.
   */
  public async createFromDto(dto: ThreadCreateDto): Promise<Thread> {
    const { searchResult, estimate } = await this.fetchAndEstimate(dto);

    const saved = await this.persistWithScore(
      searchResult,
      estimate.score,
      ThreadStatus.NEW,
    );
    this.logger.debug(
      `Admin-created thread ${saved.id} "${saved.title}" (status=NEW, score=${estimate.score}).`,
      { threadId: saved.id, topic: saved.topic },
    );
    return saved;
  }

  /**
   * Run the Stage 1 estimator against an external id without persisting.
   * Returns the score breakdown plus the would-be PlatformSearchResult and
   * the configured ingestion threshold so the caller can show the admin
   * "this is what the search executor would have done with this URL."
   */
  public async previewEstimate(dto: ThreadCreateDto): Promise<{
    searchResult: PlatformSearchResult;
    estimate: ThreadRelevanceEstimationResult;
    minRelevanceForIngestion: number;
  }> {
    return this.fetchAndEstimate(dto);
  }

  private async fetchAndEstimate(dto: ThreadCreateDto): Promise<{
    searchResult: PlatformSearchResult;
    estimate: ThreadRelevanceEstimationResult;
    minRelevanceForIngestion: number;
  }> {
    const externalId = this.extractRedditSubmissionId(dto.externalId);
    const submission = (await this.threadService.getThreadMetadata(
      externalId,
    )) as Submission;
    const searchResult = this.mapSubmissionToSearchResult(submission);
    const estimate = await this.relevanceEstimator.score(searchResult);
    const minRelevanceForIngestion =
      this.dynamicConfigService.preprocessing?.minRelevanceForIngestion ?? 40;
    return { searchResult, estimate, minRelevanceForIngestion };
  }

  /**
   * Accept either a raw Reddit submission id (e.g. "1otx0op") or a full
   * Reddit URL (e.g. "https://www.reddit.com/r/foo/comments/1otx0op/title/")
   * and return just the id. snoowrap's `getSubmission` rejects URLs with
   * "options.uri must be a path when using options.baseUrl" — this is the
   * narrow normaliser.
   */
  private extractRedditSubmissionId(input: string): string {
    const trimmed = input.trim();
    const match = trimmed.match(/\/comments\/([a-z0-9]+)/i);
    if (match) {
      return match[1];
    }
    return trimmed;
  }

  /**
   * Persist a Thread row built from a platform search result, with the
   * caller-provided ingestion-time relevance score and status. Used by the
   * search executor after running the cheap pre-filter:
   *   - status=NEW for surviving threads (awaiting Stage 2 LLM selection)
   *   - status=LOW_ESTIMATION for tombstones (Stage 1 cheap-scorer rejected,
   *     never reprocessed)
   *
   * The optional `keyword` records which search keyword discovered the
   * thread. The keyword-research pipeline always passes it; admin paths
   * (`createFromDto`) omit it. When omitted, `keywords` stays empty.
   *
   * No preprocessing is run inline. Categories are assigned later by the
   * ThreadSelectionService.
   */
  public async persistWithScore(
    result: PlatformSearchResult,
    score: number,
    status: ThreadStatus,
    keyword?: string,
  ): Promise<Thread> {
    const thread = this.mapSearchResultToThreadEntity(result);
    thread.relevanceEstimation = score;
    thread.status = status;
    thread.keywords = keyword ? [keyword] : [];

    const savedThread = await this.threadRepo.repo.save(thread);

    this.threadMetricsService.created(savedThread.source);

    this.logger.debug("Thread created", {
      threadId: savedThread.id,
      externalId: savedThread.externalId,
      status: savedThread.status,
      relevanceEstimation: savedThread.relevanceEstimation,
      keyword: keyword ?? null,
    });

    return savedThread;
  }

  /**
   * Build an unsaved Thread entity from a PlatformSearchResult. Used by both
   * the persisting paths above and by debug endpoints that need to run
   * Stage 2 against an in-memory thread without writing to the DB.
   */
  public mapSearchResultToThreadEntity(result: PlatformSearchResult): Thread {
    const thread = new Thread();

    thread.externalId = result.externalId;
    thread.source = result.platform;
    thread.title = result.title;
    thread.topic = result.topic;
    thread.author = result.author;
    thread.url = result.url;
    thread.text = sanitizeText(result.text);
    thread.commentCount = result.commentCount;
    thread.threadCreatedAt = result.createdAt;

    return thread;
  }

  private mapSubmissionToSearchResult(
    submission: Submission,
  ): PlatformSearchResult {
    return {
      externalId: submission.id,
      platform: ThreadPlatform.Reddit,
      title: submission.title,
      text: submission.selftext,
      topic: submission.subreddit_name_prefixed,
      author: submission.author?.name ?? "",
      url: `https://www.reddit.com${submission.permalink}`,
      commentCount: submission.num_comments,
      score: submission.score,
      createdAt: new Date(submission.created_utc * 1000),
    };
  }
}
