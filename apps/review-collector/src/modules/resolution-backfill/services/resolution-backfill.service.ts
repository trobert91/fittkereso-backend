import { Injectable } from "@nestjs/common";
import {
  getPrimaryModel,
  ProductModel,
  ProductReference,
  ProductReferenceRepository,
  ProductResolutionInput,
  UserComment,
  UserCommentRepository,
} from "@ebike-backend/database";
import { CustomLogger } from "@ebike-backend/logger";
import {
  ResolutionResultApplierService,
  ResolutionService,
} from "@ebike-backend/resolution";
import { ChatTraceData, DebugTraceService } from "@ebike-backend/debug";
import { CategoryNameMatcherService } from "@ebike-backend/product";
import {
  CommentModerationDecisionService,
  pooledGroupInput,
  referenceToResolutionInput,
} from "@ebike-backend/thread-processor";
import { PipelineMetricsService } from "@ebike-backend/metrics";
import { nameOf } from "@ebike-backend/utils";
import { BackfillCooldown, effectiveCooldownHours } from "./backfill-cooldown";

const TRACE_STEP = "resolution_backfill";
const MS_PER_HOUR = 60 * 60 * 1000;

export interface BackfillRunOptions {
  topN: number;
  /** Only retry references created within this many days; older ones are abandoned. */
  retryMaxAgeDays: number;
  /** Comment `relevance` floor for review-eligibility (mirrors moderation). */
  minApprovalScore: number;
  cooldown: BackfillCooldown;
}

/**
 * Resolution Backfill — Step B. Selects the highest-relevance eligible unresolved
 * references (index-backed), re-resolves them against the (growing) catalog
 * (embedding only — never web search), materialises `attemptResolutionAfter`
 * (growing backoff), and on a match copies candidates to the productLinkId group
 * and re-moderates + touches each affected comment so the existing
 * CommentReviewScheduler builds/refreshes the review naturally — never reprocessing
 * a thread and never calling the review builder directly.
 */
@Injectable()
export class ResolutionBackfillService {
  private readonly logger = new CustomLogger(ResolutionBackfillService.name);

  constructor(
    private readonly productReferenceRepository: ProductReferenceRepository,
    private readonly commentRepository: UserCommentRepository,
    private readonly productSearch: ResolutionService,
    private readonly resolutionApplier: ResolutionResultApplierService,
    private readonly categoryNameMatcher: CategoryNameMatcherService,
    private readonly moderationDecision: CommentModerationDecisionService,
    private readonly debugTrace: DebugTraceService,
    private readonly pipelineMetrics: PipelineMetricsService,
  ) {}

