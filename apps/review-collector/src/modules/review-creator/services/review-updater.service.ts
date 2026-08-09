import { Injectable } from "@nestjs/common";
import {
  CommentStatus,
  Depth,
  ExperienceType,
  getPrimaryModel,
  Intent,
  ProductModel,
  ProductReference,
  ProductReferenceCandidate,
  ProductReferenceCandidateRepository,
  ProductReferenceRepository,
  Review,
  ReviewLabel,
  ReviewLabelRepository,
  ReviewRepository,
  Sentiment,
  ThreadPlatform,
  UserComment,
  UserCommentRepository,
} from "@ebike-backend/database";
import { DebugTraceService } from "@ebike-backend/debug";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";

const SUBSTANTIVE_DEPTHS = new Set<Depth>([
  Depth.Comprehensive,
  Depth.Detailed,
  Depth.Mentioned,
]);
import { CustomLogger } from "@ebike-backend/logger";
import { chain, isEmpty } from "lodash";
import { nameOf } from "@ebike-backend/utils";
import {
  ReviewEvaluatorService,
  ReviewEvaluationResult,
} from "./review-evaluator.service";

@Injectable()
export class ReviewUpdaterService {
  private readonly logger = new CustomLogger(ReviewUpdaterService.name);

  constructor(
    private readonly reviewRepo: ReviewRepository,
    private readonly reviewLabelRepo: ReviewLabelRepository,
    private readonly commentRepo: UserCommentRepository,
    private readonly productRefRepo: ProductReferenceRepository,
    private readonly candidateRepo: ProductReferenceCandidateRepository,
    private readonly evaluator: ReviewEvaluatorService,
    private readonly debugTrace: DebugTraceService,
    private readonly dynamicConfig: DynamicConfigService,
  ) {}

  public async process(comment: UserComment): Promise<void> {
    try {
      if (isEmpty(comment.productReferences)) {
        this.logger.debug(
          `Comment ${comment.id} has no product references, skipping.`,
        );
        return;
      }

      // Deleted users have no authorId — generate a synthetic one from the
      // short external ID so each deleted-user comment gets its own review.
      if (!comment.authorId) {
        comment.authorId = `del_${comment.externalId}`;
        comment.authorName = comment.authorName || "[deleted]";
        // Targeted UPDATE bypasses the cascade on UserComment.productReferences,
        // which would otherwise re-save every loaded ProductReference and can
        // trip FK constraints if any joined parent row has been removed.
        await this.commentRepo.repo.update(
          { id: comment.id },
          { authorId: comment.authorId, authorName: comment.authorName },
        );
      }

      // A single comment can spawn up to N (author, model) reviews — one per
      // distinct candidate.modelId across the comment's references.
      const distinctModelIds = new Set<string>();
      for (const productRef of comment.productReferences ?? []) {
        for (const candidate of productRef.candidates ?? []) {
          if (candidate.model?.id) {
            distinctModelIds.add(candidate.model.id);
          }
        }
      }

      for (const modelId of distinctModelIds) {
        await this.processUserProductFromComment(comment, modelId);
      }
    } catch (error) {
      this.logger.error(`Error processing comment ${comment.id}`, error);
      throw error;
    }
  }

  // Stale-review entry point: rebuild a review purely from current refs without
  // a triggering UserComment (e.g. for refs whose source comments were deleted
  // and cascaded the refs away, or whose ref.updatedAt is newer than the
  // review.lastEvaluatedAt). Returns true if the review still has linked refs
  // after rebuild, false if it was soft-deleted.
  public async processUserProduct(
    userId: string,
    modelId: string,
  ): Promise<boolean> {
    try {
      return await this.rebuildReview({ userId, modelId });
    } catch (error) {
      this.logger.error(
        `Error processing user/product (${userId}, ${modelId})`,
        error,
      );
      throw error;
    }
  }

