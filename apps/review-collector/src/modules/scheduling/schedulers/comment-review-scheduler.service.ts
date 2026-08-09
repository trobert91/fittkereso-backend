import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
  CommentStatus,
  ProductModel,
  ProductReference,
  ProductReferenceCandidate,
  Review,
  ReviewRepository,
  UserComment,
  UserCommentRepository,
} from "@ebike-backend/database";
import { SchedulerMetricsService } from "@ebike-backend/metrics";
import { BaseScheduler } from "@ebike-backend/task";
import { nameOf } from "@ebike-backend/utils";
import { ReviewUpdaterService } from "../../review-creator/services/review-updater.service";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";
import {
  ProcessorConfigService,
  SCHEDULING_DEFAULTS,
} from "@ebike-backend/config";
import { isEmpty, uniq } from "lodash";

@Injectable()
export class CommentReviewSchedulerService extends BaseScheduler {
  constructor(
    readonly metricsService: SchedulerMetricsService,
    private readonly commentRepo: UserCommentRepository,
    private readonly reviewRepo: ReviewRepository,
    private readonly reviewUpdater: ReviewUpdaterService,
    private readonly dynamicConfigService: DynamicConfigService,
    private readonly processorConfig: ProcessorConfigService,
  ) {
    super(CommentReviewSchedulerService.name, metricsService);
  }

  // @Cron(CronExpression.EVERY_30_MINUTES)
  @Cron(CronExpression.EVERY_MINUTE)
  async schedule() {
    await super.schedule(this.scheduleCommentReview.bind(this));
  }

  async scheduleCommentReview() {
    const batchLimit =
      this.dynamicConfigService.scheduling?.commentReview?.batchLimit ??
      SCHEDULING_DEFAULTS.commentReview.batchLimit;
    const commentReviewConfig =
      this.dynamicConfigService.scheduling?.commentReview;
    const delays = {
      approvedMs:
        (commentReviewConfig?.approvedDelayHours ??
          SCHEDULING_DEFAULTS.commentReview.approvedDelayHours) *
        3600 *
        1000,
      revocationMs:
        (commentReviewConfig?.revocationDelayHours ??
          SCHEDULING_DEFAULTS.commentReview.revocationDelayHours) *
        3600 *
        1000,
    };

    await this.reevaluateStaleReviews(batchLimit);
    await this.softDeleteOrphanedReviews(batchLimit);

    const commentsToProcess = await this.getChangedComments(batchLimit, delays);
    if (isEmpty(commentsToProcess)) {
      return;
    }

    const deduplicated = this.deduplicateByAuthorAndProduct(commentsToProcess);

    this.logger.debug(
      `Found ${commentsToProcess.length} comments to process, deduplicated to ${deduplicated.length} unique (author, product) pairs.`,
    );

    const { approvals, revocations } = this.splitByDirection(deduplicated);
    const succeededIds: string[] = [];

    for (const comment of approvals) {
      try {
        await this.reviewUpdater.process(comment);
        succeededIds.push(comment.id);
      } catch (error) {
        this.logger.error(
          `Error processing review update with comment ${comment.id}`,
          error,
        );
      }
    }

    for (const comment of revocations) {
      try {
        await this.softDeleteReviews(comment);
        succeededIds.push(comment.id);
      } catch (error) {
        this.logger.error(
          `Error soft-deleting reviews for comment ${comment.id}`,
          error,
        );
      }
    }

    // Mark every successfully-processed comment in the original batch (not just
    // the deduplicated representatives) so the scheduler can't re-pick them
    // next minute. ReviewUpdaterService.process re-evaluates every sibling
    // comment by the same author/product internally, so siblings dropped by
    // deduplication share the same outcome as the kept representative.
    const succeededKeys = this.collectSucceededAuthorProductKeys(
      deduplicated,
      new Set(succeededIds),
    );
    const commentIdsToMark = commentsToProcess
      .filter((comment) =>
        this.commentAuthorProductKeys(comment).some((key) =>
          succeededKeys.has(key),
        ),
      )
      .map((comment) => comment.id);

    if (!isEmpty(commentIdsToMark)) {
      await this.commentRepo.repo
        .createQueryBuilder()
        .update(UserComment)
        .set({
          lastProcessedStatus: () => `"${nameOf<UserComment>("status")}"`,
        })
        .whereInIds(commentIdsToMark)
        .execute();
    }

    this.logger.debug(
      `${deduplicated.length} comment(s) processed (${approvals.length} approvals, ${revocations.length} revocations).`,
    );
  }