  async runBackfill(
    options: BackfillRunOptions,
  ): Promise<{ attempted: number; resolved: number; propagated: number }> {
    // Selection + ordering are index-backed in SQL (highest-relevance first), so
    // the DB walks only the eligible slice and stops at the limit.
    const candidates =
      await this.productReferenceRepository.findBackfillCandidates(
        options.topN,
        options.retryMaxAgeDays,
        options.minApprovalScore,
      );
    if (candidates.length === 0) {
      return { attempted: 0, resolved: 0, propagated: 0 };
    }

    let attempted = 0;
    let resolved = 0;
    let propagated = 0;

    for (const reference of candidates) {
      attempted++;
      try {
        const result = await this.backfillReference(reference, options);

        if (result.model) {
          resolved++;
          // Bring the ref's comment to its post-resolve status and mark it dirty
          // so CommentReviewScheduler builds/refreshes the review naturally.
          await this.remoderateAndTouchComment(reference.comment?.id);
          propagated += await this.propagateToSiblings(reference, result.model);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Resolution backfill failed for reference ${reference.id}: ${message}`,
          { error, referenceId: reference.id },
        );
      }
    }

    this.logger.log(
      `Resolution backfill complete: attempted ${attempted}, resolved ${resolved}, propagated ${propagated}`,
    );
    return { attempted, resolved, propagated };
  }

  private async backfillReference(
    reference: ProductReference,
    options: BackfillRunOptions,
  ): Promise<{ model?: ProductModel }> {
    const now = new Date();

    // Identify the category if it wasn't linked at extraction time: a ref with a
    // hint but no category gets matched against the enabled categories now, so a
    // category created/enabled after extraction links its backlog lazily here
    // (no separate reconciliation pass). No enabled match → resolve unscoped.
    await this.identifyCategoryIfMissing(reference);

    if (reference.productCategory && reference.context) {
      reference.context.resolution = {
        ...reference.context.resolution,
        preResolvedCategories: [
          {
            id: reference.productCategory.id,
            name: reference.productCategory.name,
            similarity: 1.0,
          },
        ],
      };
    }

    const input = await this.buildBackfillInput(reference);
    let cost = 0;
    const result = await this.productSearch.search(
      input,
      // Catalog-only — backfill never runs web search (cost control; the catalog
      // is the only thing that changed since the original resolution).
      { useEmbedding: true, webSearchEnabled: false, mode: "loose" },
      {},
      (traceData: ChatTraceData) => {
        cost += traceData.cost;
      },
      { referenceId: reference.id, commentId: reference.comment?.id ?? "" },
    );

    reference.searchContext = result.context;
    await this.resolutionApplier.apply(reference, result, { commentBody: "" });
    reference.resolutionFinished = true;
    reference.resolutionLastAttemptedAt = now;
    reference.resolutionAttemptCount += 1;
    reference.attemptResolutionAfter = new Date(
      now.getTime() +
        effectiveCooldownHours(
          reference.resolutionAttemptCount,
          options.cooldown,
        ) *
          MS_PER_HOUR,
    );
    await this.productReferenceRepository.save(reference);

    this.pipelineMetrics.recordResolutionOutcome(
      result.resolvedModel ? "resolved" : "unresolved",
      false,
      false,
    );
    await this.recordTrace(reference, result.resolvedModel != null, cost);

    return { model: result.resolvedModel ?? undefined };
  }

  /**
   * Replay the enriched input where available, then pool the productLinkId
   * group's evidence (specs/clues) so the one resolution uses everything the
   * group's mentions collectively provide.
   */
  private async buildBackfillInput(
    reference: ProductReference,
  ): Promise<ProductResolutionInput> {
    const base =
      reference.searchContext?.input ?? referenceToResolutionInput(reference);
    if (!reference.productLinkId) return pooledGroupInput([reference], base);
    const siblings =
      await this.productReferenceRepository.findUnresolvedSiblingsByLinkId(
        reference.productLinkId,
        reference.id,
      );
    return pooledGroupInput([reference, ...siblings], base);
  }

  /**
   * Link an unresolved ref's category lazily, at resolve time: if it has no
   * `productCategory` but carries a `categoryHint`, match the hint against the
   * enabled categories and assign the result (persisted with the attempt's save).
   * No enabled match → leave it category-less and resolve unscoped. This replaces
   * the separate category-reconciliation pass — flipping a category to enabled
   * makes its already-linked backlog eligible via the candidate query directly,
   * and null-category refs get identified here when they come up for resolution.
   */
  private async identifyCategoryIfMissing(
    reference: ProductReference,
  ): Promise<void> {
    if (reference.productCategory) return;
    const hint =
      reference.categoryHint ?? reference.context?.identification?.categoryHint;
    if (!hint) return;
    const matched =
      await this.categoryNameMatcher.matchFromEnabledCategories(hint);
    if (matched) reference.productCategory = matched;
  }

  /**
   * Copy the resolved candidate set onto every unresolved member of the same
   * productLinkId group (one exact product) — no search — then re-moderate +
   * touch each member's comment so its review is picked up naturally. Returns the
   * number of siblings propagated to.
   */
  private async propagateToSiblings(
    resolvedRef: ProductReference,
    _resolvedModel: ProductModel,
  ): Promise<number> {
    if (!resolvedRef.productLinkId) return 0;
    const siblings =
      await this.productReferenceRepository.findUnresolvedSiblingsByLinkId(
        resolvedRef.productLinkId,
        resolvedRef.id,
        true, // skip disabled-category siblings — held back until enabled
      );
    if (siblings.length === 0) return 0;

    const snapshot = (resolvedRef.candidates ?? []).map((candidate) => ({
      model: candidate.model,
      weight: candidate.weight,
      confidence: candidate.confidence,
      isPrimary: candidate.isPrimary,
    }));

    let count = 0;
    for (const sibling of siblings) {
      await this.resolutionApplier.copyCandidateSet(sibling, snapshot);
      sibling.resolutionFinished = true;
      sibling.resolutionLastAttemptedAt = new Date();
      await this.productReferenceRepository.save(sibling);
      await this.remoderateAndTouchComment(sibling.comment?.id);
      count++;
    }
    return count;
  }

  /**
   * After a ref on this comment is resolved, re-derive the comment's moderation
   * status (resolution may flip it IN_REVIEW → APPROVED) and mark it dirty, so the
   * every-minute CommentReviewScheduler builds/refreshes the (author, product)
   * review through the normal path. We never call the review builder directly.
   *
   * `lastProcessedStatus = NULL` re-arms the scheduler's first-review trigger;
   * the `updatedAt` bump clears its approval delay. The targeted `update` writes
   * only these columns and bypasses the `productReferences` cascade (same reason
   * as ReviewUpdaterService.process).
   */
  private async remoderateAndTouchComment(
    commentId: string | undefined,
  ): Promise<void> {
    if (!commentId) return;
    try {
      const comment = await this.commentRepository.repo.findOne({
        where: { id: commentId },
        relations: {
          productReferences: { candidates: { model: true } },
        },
      });
      if (!comment) return;

      const decision = this.moderationDecision.decide(comment);

      await this.commentRepository.repo.update(
        { id: commentId },
        {
          status: decision.status,
          issueSeverity: decision.commentIssueSeverity,
          openIssueSeverity: decision.commentOpenIssueSeverity,
          moderationPriority: decision.moderationPriority,
          validationDecision: decision.status,
          lastProcessedStatus: null,
          updatedAt: () => "NOW()",
        },
      );
    } catch (error: unknown) {
      this.logger.warn(
        `Failed to re-moderate/touch comment ${commentId} after backfill`,
        { error, commentId },
      );
    }
  }

  private async recordTrace(
    reference: ProductReference,
    wasResolved: boolean,
    cost: number,
  ): Promise<void> {
    try {
      const threadId = reference.comment?.id
        ? await this.getThreadIdForComment(reference.comment.id)
        : undefined;
      if (!threadId) return;

      const displayName =
        reference.context?.identification?.displayName ?? "unknown";
      const resolvedModel = getPrimaryModel(reference);

      await this.debugTrace.record({
        threadId,
        commentId: reference.comment?.id,
        productReferenceId: reference.id,
        step: TRACE_STEP,
        statusBefore: "unresolved",
        statusAfter: wasResolved ? "resolved" : "unresolved",
        durationMs: 0,
        cost,
        costLabel: TRACE_STEP,
        data: {
          summary: wasResolved
            ? `Resolution backfill: "${displayName}" → ${resolvedModel?.displayName}`
            : `Resolution backfill: "${displayName}" still unresolved (attempt ${reference.resolutionAttemptCount})`,
          resolution: {
            referenceId: reference.id,
            input: {
              displayName,
              brand: reference.context?.identification?.brand,
              model: reference.context?.identification?.model,
            },
            productCandidates: [],
            resolvedProduct: resolvedModel
              ? {
                  id: resolvedModel.id,
                  displayName: resolvedModel.displayName,
                  brand: resolvedModel.brand?.name,
                  model: resolvedModel.model,
                }
              : undefined,
          },
        },
      });
    } catch (error: unknown) {
      this.logger.warn("Failed to record resolution-backfill trace", {
        error,
        referenceId: reference.id,
      });
    }
  }

  private async getThreadIdForComment(
    commentId: string,
  ): Promise<string | undefined> {
    const comment = await this.commentRepository.repo.findOne({
      where: { id: commentId },
      relations: [nameOf<UserComment>("thread")],
      select: ["id"],
    });
    return comment?.thread?.id;
  }
}