  private async processUserProductFromComment(
    comment: UserComment,
    modelId: string,
  ): Promise<void> {
    const authorId = comment.authorId;
    if (!authorId) return;

    // Locate the triggering candidate on this comment that points at modelId
    // (highest weight wins on ambiguous refs).
    const triggeringCandidate = chain(comment.productReferences ?? [])
      .flatMap((reference) => reference.candidates ?? [])
      .filter((candidate) => candidate.model?.id === modelId)
      .orderBy((candidate) => candidate.weight ?? 0, "desc")
      .head()
      .value();
    const triggeringRef = triggeringCandidate?.reference;

    await this.rebuildReview({
      userId: authorId,
      modelId,
      triggeringComment: comment,
      triggeringRef,
      triggeringCandidate,
    });
  }

  private async rebuildReview(input: {
    userId: string;
    modelId: string;
    triggeringComment?: UserComment;
    triggeringRef?: ProductReference;
    triggeringCandidate?: ProductReferenceCandidate;
  }): Promise<boolean> {
    const {
      userId,
      modelId,
      triggeringComment,
      triggeringRef,
      triggeringCandidate,
    } = input;

    let review = await this.loadReviewByUserAndModel(userId, modelId);

    // For the comment-driven path the resolvedModel comes from the triggering
    // candidate. For the stale path we need the model row from the review
    // (which must exist, since we found it by modelId).
    const resolvedModel = triggeringCandidate?.model ?? review?.model ?? null;
    if (!resolvedModel) {
      this.logger.debug(
        `No resolved model available for (${userId}, ${modelId}), skipping rebuild.`,
      );
      return false;
    }

    const username =
      triggeringComment?.authorName ?? review?.username ?? "[deleted]";
    const platformFallback =
      triggeringComment?.thread?.source ??
      review?.platform ??
      ThreadPlatform.Reddit;

    if (!review) {
      review = this.createReviewShell({
        resolvedModel,
        userId,
        username,
        platform: platformFallback,
      });
    }

    // Persist new review before linking references (FK requires review to exist)
    if (!review.id) {
      try {
        await this.reviewRepo.save(review);
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          error.message?.includes("unique constraint")
        ) {
          const reloaded = await this.loadReviewByUserAndModel(userId, modelId);
          if (!reloaded) {
            throw error;
          }
          review = reloaded;
        } else {
          throw error;
        }
      }
    }

    const comments = await this.fetchCommentsForUserAndProduct(userId, modelId);

    const linkedCandidates = await this.linkCandidatesToReview(
      review,
      comments,
      modelId,
    );

    if (isEmpty(linkedCandidates)) {
      this.logger.debug(
        `No linked candidates for (${userId}, ${modelId}) — skipping evaluation.`,
      );
      await this.softDeleteReview(review);
      return false;
    }

    // Revive if previously soft-deleted
    const isNew = !review.id;
    review.enabled = true;
    review.deletedAt = null;

    review.candidates = linkedCandidates;
    review.platform =
      comments.find((c) => c.thread?.source)?.thread?.source ??
      platformFallback;

    const startTime = Date.now();
    let evaluationResult = await this.evaluator.evaluate(review);
    review.lastEvaluatedAt = new Date();

    // Gate: only persist when at least one medium-or-high quote survived
    // filtering and deduplication. Low-quality quotes are already excluded
    // upstream in ReviewEvaluatorService.deduplicateQuotes.
    if (isEmpty(review.quotes)) {
      this.logger.debug(
        `No qualifying medium/high-quality quote for (${userId}, ${modelId}) — skipping persistence.`,
      );
      await this.softDeleteReview(review);
      return false;
    }

