import { Injectable } from "@nestjs/common";
import {
  CommentModeration,
  CommentStatus,
  ProductReference,
  ProductReferenceRepository,
  UserComment,
  UserCommentRepository,
} from "@ebike-backend/database";
import { DebugTraceService } from "@ebike-backend/debug";
import { isEmpty } from "lodash";
import { Subtree } from "../../models/subtree.model";
import { CommentModerationDecisionService } from "./comment-moderation-decision.service";

export interface ModerationOpts {
  threadId: string;
  subtreeIndex: number;
}

@Injectable()
export class SubtreeModerationService {
  constructor(
    private readonly productReferenceRepository: ProductReferenceRepository,
    private readonly commentRepository: UserCommentRepository,
    private readonly moderationDecision: CommentModerationDecisionService,
    private readonly debugTrace: DebugTraceService,
  ) {}

  async moderate(subtree: Subtree, opts: ModerationOpts): Promise<void> {
    const phaseStart = Date.now();
    const changedRefs: ProductReference[] = [];
    const changedComments: UserComment[] = [];

    for (const { comment } of subtree.planNodes) {
      if (comment.status !== CommentStatus.RELEVANCE_CALCULATED) continue;

      // Single source of truth for the approval rule + severity math — shared
      // with the Resolution Backfill, which re-runs it after resolving a ref.
      const decision = this.moderationDecision.decide(comment);

      for (const ref of comment.productReferences ?? []) {
        const severity = decision.refSeverityById.get(ref.id);
        ref.issueSeverity = severity?.issueSeverity ?? 0;
        ref.openIssueSeverity = severity?.openIssueSeverity ?? 0;
        changedRefs.push(ref);
      }

      comment.issueSeverity = decision.commentIssueSeverity;
      comment.openIssueSeverity = decision.commentOpenIssueSeverity;
      comment.moderationPriority = decision.moderationPriority;
      comment.validationDecision = decision.status;
      comment.status = decision.status;

      const moderation: CommentModeration = {
        reviewedBy: "moderation_pipeline",
        source: "system",
        suggestedStatus: comment.status,
        reviewComment: `severity=${comment.openIssueSeverity ?? 0}, priority=${comment.moderationPriority ?? 0}`,
        createdAt: new Date().toISOString(),
      };
      comment.moderations = [...(comment.moderations ?? []), moderation];

      changedComments.push(comment);
    }

    if (!isEmpty(changedRefs)) {
      await this.productReferenceRepository.saveAll(changedRefs);
    }
    if (!isEmpty(changedComments)) {
      await this.commentRepository.saveAll(changedComments);
    }

    await this.debugTrace.record({
      threadId: opts.threadId,
      batchId: String(opts.subtreeIndex),
      step: "comment_moderation",
      statusBefore: "relevance_calculated",
      statusAfter: "moderated",
      durationMs: Date.now() - phaseStart,
      data: {
        commentsModerated: changedComments.length,
        decisions: this.summarizeDecisions(changedComments),
      } as any,
    });
  }

  private summarizeDecisions(comments: UserComment[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of comments) {
      const key = c.validationDecision ?? "unknown";
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  }
}
