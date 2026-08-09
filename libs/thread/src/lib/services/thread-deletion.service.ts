import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  ProductReference,
  ProductReferenceRepository,
  ReviewRepository,
  ThreadRepository,
  UserCommentRepository,
} from "@ebike-backend/database";
import { Thread, ThreadStatus } from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import { nameOf } from "@ebike-backend/utils";
import { compact, isEmpty } from "lodash";

@Injectable()
export class ThreadDeletionService {
  private readonly logger = new CustomLogger(ThreadDeletionService.name);

  constructor(
    private readonly threadRepository: ThreadRepository,
    private readonly userCommentRepository: UserCommentRepository,
    private readonly productReferenceRepository: ProductReferenceRepository,
    private readonly reviewRepository: ReviewRepository,
  ) {}

  async removeThreadData(
    threadId: string,
    deleteThread: boolean,
  ): Promise<Thread> {
    const thread = await this.threadRepository.repo.findOne({
      where: { id: threadId },
      relations: { categories: { productCategory: true } },
    });

    if (!thread) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }

    if (thread.processRunning) {
      throw new ConflictException(
        `Thread ${threadId} is currently being processed`,
      );
    }

    const affectedReviewIds = await this.collectAffectedReviewIds(threadId);

    // Traces are stored in Loki and expire via retention — no deletion needed

    await this.userCommentRepository.repo.delete({ thread: { id: threadId } });

    await this.markReviewsForReevaluation(affectedReviewIds);

    // Reset wipes the extraction artifacts (comments, trees, media, OP
    // summary) but preserves the relevance verdict — `relevance`,
    // `relevanceEstimation`, `relevanceResult`, and the `categories`
    // associations are all left intact. Stage 2 is expensive (LLM call) and
    // the verdict still applies to the same thread title/topic, so the next
    // pipeline run should re-extract with the existing categories rather
    // than recompute Stage 2. Status flips to SELECTED when the thread
    // already had categories (the verdict was usable) so the
    // run-pipeline-without-reselect path picks it up.
    const hadUsableCategories = !isEmpty(thread.categories);
    thread.status = this.computeResetStatus(deleteThread, hadUsableCategories);
    thread.processRunning = false;
    thread.preprocessingFailed = false;
    thread.markedForSync = false;
    thread.commentCount = null;
    thread.commentTree = null;
    thread.media = null;
    thread.lastProcessedAt = null;
    thread.lastSynced = null;
    if (!deleteThread) {
      thread.opSummary = null;
    }

    const updated = await this.threadRepository.repo.save(thread);
    this.logger.log(
      deleteThread ? "Thread soft-deleted" : "Thread data reset",
      {
        threadId,
        newStatus: updated.status,
        preservedCategories: hadUsableCategories ? thread.categories.length : 0,
      },
    );
    return updated;
  }

  private computeResetStatus(
    deleteThread: boolean,
    hadUsableCategories: boolean,
  ): ThreadStatus {
    if (deleteThread) return ThreadStatus.DELETED;
    return hadUsableCategories ? ThreadStatus.SELECTED : ThreadStatus.NEW;
  }

  private async collectAffectedReviewIds(threadId: string): Promise<string[]> {
    // Review FK moved from ProductReference to ProductReferenceCandidate —
    // walk candidates → reference → comment to find every review linked to
    // any candidate on this thread's references.
    const rows = await this.productReferenceRepository.repo
      .createQueryBuilder("reference")
      .select('candidate."reviewId"', "reviewId")
      .innerJoin(`reference.${nameOf<ProductReference>("comment")}`, "comment")
      .innerJoin(
        "product_reference_candidate",
        "candidate",
        'candidate."referenceId" = reference.id',
      )
      .where('comment."threadId" = :threadId', { threadId })
      .andWhere('candidate."reviewId" IS NOT NULL')
      .distinct(true)
      .getRawMany();

    return compact(rows.map((row) => row.reviewId));
  }

  private async markReviewsForReevaluation(reviewIds: string[]): Promise<void> {
    if (isEmpty(reviewIds)) {
      return;
    }

    await this.reviewRepository.repo
      .createQueryBuilder()
      .update()
      .set({ lastEvaluatedAt: null })
      .whereInIds(reviewIds)
      .execute();
  }
}