    try {
      await this.saveReviewWithLabels(review);
    } catch (error: unknown) {
      // Handle unique constraint violation from concurrent worker race condition
      if (
        error instanceof Error &&
        error.message?.includes("unique constraint")
      ) {
        this.logger.debug(
          "Review already created by concurrent worker, retrying with existing review",
          { userId, modelId },
        );
        const reloaded = await this.loadReviewByUserAndModel(userId, modelId);
        if (!reloaded) {
          throw error;
        }
        review = reloaded;
        review.enabled = true;
        review.deletedAt = null;
        review.candidates = linkedCandidates;
        review.platform =
          comments.find((c) => c.thread?.source)?.thread?.source ??
          platformFallback;
        evaluationResult = await this.evaluator.evaluate(review);
        review.lastEvaluatedAt = new Date();
        if (isEmpty(review.quotes)) {
          this.logger.debug(
            `No qualifying medium/high-quality quote after retry — skipping persistence.`,
          );
          await this.softDeleteReview(review);
          return false;
        }
        await this.saveReviewWithLabels(review);
      } else {
        throw error;
      }
    }

    const durationMs = Date.now() - startTime;
    await this.recordReviewCreationTrace({
      triggeringComment,
      triggeringRef,
      review,
      resolvedModel,
      linkedCandidates,
      isNew,
      evaluationResult,
      durationMs,
    });