  private collectSucceededAuthorProductKeys(
    deduplicated: UserComment[],
    succeededIds: Set<string>,
  ): Set<string> {
    const keys = new Set<string>();
    for (const comment of deduplicated) {
      if (!succeededIds.has(comment.id)) {
        continue;
      }
      for (const key of this.commentAuthorProductKeys(comment)) {
        keys.add(key);
      }
    }
    return keys;
  }

  private commentAuthorProductKeys(comment: UserComment): string[] {
    const authorId = comment.authorId ?? `del_${comment.externalId}`;
    const modelIds = (comment.productReferences ?? [])
      .flatMap((ref) => ref.candidates ?? [])
      .map((candidate) => candidate.model?.id)
      .filter((modelId): modelId is string => !!modelId);
    return uniq(modelIds).map((modelId) => `${authorId}::${modelId}`);
  }

  private splitByDirection(comments: UserComment[]): {
    approvals: UserComment[];
    revocations: UserComment[];
  } {
    return {
      approvals: comments.filter(
        (comment) => comment.status === CommentStatus.APPROVED,
      ),
      revocations: comments.filter(
        (comment) => comment.status !== CommentStatus.APPROVED,
      ),
    };
  }

  /**
   * For each distinct candidate.modelId on this comment's references, soft-
   * delete the (author, model) review. Walks ALL candidates, not just primaries,
   * so revocation reaches reviews built from runner-up candidates too.
   */
  private async softDeleteReviews(comment: UserComment): Promise<void> {
    const modelIds = uniq(
      (comment.productReferences ?? [])
        .flatMap((ref) => ref.candidates ?? [])
        .map((candidate) => candidate.model?.id)
        .filter((modelId): modelId is string => !!modelId),
    );

    for (const modelId of modelIds) {
      const review = await this.reviewRepo.repo
        .createQueryBuilder("review")
        .innerJoin(`review.${nameOf<Review>("model")}`, "model")
        .where(`review.${nameOf<Review>("userId")} = :userId`, {
          userId: comment.authorId,
        })
        .andWhere(`model.${nameOf<ProductModel>("id")} = :modelId`, { modelId })
        .getOne();

      if (!review) {
        continue;
      }

      review.enabled = false;
      review.deletedAt = new Date();
      await this.reviewRepo.save(review);
    }

    // Also catch reviews linked via candidate.reviewId where the candidate is
    // attached to a reference from this comment but whose modelId is no longer
    // in the comment's candidate set (e.g. the resolver dropped it on
    // re-resolution).
    const directlyLinkedReviews = await this.reviewRepo.repo
      .createQueryBuilder("review")
      .innerJoin(`review.${nameOf<Review>("candidates")}`, "candidate")
      .innerJoin(
        `candidate.${nameOf<ProductReferenceCandidate>("reference")}`,
        "ref",
      )
      .where(`ref.${nameOf<ProductReference>("comment")} = :commentId`, {
        commentId: comment.id,
      })
      .andWhere(`review.${nameOf<Review>("enabled")} = :enabled`, {
        enabled: true,
      })
      .getMany();

    for (const review of directlyLinkedReviews) {
      review.enabled = false;
      review.deletedAt = new Date();
      await this.reviewRepo.save(review);
    }
  }

