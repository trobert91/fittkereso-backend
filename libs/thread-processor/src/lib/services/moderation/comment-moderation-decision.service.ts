import { Injectable } from "@nestjs/common";
import {
  CommentStatus,
  isUnresolved,
  ModerationStatus,
  UserComment,
} from "@ebike-backend/database";
import { ProcessorConfigService } from "@ebike-backend/config";

const RELEVANCE_FLOOR = 0.1;
const PER_ISSUE_HIGH_SEVERITY_THRESHOLD = 20;
const UNRESOLVED_REF_SEVERITY = 25;

/** The moderation decision for a single comment, plus the severity/priority
 *  figures it was derived from. Callers write these back onto the comment (and
 *  its refs) however they persist. */
export interface CommentModerationDecision {
  /** The moderation outcome — assign to both `comment.status` and
   *  `comment.validationDecision` (same `ModerationStatus` type). */
  status: ModerationStatus;
  moderationPriority: number;
  commentIssueSeverity: number;
  commentOpenIssueSeverity: number;
  /** Per-reference severity, keyed by reference id, so the caller can persist
   *  `issueSeverity`/`openIssueSeverity` on each ref consistently. */
  refSeverityById: Map<
    string,
    { issueSeverity: number; openIssueSeverity: number }
  >;
}

/**
 * The moderation approval rule, extracted from `SubtreeModerationService` so it
 * is a single source of truth: the extraction pipeline runs it once, and the
 * Resolution Backfill re-runs it after resolving a ref (resolution removes the
 * `UNRESOLVED_REF_SEVERITY` / `hasUnresolvedRef` triggers, so an `IN_REVIEW`
 * comment held only for that unresolved ref can flip to `APPROVED`).
 *
 * Stateless — depends only on `ProcessorConfigService.moderation.*` and the
 * comment's already-loaded `productReferences` (with candidates so
 * `isUnresolved` is accurate), `context.issues`, and `moderations`.
 */
@Injectable()
export class CommentModerationDecisionService {
  constructor(private readonly processorConfig: ProcessorConfigService) {}

  /**
   * Compute the moderation decision for a fully-loaded comment. Does NOT mutate
   * or persist — returns the decision plus the severity/priority figures.
   */
  decide(comment: UserComment): CommentModerationDecision {
    const refSeverityById = new Map<
      string,
      { issueSeverity: number; openIssueSeverity: number }
    >();

    for (const ref of comment.productReferences ?? []) {
      let refSeverity = 0;
      let refOpenSeverity = 0;
      for (const issue of ref.context?.issues ?? []) {
        refSeverity += issue.magnitude;
        if (issue.status !== "resolved") {
          refOpenSeverity += issue.magnitude;
        }
      }
      if (ref.enabled && isUnresolved(ref)) {
        refSeverity += UNRESOLVED_REF_SEVERITY;
        refOpenSeverity += UNRESOLVED_REF_SEVERITY;
      }
      refSeverityById.set(ref.id, {
        issueSeverity: refSeverity,
        openIssueSeverity: refOpenSeverity,
      });
    }

    let commentLevelSeverity = 0;
    let commentLevelOpenSeverity = 0;
    for (const issue of comment.context?.issues ?? []) {
      commentLevelSeverity += issue.magnitude;
      if (issue.status !== "resolved") {
        commentLevelOpenSeverity += issue.magnitude;
      }
    }

    const refs = comment.productReferences ?? [];
    const commentIssueSeverity =
      refs.reduce(
        (sum, r) => sum + (refSeverityById.get(r.id)?.issueSeverity ?? 0),
        0,
      ) + commentLevelSeverity;
    const commentOpenIssueSeverity =
      refs.reduce(
        (sum, r) => sum + (refSeverityById.get(r.id)?.openIssueSeverity ?? 0),
        0,
      ) + commentLevelOpenSeverity;

    // Normalize moderationPriority to [1, 100].
    const severityCap = this.processorConfig.moderation.severityCap;
    const severityNorm =
      Math.min(commentOpenIssueSeverity, severityCap) / severityCap;
    const relevanceNorm =
      Math.max(comment.relevance ?? 0, RELEVANCE_FLOOR) / 100;
    const rawPriority = 100 * severityNorm * relevanceNorm;
    const moderationPriority = Math.max(
      1,
      Math.min(100, Math.round(rawPriority)),
    );

    const status = this.deriveDecision(comment, commentOpenIssueSeverity);

    return {
      status,
      moderationPriority,
      commentIssueSeverity,
      commentOpenIssueSeverity,
      refSeverityById,
    };
  }

  private deriveDecision(
    comment: UserComment,
    openIssueSeverity: number,
  ): ModerationStatus {
    // Validation LLM suggestions take precedence — `deleted` short-circuits
    // before severity math; `in_review` overrides severity-based approval.
    const llmSuggestions = (comment.moderations ?? []).filter(
      (m) => m.source === "validation_llm" && m.suggestedStatus,
    );
    if (
      llmSuggestions.some((m) => m.suggestedStatus === CommentStatus.DELETED)
    ) {
      return CommentStatus.DELETED;
    }
    const llmInReview = llmSuggestions.some(
      (m) => m.suggestedStatus === CommentStatus.IN_REVIEW,
    );

    const enabledRefs = (comment.productReferences ?? []).filter(
      (r) => r.enabled,
    );
    const hasEnabledRefs = enabledRefs.length > 0;
    const unresolvedRefs = enabledRefs.filter((r) => isUnresolved(r));
    const highRelevanceThreshold =
      this.processorConfig.moderation.highRelevanceThreshold;
    const hasUnresolvedHighRelevanceRef = unresolvedRefs.some(
      (r) => (r.relevance ?? 0) >= highRelevanceThreshold,
    );
    const allUnresolved =
      enabledRefs.length > 0 && unresolvedRefs.length === enabledRefs.length;
    const hasUnresolvedRef = allUnresolved || hasUnresolvedHighRelevanceRef;

    const allIssues = [
      ...enabledRefs.flatMap((r) => r.context?.issues ?? []),
      ...(comment.context?.issues ?? []),
    ];
    if (
      allIssues.length === 0 &&
      !llmInReview &&
      !hasUnresolvedRef &&
      hasEnabledRefs
    ) {
      return CommentStatus.APPROVED;
    }

    const hasUnresolvedHighSev = allIssues.some(
      (i) =>
        i.magnitude >= PER_ISSUE_HIGH_SEVERITY_THRESHOLD &&
        i.status !== "resolved",
    );

    const threshold =
      this.processorConfig.moderation.openSeverityReviewThreshold;
    const cumulativeExceedsThreshold = openIssueSeverity >= threshold;

    if (
      llmInReview ||
      hasUnresolvedHighSev ||
      cumulativeExceedsThreshold ||
      hasUnresolvedRef ||
      !hasEnabledRefs
    ) {
      return CommentStatus.IN_REVIEW;
    }
    return CommentStatus.APPROVED;
  }
}