    this.logger.debug(
      `Linked ${linkedCandidates.length} candidates to review ${review.id}`,
    );
    return true;
  }

  private async softDeleteReview(review: Review): Promise<void> {
    if (!review.id) return;
    review.enabled = false;
    review.deletedAt = new Date();
    review.lastEvaluatedAt = new Date();
    await this.reviewRepo.save(review);
    this.logger.debug(`Soft-deleted review ${review.id}`);
  }

  // TypeORM's `orphanedRowAction: 'delete'` on Review.labels is unreliable
  // when `deriveLabels` reassigns `review.labels = [...new instances...]`
  // — the original tracked collection reference is lost and orphan detection
  // misses the previous rows. Delete them explicitly here, then cascade-insert
  // the fresh set via the regular save.
  private async saveReviewWithLabels(review: Review): Promise<void> {
    const freshLabels = review.labels ?? [];
    if (review.id) {
      await this.reviewLabelRepo.repo.delete({ review: { id: review.id } });
    }
    review.labels = freshLabels.map((label) => {
      const detached = new ReviewLabel();
      detached.review = review;
      detached.type = label.type;
      detached.label = label.label;
      detached.sentiment = label.sentiment;
      detached.evidenceCount = label.evidenceCount;
      return detached;
    });
    await this.reviewRepo.save(review);
  }

  private async loadReviewByUserAndModel(
    userId: string,
    modelId: string,
  ): Promise<Review | null> {
    return this.reviewRepo.repo
      .createQueryBuilder("review")
      .leftJoinAndSelect(`review.${nameOf<Review>("candidates")}`, "candidates")
      .leftJoinAndSelect(
        `candidates.${nameOf<ProductReferenceCandidate>("reference")}`,
        "reference",
      )
      .leftJoinAndSelect(
        `reference.${nameOf<ProductReference>("comment")}`,
        "refComment",
      )
      .leftJoinAndSelect(
        `candidates.${nameOf<ProductReferenceCandidate>("model")}`,
        "candidateModel",
      )
      .leftJoinAndSelect(`review.${nameOf<Review>("labels")}`, "labels")
      .leftJoinAndSelect(`review.${nameOf<Review>("model")}`, "model")
      .where(`review.${nameOf<Review>("userId")} = :userId`, { userId })
      .andWhere(`model.${nameOf<ProductModel>("id")} = :productModelId`, {
        productModelId: modelId,
      })
      .getOne();
  }

  private createReviewShell(input: {
    resolvedModel: ProductModel;
    userId: string;
    username: string;
    platform: ThreadPlatform;
  }): Review {
    const review = new Review();
    review.model = input.resolvedModel;
    review.enabled = true;
    review.userId = input.userId;
    review.username = input.username;
    review.sentiment = Sentiment.Neutral;
    review.experience = ExperienceType.Reference;
    review.intents = [Intent.Recommendation];
    review.platform = input.platform;
    return review;
  }

  /**
   * Load every APPROVED comment authored by `userId` whose references attach
   * (via candidate.model = modelId) to the target product. Eager-loads the
   * candidate set + the resolved model so downstream evaluation can walk
   * `comment.productReferences[].candidates[]` without extra round-trips.
   */
  private async fetchCommentsForUserAndProduct(
    userId: string,
    modelId: string,
  ): Promise<UserComment[]> {
    return (
      this.commentRepo.repo
        .createQueryBuilder("comment")
        .leftJoinAndSelect(`comment.${nameOf<UserComment>("parent")}`, "parent")
        .leftJoinAndSelect(
          `parent.${nameOf<UserComment>("parent")}`,
          "grandparent",
        )
        .leftJoinAndSelect(
          `comment.${nameOf<UserComment>("productReferences")}`,
          "ref",
        )
        .leftJoinAndSelect(
          `ref.${nameOf<ProductReference>("candidates")}`,
          "candidate",
        )
        .leftJoinAndSelect(
          `candidate.${nameOf<ProductReferenceCandidate>("model")}`,
          "model",
        )
        .leftJoinAndSelect(
          `model.${nameOf<ProductModel>("productCategory")}`,
          "category",
        )
        .leftJoinAndSelect(`comment.${nameOf<UserComment>("thread")}`, "thread")
        .where(`comment.${nameOf<UserComment>("authorId")} = :authorId`, {
          authorId: userId,
        })
        .andWhere(
          // Restrict to comments that have at least one candidate pointing at modelId.
          // We don't filter the joined candidates collection by modelId here because
          // we still want the full candidate set on each reference for downstream
          // weight-aware aggregation.
          (qb) =>
            `EXISTS (${qb
              .subQuery()
              .from(ProductReferenceCandidate, "subCandidate")
              .innerJoin(
                `subCandidate.${nameOf<ProductReferenceCandidate>("reference")}`,
                "subRef",
              )
              .where(`subRef.commentId = comment.id`)
              .andWhere(`subCandidate.modelId = :modelId`)
              .getQuery()})`,
          { modelId },
        )
        // Aggregation eligibility: comments must be APPROVED and the linked refs
        // must remain enabled. Filtering at the database keeps in-review and
        // rejected rows out of memory entirely.
        .andWhere(
          `comment.${nameOf<UserComment>("status")} = :approvedStatus`,
          {
            approvedStatus: CommentStatus.APPROVED,
          },
        )
        .andWhere(`ref.${nameOf<ProductReference>("enabled")} = true`)
        .orderBy(`comment.${nameOf<UserComment>("externalCreationTs")}`, "ASC")
        .getMany()
    );
  }

  /**
   * For each approved comment, pick its highest-weight candidate that points
   * at `targetModelId` and set its `review` FK to the given review. Previously-
   * linked candidates on the review that aren't re-selected are unlinked.
   */
  private async linkCandidatesToReview(
    review: Review,
    comments: UserComment[],
    targetModelId: string,
  ): Promise<ProductReferenceCandidate[]> {
    const approvedComments = comments.filter(
      (comment) => comment.status === CommentStatus.APPROVED,
    );

    if (isEmpty(approvedComments) || !targetModelId) {
      return [];
    }

    const linkedCandidates: ProductReferenceCandidate[] = [];
    const previouslyLinked = review.candidates ?? [];
    const newlyLinkedIds = new Set<string>();

    for (const comment of approvedComments) {
      // Walk every reference's candidate set, filter to qualifying candidates
      // (enabled ref, depth substantive, modelId match), pick the highest-
      // weight candidate per comment so one comment contributes to one
      // (user, product) review at most.
      const modelInComment = chain(comment.productReferences ?? [])
        .flatMap((reference) =>
          (reference.candidates ?? [])
            .filter((candidate) =>
              this.isQualifyingCandidate(reference, candidate, targetModelId),
            )
            .map((candidate) => ({ candidate, reference })),
        )
        .orderBy(({ candidate }) => candidate.weight ?? 0, "desc")
        .head()
        .value();

      if (!modelInComment) continue;

      modelInComment.candidate.review = review;
      // Hydrate the in-memory back-pointer to the parent reference. The query
      // that loads comments walks ref → candidates (parent → children), so
      // TypeORM does not populate candidate.reference. Without this, the
      // evaluator drops every contribution and the review gets soft-deleted.
      modelInComment.candidate.reference = modelInComment.reference;
      // Make sure the reference's `comment` FK is set — joins above leave it
      // hydrated, but for fresh candidate rows it can be stale.
      modelInComment.reference.comment = comment;
      linkedCandidates.push(modelInComment.candidate);
      newlyLinkedIds.add(modelInComment.candidate.id);
    }

    const unlinkedCandidates = previouslyLinked.filter(
      (candidate) => !newlyLinkedIds.has(candidate.id),
    );
    for (const candidate of unlinkedCandidates) {
      candidate.review = null;
    }

    const allChanged = [...linkedCandidates, ...unlinkedCandidates];
    if (allChanged.length > 0) {
      await this.candidateRepo.repo.save(allChanged);
    }

    return linkedCandidates;
  }

  private isQualifyingCandidate(
    reference: ProductReference,
    candidate: ProductReferenceCandidate,
    targetModelId: string,
  ): boolean {
    if (!reference.enabled || candidate.model?.id !== targetModelId) {
      return false;
    }
    if (isEmpty(reference.quotes) || !reference.depth) {
      return false;
    }
    // All experience types can create reviews (non-hands-on are excluded from
    // scoring downstream in ProductRatingUpdaterService, displayed as
    // speculative comments).
    return SUBSTANTIVE_DEPTHS.has(reference.depth);
  }

  private async recordReviewCreationTrace(input: {
    triggeringComment?: UserComment;
    triggeringRef?: ProductReference;
    review: Review;
    resolvedModel: ProductModel;
    linkedCandidates: ProductReferenceCandidate[];
    isNew: boolean;
    evaluationResult: ReviewEvaluationResult | undefined;
    durationMs: number;
  }): Promise<void> {
    const {
      triggeringComment,
      triggeringRef,
      review,
      resolvedModel,
      linkedCandidates,
      isNew,
      evaluationResult,
      durationMs,
    } = input;
    try {
      if (!this.dynamicConfig.debug?.traceEnabled) return;
      if (!evaluationResult) return;

      const triggeringResolved = getPrimaryModel(triggeringRef);
      const productId = triggeringResolved?.id ?? resolvedModel.id;
      const productName =
        triggeringResolved?.displayName ??
        triggeringResolved?.model ??
        resolvedModel.displayName ??
        resolvedModel.model;

      await this.debugTrace.record({
        threadId: triggeringComment?.thread?.id,
        reviewId: review.id,
        productId,
        step: "review_creation",
        statusBefore: isNew ? "new" : "existing",
        statusAfter: "evaluated",
        durationMs,
        data: {
          summary: `Review ${review.id} for ${productName}: score=${review.reviewScore}, sentiment=${review.sentiment}, ${linkedCandidates.length} candidates`,
          reviewCreation: {
            reviewId: review.id,
            productId: productId ?? "",
            userId: review.userId,
            isNew,
            sourceReferences: linkedCandidates.map((candidate) => {
              const reference = candidate.reference;
              return {
                referenceId: reference?.id ?? "",
                commentId: reference?.comment?.id ?? "",
                sentiment: reference?.sentiment ?? "",
                experience: reference?.experience ?? "",
                depth: reference?.depth ?? "",
                relevance: reference?.relevance ?? 0,
                quoteCount: (reference?.quotes ?? []).length,
                candidateWeight: candidate.weight,
                candidateConfidence: candidate.confidence,
                isPrimary: candidate.isPrimary,
              };
            }),
            sentimentAggregation: evaluationResult.sentimentBreakdown,
            scoreBreakdown: evaluationResult.scoreBreakdown,
            selectedExperience: evaluationResult.selectedExperience,
            selectedDepth: evaluationResult.selectedDepth,
            selectedIntents: evaluationResult.selectedIntents,
          },
        },
      });
    } catch (error) {
      this.logger.warn("Failed to record review creation trace", { error });
    }
  }
}