  private deduplicateByAuthorAndProduct(
    comments: UserComment[],
  ): UserComment[] {
    const seen = new Set<string>();
    const result: UserComment[] = [];

    for (const comment of comments) {
      for (const ref of comment.productReferences ?? []) {
        for (const candidate of ref.candidates ?? []) {
          const modelId = candidate.model?.id;
          if (!modelId) continue;

          const key = `${comment.authorId}::${modelId}`;
          if (!seen.has(key)) {
            seen.add(key);
            result.push(comment);
          }
        }
      }
    }

    return result;
  }

  // Fallback: any live review with zero linked candidates that hasn't been
  // touched within the grace period is genuinely orphaned and gets soft-
  // deleted. The grace period (on `updatedAt`) protects mid-rebuild reviews —
  // those still get a fresh `updatedAt` when ReviewUpdaterService saves them.
  private async softDeleteOrphanedReviews(limit: number): Promise<void> {
    const orphanGracePeriodMs = 60 * 60 * 1000;
    const orphanThreshold = new Date(Date.now() - orphanGracePeriodMs);

    const orphanedReviews = await this.reviewRepo.repo
      .createQueryBuilder("review")
      .where(`review.${nameOf<Review>("deletedAt")} IS NULL`)
      .andWhere(`review.${nameOf<Review>("enabled")} = :enabled`, {
        enabled: true,
      })
      .andWhere(`review.${nameOf<Review>("updatedAt")} <= :orphanThreshold`, {
        orphanThreshold,
      })
      .andWhere(
        // prc."reviewId" stays raw: ProductReferenceCandidate exposes the
        // relation as `review` and has no typed reviewId property to feed nameOf.
        `NOT EXISTS (
          SELECT 1 FROM product_reference_candidate prc WHERE prc."reviewId" = review.id
        )`,
      )
      .take(limit)
      .getMany();

    if (isEmpty(orphanedReviews)) {
      return;
    }

    for (const review of orphanedReviews) {
      review.enabled = false;
      review.deletedAt = new Date();
      review.lastEvaluatedAt = new Date();
    }

    await this.reviewRepo.saveAll(orphanedReviews);
    this.logger.debug(
      `Soft-deleted ${orphanedReviews.length} orphaned review(s)`,
    );
  }

  // Picks up reviews whose backing candidates have changed since the last
  // evaluation and re-runs ReviewUpdaterService for each. Two OR'd triggers:
  // (a) the current linked-candidate count differs from partCount; (b) at
  // least one linked candidate has a parent ref whose updatedAt > review.
  // lastEvaluatedAt. Both walk product_reference_candidate, not the legacy
  // ProductReference.reviewId column.
  private async reevaluateStaleReviews(limit: number): Promise<void> {
    const staleReviews = await this.reviewRepo.repo
      .createQueryBuilder("review")
      .select("review.id", "id")
      .addSelect(`review.${nameOf<Review>("userId")}`, "userId")
      .addSelect('review."modelId"', "modelId")
      .where(`review.${nameOf<Review>("deletedAt")} IS NULL`)
      .andWhere(`review.${nameOf<Review>("enabled")} = :enabled`, {
        enabled: true,
      })
      .andWhere(
        `(
          review."${nameOf<Review>("partCount")}" IS DISTINCT FROM (
            SELECT COUNT(*)::int FROM product_reference_candidate prc WHERE prc."reviewId" = review.id
          )
          OR (
            review."${nameOf<Review>("lastEvaluatedAt")}" IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM product_reference_candidate prc
              INNER JOIN product_reference pr ON pr.id = prc."referenceId"
              WHERE prc."reviewId" = review.id
              AND pr."${nameOf<ProductReference>("updatedAt")}" > review."${nameOf<Review>("lastEvaluatedAt")}"
            )
          )
        )`,
      )
      .take(limit)
      .getRawMany<{ id: string; userId: string; modelId: string }>();

    if (isEmpty(staleReviews)) {
      return;
    }

    let processed = 0;
    for (const row of staleReviews) {
      try {
        await this.reviewUpdater.processUserProduct(row.userId, row.modelId);
        processed++;
      } catch (error) {
        this.logger.error(`Error re-evaluating stale review ${row.id}`, error);
      }
    }

    this.logger.debug(`Re-evaluated ${processed} stale review(s)`);
  }

  /**
   * Pull every comment whose references attach to at least one persisted
   * candidate AND whose status / lastProcessedStatus / candidate-updatedAt
   * combination flags it as in need of (re-)evaluation.
   */
  private async getChangedComments(
    limit: number,
    delays: { approvedMs: number; revocationMs: number },
  ): Promise<UserComment[]> {
    const approvedThreshold = new Date(Date.now() - delays.approvedMs);
    const revocationThreshold = new Date(Date.now() - delays.revocationMs);

    return (
      this.commentRepo.repo
        .createQueryBuilder("comment")
        .innerJoinAndSelect(
          `comment.${nameOf<UserComment>("productReferences")}`,
          "ref",
        )
        .innerJoinAndSelect(
          `ref.${nameOf<ProductReference>("candidates")}`,
          "candidate",
        )
        .innerJoinAndSelect(
          `candidate.${nameOf<ProductReferenceCandidate>("model")}`,
          "model",
        )
        // FK columns referenced raw inside the EXISTS subqueries below
        // ("reviewId", "commentId", "modelId", "referenceId") have no typed
        // property on their owning entity (the relations are exposed as
        // `review`, `comment`, `model`, `reference`), so they have no nameOf
        // equivalent. Everything backed by a real entity column routes through
        // nameOf.
        .where(
          `((comment."${nameOf<UserComment>("status")}" = :approved
            AND comment."${nameOf<UserComment>("relevance")}" >= :minApprovalScore)
          AND (comment."${nameOf<UserComment>("lastProcessedStatus")}" IS NULL OR comment."${nameOf<UserComment>("lastProcessedStatus")}" != :approved)
          AND comment."${nameOf<UserComment>("updatedAt")}" <= :approvedThreshold)
         OR
         (comment."${nameOf<UserComment>("status")}" IN (:...revocationStatuses)
          AND comment."${nameOf<UserComment>("lastProcessedStatus")}" = :approved
          AND comment."${nameOf<UserComment>("updatedAt")}" <= :revocationThreshold)
         OR
         ((comment."${nameOf<UserComment>("status")}" = :approved
            AND comment."${nameOf<UserComment>("relevance")}" >= :minApprovalScore)
          AND comment."${nameOf<UserComment>("lastProcessedStatus")}" = :approved
          AND (
            EXISTS (
              SELECT 1 FROM product_reference_candidate prc
              INNER JOIN product_reference pref ON pref.id = prc."referenceId"
              INNER JOIN review r ON r.id = prc."reviewId"
              WHERE pref."commentId" = comment.id
              AND prc."reviewId" IS NOT NULL
              AND (r."${nameOf<Review>("lastEvaluatedAt")}" IS NULL OR pref."${nameOf<ProductReference>("updatedAt")}" > r."${nameOf<Review>("lastEvaluatedAt")}")
            )
            OR
            EXISTS (
              SELECT 1 FROM product_reference_candidate prc
              INNER JOIN product_reference pref ON pref.id = prc."referenceId"
              INNER JOIN review r ON r."${nameOf<Review>("userId")}" = comment."${nameOf<UserComment>("authorId")}" AND r."modelId" = prc."modelId"
              WHERE pref."commentId" = comment.id
              AND prc."reviewId" IS NULL
              AND (r."${nameOf<Review>("lastEvaluatedAt")}" IS NULL OR pref."${nameOf<ProductReference>("updatedAt")}" > r."${nameOf<Review>("lastEvaluatedAt")}")
            )
          ))`,
          {
            approved: CommentStatus.APPROVED,
            revocationStatuses: [
              CommentStatus.IN_REVIEW,
              CommentStatus.DELETED,
            ],
            approvedThreshold,
            revocationThreshold,
            minApprovalScore: this.processorConfig.relevance.minApprovalScore,
          },
        )
        .orderBy(`comment.${nameOf<UserComment>("updatedAt")}`, "ASC")
        .take(limit)
        .getMany()
    );
  }
}
